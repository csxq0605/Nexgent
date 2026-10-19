/**
 * The layer-3 proposal (ADR 0026): one request that rewrites one learnable
 * part of the parent from what the parent did on the minibatch (GEPA's
 * reflective dataset: inputs, outputs, feedback) and the edits to that part
 * the minibatch already refused (DSPy's instruction history, ADAS's failure
 * feedback). The frozen fields are named so the model knows it cannot touch
 * them; the host checks the reply again (`offlineCandidateProblems`). The
 * prompt names no kind of task.
 */
import { randomUUID } from 'node:crypto'
import {
  OFFLINE_FROZEN_FIELDS,
  OFFLINE_LIMITS,
  OFFLINE_RETRIEVAL_BOUNDS,
  offlineCandidateProblems,
  ZERO_USAGE,
  type LedgerAttribution,
  type LLMCompleteOptions,
  type LLMProvider,
  type LLMUsage,
  type OfflineCandidate,
  type OfflineComponent,
  type OfflineRejectedEdit,
  type ThinkingMode,
} from '@nexgent/kernel'
import type { PracticeCaseResult } from './evaluator.js'

/** What a proposal is built from. */
export interface OfflineProposalInput {
  readonly runId: string
  readonly component: OfflineComponent
  readonly parent: OfflineCandidate
  readonly minibatch: readonly PracticeCaseResult[]
  readonly rejected: readonly OfflineRejectedEdit[]
}

/** A proposal: the child, or why there is none. */
export interface OfflineProposal {
  readonly candidate?: OfflineCandidate
  readonly usd: number
  readonly detail?: string
}

/** Proposes a child. */
export interface OfflineProposer {
  propose(input: OfflineProposalInput, signal: AbortSignal): Promise<OfflineProposal>
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The system prompt. */
export function offlineProposalSystemPrompt(component: OfflineComponent): string {
  const part = component === 'execution-guidance'
    ? [
        'You improve the execution guidance of a general-purpose agent: a short text given at the start of every task, saying how to work.',
        `Write the whole new guidance (at most ${OFFLINE_LIMITS.maxGuidanceChars} characters). It must hold for any task: no values, file names or wording of the tasks shown, no rules for one kind of task. The task's own instructions always win over it.`,
        'Reply with JSON only: {"executionGuidance":"..."}',
      ]
    : [
        'You tune the retrieval parameters of a general-purpose agent: how many handbook entries a task gets, how strictly they must match the task, and how many learned skills it may be given.',
        `Bounds: ${Object.entries(OFFLINE_RETRIEVAL_BOUNDS).map(([key, [min, max, integer]]) => `${key} ${min}–${max}${integer ? ' (integer)' : ''}`).join('; ')}.`,
        'Reply with JSON only: {"retrieval":{"handbookTopK":n,"handbookMinCoverage":x,"handbookMinSharedTerms":n,"skillMaxActive":n}}',
      ]
  return [
    ...part,
    '',
    'You see how the current version did on a few practice tasks (task, what the run produced, the scorer\'s feedback) and earlier proposals for this part that did not do better. Change what the feedback points at; do not repeat a refused proposal.',
    `These are frozen and may not appear in the reply: ${OFFLINE_FROZEN_FIELDS.join(', ')}.`,
  ].join('\n')
}

/** The user message. */
export function offlineProposalUserMessage(input: OfflineProposalInput): string {
  const current = input.component === 'execution-guidance'
    ? `# Current guidance\n${input.parent.executionGuidance === '' ? '(empty)' : input.parent.executionGuidance}`
    : `# Current retrieval parameters\n${JSON.stringify(input.parent.retrieval)}`
  const cases = input.minibatch.map((result, index) => [
    `## Task ${index + 1} (score ${result.score.toFixed(2)}${result.unknown === true ? ', unknown result' : ''})`,
    `Task: ${clip(result.input ?? '(not shown)', 2000)}`,
    `Run: ${clip(result.output ?? '(not shown)', 1500)}`,
    `Feedback: ${clip(result.feedback, 1500)}`,
  ].join('\n'))
  const rejected = input.rejected.length === 0 ? '(none)' : input.rejected.map(edit => `- ${clip(edit.proposal, 600)} — ${edit.reason}`).join('\n')
  return [current, `# Practice tasks\n${cases.join('\n\n')}`, `# Earlier proposals for this part that did not do better\n${rejected}`].join('\n\n')
}

function firstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Parse a reply into the child (pure): the parent with the one part
 * replaced. A reply naming another part or a frozen field, out of bounds,
 * or equal to the parent is refused with the reason.
 */
export function parseOfflineProposal(component: OfflineComponent, parent: OfflineCandidate, text: string): { readonly candidate: OfflineCandidate } | { readonly problem: string } {
  const json = firstObject(text)
  if (json === undefined) return { problem: 'the reply was not the JSON asked for' }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { problem: 'the reply was not valid JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { problem: 'the reply was not a JSON object' }
  const reply = value as Record<string, unknown>
  const field = component === 'execution-guidance' ? 'executionGuidance' : 'retrieval'
  const others = Object.keys(reply).filter(key => key !== field)
  if (others.length > 0) return { problem: `the reply changes more than ${field}: ${others.join(', ')}` }
  const merged = { ...parent, [field]: typeof reply[field] === 'string' ? (reply[field] as string).trim() : reply[field] }
  const problems = offlineCandidateProblems(merged)
  if (problems.length > 0) return { problem: problems.join('; ') }
  const candidate = merged as OfflineCandidate
  if (JSON.stringify(candidate) === JSON.stringify(parent)) return { problem: 'the proposal is the same as the parent' }
  return { candidate }
}

/** The product proposer: one request per proposal, priced from its usage. */
export function llmOfflineProposer(options: { readonly llm: LLMProvider; readonly model: string; readonly thinking: ThinkingMode; readonly estimateUsd: (model: string, usage: LLMUsage) => number | 'unknown'; readonly maxTokens?: number }): OfflineProposer {
  return {
    async propose(input, signal) {
      const attribution: LLMCompleteOptions & LedgerAttribution = { purpose: 'auxiliary', taskId: `offline:${input.runId}` }
      const maxTokens = options.maxTokens ?? 4000
      let text = ''
      let usage: LLMUsage = ZERO_USAGE
      let failure: string | undefined
      for await (const event of options.llm.complete({
        requestId: randomUUID(),
        model: options.model,
        thinking: options.thinking,
        maxTokens: options.thinking === 'off' ? maxTokens : maxTokens * 2,
        messages: [
          { role: 'system', content: offlineProposalSystemPrompt(input.component) },
          { role: 'user', content: offlineProposalUserMessage(input) },
        ],
        signal,
      }, attribution)) {
        if (event.type === 'text.delta') text += event.text
        else if (event.type === 'usage') usage = event.usage
        else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
      }
      signal.throwIfAborted()
      const usd = options.estimateUsd(options.model, usage)
      const spent = usd === 'unknown' ? OFFLINE_LIMITS.proposalUsd : usd
      if (failure !== undefined) return { usd: spent, detail: `the proposal request failed: ${failure}` }
      const parsed = parseOfflineProposal(input.component, input.parent, text)
      return 'candidate' in parsed ? { candidate: parsed.candidate, usd: spent } : { usd: spent, detail: parsed.problem }
    },
  }
}
