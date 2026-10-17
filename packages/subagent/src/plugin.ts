/**
 * Cordis plugin of `@nexgent/subagent` (profile row `@nexgent/subagent`).
 */
import type { AgentsService, Context, SessionStore, TaskingService } from '@nexgent/kernel'
import { capabilityPresetLookup } from '@nexgent/preset'
import { delegateTool } from './delegate-tool.js'

/** The plugin: whenever `ctx.tools` and `ctx.agents` are available registers `delegate`; disposal unregisters it. */
export const SubagentPlugin = {
  name: '@nexgent/subagent',
  apply(ctx: Context): void {
    ctx.inject(['tools', 'agents'], scope => {
      // The `ctx.agents` augmentation may come from the kernel's sources (the test type check compiles them),
      // which TypeScript treats as a different class from the declarations this package imports.
      const agents: unknown = scope.agents
      const tool = delegateTool({
        agents: agents as AgentsService,
        tasking: () => ctx.get('tasking') as TaskingService | undefined,
        session: () => ctx.get('session') as SessionStore | undefined,
        capabilities: capabilityPresetLookup(ctx),
      })
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
    })
  },
}

export const name = SubagentPlugin.name
export const apply = SubagentPlugin.apply
