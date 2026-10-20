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
  type ToolEffect,
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

/**
 * Step 4: the names `functionToolName` gives a function module's functions
 * (`cap_<module>_<function>`; the module name may hold `-`, the function
 * name capitals), which the general rule would refuse. At most 64 characters.
 */
export const FUNCTION_TOOL_NAME_PATTERN = /^cap_[a-z][a-z0-9-]{0,63}_[a-zA-Z][a-zA-Z0-9_]{0,31}$/

/** Whether `name` may be registered: the contract rule, or a function module's tool name. */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name) || (name.length <= 64 && FUNCTION_TOOL_NAME_PATTERN.test(name))
}

interface Entry {
  readonly tool: Tool
  readonly scope: ToolScope | undefined
  readonly seq: number
}

/** The `ctx.tools` service. */
export class ToolRegistryService extends Service implements ToolRegistry {
  private readonly entries: Entry[] = []
  private readonly restrictions = new Map<ToolScope, ToolRestriction[]>()
  /** Step 3: a member scope also obeys the restrictions of the scope that started it. */
  private readonly parents = new Map<ToolScope, ToolScope>()
  /** Coordinator: effects a scope's tools may have (this scope only; members do not inherit it). */
  private readonly effectLimits = new Map<ToolScope, ReadonlySet<ToolEffect>>()
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
    if (!isValidToolName(definition.name)) {
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
    const masks = this.masks(scope)
    const own = new Set(this.entries.filter(entry => scope !== undefined && entry.scope === scope).map(entry => entry.tool.definition.name))
    const limit = scope === undefined ? undefined : this.effectLimits.get(scope)
    return this.entries
      .filter(entry => limit === undefined || entry.tool.definition.effects.every(effect => limit.has(effect)))
      .filter(entry => {
        if (entry.scope === scope && scope !== undefined) return true
        if (entry.scope !== undefined) return false
        return !own.has(entry.tool.definition.name) && isToolAdmitted(entry.tool.definition.name, masks)
      })
      .sort((a, b) => a.seq - b.seq)
  }

  /** Restrictions in force for a scope: its own and those of the scopes it inherits from. */
  private masks(scope: ToolScope | undefined): ToolRestriction[] {
    const masks: ToolRestriction[] = []
    const seen = new Set<ToolScope>()
    for (let current = scope; current !== undefined && !seen.has(current); current = this.parents.get(current)) {
      seen.add(current)
      masks.push(...(this.restrictions.get(current) ?? []))
    }
    return masks
  }

  /**
   * Step 3 (not part of the `ToolRegistry` contract): make the calling
   * (member) scope obey every restriction of `parent`, now and later, so a
   * member sees at most what its parent sees among inherited tools. Agent
   * scopes' own tools stay private either way.
   * @returns the disposer that unlinks the scopes.
   */
  inherit(parent: ToolScope): () => void {
    const scope = this.scope
    if (scope === undefined) throw new NexgentError('config/invalid', 'only a scoped (agent) context can inherit restrictions')
    if (scope === parent) throw new NexgentError('config/invalid', 'a scope cannot inherit from itself')
    return this.ctx.fiber.effect(() => {
      this.parents.set(scope, parent)
      return () => {
        if (this.parents.get(scope) === parent) this.parents.delete(scope)
      }
    }, 'ctx.tools.inherit()')
  }

  list(): readonly ToolDefinition[] {
    return this.visible(this.scope).map(entry => entry.tool.definition)
  }

  get(name: string): Tool | undefined {
    return this.visible(this.scope).find(entry => entry.tool.definition.name === name)?.tool
  }

  /**
   * Coordinator (not part of the `ToolRegistry` contract): the calling scope
   * sees only tools whose every effect is in `effects`, its own tools
   * included. Unlike {@link restrict}, member scopes that inherit from it are
   * not limited.
   * @returns the disposer.
   */
  limitEffects(effects: readonly ToolEffect[]): () => void {
    const scope = this.scope
    if (scope === undefined) throw new NexgentError('config/invalid', 'an effect limit needs a scoped (agent) context')
    const limit: ReadonlySet<ToolEffect> = new Set(effects)
    return this.ctx.fiber.effect(() => {
      this.effectLimits.set(scope, limit)
      return () => {
        if (this.effectLimits.get(scope) === limit) this.effectLimits.delete(scope)
      }
    }, 'ctx.tools.limitEffects()')
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
