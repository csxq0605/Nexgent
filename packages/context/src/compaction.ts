/**
 * The basic compactor (`ctx.context.compactor`): when the estimated input of
 * the next request reaches a threshold, older history is summarized by one
 * auxiliary model request and replaced by the summary; the most recent turns
 * stay verbatim. When the current turn alone is too large (a long run of tool
 * calls), its earlier steps are summarized too and its request is carried
 * verbatim in the summary (ADR 0021). Record format and resume semantics:
 * `docs/spec/data-formats.md` §压缩; trigger: `agent-hooks.md` §压缩.
 *
 * Thinking blocks: the summary request is built from a plain-text transcript,
 * so no `providerContent` (thinking blocks and their signatures) of a
 * summarized reply is sent anywhere; after the `compaction` record kept
 * replies are replayed as text and tool calls only (`compactionTail`).
 */
import { randomUUID } from 'node:crypto'
import {
  billedInputTokens,
  compactionTail,
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

/** Default output cap of the summary request (room for adaptive thinking plus the summary). */
export const DEFAULT_SUMMARY_MAX_TOKENS = 32_000

/** Share of the threshold the kept messages may take before the current turn is split too. */
export const DEFAULT_KEEP_SHARE = 0.3

/** The kept messages may always take this many tokens; below it the current turn is never split. */
export const MIN_KEEP_BUDGET_TOKENS = 20_000

/** Share of the model's context window the threshold never exceeds. */
export const WINDOW_THRESHOLD_SHARE = 0.75

/** Default total character budget of the summary transcript. */
export const DEFAULT_TRANSCRIPT_MAX_CHARS = 400_000

/** Characters per token in size estimates; low on purpose (code and CJK text tokenize densely). */
export const ESTIMATE_CHARS_PER_TOKEN = 3

/** Cap on the verbatim current request carried in a summary that split the turn. */
export const CURRENT_REQUEST_MAX_CHARS = 20_000

/**
 * The context window of a model id, in tokens. Current Claude models have
 * 1M; older or unknown ids get 200K, the smallest window a supported model
 * has. Pure.
 */
export function contextWindowOf(model: string): number {
  return /^claude-(?:fable|mythos|haiku-5|sonnet-5|opus-5|opus-4-[6-9]|sonnet-4-[6-9])(?:$|[-.])/.test(model) ? 1_000_000 : 200_000
}

/** Rough token count of messages as sent (reply blocks, text, tool input and results). Pure. */
export function estimateTokens(messages: readonly HistoryMessage[]): number {
  let chars = 0
  for (const message of messages) {
    if (message.role === 'assistant' && message.providerContent !== undefined) {
      chars += JSON.stringify(message.providerContent).length
      continue
    }
    chars += message.content.length
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) chars += call.arguments.length + call.name.length
  }
  return Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN)
}

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
  /** Messages kept at the end (≥ 1); the kept part starts with a `user` message, or with a reply when the turn is split. */
  readonly keepMessages: number
  /** Messages folded into the summary (≥ 1). */
  readonly compactedMessages: number
  /** Set when the current turn is split: index of its first message (its request, carried verbatim in the summary). */
  readonly currentTurnStart?: number
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
 * is the last one); when that leaves nothing to summarize, keep fewer, down to
 * the current turn alone. With `keepBudgetTokens`, when the kept part is
 * still larger than that estimate, the current turn is split as well: the
 * kept part then starts at the earliest reply of the turn whose suffix fits
 * the budget (at least the turn's last reply and its tool results stay).
 * `undefined` when no split would summarize anything but an earlier summary
 * on its own. Pure.
 */
export function planCompaction(messages: readonly HistoryMessage[], keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS, keepBudgetTokens?: number): CompactionPlan | undefined {
  const starts = segmentStarts(messages)
  let plan: CompactionPlan | undefined
  for (let keep = Math.max(1, keepRecentTurns); keep >= 1; keep--) {
    const cut = starts[starts.length - keep]
    if (cut === undefined || cut <= 0) continue
    const first = messages[0]
    if (cut === 1 && first !== undefined && isCompactionSummary(first)) continue
    plan = { keepMessages: messages.length - cut, compactedMessages: cut }
    break
  }
  const turnStart = starts.at(-1)
  if (keepBudgetTokens === undefined || turnStart === undefined) return plan
  const keptFrom = plan === undefined ? turnStart : messages.length - plan.keepMessages
  if (estimateTokens(messages.slice(keptFrom)) <= keepBudgetTokens) return plan
  const replies: number[] = []
  for (let index = turnStart + 1; index < messages.length; index++) {
    if (messages[index]!.role === 'assistant') replies.push(index)
  }
  if (replies.length === 0) return plan
  const cut = replies.find(index => estimateTokens(messages.slice(index)) <= keepBudgetTokens) ?? replies.at(-1)!
  return { keepMessages: messages.length - cut, compactedMessages: cut, currentTurnStart: turnStart }
}

/** The current turn's request as sent: its leading run of `user` messages (injected context included). Pure. */
export function currentRequestText(messages: readonly HistoryMessage[], turnStart: number): string {
  const parts: string[] = []
  for (let index = turnStart; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== 'user') break
    if (!isCompactionSummary(message)) parts.push(message.content)
  }
  return clip(parts.join('\n\n'), CURRENT_REQUEST_MAX_CHARS)
}

