/**
 * Cordis plugin of `@nexgent/team` (profile row `@nexgent/team`).
 */
import type { AgentsService, Context, ContextService, SessionStore, TaskingService, Workspace } from '@nexgent/kernel'
import { capabilityPresetLookup } from '@nexgent/preset'
import { TeamRegistry } from './registry.js'
import { leadTools, teammateTools } from './tools.js'

/**
 * The plugin: whenever `ctx.tools`, `ctx.agents` and `ctx.session` are
 * available registers the Lead's team tools; whenever `ctx.context` is,
 * registers the mail provider. Disposal undoes both.
 */
export const TeamPlugin = {
  name: '@nexgent/team',
  apply(ctx: Context): void {
    ctx.inject(['tools', 'agents', 'session'], scope => {
      // See @nexgent/subagent: the `ctx.agents` augmentation may come from the kernel's sources.
      const agents: unknown = scope.agents
      const registry = new TeamRegistry({
        agents: agents as AgentsService,
        store: scope.session as SessionStore,
        projectRoot: () => (ctx.get('workspace') as Workspace).root,
        teammateTools,
        capabilities: capabilityPresetLookup(ctx),
      })
      for (const tool of leadTools({ team: id => registry.open(id, true), tasking: () => ctx.get('tasking') as TaskingService | undefined, capabilities: capabilityPresetLookup(ctx) })) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
      scope.inject(['context'], inner => {
        const service = inner.get('context') as ContextService
        inner.effect(() => service.register(registry.provider()), 'context.register(team-mail)')
      })
    })
  },
}

export const name = TeamPlugin.name
export const apply = TeamPlugin.apply
