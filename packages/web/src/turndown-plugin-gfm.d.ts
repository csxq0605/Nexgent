// Adapted from deepseek-harness@46a7f68b packages/web/tool-web/src/turndown-plugin-gfm.d.ts (MIT)
/**
 * Ambient module declaration for `@joplin/turndown-plugin-gfm`, which ships no
 * types and has no DefinitelyTyped package. Only the composite `gfm` plugin is
 * declared; the package's individual plugins (`tables`, `strikethrough`, …)
 * stay undeclared until something imports them.
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** The composite GitHub-flavored-markdown plugin (tables, strikethrough, task lists, highlighted code blocks). */
  export const gfm: TurndownService.Plugin
}
