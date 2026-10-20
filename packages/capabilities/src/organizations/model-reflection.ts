/**
 * Coordinator step three: reflection by a model. The data still finds the
 * hottest part of a team run (`findHotspot`); a model then reads that part's
 * run records, judges why it was hot, and picks one of the changes that fit
 * (`actionsFor`, minus the ones that did not work before) with a reason.
 * The library falls back to the fixed order when this returns nothing
 * (no model, a failed call, an answer that is not one of the listed changes).
 *
 * One auxiliary request per new change, on the run's own model. The prompt
 * names no kind of task; the records are the run's own.
 */
import { randomUUID } from 'node:crypto'
import {
  ORGANIZATION_CHANGE_ACTIONS,
  ORGANIZATION_REFLECTION_LEAD,
  type LLMCompleteOptions,
  type LLMProvider,
  type LedgerAttribution,
  type OrganizationChangeAction,
  type OrganizationHotspot,
  type OrganizationProfile,
  type OrganizationShape,
  type SessionRecord,
} from '@nexgent/kernel'
import type { ModelChoice } from './reflection.js'

/** What the model is asked about. */
export interface ReflectionRequest {
  readonly sessionId: string
  readonly turn: number
  readonly hotspot: OrganizationHotspot
  readonly profile: OrganizationProfile
  readonly organization?: OrganizationShape
  /** The changes it may pick from, the rule's first. */
  readonly allowed: readonly OrganizationChangeAction[]
}

/** Picks a change for a hotspot; `undefined` lets the rule decide. */
export type OrganizationReflector = (request: ReflectionRequest) => Promise<ModelChoice | undefined>

/** Characters of run records the model is shown. */
export const REFLECTION_EXCERPT_CHARS = 12_000
/** Answer tokens. */
export const REFLECTION_MAX_TOKENS = 1_500
/** How long the request may take. */
export const REFLECTION_TIMEOUT_MS = 90_000

/** What each change does, as the model is told. */
export const ACTION_TEXT: Readonly<Record<OrganizationChangeAction, string>> = {
  'narrow-reading': 'tell the part exactly which files and directories it touches and to read only those',
  split: 'split the part between two members (or threads) that change different files and run at the same time; for the conversation that gave out the parts, hand its largest piece of its own work to a part of its own',
  merge: 'do not give the part a member (or thread) of its own (fold it into the one that redid it, or into fewer parts)',
  parallelize: 'start the part at the same time as the part of the same kind it waited for, on different files',
  sequence: 'run parts that touch the same files one after another instead of at the same time',
  'full-handoff': 'give the part the full results of the parts before it (paths, decisions, what is left), not a summary',
}

export const REFLECTION_SYSTEM = [
  `${ORGANIZATION_REFLECTION_LEAD}: a conversation and the parts it gave the work to (the project coordinator's threads, or a thread's or conversation's members).`,
  'Measurements already found the hottest part of the run (the most failures, wasted work, cost, time or idle wait). You see that part\'s measurements and its run records.',
  'Judge from the records why that part was hot: the concrete cause (for example what it kept re-reading, which calls failed and why, what was redone and by whom, what it waited for). Then pick the one change from the list that best removes that cause on the next similar task, and say why it fits better than the others.',
  'Judge only from what is shown. Pick exactly one change from the list, by its id.',
  'Answer with only this JSON object: {"cause":"...","action":"<id>","reason":"..."} (cause and reason one or two sentences each).',
].join('\n')

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text
}

/** Pure: one turn of a session's records as lines for the model. */
export function recordLines(records: readonly SessionRecord[], turn: number): string[] {
  const lines: string[] = []
  for (const record of records) {
    if (!('turn' in record) || record.turn !== turn) continue
    switch (record.type) {
      case 'user.message':
        if (record.source !== 'inject') lines.push(`[message] ${clip(record.content, 1_500)}`)
        break
      case 'assistant.message':
        if (record.content.trim() !== '') lines.push(`[assistant] ${clip(record.content, 600)}`)
        for (const call of record.toolCalls ?? []) lines.push(`[call] ${call.name} ${clip(call.arguments, 300)}`)
        break
      case 'tool.result':
        lines.push(record.isError ? `[failed] ${record.name}: ${clip(record.error?.message ?? record.content, 400)}` : `[result] ${record.name}: ${clip(record.content, 150)}`)
        break
      case 'subagent.start':
        lines.push(`[member start] ${record.name} (${record.executionForm}): ${clip(record.task, 400)}`)
        break
      case 'subagent.end':
        lines.push(`[member end] ${record.childSessionId}: ${record.result.status}${record.result.text === '' ? '' : ` ${clip(record.result.text, 400)}`}`)
        break
      case 'turn.end':
        lines.push(`[turn end] ${record.reason.kind}`)
        break
      default:
        break
    }
  }
  return lines
}

