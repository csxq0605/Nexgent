/**
 * The context provider of `@nexgent/capabilities` (id `capabilities`). At
 * the start of every turn it makes sure the session's function-module and
 * plugin tools are registered in its scope (so a session opened on an
 * adopted bundle gets them before its first request), and renders the
 * text-only components in force: the context policy's `instructions` (and
 * `personaSuffix`) as `# Learned practices`, team templates as
 * `# Team templates`, presets and workflow graphs as `# Learned
 * collaboration` (the collaboration tools take a preset by name and a graph
 * inline; the `workflow` tool cannot name a stored graph). A component that
 * fails to attach is named in `# Capability problems` instead of failing
 * the turn.
 */
import { readFile } from 'node:fs/promises'
import type { ContextContribution, ContextProvider, SystemPromptSection, TeamTemplateSpec, TurnContextInput } from '@nexgent/kernel'
import type { ActiveComponent, CapabilityService } from './service.js'

async function collaborationLines(components: readonly ActiveComponent[]): Promise<string[]> {
  const lines: string[] = []
  for (const component of components) {
    if (component.kind !== 'preset' && component.kind !== 'architecture') continue
    let value: { readonly description?: unknown; readonly architecture?: unknown }
    try {
      value = JSON.parse(await readFile(component.entryPath, 'utf8')) as typeof value
    } catch {
      continue
    }
    if (component.kind === 'preset') {
      const description = value.description
      lines.push(`- preset ${component.name}: ${typeof description === 'string' ? description : ''} (pass "preset": "${component.name}" to delegate, spawn_teammate or a workflow node)`)
    } else {
      const graph = JSON.stringify(value.architecture)
      lines.push(`- workflow graph ${component.name} (pass it as "graph" to workflow, adapting the prompts to the task): ${graph}`)
    }
  }
  return lines
}

function renderTemplate(spec: TeamTemplateSpec): string {
  const members = spec.members.map(member => `  - ${member.name}${member.preset === undefined ? '' : ` (preset ${member.preset})`}: ${member.task}`)
  return [`- ${spec.name}: ${spec.description}`, ...members].join('\n')
}

/** The `setSessionOverride` of `@nexgent/context`'s compactor, when present. */
export type CompactionOverrideSink = (sessionId: string, override: { readonly thresholdTokens?: number; readonly keepRecentTurns?: number } | undefined) => void

/**
 * Build the provider.
 * @param compaction - applies a context policy's `compaction` to the session (from the next compaction check on).
 */
export function capabilitiesProvider(service: CapabilityService, compaction?: () => CompactionOverrideSink | undefined): ContextProvider {
  return {
    id: 'capabilities',
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      const sections: SystemPromptSection[] = []
      try {
        await service.attach(input.sessionId)
      } catch (error) {
        sections.push({ id: 'capabilities-problems', title: 'Capability problems', body: `Some learned tools could not be loaded in this session: ${(error as Error).message}` })
      }
      const components = await service.components(input.sessionId)
      const policy = components.find(component => component.spec.kind === 'context-policy')
      compaction?.()?.(input.sessionId, policy?.spec.kind === 'context-policy' ? policy.spec.spec.compaction : undefined)
      for (const component of components) {
        if (component.spec.kind !== 'context-policy') continue
        const parts = [component.spec.spec.instructions, component.spec.spec.personaSuffix].filter((part): part is string => part !== undefined && part.trim() !== '')
        if (parts.length > 0) sections.push({ id: 'capabilities-practices', title: 'Learned practices', body: parts.join('\n\n') })
      }
      const templates = components.flatMap(component => (component.spec.kind === 'team-template' ? [component.spec.spec] : []))
      if (templates.length > 0) {
        sections.push({
          id: 'capabilities-team-templates',
          title: 'Team templates',
          body: `Line-ups that worked before; start the teammates yourself with spawn_teammate when a task fits.\n${templates.map(renderTemplate).join('\n')}`,
        })
      }
      const collaboration = await collaborationLines(components)
      if (collaboration.length > 0) {
        sections.push({ id: 'capabilities-collaboration', title: 'Learned collaboration', body: `Presets and workflow graphs that worked before:\n${collaboration.join('\n')}` })
      }
      return sections.length === 0 ? {} : { systemSections: sections }
    },
  }
}
