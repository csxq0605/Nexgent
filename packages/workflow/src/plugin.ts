/**
 * Cordis plugin of `@nexgent/workflow` (profile row `@nexgent/workflow`).
 */
import type { AgentsService, Context, LLMProvider, OrganizationMemory } from '@nexgent/kernel'
import { capabilityPresetLookup } from '@nexgent/preset'
import { validateCapabilityArchitecture, type ArchitectureComponentInput } from './capability-architecture.js'
import { agentsMemberRunner } from './runner.js'
import { workflowTool } from './tool.js'
import { defaultOrganizer, organizeTool, type DefaultOrganizerOptions } from './organize.js'

/** Plugin config: options of the default organizer (tests fix its control draw). */
export interface WorkflowPluginConfig {
  readonly organizer?: DefaultOrganizerOptions
}

/** The plugin: whenever `ctx.tools` and `ctx.agents` are available registers `workflow`; disposal unregisters it. */
export const WorkflowPlugin = {
  name: '@nexgent/workflow',
  apply(ctx: Context, config: WorkflowPluginConfig = {}): void {
    ctx.inject(['tools', 'agents'], scope => {
      // As in @nexgent/subagent: the `ctx.agents` augmentation may come from the kernel's sources under the test type check.
      const agents: unknown = scope.agents
      const runner = agentsMemberRunner(agents as AgentsService, capabilityPresetLookup(ctx))
      const tool = workflowTool({ runner })
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      // New direction step 2: one entry point for organizing members.
      const organize = organizeTool({ runner, agent: sessionId => (agents as AgentsService).get(sessionId) })
      scope.effect(() => scope.tools.register(organize), `tools.register(${organize.definition.name})`)
    })
    // New direction step 2: whether members help with a root turn.
    // Step 3: with `ctx.organizations` (the user's organization library, `@nexgent/capabilities`), what worked on similar tasks decides.
    const memory = () => (ctx as unknown as { get(name: string): unknown }).get('organizations') as OrganizationMemory | undefined
    // Coordinator: the organization profile prices each part with the model's own prices when `ctx.llm` knows them.
    const costOf: DefaultOrganizerOptions['costOf'] = (usage, model) => {
      const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as Pick<LLMProvider, 'estimateUsd'> | undefined
      const usd = model === undefined ? undefined : llm?.estimateUsd?.(model, usage)
      return typeof usd === 'number' ? usd : undefined
    }
    ctx.provide('organizer', defaultOrganizer({ memory, costOf, ...(config?.organizer ?? {}) }))
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
