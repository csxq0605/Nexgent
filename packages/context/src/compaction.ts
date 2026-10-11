/**
 * The basic compactor (`ctx.context.compactor`): when the latest request's
 * billed input reaches a threshold, older turns are summarized by one
 * auxiliary model request and replaced by the summary; the most recent turns
 * (always including the current one) stay verbatim. Record format and resume
 * semantics: `docs/spec/data-formats.md` §压缩; trigger: `agent-hooks.md` §压缩.
 *
 * Thinking blocks: the summary request is built from a plain-text transcript,
 * so no `providerContent` (thinking blocks and their signatures) of a
 * summarized reply is sent anywhere; after the `compaction` record the
 * projection drops those replies, and only kept replies are replayed with
 * their thinking blocks.
 */
import { randomUUID } from 'node:crypto'
import {
  billedInputTokens,
  NexgentError,
  renderCompactionSummary,
  UNKNOWN_USAGE,
  type CompactionCheckInput,
  type CompactionResult,
  type Compactor,
  type Effort,
  type LLMMessage,
  type LLMProvider,
  type LLMUsage,
  type ThinkingMode,
} from '@nexgent/kernel'
import { clip } from './text.js'

/** A message of the history the compactor sees (no system message). */
export type HistoryMessage = Exclude<LLMMessage, { role: 'system' }>

/** Default threshold of billed input tokens. */
export const DEFAULT_COMPACTION_THRESHOLD = 160_000

/** Default number of most recent turns kept verbatim. */
export const DEFAULT_KEEP_RECENT_TURNS = 2

/** Default output cap of the summary request. */
export const DEFAULT_SUMMARY_MAX_TOKENS = 16_000

/** Environment variable that overrides the threshold (acceptance runs lower it). */
export const COMPACTION_THRESHOLD_ENV = 'NEXGENT_COMPACTION_THRESHOLD'

/** Default per-item character cap inside the transcript (tool arguments and results). */
export const DEFAULT_TRANSCRIPT_ITEM_MAX_CHARS = 8_000

/** System prompt of the summary request. */
export const SUMMARY_SYSTEM_PROMPT = 'You write checkpoint summaries of conversations between a user and Nexgent, a general task agent, so that the work can continue after the older messages are removed.'

/** The fixed instruction that follows the transcript in the summary request. */
export const SUMMARY_INSTRUCTION = [
  'Summarize the conversation above into a checkpoint that lets the agent continue the work without the original messages.',
  '',
  'Use exactly these Markdown sections, in this order; write "(none)" for an empty section:',
  '',
  '## User requests',
  "- what the user asked for, including later changes and feedback; quote exact wording where it matters",
  '',
  '## Materials and files',
  '- project paths that were read, created or changed, and what each holds or why it matters',
  '',
  '## Work done',
  '- results so far: deliverables presented (with ids and versions), commands run, checks passed or failed',
  '',
  '## Errors and fixes',
  '- problems met and how they were resolved',
  '',
  '## Open items',
  '- requested work not finished yet, and the next step',
  '',
  '## Key facts',
  '- decisions, constraints, user preferences, exact identifiers, numbers and paths needed to continue',
  '',
  'Rules:',
  '- Keep exact file paths, identifiers, numbers and error messages.',
  '- If the conversation starts with an earlier <conversation-summary>, merge it: keep what is still true, drop what is stale.',
  '- Write only the checkpoint. Do not mention this request and do not call tools.',
].join('\n')

/** How a history would be split. */
export interface CompactionPlan {
  /** Messages kept verbatim at the end (≥ 1); the kept part starts with a `user` message. */
  readonly keepMessages: number
  /** Messages folded into the summary (≥ 1). */
  readonly compactedMessages: number
}

/** Whether a message is a summary produced by an earlier compaction. Pure. */
export function isCompactionSummary(message: HistoryMessage): boolean {
  return message.role === 'user' && message.content.startsWith('<conversation-summary>\n')
}

