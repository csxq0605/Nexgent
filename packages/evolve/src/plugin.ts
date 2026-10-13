/**
 * The `@nexgent/evolve` plugin: provides `ctx.improve` (the project's
 * {@link ImprovementHost}). On start it begins counting in the project and
 * recovers interrupted jobs. At the start of every turn it counts the
 * session's new feedback (a feedback submission opens a turn whose user
 * message is the feedback), without holding the turn up; a counting
 * failure never stops a task. Check failures arrive through
 * `ctx.improve.noteCheckFailure` (the kernel's signal), explicit runs
 * through `ctx.improve.run` (the SDK).
 */
import type { Context, ContextContribution, ContextProvider, TurnContextInput } from '@nexgent/kernel'
import { ImprovementHost, type ImprovementHostConfig } from './host.js'

/** Plugin-row config. */
export type EvolvePluginConfig = ImprovementHostConfig

/** The context provider that counts feedback when a turn starts. */
export function feedbackCounter(host: ImprovementHost): ContextProvider {
  return {
    id: 'evolve-feedback',
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      void host.syncFeedback(input.sessionId).catch(() => undefined)
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
