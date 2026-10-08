// Adapted from deepseek-harness@46a7f68b packages/core/tools/src (scoped registry design) and packages/core/scope/src/index.ts (MIT)
/**
 * `ctx.tools`: the {@link ToolRegistry} service.
 *
 * Scope comes from the context the registry is reached through. A context
 * carrying a {@link ToolScope} under {@link TOOL_SCOPE} (every agent's
 * context does) registers agent-private tools and may restrict what it
 * inherits; any other context registers global tools. Every registration and
 * restriction is a Cordis effect of the caller's fiber, so it disappears
 * when the registering plugin or agent is disposed.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { NexgentError } from './contracts/errors.js'
import {
  assertToolRestriction,
  isToolAdmitted,
  type Tool,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRestriction,
} from './contracts/tools.js'

/** Context key of the tool scope an agent context carries. */
export const TOOL_SCOPE: unique symbol = Symbol.for('nexgent.tools.scope')

/** Identity of one agent's tool scope. */
export interface ToolScope {
  /** Display id, e.g. the session id. */
  readonly id: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    [TOOL_SCOPE]?: ToolScope
  }
}

/** Tool name rule from the contract. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

interface Entry {
  readonly tool: Tool
  readonly scope: ToolScope | undefined
  readonly seq: number
}

/** The `ctx.tools` service. */
export class ToolRegistryService extends Service implements ToolRegistry {
  private readonly entries: Entry[] = []
  private readonly restrictions = new Map<ToolScope, ToolRestriction[]>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** The scope of the calling context (`this.ctx` is the caller's context under Cordis tracing). */
  private get scope(): ToolScope | undefined {
    return this.ctx[TOOL_SCOPE]
  }

  register(tool: Tool): () => void {
    const definition = tool.definition
    if (!TOOL_NAME_PATTERN.test(definition.name)) {
      throw new NexgentError('tool/invalid-input', `invalid tool name "${definition.name}"`)
    }
    const scope = this.scope
    if (this.entries.some(entry => entry.scope === scope && entry.tool.definition.name === definition.name)) {
      throw new NexgentError('tool/invalid-input', `tool "${definition.name}" is already registered in this scope`)
    }
    const entry: Entry = { tool, scope, seq: ++this.seq }
    return this.ctx.fiber.effect(() => {
      this.entries.push(entry)
      return () => {
        const index = this.entries.indexOf(entry)
        if (index >= 0) this.entries.splice(index, 1)
      }
    }, `ctx.tools.register(${JSON.stringify(definition.name)})`)
  }

  unregister(name: string): boolean {
    const scope = this.scope
    const index = this.entries.findIndex(entry => entry.scope === scope && entry.tool.definition.name === name)
    if (index < 0) return false
    this.entries.splice(index, 1)
    return true
  }

  /** Visible entries for a scope: its own tools shadow inherited ones of the same name. */
  private visible(scope: ToolScope | undefined): Entry[] {
    const masks = scope === undefined ? [] : (this.restrictions.get(scope) ?? [])
    const own = new Set(this.entries.filter(entry => scope !== undefined && entry.scope === scope).map(entry => entry.tool.definition.name))
    return this.entries
      .filter(entry => {
        if (entry.scope === scope && scope !== undefined) return true
        if (entry.scope !== undefined) return false
        return !own.has(entry.tool.definition.name) && isToolAdmitted(entry.tool.definition.name, masks)
      })
      .sort((a, b) => a.seq - b.seq)
  }

  list(): readonly ToolDefinition[] {
    return this.visible(this.scope).map(entry => entry.tool.definition)
  }

  get(name: string): Tool | undefined {
    return this.visible(this.scope).find(entry => entry.tool.definition.name === name)?.tool
  }

  restrict(restriction: ToolRestriction): () => void {
    assertToolRestriction(restriction)
    const scope = this.scope
    if (scope === undefined) {
      throw new NexgentError('config/invalid', 'tool restrictions need a scoped (agent) context; the root context would mask every agent')
    }
    const frozen: ToolRestriction = {
      ...(restriction.allow === undefined ? {} : { allow: [...restriction.allow] }),
      ...(restriction.deny === undefined ? {} : { deny: [...restriction.deny] }),
    }
    return this.ctx.fiber.effect(() => {
      const list = this.restrictions.get(scope) ?? []
      list.push(frozen)
      this.restrictions.set(scope, list)
      return () => {
        const current = this.restrictions.get(scope) ?? []
        const index = current.indexOf(frozen)
        if (index >= 0) current.splice(index, 1)
        if (current.length === 0) this.restrictions.delete(scope)
      }
    }, 'ctx.tools.restrict()')
  }
}
