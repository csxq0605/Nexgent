/**
 * Cordis plugin of `@nexgent/tool-spreadsheet` (profile row
 * `@nexgent/tool-spreadsheet`).
 */
import type { Context, SkillGatedTools } from '@nexgent/kernel'
import { readSpreadsheetTool, writeSpreadsheetTool } from './tools.js'

/**
 * The plugin: offers `read_spreadsheet` and `write_spreadsheet` over
 * `ctx.sandbox` as skill-gated tools (`ctx.skillTools`, from
 * `@nexgent/skill`): a session sees them only after it ran `load_skill` for
 * the bundled `spreadsheets` skill. They are not in the default tool set.
 * Each offer is withdrawn when either side is disposed.
 */
export const SpreadsheetPlugin = {
  name: '@nexgent/tool-spreadsheet',
  inject: ['workspace', 'sandbox'],
  apply(ctx: Context): void {
    const sandbox = ctx.sandbox
    ctx.inject(['skillTools' as never], scope => {
      const gate = (scope as unknown as { get(name: string): unknown }).get('skillTools') as SkillGatedTools | undefined
      if (gate === undefined) return
      for (const tool of [readSpreadsheetTool(sandbox), writeSpreadsheetTool(sandbox)]) {
        scope.effect(() => gate.offer(tool), `skillTools.offer(${tool.definition.name})`)
      }
    })
  },
}

export const name = SpreadsheetPlugin.name
export const apply = SpreadsheetPlugin.apply
