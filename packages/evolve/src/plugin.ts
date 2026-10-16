/**
 * The `@nexgent/evolve` plugin: provides `ctx.improve` (the project's
 * {@link ImprovementHost}) with layer-1 learning attached
 * ({@link LearningHost}, ADR 0018). On start it recovers interrupted jobs
 * and resumes learning left queued; after every root task turn the kernel's
 * `noteTurnEnd` queues the task and the learning loop runs in this process
 * in the background; disposing the plugin (app exit) stops it. At the start
 * of every turn it records first uses of adopted improvements (and, only with
 * the retired `legacyCounting`, counts feedback and resumes waiting jobs) —
 * one sweep at a time, without holding the turn up; a failure there never
 * stops a task. Explicit runs come through `ctx.improve.run` (the SDK).
 */
import type { Context, ContextContribution, ContextProvider, TurnContextInput } from '@nexgent/kernel'
import { ImprovementHost, type ImprovementHostConfig } from './host.js'
import { LearningHost } from './learning/host.js'

/** Plugin-row config. */
export type EvolvePluginConfig = ImprovementHostConfig

/** The context provider that counts feedback when a turn starts. */
export function feedbackCounter(host: ImprovementHost): ContextProvider {
  let running = false
  return {
    id: 'evolve-feedback',
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      if (running) return {}
      running = true
      void (async () => {
        if (host.legacyCounting) {
          await host.syncFeedback(input.sessionId).catch(() => undefined)
          await host.resumeWaiting().catch(() => undefined)
        }
        await host.sweepAdopted().catch(() => undefined)
      })().finally(() => { running = false })
      return {}
    },
  }
}

/** The plugin as an object, for `ctx.plugin(EvolvePlugin, config)`. */
export const EvolvePlugin = {
  name: '@nexgent/evolve',
  inject: ['workspace'],
  provide: ['improve'],
  apply(ctx: Context, config: EvolvePluginConfig = {}): void {
    const host = new ImprovementHost(ctx.workspace.layout, config ?? {}, () => ctx.get('tasking')?.feedback)
    const settings = config ?? {}
    host.learning = new LearningHost({
      layout: ctx.workspace.layout,
      home: host.home,
      llm: () => ctx.get('llm'),
      ledger: () => ctx.get('ledger'),
      sessions: () => ctx.get('session'),
      ...(settings.language === undefined ? {} : { language: settings.language }),
    })
    const learning = host.learning
    ctx.provide('improve', host)
    void host.start().catch(() => undefined)
    void learning.start().catch(() => undefined)
    ctx.effect(() => () => learning.stop(), 'improve.learning.stop')
    ctx.inject(['context'], scope => {
      scope.effect(() => scope.context.register(feedbackCounter(host)), 'context.register(evolve-feedback)')
    })
  },
}

export const name = EvolvePlugin.name
export const apply = EvolvePlugin.apply
