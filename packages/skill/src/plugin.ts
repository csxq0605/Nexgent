/**
 * Cordis plugin of `@nexgent/skill` (profile row `@nexgent/skill`).
 */
import { join } from 'node:path'
import { nexgentHome, USER_SKILLS_DIR, type Context, type SessionStore, type SkillGatedTools, type SkillRegistry } from '@nexgent/kernel'
import { capabilitySkillLookup, validateCapabilitySkill, type CapabilitySkillService } from './capability-skills.js'
import { SkillToolGate } from './gating.js'
import { skillsProvider } from './provider.js'
import { FileSkillRegistry } from './registry.js'
import { loadSkillTool, readDocumentTool } from './tools.js'

/** Plugin config. */
export interface SkillPluginConfig {
  /** Built-in skills directory; default the one shipped with this package. */
  readonly builtinDir?: string
  /** User skills directory; default `<NEXGENT_HOME or ~/.nexgent>/skills` from `process.env`. Hosts with their own home pass it. */
  readonly userDir?: string
}

/**
 * The plugin: provides `ctx.skills` (a {@link FileSkillRegistry} over the
 * built-in directory, the user's `~/.nexgent/skills` and
 * `<project>/.nexgent/skills`); whenever `ctx.tools`
 * is available registers `load_skill` and `read_document`; whenever
 * `ctx.context` is available registers the `skills` provider. Each
 * registration is undone when either side is disposed. When
 * `ctx.capabilities` is loaded (step 4), each session also sees the skills
 * of its capability version and the ones it tried, and the plugin registers
 * the `skill` component check with it. It also provides `ctx.skillTools`
 * ({@link SkillGatedTools}): tools a plugin offers there are visible to a
 * session only after it loaded a skill whose `tools` names them.
 */
export const SkillPlugin = {
  name: '@nexgent/skill',
  inject: ['workspace', 'sandbox'],
  provide: ['skills', 'skillTools'],
  apply(ctx: Context, config: SkillPluginConfig = {}): void {
    const registry: SkillRegistry = new FileSkillRegistry({
      projectRoot: ctx.workspace.root,
      ...(config?.builtinDir === undefined ? {} : { builtinDir: config.builtinDir }),
      userDir: config?.userDir ?? join(nexgentHome(), USER_SKILLS_DIR),
    })
    const layered = registry as FileSkillRegistry
    ctx.provide('skills', registry)
    const agents = ctx as unknown as { get(name: string): unknown }
    const gate = new SkillToolGate(
      sessionId => (agents.get('agents') as { get(id: string): { ctx: Context } | undefined } | undefined)?.get(sessionId)?.ctx,
      () => agents.get('session') as SessionStore | undefined,
    )
    ctx.provide('skillTools' as never, gate as never)
    const sandbox = ctx.sandbox
    const capabilities = (): CapabilitySkillService | undefined => (ctx as unknown as { get(name: string): unknown }).get('capabilities') as CapabilitySkillService | undefined
    const lookup = capabilitySkillLookup(capabilities)
    ctx.inject(['capabilities' as never], scope => {
      const service = (scope as unknown as { get(name: string): unknown }).get('capabilities') as CapabilitySkillService | undefined
      if (service !== undefined && typeof service.registerValidator === 'function') {
        scope.effect(() => service.registerValidator('skill', validateCapabilitySkill), 'capabilities.registerValidator(skill)')
      }
    })
    ctx.inject(['tools'], scope => {
      for (const tool of [loadSkillTool(layered, lookup, gate), readDocumentTool(sandbox)]) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
    })
    ctx.inject(['context'], scope => {
      scope.effect(() => scope.context.register(skillsProvider(layered, lookup, gate)), 'context.register(skills)')
    })
  },
}

export const name = SkillPlugin.name
export const apply = SkillPlugin.apply
