/**
 * The skill contract (step 2): discovery of `SKILL.md` files, the list the
 * system prompt shows, and on-demand loading through the `load_skill` tool.
 * `@nexgent/skill` implements it. Normative text: `docs/spec/agent-hooks.md`
 * §技能.
 */

/** Where a skill came from; a project skill overrides a built-in one of the same name. */
export type SkillSource = 'builtin' | 'project'

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
  /** Tool names the skill expects to be available (informational). */
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
   * Scan the built-in directory and `<project>/.nexgent/skills/*\/SKILL.md`.
   * Never throws for a bad file; it lands in `problems`.
   */
  catalog(): Promise<SkillCatalog>
  /** Load one skill by name. @throws `tool/not-found` for an unknown name. */
  load(name: string): Promise<LoadedSkill>
}

/** Pattern a skill name must match. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Directory, relative to the project root, that holds project skills. */
export const PROJECT_SKILLS_DIR = '.nexgent/skills'

/** File name of a skill. */
export const SKILL_FILE = 'SKILL.md'
