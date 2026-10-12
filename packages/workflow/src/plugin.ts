/**
 * Cordis plugin of `@nexgent/workflow` (profile row `@nexgent/workflow`).
 */
import type { AgentsService, Context } from '@nexgent/kernel'
import { capabilityPresetLookup } from '@nexgent/preset'
import { validateCapabilityArchitecture, type ArchitectureComponentInput } from './capability-architecture.js'
import { agentsMemberRunner } from './runner.js'
import { workflowTool } from './tool.js'

/** The plugin: whenever `ctx.tools` and `ctx.agents` are available registers `workflow`; disposal unregisters it. */
export const WorkflowPlugin = {
  name: '@nexgent/workflow',
  apply(ctx: Context): void {
    ctx.inject(['tools', 'agents'], scope => {
      // As in @nexgent/subagent: the `ctx.agents` augmentation may come from the kernel's sources under the test type check.
      const agents: unknown = scope.agents
      const tool = workflowTool({ runner: agentsMemberRunner(agents as AgentsService, capabilityPresetLookup(ctx)) })
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
    })
    // Step 4: when `ctx.capabilities` is loaded, it checks architecture components with this package's compiler.
    ctx.inject(['capabilities' as never], scope => {
      const service = (scope as unknown as { get(name: string): unknown }).get('capabilities') as
        { registerValidator?: (kind: 'architecture', validator: (input: ArchitectureComponentInput) => void) => () => void } | undefined
      if (typeof service?.registerValidator === 'function') {
        scope.effect(() => service.registerValidator!('architecture', validateCapabilityArchitecture), 'capabilities.registerValidator(architecture)')
      }
    })
  },
}

export const name = WorkflowPlugin.name
export const apply = WorkflowPlugin.apply
