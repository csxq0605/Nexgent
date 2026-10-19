/**
 * The `@nexgent/evolve` plugin: provides `ctx.improve` (the project's
 * {@link ImprovementHost}) with layer-1 learning attached
 * ({@link LearningHost}, ADR 0018). On start it resumes learning left
 * queued; after every root task turn the kernel's `noteTurnEnd` queues the
 * task and the learning loop runs in this process in the background;
 * disposing the plugin (app exit) stops it.
 */
import type { Context, SkillRegistry } from '@nexgent/kernel'
import { ImprovementHost, type ImprovementHostConfig } from './host.js'
import { LearningHost } from './learning/host.js'

/** Plugin-row config. */
export type EvolvePluginConfig = ImprovementHostConfig

/** The plugin as an object, for `ctx.plugin(EvolvePlugin, config)`. */
export const EvolvePlugin = {
  name: '@nexgent/evolve',
  inject: ['workspace'],
  provide: ['improve'],
  apply(ctx: Context, config: EvolvePluginConfig = {}): void {
    const settings = config ?? {}
    const host = new ImprovementHost(ctx.workspace.layout, settings)
    host.learning = new LearningHost({
      layout: ctx.workspace.layout,
      home: host.home,
      llm: () => ctx.get('llm'),
      ledger: () => ctx.get('ledger'),
      sessions: () => ctx.get('session'),
      skillNames: async () => {
        const registry = (ctx as unknown as { get(name: string): unknown }).get('skills') as SkillRegistry | undefined
        return ((await registry?.catalog())?.skills ?? []).map(skill => skill.name)
      },
      ...(settings.language === undefined ? {} : { language: settings.language }),
    })
    const learning = host.learning
    ctx.provide('improve', host)
    void learning.start().catch(() => undefined)
    ctx.effect(() => () => learning.stop(), 'improve.learning.stop')
  },
}

export const name = EvolvePlugin.name
export const apply = EvolvePlugin.apply
