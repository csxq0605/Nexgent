/**
 * The layer-2 induction request (ADR 0025): one model request that reads a
 * group of similar successful tasks and may propose up to two skills.
 * Adapted from what the compared systems do (design notes,
 * `evolution-layer2-3-design.md` §1): AWM's placeholders for task values,
 * Voyager's and skill-creator's description that says when the skill
 * applies, SkillWeaver's rewrite as a new version instead of an in-place
 * edit, and GEPA's reflective dataset (inputs, what was done, feedback).
 * The prompt names no kind of task.
 */
import { LEARNED_SKILL_NAME_PATTERN, SKILL_LIBRARY_LIMITS, type HandbookEntry, type LearnedSkill, type SkillRejection } from '@nexgent/kernel'
import { languageName, type LearningLanguage } from '../learning/text.js'

/** Changes when the wording changes (recorded with each run). */
export const INDUCTION_PROMPT_VERSION = 1

/** One task of the group, as the request shows it. */
export interface InductionTask {
  readonly taskId: string
  /** 0–1, from the user, the checks or the external review. */
  readonly score: number
  /** `renderTaskRun`, clipped. */
  readonly run: string
}

/** What the request is built from. */
export interface InductionInput {
  readonly tasks: readonly InductionTask[]
  /** Learned skills in force (to replace, not repeat). */
  readonly skills: readonly LearnedSkill[]
  /** Names of the other skills the agent has (built-in, the user's, the project's). */
  readonly reservedNames: readonly string[]
  /** Handbook practices related to the tasks. */
  readonly practices: readonly HandbookEntry[]
  /** Recently refused candidates. */
  readonly rejected: readonly SkillRejection[]
}

/** The system prompt. */
export function inductionSystemPrompt(language: LearningLanguage): string {
  return [
    'You write reusable skills for a general-purpose agent, from a group of similar tasks that went well.',
    'A skill is a SKILL.md: a name, a one-line description of the kind of work it covers, when_to_use saying how to recognize such a task, and a body of instructions the agent follows after loading it. The agent sees only the name, description and when_to_use until it loads the skill.',
    '',
    'Rules:',
    '- Write a skill only for a procedure the tasks share and that a future task of the same kind would follow. When the tasks share no reusable procedure, return an empty list.',
    '- Generalize. Replace every value of one task (file names, paths, numbers, names, dates, quoted wording) with a placeholder in angle brackets, such as <input file> or <target column>. Never copy the user\'s request text.',
    '- The body says how to do the work: the order of steps, the checks that caught mistakes, the pitfalls the runs hit and how they were avoided, and how to verify the result before finishing. Do not narrate the given tasks.',
    '- The task\'s own instructions always win over the skill: write steps as defaults, not as requirements that could contradict a request.',
    '- Do not repeat an existing skill or a handbook practice. To improve a learned skill, set replaces to its id and write the whole new version under the same name.',
    '- Avoid the mistakes of the refused candidates listed.',
    `- At most ${SKILL_LIBRARY_LIMITS.maxCandidatesPerInduction} skills. name: lowercase words joined by dashes (${LEARNED_SKILL_NAME_PATTERN.source}), at most ${SKILL_LIBRARY_LIMITS.maxNameChars} characters, not a name already taken. description: one sentence. Body at most ${SKILL_LIBRARY_LIMITS.maxBodyChars} characters.`,
    `- Write description, when_to_use and body in ${languageName(language)}.`,
    '',
    'Reply with JSON only:',
    '{"skills":[{"name":"...","description":"...","when_to_use":"...","body":"...","replaces":"<skill id, only when replacing>"}]}',
  ].join('\n')
}

/** The user message. */
export function inductionUserMessage(input: InductionInput): string {
  const parts: string[] = []
  parts.push(`# Tasks that went well (${input.tasks.length})`)
  input.tasks.forEach((task, index) => parts.push(`## Task ${index + 1} (outcome score ${task.score.toFixed(2)})\n${task.run}`))
  parts.push(`# Learned skills in force\n${input.skills.length === 0 ? '(none)' : input.skills.map(skill => `- ${skill.id} [${skill.status}]: ${skill.description}${skill.whenToUse === undefined ? '' : ` Use when: ${skill.whenToUse}`}`).join('\n')}`)
  parts.push(`# Names already taken by other skills\n${input.reservedNames.length === 0 ? '(none)' : input.reservedNames.join(', ')}`)
  if (input.practices.length > 0) parts.push(`# Handbook practices related to these tasks\n${input.practices.map(entry => `- ${entry.text.replace(/\s+/g, ' ')}`).join('\n')}`)
  if (input.rejected.length > 0) parts.push(`# Refused candidates (do not repeat these mistakes)\n${input.rejected.map(record => `- ${record.name ?? '(no name)'}: ${record.reason} (${record.detail})`).join('\n')}`)
  return parts.join('\n\n')
}

/** One proposed skill. */
export interface ProposedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly body: string
  readonly replaces?: string
}

/** A parsed reply: the candidates and how many items were malformed. */
export interface ParsedInduction {
  readonly skills: readonly ProposedSkill[]
  readonly malformed: number
}

function firstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Parse the reply (pure); `undefined` when it is not the JSON asked for. */
export function parseInduction(text: string): ParsedInduction | undefined {
  const json = firstObject(text)
  if (json === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { skills?: unknown }).skills)) return undefined
  const skills: ProposedSkill[] = []
  let malformed = 0
  for (const raw of (value as { skills: unknown[] }).skills) {
    const item = raw as Record<string, unknown> | null
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.description !== 'string' || typeof item.body !== 'string') {
      malformed += 1
      continue
    }
    const whenToUse = typeof item.when_to_use === 'string' && item.when_to_use.trim() !== '' ? item.when_to_use.trim() : undefined
    const replaces = typeof item.replaces === 'string' && item.replaces.trim() !== '' ? item.replaces.trim() : undefined
    skills.push({
      name: item.name.trim(),
      description: item.description.replace(/\s+/g, ' ').trim(),
      ...(whenToUse === undefined ? {} : { whenToUse: whenToUse.replace(/\s+/g, ' ') }),
      body: item.body.trim(),
      ...(replaces === undefined ? {} : { replaces }),
    })
  }
  return { skills, malformed }
}
