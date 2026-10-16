/**
 * The context contract (step 2): what is added to a request besides the
 * stored history, and how long histories are compacted.
 *
 * `@nexgent/context` implements the workspace-instructions provider, the
 * material-reference provider and the compactor; `@nexgent/tasking` adds a
 * goal provider and `@nexgent/skill` a skill-list provider. The kernel loop
 * calls them at the points `docs/spec/agent-hooks.md` fixes.
 */
import type { LLMMessage, LLMUsage } from './llm.js'
import type { SessionState, UserMessageSource } from './session.js'

/** A titled block appended to the system prompt. */
export interface SystemPromptSection {
  /** Stable id; sections are ordered by provider order, then by id. */
  readonly id: string
  /** Rendered as a `# <title>` heading. */
  readonly title: string
  readonly body: string
}

/** What the loop tells providers at the start of a turn. */
export interface TurnContextInput {
  readonly sessionId: string
  readonly turn: number
  /** Absolute project root. */
  readonly projectRoot: string
  /** The user's text for this turn (already recorded or about to be). */
  readonly text: string
  readonly source: Exclude<UserMessageSource, 'inject'>
  /** Material ids attached to this turn's message. */
  readonly materialIds: readonly string[]
  /** State as of the turn's start (history before this turn). */
  readonly state: SessionState
  readonly signal: AbortSignal
}

/**
 * One provider's contribution for a turn. `systemSections` are rendered into
 * the system prompt of every request of the turn and never stored (so the
 * prompt prefix stays byte-stable within the turn); `inject` texts are stored
 * as `user.message { source: 'inject' }` records right before the turn's own
 * user message and so are replayed on resume.
 */
export interface ContextContribution {
  readonly systemSections?: readonly SystemPromptSection[]
  readonly inject?: readonly string[]
}

/** A source of per-turn context. A provider that throws is skipped for that turn and an `error` record (non-fatal) is written. */
export interface ContextProvider {
  /** Unique id, e.g. `workspace-instructions`, `materials`, `goal`, `skills`. */
  readonly id: string
  beginTurn(input: TurnContextInput): Promise<ContextContribution>
}

/** What the loop hands to the compactor before every model call. */
export interface CompactionCheckInput {
  readonly sessionId: string
  readonly turn: number
  /** The step about to run. */
  readonly step: number
  readonly model: string
  /** History as it would be sent (no system message). */
  readonly messages: readonly Exclude<LLMMessage, { role: 'system' }>[]
  /** Usage of the latest request of this session, when known; the trigger reads its input size. */
  readonly lastUsage?: LLMUsage
  /** Whether a compaction already failed in this turn (the loop then skips further attempts). */
  readonly failedThisTurn: boolean
}

/** A successful compaction, before it is recorded. */
export interface CompactionResult {
  readonly summary: string
  /** Messages kept (≥ 1); the kept tail starts with a `user` message or a reply of the current turn, never a tool result (`compactionTail`). */
  readonly keepMessages: number
  readonly compactedMessages: number
  /** The auxiliary request that produced the summary (purpose `auxiliary` in the ledger). */
  readonly requestId: string
  readonly usage: LLMUsage
  readonly trigger: { readonly inputTokens: number; readonly threshold: number }
}

/**
 * Decides when and how to compact (`ctx.context.compactor`). `compact` may
 * fail (it then rejects); the loop writes a non-fatal `error` record, keeps
 * the uncompacted history and does not try again in the same turn, except
 * once when a request fails because the prompt exceeds the context window:
 * the loop then calls `compact` directly, without `shouldCompact` (ADR 0021).
 */
export interface Compactor {
  /** Cheap, synchronous check. */
  shouldCompact(input: CompactionCheckInput): boolean
  compact(input: CompactionCheckInput, signal: AbortSignal): Promise<CompactionResult>
}

/** Billed input of a usage record (`input + cacheRead + cacheWrite`), or `undefined` when any part is unknown. Pure. */
export function billedInputTokens(usage: LLMUsage): number | undefined {
  const parts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
  let total = 0
  for (const part of parts) {
    if (part === 'unknown') return undefined
    total += part
  }
  return total
}

/** The `ctx.context` service. */
export interface ContextService {
  /** Providers in call order. */
  readonly providers: readonly ContextProvider[]
  /** Add a provider (other packages register theirs); returns the disposer. */
  register(provider: ContextProvider): () => void
  readonly compactor?: Compactor
}
