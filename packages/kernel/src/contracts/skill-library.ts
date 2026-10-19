/**
 * ADR 0018 decision 5, ADR 0025: layer 2, the learned skill library. A
 * learned skill is a `SKILL.md` (name, description, when to use, body) that
 * induction wrote from at least two similar successful tasks. It lives in
 * the user's Nexgent home, is versioned (`<name>@v<n>`, a new version never
 * overwrites an old one) and changes only through operations appended to a
 * log, like the handbook (`handbook.ts`):
 *
 * - `<home>/skill-library/log.jsonl`: `add` and `status` operations;
 * - `<home>/skill-library/skills/<name>/v<n>/SKILL.md`: written before its
 *   `add`, never changed afterwards;
 * - `<home>/skill-library/usage.jsonl`: the same records as a handbook
 *   directory's `usage.jsonl` (`handbook-evidence.ts`), `entryId` being the
 *   skill id, so the ADR 0023 randomized exposure decides trial → active
 *   and retirement with the same rule;
 * - `<home>/skill-library/rejected.jsonl`: candidates induction proposed
 *   and curation refused (the failure archive the next induction reads).
 *
 * v1 skills are instructions only: the model's file tools may not read the
 * Nexgent home (permissions.md), so a script there could not be run.
 *
 * Pure: shapes, limits and the fold. `@nexgent/capabilities` stores and
 * gives skills, `@nexgent/evolve` induces them. Normative text:
 * `docs/spec/data-formats.md` §技能库.
 */
import type { HandbookSource } from './handbook.js'

/** `<NEXGENT_HOME>/skill-library/`. */
export const SKILL_LIBRARY_DIR = 'skill-library'
/** The operation log of the library. */
export const SKILL_LIBRARY_LOG_FILE = 'log.jsonl'
/** The usage records (ADR 0023 draws and outcomes). */
export const SKILL_LIBRARY_USAGE_FILE = 'usage.jsonl'
/** Candidates curation refused. */
export const SKILL_LIBRARY_REJECTED_FILE = 'rejected.jsonl'
/** Directory of the skill files. */
export const SKILL_LIBRARY_SKILLS_DIR = 'skills'

/** A learned skill's life, as a handbook entry's. */
export type LearnedSkillStatus = 'trial' | 'active' | 'retired'

/** Every {@link LearnedSkillStatus}. */
export const LEARNED_SKILL_STATUSES: readonly LearnedSkillStatus[] = ['trial', 'active', 'retired']

/** Who appended an operation. */
export type SkillLibraryActor = 'induction' | 'host' | 'user'

/** Every {@link SkillLibraryActor}. */
export const SKILL_LIBRARY_ACTORS: readonly SkillLibraryActor[] = ['induction', 'host', 'user']

/** Bounds the writer and curation enforce. */
export const SKILL_LIBRARY_LIMITS = {
  maxNameChars: 64,
  maxDescriptionChars: 1024,
  maxWhenToUseChars: 1024,
  maxBodyChars: 8000,
  maxReasonChars: 200,
  /** Candidates one induction may propose. */
  maxCandidatesPerInduction: 2,
  /** Skills in force (trial or active) one root task may be drawn from. */
  maxTrialPerTask: 1,
  maxActivePerTask: 2,
} as const

/** A learned skill's name: kebab-case, lowercase letters and digits joined by single dashes (stricter than `SKILL_NAME_PATTERN`). */
export const LEARNED_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface SkillLibraryOpBase {
  readonly formatVersion: 1
  /** 1, 2, … in file order. */
  readonly seq: number
  /** ISO-8601 UTC. */
  readonly at: string
  /** `<name>@v<n>`. */
  readonly skillId: string
  readonly actor: SkillLibraryActor
  /** At most {@link SKILL_LIBRARY_LIMITS.maxReasonChars} characters. */
  readonly reason?: string
}

/** A new skill version; its `SKILL.md` is already on disk. */
export interface SkillLibraryAdd extends SkillLibraryOpBase {
  readonly op: 'add'
  readonly name: string
  /** 1, 2, …; one more than the highest version of this name. */
  readonly version: number
  readonly description: string
  readonly whenToUse?: string
  /** The skill id this version is meant to replace; the old one retires when this one becomes active. */
  readonly replaces?: string
  /** The successful tasks it was induced from (at least two). */
  readonly sources: readonly HandbookSource[]
}

