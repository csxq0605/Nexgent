/**
 * `@nexgent/skill` — skill discovery (`SKILL.md` with front matter, built-in
 * and project skills), the skill-list context provider (injected into the conversation), skill-gated tools (`ctx.skillTools`), the `load_skill`
 * tool, and the built-in Office reading skill with its `read_document` tool
 * (.docx / .xlsx / .pdf, pure JS). Implements `SkillRegistry`
 * (`packages/kernel/src/contracts/skill.ts`). See README.md.
 */
export * from './documents/index.js'
export * from './frontmatter.js'
export * from './registry.js'
export * from './capability-skills.js'
export * from './gating.js'
export * from './provider.js'
export * from './tools.js'
export { apply, name, SkillPlugin } from './plugin.js'
export type { SkillPluginConfig } from './plugin.js'
