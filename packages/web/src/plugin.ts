/**
 * Cordis plugin of `@nexgent/web` (profile row `@nexgent/web`).
 */
import type { Context } from '@nexgent/kernel'
import { webFetchTool } from './tool.js'

/** The plugin: whenever `ctx.tools` is available registers `web_fetch`; disposal unregisters it. */
export const WebPlugin = {
  name: '@nexgent/web',
  apply(ctx: Context): void {
    ctx.inject(['tools'], scope => {
      const tool = webFetchTool()
      scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
    })
  },
}

export const name = WebPlugin.name
export const apply = WebPlugin.apply