/**
 * The history after a compaction, exactly as the session projection builds it:
 * the wrapped summary, then `compactionTail` (the last `keepMessages` messages, replies without their provider content). Pure.
 */
export function applyCompaction(messages: readonly HistoryMessage[], summary: string, keepMessages: number): HistoryMessage[] {
  if (!Number.isSafeInteger(keepMessages) || keepMessages < 1 || keepMessages > messages.length) {
    throw new NexgentError('internal', `keepMessages ${keepMessages} is out of range for ${messages.length} messages`)
  }
  return [{ role: 'user', content: renderCompactionSummary(summary) }, ...compactionTail(messages, keepMessages)]
}

/**
 * Render messages as a plain-text transcript for the summary request. Tool
 * arguments and results are clipped to `itemMaxChars`; `providerContent`
 * (thinking blocks) is never rendered. When the result is longer than
 * `totalMaxChars`, the per-item cap is halved (down to 500) and, if that is
 * not enough, the middle of the transcript is cut. Pure.
 */
export function renderTranscript(messages: readonly HistoryMessage[], itemMaxChars = DEFAULT_TRANSCRIPT_ITEM_MAX_CHARS, totalMaxChars = DEFAULT_TRANSCRIPT_MAX_CHARS): string {
  let cap = itemMaxChars
  let text = renderItems(messages, cap)
  while (text.length > totalMaxChars && cap > 500) {
    cap = Math.max(500, Math.floor(cap / 2))
    text = renderItems(messages, cap)
  }
  if (text.length <= totalMaxChars) return text
  const head = Math.floor(totalMaxChars * 0.25)
  const tail = totalMaxChars - head
  return `${text.slice(0, head)}\n\n[… ${text.length - totalMaxChars} characters of the conversation omitted …]\n\n${text.slice(text.length - tail)}`
}

