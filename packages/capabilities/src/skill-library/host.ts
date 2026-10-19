/**
 * Learned skills in running sessions (ADR 0025):
 *
 * - {@link SkillLibraryHost.forTurn}: at a root task's user turn, the
 *   versions in force whose description matches the turn's text are drawn
 *   by the ADR 0023 coins (an active version with
 *   `HANDBOOK_EVIDENCE.activeShowProbability`, at most
 *   `SKILL_LIBRARY_LIMITS.maxActivePerTask`; one trial version per task with
 *   `trialShowProbability`), the draws are recorded in the library's
 *   `usage.jsonl`, and the shown ones are named in a line the kernel injects
 *   with the handbook's message. A task never gets two versions of one name.
 * - {@link SkillLibraryHost.skillsFor}: the shown versions of a session's
 *   root task, which `@nexgent/skill` adds to the skills list and to
 *   `load_skill` (members use their root task's draw).
 *
 * Nothing when `learning.useShared` is off (the library is user-level), in
 * an improvement session, or for members and feedback turns. A trial copy
 * of a project draws no coin and records nothing: it gives the chosen
 * versions, as the handbook does.
 */
import { HANDBOOK_EVIDENCE, SKILL_LIBRARY_LIMITS, type HandbookDraw, type HandbookTurnInput, type LearnedSkill, type SessionRecord } from '@nexgent/kernel'
import { handbookProjectId, projectLearning } from '../handbook/handbook.js'
import type { LearnedSkillFile } from '../service.js'
import { SkillLibrary, type SkillTurnHit } from './library.js'

/** The line before the learned skills a turn was given. */
export const LEARNED_SKILLS_HEADER = 'Skills learned from earlier tasks that may fit this task are in the skills list; load one with load_skill only if it fits, and follow the task as asked:'

/** Options of {@link SkillLibraryHost}. */
export interface SkillLibraryHostOptions {
  readonly projectRoot: string
  /** Absolute Nexgent home. */
  readonly home: string
  readonly readRecords: (sessionId: string) => Promise<readonly SessionRecord[]>
  /** Whether this project is a trial copy (no coin, nothing recorded). */
  readonly readOnly: () => Promise<boolean>
  /** The exposure coin; default `Math.random`. */
  readonly random?: () => number
  readonly now?: () => Date
  /** ADR 0027: active versions drawn per task under the execution profile in force; default `SKILL_LIBRARY_LIMITS.maxActivePerTask`. */
  readonly maxActive?: () => Promise<number | undefined>
}

/** The learned-skill side of a project's running sessions. */
export class SkillLibraryHost {
  readonly library: SkillLibrary
  readonly #options: SkillLibraryHostOptions
  /** Versions shown per root session in this process (a trial copy's live only here). */
  readonly #shown = new Map<string, Set<string>>()

  constructor(options: SkillLibraryHostOptions) {
    this.#options = options
    this.library = SkillLibrary.of(options.home, options.now === undefined ? {} : { now: options.now })
  }

  async #useShared(): Promise<boolean> {
    return (await projectLearning(this.#options.projectRoot)).useShared
  }

  /** The text to add to a root task's turn injection; `undefined` when nothing is shown. */
  async forTurn(input: HandbookTurnInput): Promise<string | undefined> {
    const records = await this.#options.readRecords(input.sessionId)
    const start = records[0]
    if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.member !== undefined || start.purpose === 'improvement') return undefined
    if (!(await this.#useShared())) return undefined
    const counted = !(await this.#options.readOnly())
    if (counted) await this.library.applyEvidence().catch(() => undefined)
    const drawn = counted ? await this.library.drawsOf(input.sessionId) : new Map<string, { readonly draw: HandbookDraw; readonly status?: 'trial' | 'active' }>()
    const shown = this.#shown.get(input.sessionId) ?? new Set<string>()
    for (const [id, draw] of drawn) if (draw.draw === 'shown') shown.add(id)
    const all = await this.library.skills({ includeRetired: true })
    const byId = new Map(all.map(skill => [skill.id, skill]))
    const takenNames = new Set([...drawn.keys(), ...shown].map(id => byId.get(id)?.name).filter((name): name is string => name !== undefined))
    const found: LearnedSkill[] = []
    for (const { skill } of await this.library.retrieve(input.text, { exclude: [...drawn.keys(), ...shown] })) {
      if (takenNames.has(skill.name)) continue
      takenNames.add(skill.name)
      found.push(skill)
    }
    if (found.length === 0) return undefined
    const random = this.#options.random ?? Math.random
    const drawnOf = (status: 'trial' | 'active') => [...drawn.values()].filter(draw => draw.status === status).length
    const maxActive = (await this.#options.maxActive?.().catch(() => undefined)) ?? SKILL_LIBRARY_LIMITS.maxActivePerTask
    let activeLeft = Math.max(0, maxActive - drawnOf('active'))
    let trialLeft = Math.max(0, SKILL_LIBRARY_LIMITS.maxTrialPerTask - drawnOf('trial'))
    const hits: SkillTurnHit[] = found.map(skill => {
      const status = skill.status === 'active' ? 'active' : 'trial'
      const chosen = status === 'active' ? activeLeft-- > 0 : trialLeft-- > 0
      if (!chosen) return { skillId: skill.id, given: false, status }
      if (!counted) return { skillId: skill.id, given: true, status }
      const showProbability = status === 'active' ? HANDBOOK_EVIDENCE.activeShowProbability : HANDBOOK_EVIDENCE.trialShowProbability
      const draw: HandbookDraw = random() < showProbability ? 'shown' : 'held-back'
      return { skillId: skill.id, given: draw === 'shown', status, draw, showProbability }
    })
    if (counted) {
      const projectId = await handbookProjectId(this.#options.projectRoot)
      await this.library.recordTurn({ projectId, sessionId: input.sessionId, hits }).catch(() => undefined)
    }
    const given = hits.filter(hit => hit.given).map(hit => byId.get(hit.skillId)!)
    if (given.length === 0) return undefined
    for (const skill of given) shown.add(skill.id)
    this.#shown.set(input.sessionId, shown)
    return [LEARNED_SKILLS_HEADER, ...given.map(skill => `- ${skill.name}${skill.status === 'trial' ? ' (on trial)' : ''}: ${skill.description}`)].join('\n')
  }

  /** The learned skills a session's root task was shown. */
  async skillsFor(sessionId: string): Promise<LearnedSkillFile[]> {
    const root = await this.#root(sessionId)
    if (root === undefined || !(await this.#useShared())) return []
    const ids = new Set(this.#shown.get(root) ?? [])
    for (const [id, draw] of await this.library.drawsOf(root)) if (draw.draw === 'shown') ids.add(id)
    if (ids.size === 0) return []
    const skills = (await this.library.skills({ includeRetired: true })).filter(skill => ids.has(skill.id))
    return skills.map(skill => ({ name: skill.name, entryPath: this.library.pathOf(skill) }))
  }

  async #root(sessionId: string): Promise<string | undefined> {
    let id = sessionId
    for (let depth = 0; depth < 5; depth += 1) {
      const start = (await this.#options.readRecords(id))[0]
      if (start?.type !== 'session.start') return undefined
      if (start.parentSessionId === undefined) return start.purpose === 'improvement' ? undefined : id
      id = start.parentSessionId
    }
    return undefined
  }
}