/** A status change by the host (evidence, idleness, replacement) or the user. */
export interface SkillLibraryStatusOp extends SkillLibraryOpBase {
  readonly op: 'status'
  readonly status: LearnedSkillStatus
}

/** One line of `log.jsonl`. */
export type SkillLibraryOp = SkillLibraryAdd | SkillLibraryStatusOp

/** One learned skill version, as the fold of its operations. */
export interface LearnedSkill {
  /** `<name>@v<n>`. */
  readonly id: string
  readonly name: string
  readonly version: number
  readonly description: string
  readonly whenToUse?: string
  readonly status: LearnedSkillStatus
  readonly replaces?: string
  /** The version that replaced this one (set when that one became active). */
  readonly supersededBy?: string
  readonly sources: readonly HandbookSource[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** The id of a skill version. */
export function learnedSkillId(name: string, version: number): string {
  return `${name}@v${version}`
}

/** `skills/<name>/v<n>/SKILL.md`, relative to the library directory (always `/`). */
export function learnedSkillPath(name: string, version: number): string {
  return `${SKILL_LIBRARY_SKILLS_DIR}/${name}/v${version}/SKILL.md`
}

/**
 * Pure: the library as of `untilSeq` (default: every operation). A version
 * starts as trial. When a version becomes active, every other active or
 * trial version of the same name, and the one it `replaces`, retire with
 * `supersededBy` (one version of a name is in force once one is proven).
 */
export function foldSkillLibrary(ops: readonly SkillLibraryOp[], untilSeq = Number.POSITIVE_INFINITY): LearnedSkill[] {
  const skills = new Map<string, { -readonly [K in keyof LearnedSkill]: LearnedSkill[K] }>()
  for (const op of ops) {
    if (op.seq > untilSeq) break
    if (op.op === 'add') {
      if (skills.has(op.skillId)) continue
      skills.set(op.skillId, {
        id: op.skillId,
        name: op.name,
        version: op.version,
        description: op.description,
        ...(op.whenToUse === undefined ? {} : { whenToUse: op.whenToUse }),
        status: 'trial',
        ...(op.replaces === undefined ? {} : { replaces: op.replaces }),
        sources: op.sources,
        createdAt: op.at,
        updatedAt: op.at,
      })
      continue
    }
    const skill = skills.get(op.skillId)
    if (skill === undefined) continue
    skill.status = op.status
    skill.updatedAt = op.at
    if (op.status !== 'active') continue
    for (const other of skills.values()) {
      if (other === skill || other.status === 'retired') continue
      if (other.name === skill.name || other.id === skill.replaces) {
        other.status = 'retired'
        other.supersededBy = skill.id
        other.updatedAt = op.at
      }
    }
  }
  return [...skills.values()]
}

/** Whether a skill version can be given to tasks. */
export function isLearnedSkillInForce(skill: Pick<LearnedSkill, 'status'>): boolean {
  return skill.status !== 'retired'
}

/** Why curation refused a candidate (`rejected.jsonl`). */
export type SkillRejectionReason =
  | 'malformed'
  | 'invalid-name'
  | 'name-taken'
  | 'too-long'
  | 'instance-literal'
  | 'project-name'
  | 'copied-request'
  | 'duplicate'
  | 'unknown-replaces'
  | 'too-many'

/** One refused candidate. */
export interface SkillRejection {
  readonly formatVersion: 1
  readonly at: string
  readonly projectId: string
  /** The task group induction ran for. */
  readonly group: string
  readonly name?: string
  readonly description?: string
  readonly reason: SkillRejectionReason
  readonly detail: string
}

/**
 * Render a learned skill's `SKILL.md`: YAML front matter (`name`,
 * `description`, `when_to_use` as JSON strings, which YAML reads as
 * double-quoted scalars) and the body.
 */
export function renderLearnedSkill(skill: { readonly name: string; readonly description: string; readonly whenToUse?: string; readonly body: string }): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`]
  if (skill.whenToUse !== undefined) lines.push(`when_to_use: ${JSON.stringify(skill.whenToUse)}`)
  lines.push('---', '', skill.body.trim(), '')
  return lines.join('\n')
}