function renderItems(messages: readonly HistoryMessage[], itemMaxChars: number): string {
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
  /** Total cap of the transcript; default {@link DEFAULT_TRANSCRIPT_MAX_CHARS}. */
  readonly transcriptMaxChars?: number
  /** Environment for the threshold override (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv
}

/** Per-session compaction settings from a capability context policy (step 4, `ContextPolicySpec.compaction`). */
export interface CompactionOverride {
  readonly thresholdTokens?: number
  readonly keepRecentTurns?: number
}

/** The {@link Compactor} of `@nexgent/context`. */
export class BasicCompactor implements Compactor {
  readonly thresholdTokens: number
  readonly keepRecentTurns: number
  private readonly options: BasicCompactorOptions
  private readonly overrides = new Map<string, CompactionOverride>()

  constructor(options: BasicCompactorOptions) {
    this.options = options
    this.thresholdTokens = resolveCompactionThreshold(options.thresholdTokens, options.env)
    this.keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS
    if (!Number.isSafeInteger(this.keepRecentTurns) || this.keepRecentTurns < 1) {
      throw new NexgentError('config/invalid', `compaction.keepRecentTurns must be a positive integer, got ${String(this.keepRecentTurns)}`)
    }
  }

  /**
   * Replace the threshold / kept turns for one session (`@nexgent/capabilities`
   * sets it at each turn from the session's context policy); `undefined` clears it.
   * Values outside the contract ranges are ignored.
   */
  setSessionOverride(sessionId: string, override: CompactionOverride | undefined): void {
    const threshold = override?.thresholdTokens
    const keep = override?.keepRecentTurns
    const valid: CompactionOverride = {
      ...(Number.isSafeInteger(threshold) && threshold! >= 10_000 && threshold! <= 1_000_000 ? { thresholdTokens: threshold! } : {}),
      ...(Number.isSafeInteger(keep) && keep! >= 1 && keep! <= 10 ? { keepRecentTurns: keep! } : {}),
    }
    if (Object.keys(valid).length === 0) this.overrides.delete(sessionId)
    else this.overrides.set(sessionId, valid)
  }

  /** The session's threshold, never above {@link WINDOW_THRESHOLD_SHARE} of the model's context window. */
  private threshold(sessionId: string, model: string): number {
    const configured = this.overrides.get(sessionId)?.thresholdTokens ?? this.thresholdTokens
    return Math.min(configured, Math.floor(contextWindowOf(model) * WINDOW_THRESHOLD_SHARE))
  }

  private keepBudget(input: CompactionCheckInput): number {
    return Math.max(MIN_KEEP_BUDGET_TOKENS, Math.floor(this.threshold(input.sessionId, input.model) * DEFAULT_KEEP_SHARE))
  }

  private keep(sessionId: string): number {
    return this.overrides.get(sessionId)?.keepRecentTurns ?? this.keepRecentTurns
  }

  /**
   * Estimated input of the next request: the latest request's billed input
   * plus its output and the messages added after its reply (tool results,
   * injected context); the whole history's estimate when no usage is known
   * (after a resume or a compaction).
   */
  private inputTokens(input: CompactionCheckInput): number {
    const billed = input.lastUsage === undefined ? undefined : billedInputTokens(input.lastUsage)
    if (billed === undefined) return estimateTokens(input.messages)
    let lastReply = input.messages.length - 1
    while (lastReply >= 0 && input.messages[lastReply]!.role !== 'assistant') lastReply--
    const output = typeof input.lastUsage?.outputTokens === 'number' ? input.lastUsage.outputTokens : 0
    return billed + output + estimateTokens(input.messages.slice(lastReply + 1))
  }

  shouldCompact(input: CompactionCheckInput): boolean {
    if (input.failedThisTurn) return false
    if (this.inputTokens(input) < this.threshold(input.sessionId, input.model)) return false
    return planCompaction(input.messages, this.keep(input.sessionId), this.keepBudget(input)) !== undefined
  }

  async compact(input: CompactionCheckInput, signal: AbortSignal): Promise<CompactionResult> {
    const plan = planCompaction(input.messages, this.keep(input.sessionId), this.keepBudget(input))
    if (plan === undefined) throw new NexgentError('internal', 'nothing to compact: the history is the current turn only')
    const inputTokens = this.inputTokens(input)
    const settings = typeof this.options.settings === 'function'
      ? await this.options.settings()
      : this.options.settings ?? { thinking: 'on' }
    const llm = typeof this.options.llm === 'function' ? this.options.llm() : this.options.llm
    const requestId = randomUUID()
    const transcript = renderTranscript(input.messages.slice(0, plan.compactedMessages), this.options.transcriptItemMaxChars, this.options.transcriptMaxChars)
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
    const written = text.trim()
    if (written === '') throw new NexgentError('llm/invalid-response', 'compaction request returned an empty summary', { details: { requestId } })
    // A split turn keeps going after the summary: its request must survive word for word.
    const summary = plan.currentTurnStart === undefined
      ? written
      : `${written}\n\n## Current request (verbatim; the work on it continues below)\n${currentRequestText(input.messages, plan.currentTurnStart)}`
    return {
      summary,
      keepMessages: plan.keepMessages,
      compactedMessages: plan.compactedMessages,
      requestId,
      usage,
      trigger: { inputTokens, threshold: this.threshold(input.sessionId, input.model) },
    }
  }
}
