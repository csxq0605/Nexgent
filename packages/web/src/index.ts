/**
 * `@nexgent/web` — the `web_fetch` tool: public HTTP(S) pages only
 * (address-checked, pinned connections; every redirect re-checked), HTML
 * converted to Markdown, long pages in parts. See README.md.
 */
export * from './network.js'
export * from './fetch.js'
export { exceedsConversionDepth, htmlTitle, htmlToMarkdown, MAX_CONVERSION_DEPTH } from './markdown.js'
export * from './tool.js'
export { apply, name, WebPlugin } from './plugin.js'
