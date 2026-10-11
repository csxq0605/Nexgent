/**
 * Cordis plugin of `@nexgent/tool-spreadsheet` (profile row
 * `@nexgent/tool-spreadsheet`).
 */
import type { Context } from '@nexgent/kernel'
import { readSpreadsheetTool, writeSpreadsheetTool } from './tools.js'

/**
 * The plugin: whenever `ctx.tools` is available registers `read_spreadsheet`
 * and `write_spreadsheet` over `ctx.sandbox`; each registration is undone
 * when either side is disposed.
 */
export const SpreadsheetPlugin = {
  name: '@nexgent/tool-spreadsheet',
  inject: ['workspace', 'sandbox'],
  apply(ctx: Context): void {
    const sandbox = ctx.sandbox
    ctx.inject(['tools'], scope => {
      for (const tool of [readSpreadsheetTool(sandbox), writeSpreadsheetTool(sandbox)]) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
    })
  },
}

export const name = SpreadsheetPlugin.name
export const apply = SpreadsheetPlugin.apply
