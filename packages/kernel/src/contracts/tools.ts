/**
 * The tool contract: what a tool declares, what it receives when called,
 * what it returns, how the registry exposes it, and how a scope narrows the
 * visible set.
 *
 * Tools are plain objects registered on `ctx.tools`. The registry obtained
 * through an agent's scoped Cordis context registers into that fiber, so a
 * tool (or restriction) added by a plugin disappears when the plugin or the
 * agent is disposed, and a tool registered from an agent's context is visible
 * only to that agent. Global registrations come from the root context.
 */
import type { ToolApprovalAsk } from './approvals.js'
import { NexgentError } from './errors.js'
import type { JsonSchema, JsonValue } from './json.js'
import type { SandboxMode, Workspace } from './workspace.js'

/** What a tool may do to the world; drives sandbox checks and approval defaults. */
export type ToolEffect = 'read' | 'write' | 'execute' | 'network'

/** When a human must confirm a call: never, when the sandbox mode would deny it (`ask`), or every time. */
export type ToolApproval = 'never' | 'ask' | 'always'

/** A tool as registered: model-facing schema plus host-facing policy facts. */
export interface ToolDefinition {
  /** Unique name, `^[a-z][a-z0-9_]*$`, as the model calls it. */
  readonly name: string
  /** What the tool does, for the model. */
  readonly description: string
  /** JSON Schema for the arguments object; validated before the handler runs. */
  readonly inputSchema: JsonSchema
  /** Every effect the tool can have; `bash` is `['execute', 'write', 'network']`, `read_file` is `['read']`. */
  readonly effects: readonly ToolEffect[]
  /** Approval policy; `permissions.md` says how `ask` interacts with sandbox modes. */
  readonly approval: ToolApproval
  /** Cooperative deadline in ms; the registry aborts `context.signal` when it passes. Absent means none. */
  readonly timeoutMs?: number
}

/** What a tool receives besides its parsed arguments. */
export interface ToolContext {
  /** Session the call belongs to. */
  readonly sessionId: string
  /** The {@link ToolCall.id} being executed. */
  readonly callId: string
  /** Turn number within the session. */
  readonly turn: number
  /** Workspace the tool operates in; paths resolve against its root. */
  readonly workspace: Workspace
  /** Sandbox mode in force for this call. */
  readonly sandboxMode: SandboxMode
  /** Fires on user cancel, timeout or shutdown; the handler must settle promptly after. */
  readonly signal: AbortSignal
  /** `true` when the loop already obtained approval for this call (an `ask` / `always` tool). */
  readonly approved: boolean
  /**
   * Raise an approval question for this one call (a sandbox `ask` the tool
   * discovers while running); resolves `true` when the call may proceed.
   * Tools never prompt by themselves; without a host responder this denies.
   */
  requestApproval(ask: ToolApprovalAsk): Promise<boolean>
}

/** What a handler returns; the loop wraps it into a `tool.result` record and a `tool` message. */
export interface ToolOutput {
  /** Model-facing text. */
  readonly content: string
  /** Whether the call failed; defaults to `false`. */
  readonly isError?: boolean
  /** Tool-private, JSON-safe presentation payload (e.g. a diff), persisted verbatim. */
  readonly meta?: JsonValue
}

/**
 * The function behind a tool. It receives already-validated arguments. It may
 * throw a {@link NexgentError}; the registry turns any throw into an
 * `isError` output so the model always gets a result.
 */
export type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolOutput>

/** A definition and its handler. */
export interface Tool {
  readonly definition: ToolDefinition
  readonly handler: ToolHandler
}

/**
 * Per-scope mask over the tools a scope inherits. Masks intersect: a tool is
 * visible only if every active mask admits it. A mask never hides tools the
 * same scope registered itself.
 */
export interface ToolRestriction {
  /** Names that stay visible; everything else inherited is hidden. */
  readonly allow?: readonly string[]
  /** Names hidden from this scope. */
  readonly deny?: readonly string[]
}

/** The `ctx.tools` service. Scope comes from the context it is reached through. */
export interface ToolRegistry {
  /**
   * Register a tool into the calling scope's fiber.
   * @throws `tool/invalid-input` when the name is already registered in that scope.
   * @returns the disposer that unregisters it.
   */
  register(tool: Tool): () => void
  /** Remove a tool registered in the calling scope; `false` when none matched. */
  unregister(name: string): boolean
  /** Every definition visible from the calling scope, after restrictions, in registration order. */
  list(): readonly ToolDefinition[]
  /** One visible tool by name, or `undefined`. */
  get(name: string): Tool | undefined
  /**
   * Narrow what the calling scope inherits. Must be called from a scoped
   * (agent) context; the root context throws because a global mask would
   * hide tools from every agent.
   * @returns the disposer that lifts this restriction.
   */
  restrict(restriction: ToolRestriction): () => void
}

/**
 * Validate an untrusted value as a {@link ToolRestriction} before it crosses
 * an execution boundary (a profile row, a workflow argument).
 * @throws `config/invalid` with the offending field when the shape is wrong.
 */
export function assertToolRestriction(value: unknown): asserts value is ToolRestriction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NexgentError('config/invalid', 'tool restriction must be an object')
  }
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter(key => key !== 'allow' && key !== 'deny')
  if (extra.length > 0) {
    throw new NexgentError('config/invalid', `tool restriction accepts only allow and deny, got ${extra.join(', ')}`)
  }
  if (record.allow === undefined && record.deny === undefined) {
    throw new NexgentError('config/invalid', 'tool restriction must declare allow and/or deny')
  }
  for (const key of ['allow', 'deny'] as const) {
    const names = record[key]
    if (names === undefined) continue
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new NexgentError('config/invalid', `tool restriction ${key} must be an array of strings`)
    }
  }
}

/**
 * Whether a tool name survives a set of restrictions, with intersection
 * semantics: every `allow` must contain it and no `deny` may contain it.
 * An empty set of restrictions admits everything.
 */
export function isToolAdmitted(name: string, restrictions: readonly ToolRestriction[]): boolean {
  for (const restriction of restrictions) {
    if (restriction.allow !== undefined && !restriction.allow.includes(name)) return false
    if (restriction.deny !== undefined && restriction.deny.includes(name)) return false
  }
  return true
}

/**
 * Fold several restrictions into one equivalent restriction. The result's
 * `allow` is the intersection of all `allow` lists (absent when none had
 * one) and its `deny` is the union of all `deny` lists (absent when none had
 * one). `isToolAdmitted(n, rs)` equals `isToolAdmitted(n, [intersectToolRestrictions(rs)])`.
 */
export function intersectToolRestrictions(restrictions: readonly ToolRestriction[]): ToolRestriction {
  let allow: Set<string> | undefined
  let deny: Set<string> | undefined
  for (const restriction of restrictions) {
    if (restriction.allow !== undefined) {
      const next = new Set(restriction.allow)
      allow = allow === undefined ? next : new Set([...allow].filter(name => next.has(name)))
    }
    if (restriction.deny !== undefined) {
      deny = new Set([...(deny ?? []), ...restriction.deny])
    }
  }
  return {
    ...(allow === undefined ? {} : { allow: [...allow].sort() }),
    ...(deny === undefined ? {} : { deny: [...deny].sort() }),
  }
}

/** Apply restrictions to a list of visible names, keeping order. */
export function filterToolNames(names: readonly string[], restrictions: readonly ToolRestriction[]): string[] {
  return names.filter(name => isToolAdmitted(name, restrictions))
}
