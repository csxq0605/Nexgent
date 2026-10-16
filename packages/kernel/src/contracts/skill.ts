import type { Tool } from './tools.js'

/**
 * The skill contract (step 2): discovery of `SKILL.md` files, the list the
 * system prompt shows, and on-demand loading through the `load_skill` tool.
 * `@nexgent/skill` implements it. Normative text: `docs/spec/agent-hooks.md`
 * §技能.
 */

/**
 * Where a skill came from. Precedence for one name: project over user over
 * built-in (step 3 adds `user`: `~/.nexgent/skills/*\/SKILL.md`).
 */
export type SkillSource = 'builtin' | 'user' | 'project'

/** A skill's front matter plus where it lives. */
export interface SkillManifest {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`; unique after overriding. */
  readonly name: string
  /** One line for the system prompt list. */
  readonly description: string
  /** Optional trigger hint ("use when …"). */
  readonly whenToUse?: string
  readonly source: SkillSource
  /** Absolute path of the `SKILL.md`. */
  readonly path: string
  /**
   * Tool names the skill needs. A name that a plugin offered through
   * {@link SkillGatedTools} (`ctx.skillTools`) becomes visible to a session
   * only after that session ran `load_skill` for this skill; other names
   * are informational.
   */
  readonly tools?: readonly string[]
}

/** A skill file that could not be used. */
export interface SkillProblem {
  /** Absolute path of the offending `SKILL.md`. */
  readonly path: string
  /** Readable reason, e.g. missing `description`, bad name, YAML error. */
  readonly reason: string
}

/** The discovery result. */
export interface SkillCatalog {
  /** Usable skills, sorted by name. */
  readonly skills: readonly SkillManifest[]
  readonly problems: readonly SkillProblem[]
}

/** A loaded skill: manifest plus the body after the front matter. */
export interface LoadedSkill {
  readonly manifest: SkillManifest
  readonly body: string
}

/** The `ctx.skills` service. */
export interface SkillRegistry {
  /**
   * Scan the built-in directory, the user directory (step 3) and `<project>/.nexgent/skills/*\/SKILL.md`.
   * Never throws for a bad file; it lands in `problems`.
   */
  catalog(): Promise<SkillCatalog>
  /** Load one skill by name. @throws `tool/not-found` for an unknown name. */
  load(name: string): Promise<LoadedSkill>
}

/**
 * The `ctx.skillTools` service of `@nexgent/skill`: a plugin offers a tool
 * that stays out of every session's tool set until a session loads a skill
 * whose `tools` names it. The tool is then registered in that session's own
 * scope (and again after a resume).
 */
export interface SkillGatedTools {
  /** Offer `tool` as skill-gated; @returns the disposer that withdraws the offer. */
  offer(tool: Tool): () => void
}

/** Pattern a skill name must match. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Directory, relative to the project root, that holds project skills. */
export const PROJECT_SKILLS_DIR = '.nexgent/skills'

/** Directory, relative to the Nexgent home (`~/.nexgent`, or `NEXGENT_HOME`), that holds user skills (step 3). */
export const USER_SKILLS_DIR = 'skills'

/** File name of a skill. */
export const SKILL_FILE = 'SKILL.md'
