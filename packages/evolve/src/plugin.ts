/**
 * The `@nexgent/evolve` plugin: provides `ctx.improve` (the project's
 * {@link ImprovementHost}). On start it begins counting in the project and
 * recovers interrupted jobs. At the start of every turn it counts the
 * session's new feedback (a feedback submission opens a turn whose user
 * message is the feedback), then resumes jobs whose history is now enough
 * and records first uses of adopted improvements — in the background,
 * one sweep at a time, without holding the turn up; a failure there never
 * stops a task. Check failures arrive through
 * `ctx.improve.noteCheckFailure` (the kernel's signal), explicit runs
 * through `ctx.improve.run` (the SDK).
 */
import type { Context, ContextContribution, ContextProvider, TurnContextInput } from '@nexgent/kernel'
import { ImprovementHost, type ImprovementHostConfig } from './host.js'

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
        await host.syncFeedback(input.sessionId).catch(() => undefined)
        await host.resumeWaiting().catch(() => undefined)
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
    ctx.provide('improve', host)
    void host.start().catch(() => undefined)
    ctx.inject(['context'], scope => {
      scope.effect(() => scope.context.register(feedbackCounter(host)), 'context.register(evolve-feedback)')
    })
  },
}

export const name = EvolvePlugin.name
export const apply = EvolvePlugin.apply