/**
 * Indexes where a turn segment starts: the first of each run of consecutive
 * `user` messages (a turn's injections and its user message form one run).
 * A leading compaction summary is a segment of its own. Pure.
 */
export function segmentStarts(messages: readonly HistoryMessage[]): number[] {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role !== 'user') return
    const previous = messages[index - 1]
    if (previous === undefined || previous.role !== 'user' || (index === 1 && isCompactionSummary(previous))) starts.push(index)
  })
  return starts
}

/**
 * Choose the split: keep the last `keepRecentTurns` segments (the current turn
 * is the last one, so it is always kept whole); when that leaves nothing to
 * summarize, keep fewer, down to the current turn alone. `undefined` when no
 * split would summarize anything but an earlier summary on its own. Pure.
 */
export function planCompaction(messages: readonly HistoryMessage[], keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS): CompactionPlan | undefined {
  const starts = segmentStarts(messages)
  for (let keep = Math.max(1, keepRecentTurns); keep >= 1; keep--) {
    const cut = starts[starts.length - keep]
    if (cut === undefined || cut <= 0) continue
    const first = messages[0]
    if (cut === 1 && first !== undefined && isCompactionSummary(first)) continue
    return { keepMessages: messages.length - cut, compactedMessages: cut }
  }
  return undefined
}

/**
 * The history after a compaction, exactly as the session projection builds it:
 * the wrapped summary, then the last `keepMessages` messages unchanged. Pure.
 */
export function applyCompaction(messages: readonly HistoryMessage[], summary: string, keepMessages: number): HistoryMessage[] {
  if (!Number.isSafeInteger(keepMessages) || keepMessages < 1 || keepMessages > messages.length) {
    throw new NexgentError('internal', `keepMessages ${keepMessages} is out of range for ${messages.length} messages`)
  }
  return [{ role: 'user', content: renderCompactionSummary(summary) }, ...messages.slice(messages.length - keepMessages)]
}

/**
 * Render messages as a plain-text transcript for the summary request. Tool
 * arguments and results are clipped to `itemMaxChars`; `providerContent`
 * (thinking blocks) is never rendered. Pure.
 */
export function renderTranscript(messages: readonly HistoryMessage[], itemMaxChars = DEFAULT_TRANSCRIPT_ITEM_MAX_CHARS): string {
  const parts: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        parts.push(isCompactionSummary(message) ? message.content : `[user]\n${message.content}`)
        break
      case 'assistant':
        if (message.content !== '') parts.push(`[assistant]\n${message.content}`)
        for (const call of message.toolCalls ?? []) parts.push(`[assistant called ${call.name}]\n${clip(call.arguments, itemMaxChars)}`)
        break
      case 'tool':
        parts.push(`[${message.name} ${message.isError ? 'failed' : 'result'}]\n${clip(message.content, itemMaxChars)}`)
        break
    }
  }
  return parts.join('\n\n')
}

/** Resolve the threshold: the environment override wins over the configured value. */
export function resolveCompactionThreshold(configured: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[COMPACTION_THRESHOLD_ENV]
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new NexgentError('config/invalid', `${COMPACTION_THRESHOLD_ENV} must be a positive integer, got ${JSON.stringify(raw)}`)
    }
    return value
  }
  const value = configured ?? DEFAULT_COMPACTION_THRESHOLD
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new NexgentError('config/invalid', `compaction.thresholdTokens must be a positive integer, got ${String(value)}`)
  }
  return value
}

/** Request settings of the summary request, resolved per call (the project config may change between sessions). */
export interface SummaryRequestSettings {
  readonly thinking: ThinkingMode
  readonly effort?: Effort
}

