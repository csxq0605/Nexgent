/**
 * The skill-list context provider (`id: 'skills'`): a `# Skills` system
 * section naming each usable skill, so the model knows when to call
 * `load_skill`. Absent when there are no skills.
 */
import type { ContextContribution, ContextProvider, SkillManifest, TurnContextInput } from '@nexgent/kernel'
import type { CapabilitySkillLookup, LayeredSkillRegistry } from './capability-skills.js'

/** Provider id (fixed call order: after `goal`, before `materials`). */
export const SKILLS_PROVIDER_ID = 'skills'

/** Render the section body. Pure. */
export function renderSkillList(skills: readonly SkillManifest[]): string {
  const lines = [
    'Skills are instructions for particular kinds of work. When the task matches a skill, call load_skill with its name and follow the instructions it returns.',
    '',
  ]
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}${skill.whenToUse === undefined ? '' : ` Use when: ${skill.whenToUse}`}`)
  }
  return lines.join('\n')
}

/** The skills {@link ContextProvider} over a registry. */
export function skillsProvider(registry: LayeredSkillRegistry, capabilitySkills?: CapabilitySkillLookup): ContextProvider {
  return {
    id: SKILLS_PROVIDER_ID,
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      const layers = capabilitySkills === undefined ? undefined : await capabilitySkills(input.sessionId)
      const { skills } = await registry.catalog(layers)
      if (skills.length === 0) return {}
      return { systemSections: [{ id: 'skills', title: 'Skills', body: renderSkillList(skills) }] }
    },
  }
}
