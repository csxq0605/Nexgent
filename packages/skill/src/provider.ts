/**
 * The skill-list context provider (`id: 'skills'`): the list of usable
 * skills, so the model knows when to call `load_skill`. It is not part of
 * the system prompt (it changes with the skills and would break the prompt
 * cache): a session's turn gets it as an injected message only when the
 * rendered list differs from the last one injected into that session
 * (after a process restart it is injected once more). Absent when there are
 * no skills. The provider also gives a resumed session its skill-gated tools
 * back.
 */
import type { ContextContribution, ContextProvider, SkillManifest, TurnContextInput } from '@nexgent/kernel'
import type { CapabilitySkillLookup, LayeredSkillRegistry } from './capability-skills.js'
import type { SkillToolGate } from './gating.js'

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
export function skillsProvider(registry: LayeredSkillRegistry, capabilitySkills?: CapabilitySkillLookup, gate?: SkillToolGate): ContextProvider {
  const lastInjected = new Map<string, string>()
  return {
    id: SKILLS_PROVIDER_ID,
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      const layers = capabilitySkills === undefined ? undefined : await capabilitySkills(input.sessionId)
      const { skills } = await registry.catalog(layers)
      await gate?.restore(input.sessionId, input.state.messages.length > 0, async name => skills.find(skill => skill.name === name)?.tools)
      if (skills.length === 0) return {}
      const text = `# Skills\n${renderSkillList(skills)}`
      if (lastInjected.get(input.sessionId) === text) return {}
      lastInjected.set(input.sessionId, text)
      return { inject: [text] }
    },
  }
}
