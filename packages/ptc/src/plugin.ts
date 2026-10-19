/**
 * Cordis plugin of `@nexgent/ptc` (profile row `@nexgent/ptc`).
 */
import type { Context } from '@nexgent/kernel'
import { runCodeTool } from './tool.js'

/**
 * The plugin: whenever `ctx.tools` is available registers `run_code` over
 * `ctx.sandbox`; the registration is undone when either side is disposed.
 */
export const PtcPlugin = {
  name: '@nexgent/ptc',
  inject: ['workspace', 'sandbox'],
  apply(ctx: Context): void {
    const sandbox = ctx.sandbox
    ctx.inject(['tools'], scope => {
      const tool = runCodeTool(sandbox)
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
    })
  },
}

export const name = PtcPlugin.name
export const apply = PtcPlugin.apply