/** Options of {@link BasicCompactor}. */
export interface BasicCompactorOptions {
  /** The model route (`ctx.llm`); a function is resolved at each compaction. */
  readonly llm: LLMProvider | (() => LLMProvider)
  /** Billed-input threshold; default {@link DEFAULT_COMPACTION_THRESHOLD}; {@link COMPACTION_THRESHOLD_ENV} overrides it. */
  readonly thresholdTokens?: number
  /** Turns kept verbatim; default {@link DEFAULT_KEEP_RECENT_TURNS}. */
  readonly keepRecentTurns?: number
  /** Output cap of the summary request. */
  readonly maxTokens?: number
  /** Thinking / effort of the summary request (the project's execution settings); default thinking `'on'` (ADR 0003). */
  readonly settings?: SummaryRequestSettings | (() => Promise<SummaryRequestSettings>)
  /** Whole-request deadline of the summary request in ms. */
  readonly timeoutMs?: number
  /** Per-item cap inside the transcript. */
  readonly transcriptItemMaxChars?: number
  /** Environment for the threshold override (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv
}

/** The {@link Compactor} of `@nexgent/context`. */
export class BasicCompactor implements Compactor {
  readonly thresholdTokens: number
  readonly keepRecentTurns: number
  private readonly options: BasicCompactorOptions

  constructor(options: BasicCompactorOptions) {
    this.options = options
    this.thresholdTokens = resolveCompactionThreshold(options.thresholdTokens, options.env)
    this.keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS
    if (!Number.isSafeInteger(this.keepRecentTurns) || this.keepRecentTurns < 1) {
      throw new NexgentError('config/invalid', `compaction.keepRecentTurns must be a positive integer, got ${String(this.keepRecentTurns)}`)
    }
  }

  /** Billed input of the latest request, when fully known. */
  private inputTokens(input: CompactionCheckInput): number | undefined {
    return input.lastUsage === undefined ? undefined : billedInputTokens(input.lastUsage)
  }

  shouldCompact(input: CompactionCheckInput): boolean {
    if (input.failedThisTurn) return false
    const tokens = this.inputTokens(input)
    if (tokens === undefined || tokens < this.thresholdTokens) return false
    return planCompaction(input.messages, this.keepRecentTurns) !== undefined
  }

  async compact(input: CompactionCheckInput, signal: AbortSignal): Promise<CompactionResult> {
    const plan = planCompaction(input.messages, this.keepRecentTurns)
    if (plan === undefined) throw new NexgentError('internal', 'nothing to compact: the history is the current turn only')
    const inputTokens = this.inputTokens(input) ?? 0
    const settings = typeof this.options.settings === 'function'
      ? await this.options.settings()
      : this.options.settings ?? { thinking: 'on' }
    const llm = typeof this.options.llm === 'function' ? this.options.llm() : this.options.llm
    const requestId = randomUUID()
    const transcript = renderTranscript(input.messages.slice(0, plan.compactedMessages), this.options.transcriptItemMaxChars)
    const stream = llm.complete(
      {
        requestId,
        model: input.model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\n${SUMMARY_INSTRUCTION}` },
        ],
        thinking: settings.thinking,
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
        maxTokens: this.options.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
        signal,
      },
      {
        sessionId: input.sessionId,
        purpose: 'auxiliary',
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
    )
    let text = ''
    let usage: LLMUsage = UNKNOWN_USAGE
    for await (const event of stream) {
      if (event.type === 'text.delta') text += event.text
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'error') {
        throw new NexgentError(event.error.code, `compaction request failed: ${event.error.message}`, { details: { requestId } })
      } else if (event.type === 'done') {
        if (event.finishReason === 'aborted') throw new NexgentError('llm/aborted', 'compaction request was aborted', { details: { requestId } })
        if (event.finishReason !== 'stop') {
          throw new NexgentError('llm/invalid-response', `compaction request ended with ${event.finishReason}; the summary is incomplete`, { details: { requestId } })
        }
      }
    }
    const summary = text.trim()
    if (summary === '') throw new NexgentError('llm/invalid-response', 'compaction request returned an empty summary', { details: { requestId } })
    return {
      summary,
      keepMessages: plan.keepMessages,
      compactedMessages: plan.compactedMessages,
      requestId,
      usage,
      trigger: { inputTokens, threshold: this.thresholdTokens },
    }
  }
}
