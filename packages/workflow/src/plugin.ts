/**
 * Cordis plugin of `@nexgent/workflow` (profile row `@nexgent/workflow`).
 */
import type { AgentsService, Context } from '@nexgent/kernel'
import { agentsMemberRunner } from './runner.js'
import { workflowTool } from './tool.js'

/** The plugin: whenever `ctx.tools` and `ctx.agents` are available registers `workflow`; disposal unregisters it. */
export const WorkflowPlugin = {
  name: '@nexgent/workflow',
  apply(ctx: Context): void {
    ctx.inject(['tools', 'agents'], scope => {
      // As in @nexgent/subagent: the `ctx.agents` augmentation may come from the kernel's sources under the test type check.
      const agents: unknown = scope.agents
      const tool = workflowTool({ runner: agentsMemberRunner(agents as AgentsService) })
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
    })
  },
}

export const name = WorkflowPlugin.name
export const apply = WorkflowPlugin.apply