/**
 * The hot part's records: the coordinator's turn, or each run of the member
 * or thread with the part's name (from the coordinator's `subagent.start`),
 * cut to {@link REFLECTION_EXCERPT_CHARS}.
 */
export async function partExcerpt(
  request: Pick<ReflectionRequest, 'sessionId' | 'turn' | 'hotspot'>,
  readRecords: (sessionId: string) => Promise<readonly SessionRecord[]>,
): Promise<string> {
  const records = await readRecords(request.sessionId)
  const lines: string[] = []
  if (request.hotspot.kind === 'coordinator') {
    lines.push(...recordLines(records, request.turn))
  } else {
    for (const start of records) {
      if (start.type !== 'subagent.start' || start.turn !== request.turn || start.name !== request.hotspot.part) continue
      lines.push(`--- ${start.name}, run ${start.childTurn} ---`)
      const child = await readRecords(start.childSessionId).catch(() => [] as readonly SessionRecord[])
      lines.push(...recordLines(child, start.childTurn))
    }
    if (lines.length === 0) lines.push(...recordLines(records, request.turn))
  }
  const text = lines.join('\n')
  return text.length > REFLECTION_EXCERPT_CHARS ? `${text.slice(0, REFLECTION_EXCERPT_CHARS)}\n…(cut)` : text
}

/** Pure: the user message of the request. */
export function reflectionMessage(request: ReflectionRequest, excerpt: string): string {
  const part = request.profile.parts.find(item => item.name === request.hotspot.part)
  const whole = { usd: request.profile.usd, ms: request.profile.ms, parts: request.profile.parts.map(item => ({ name: item.name, kind: item.kind, share: item.share, ms: item.ms, failures: item.failures, retries: item.retries, idleMs: item.idleMs, wasted: item.wasted })) }
  return [
    `Hottest part: ${request.hotspot.part} (${request.hotspot.kind}), cause measured: ${request.hotspot.cause} = ${request.hotspot.value}`,
    ...(part === undefined ? [] : [`Its measurements: ${JSON.stringify(part)}`]),
    `The whole run: ${JSON.stringify(whole)}`,
    ...(request.organization === undefined ? [] : [`The organization: ${JSON.stringify(request.organization)}`]),
    '',
    'Changes you may pick (id: what it does):',
    ...request.allowed.map(action => `- ${action}: ${ACTION_TEXT[action]}`),
    '',
    `Run records of ${request.hotspot.part}:`,
    excerpt.trim() === '' ? '(none)' : excerpt,
  ].join('\n')
}

/** Pure: the model's answer as a choice, or `undefined` when it is not one. */
export function parseChoice(text: string): ModelChoice | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const { action, cause, reason } = value as Record<string, unknown>
  if (typeof action !== 'string' || !(ORGANIZATION_CHANGE_ACTIONS as readonly string[]).includes(action)) return undefined
  if (typeof cause !== 'string' || typeof reason !== 'string') return undefined
  return { action: action as OrganizationChangeAction, cause, reason }
}

/**
 * A reflector over the project's model provider: the request goes on the
 * run's own model (its `session.start.model`) as an auxiliary request.
 * Any failure returns `undefined` (the rule decides).
 */
export function modelReflector(options: {
  readonly llm: () => LLMProvider | undefined
  readonly readRecords: (sessionId: string) => Promise<readonly SessionRecord[]>
  readonly timeoutMs?: number
}): OrganizationReflector {
  return async request => {
    const llm = options.llm()
    if (llm === undefined) return undefined
    try {
      const records = await options.readRecords(request.sessionId)
      const start = records[0]
      if (start?.type !== 'session.start') return undefined
      const excerpt = await partExcerpt(request, options.readRecords)
      const attribution: LLMCompleteOptions & LedgerAttribution = { purpose: 'auxiliary', sessionId: request.sessionId, timeoutMs: options.timeoutMs ?? REFLECTION_TIMEOUT_MS }
      let text = ''
      let failed = false
      for await (const event of llm.complete({
        requestId: randomUUID(),
        model: start.model,
        thinking: 'on',
        effort: 'low',
        maxTokens: REFLECTION_MAX_TOKENS * 2,
        messages: [
          { role: 'system', content: REFLECTION_SYSTEM },
          { role: 'user', content: reflectionMessage(request, excerpt) },
        ],
      }, attribution)) {
        if (event.type === 'text.delta') text += event.text
        else if (event.type === 'error') failed = true
      }
      return failed ? undefined : parseChoice(text)
    } catch {
      return undefined
    }
  }
}
