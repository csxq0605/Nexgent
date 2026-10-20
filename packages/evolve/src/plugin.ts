/**
 * The `@nexgent/evolve` plugin: provides `ctx.learning`, the project's
 * layer-1 learning ({@link LearningHost}, ADR 0018). On start it resumes
 * learning left queued; after every root task turn the kernel's
 * `noteTurnEnd` queues the task and the learning loop runs in this process
 * in the background; disposing the plugin (app exit) stops it.
 */
import type { Context } from '@nexgent/kernel'
import { LearningHost } from './learning/host.js'
import { homeOf } from './user-config.js'

/** Plugin-row config. */
export interface EvolvePluginConfig {
  /** The Nexgent home (default `NEXGENT_HOME` / `~/.nexgent`): the user config and the user handbook. */
  readonly home?: string
  /** ADR 0018 decision 11: the interface language (BCP 47) of what learning writes for the user; absent: each task's language. */
  readonly language?: string
}

/** The plugin as an object, for `ctx.plugin(EvolvePlugin, config)`. */
export const EvolvePlugin = {
  name: '@nexgent/evolve',
  inject: ['workspace'],
  provide: ['learning'],
  apply(ctx: Context, config: EvolvePluginConfig = {}): void {
    const settings = config ?? {}
    const learning = new LearningHost({
      layout: ctx.workspace.layout,
      home: homeOf(settings.home),
      llm: () => ctx.get('llm'),
      ledger: () => ctx.get('ledger'),
      sessions: () => ctx.get('session'),
      ...(settings.language === undefined ? {} : { language: settings.language }),
    })
    ctx.provide('learning', learning)
    void learning.start().catch(() => undefined)
    ctx.effect(() => () => learning.stop(), 'learning.stop')
  },
}

export const name = EvolvePlugin.name
export const apply = EvolvePlugin.apply
