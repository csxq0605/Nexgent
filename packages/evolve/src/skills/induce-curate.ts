/**
 * Layer-2 curation (ADR 0025): the host's deterministic decision on which
 * induced candidates enter the skill library. It fails closed and holds for
 * any task, with the same checks layer 1 uses for user-level entries:
 *
 * - Shape: name kebab-case (`LEARNED_SKILL_NAME_PATTERN`), at most
 *   `maxNameChars`; description 1–`maxDescriptionChars` characters without
 *   `<` or `>` (it is shown in a list); when_to_use and body within their
 *   limits; at most `maxCandidatesPerInduction` candidates.
 * - Names: not one of the agent's other skills; a learned skill's name only
 *   as its new version (`replaces` naming a version of that name in force).
 * - No values of the tasks (`findInstanceLiterals` against the group's
 *   messages, feedback and answers, without the project-constant exemption:
 *   the library is user-level), no file name or path of the project's tasks.
 * - No copied request: a body sharing `COPIED_REQUEST_CHARS` characters
 *   with a user message or feedback comment, or any field quoting a phrase
 *   of one. The description and when-to-use name the kind of work the
 *   tasks share, so they may echo the requests' wording.
 * - No duplicate: a description `DUPLICATE_SIMILARITY` similar to a learned
 *   skill in force (or to another candidate) that it does not replace.
 */
import {
  findInstanceLiterals,
  LEARNED_SKILL_NAME_PATTERN,
  SKILL_LIBRARY_LIMITS,
  type InstanceLiteralSource,
  type LearnedSkill,
  type SkillRejectionReason,
} from '@nexgent/kernel'
import { COPIED_REQUEST_CHARS, DUPLICATE_SIMILARITY, projectNames, quotedRequests } from '../learning/curate.js'
import { longestSharedRun, similarity } from '../learning/text.js'
import type { ProposedSkill } from './induce-prompt.js'

/** What curation knows. */
export interface InductionCurationContext {
  /** Learned skills in force. */
  readonly skills: readonly LearnedSkill[]
  /** Names of the agent's other skills. */
  readonly reservedNames: readonly string[]
  /** The group's texts: user messages, feedback comments, answers. */
  readonly sources: readonly InstanceLiteralSource[]
  /** User messages and feedback comments of the group. */
  readonly requests: readonly string[]
  /** User messages of all the project's tasks (file names that mean something only here). */
  readonly taskTexts: readonly string[]
}

/** The decision. */
export interface InductionCurationResult {
  readonly accepted: readonly ProposedSkill[]
  readonly rejected: readonly { readonly skill: ProposedSkill; readonly reason: SkillRejectionReason; readonly detail: string }[]
}

function chars(text: string): number {
  return [...text].length
}

/** Decide on the candidates (pure). */
export function curateInduction(proposed: readonly ProposedSkill[], ctx: InductionCurationContext): InductionCurationResult {
  const accepted: ProposedSkill[] = []
  const rejected: { skill: ProposedSkill; reason: SkillRejectionReason; detail: string }[] = []
  const reserved = new Set(ctx.reservedNames)
  const inForce = ctx.skills.filter(skill => skill.status !== 'retired')
  const check = (skill: ProposedSkill): { reason: SkillRejectionReason; detail: string } | undefined => {
    if (accepted.length >= SKILL_LIBRARY_LIMITS.maxCandidatesPerInduction) return { reason: 'too-many', detail: `at most ${SKILL_LIBRARY_LIMITS.maxCandidatesPerInduction} per induction` }
    if (!LEARNED_SKILL_NAME_PATTERN.test(skill.name) || skill.name.length > SKILL_LIBRARY_LIMITS.maxNameChars) return { reason: 'invalid-name', detail: `name ${JSON.stringify(skill.name)} is not kebab-case within ${SKILL_LIBRARY_LIMITS.maxNameChars} characters` }
    if (skill.description === '' || chars(skill.description) > SKILL_LIBRARY_LIMITS.maxDescriptionChars || /[<>]/.test(skill.description)) return { reason: 'too-long', detail: `description must be 1–${SKILL_LIBRARY_LIMITS.maxDescriptionChars} characters without < or >` }
    if (skill.whenToUse !== undefined && chars(skill.whenToUse) > SKILL_LIBRARY_LIMITS.maxWhenToUseChars) return { reason: 'too-long', detail: `when_to_use is longer than ${SKILL_LIBRARY_LIMITS.maxWhenToUseChars} characters` }
    if (skill.body === '' || chars(skill.body) > SKILL_LIBRARY_LIMITS.maxBodyChars) return { reason: 'too-long', detail: `body must be 1–${SKILL_LIBRARY_LIMITS.maxBodyChars} characters` }
    if (reserved.has(skill.name)) return { reason: 'name-taken', detail: `another skill is named ${skill.name}` }
    const replaced = skill.replaces === undefined ? undefined : inForce.find(other => other.id === skill.replaces)
    if (skill.replaces !== undefined && replaced === undefined) return { reason: 'unknown-replaces', detail: `no learned skill ${skill.replaces} in force` }
    if (replaced !== undefined && replaced.name !== skill.name) return { reason: 'name-taken', detail: `a new version keeps the name ${replaced.name}` }
    if (replaced === undefined && inForce.some(other => other.name === skill.name)) return { reason: 'name-taken', detail: `${skill.name} is a learned skill; give replaces to write its next version` }
    if (accepted.some(other => other.name === skill.name)) return { reason: 'name-taken', detail: 'two candidates share a name' }
    const texts = [skill.description, skill.whenToUse ?? '', skill.body]
    const hits = findInstanceLiterals(texts.map((text, index) => ({ path: ['description', 'when_to_use', 'body'][index]!, text })), ctx.sources, [])
    if (hits.length > 0) return { reason: 'instance-literal', detail: `carries values of the tasks: ${[...new Set(hits.map(hit => hit.value))].slice(0, 5).join(', ')}` }
    const names = [...new Set(texts.flatMap(text => projectNames(text, ctx.taskTexts)))]
    if (names.length > 0) return { reason: 'project-name', detail: `names files of this project: ${names.slice(0, 5).join(', ')}` }
    // The description and when-to-use name the kind of work, so they may echo the requests' wording; the body may not.
    if (ctx.requests.some(request => longestSharedRun(skill.body, request) >= COPIED_REQUEST_CHARS)) return { reason: 'copied-request', detail: `the body shares ${COPIED_REQUEST_CHARS}+ characters with a request` }
    for (const text of texts) {
      const quoted = quotedRequests(text, ctx.requests)
      if (quoted.length > 0) return { reason: 'copied-request', detail: `quotes ${quoted.slice(0, 3).join(', ')}` }
    }
    const describe = (s: { readonly description: string; readonly whenToUse?: string }) => `${s.description} ${s.whenToUse ?? ''}`
    const twin = [...inForce.filter(other => other.id !== replaced?.id), ...accepted].find(other => similarity(describe(skill), describe(other)) >= DUPLICATE_SIMILARITY)
    if (twin !== undefined) return { reason: 'duplicate', detail: `like ${'id' in twin ? (twin as LearnedSkill).id : twin.name}` }
    return undefined
  }
  for (const skill of proposed) {
    const failed = check(skill)
    if (failed === undefined) accepted.push(skill)
    else rejected.push({ skill, ...failed })
  }
  return { accepted, rejected }
}
