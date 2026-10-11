/**
 * Cordis plugin of `@nexgent/skill` (profile row `@nexgent/skill`).
 */
import type { Context, SkillRegistry } from '@nexgent/kernel'
import { skillsProvider } from './provider.js'
import { FileSkillRegistry } from './registry.js'
import { loadSkillTool, readDocumentTool } from './tools.js'

/** Plugin config. */
export interface SkillPluginConfig {
  /** Built-in skills directory; default the one shipped with this package. */
  readonly builtinDir?: string
}

/**
 * The plugin: provides `ctx.skills` (a {@link FileSkillRegistry} over the
 * built-in directory and `<project>/.nexgent/skills`); whenever `ctx.tools`
 * is available registers `load_skill` and `read_document`; whenever
 * `ctx.context` is available registers the `skills` provider. Each
 * registration is undone when either side is disposed.
 */
export const SkillPlugin = {
  name: '@nexgent/skill',
  inject: ['workspace', 'sandbox'],
  provide: ['skills'],
  apply(ctx: Context, config: SkillPluginConfig = {}): void {
    const registry: SkillRegistry = new FileSkillRegistry({
      projectRoot: ctx.workspace.root,
      ...(config?.builtinDir === undefined ? {} : { builtinDir: config.builtinDir }),
    })
    ctx.provide('skills', registry)
    const sandbox = ctx.sandbox
    ctx.inject(['tools'], scope => {
      for (const tool of [loadSkillTool(registry), readDocumentTool(sandbox)]) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
    })
    ctx.inject(['context'], scope => {
      scope.effect(() => scope.context.register(skillsProvider(registry)), 'context.register(skills)')
    })
  },
}

export const name = SkillPlugin.name
export const apply = SkillPlugin.apply
