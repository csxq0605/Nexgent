// Adapted from deepseek-harness@46a7f68b packages/web/tool-web/src/fetch.ts (MIT)
/**
 * The turndown converter, its non-visible-content and table rules and the
 * nesting-depth guard come from the source above.
 *
 * HTML → Markdown for `web_fetch`: turndown over its bundled DOM, with
 * GitHub-flavoured tables (`@joplin/turndown-plugin-gfm`); scripts, styles,
 * hidden elements and embedded frames are dropped. Pages nested deeper
 * than {@link MAX_CONVERSION_DEPTH} are not converted (conversion is
 * synchronous and superlinear in nesting depth).
 */
/// <reference path="./turndown-plugin-gfm.d.ts" />
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

/** The DOM members the rules use (the package compiles without the DOM lib). */
interface DomElement {
  readonly nodeName: string
  readonly parentElement: DomElement | null
  readonly parentNode: DomElement | null
  readonly childNodes: ArrayLike<unknown>
  readonly style: { readonly textAlign?: string }
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
}
interface DomRow extends DomElement {
  readonly cells: ArrayLike<DomElement>
}
interface DomTable extends DomElement {
  readonly rows: ArrayLike<DomRow>
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.use(gfm)
turndown.addRule('removeNonVisibleContent', {
  filter(element) {
    const node = element as DomElement
    if (['HEAD', 'TITLE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS'].includes(node.nodeName.toUpperCase())) return true
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some((declaration: string) => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
      return (property === 'display' && value === 'none') || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    })
  },
  replacement() {
    return ''
  },
})

function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

function isTableHeadingRow(row: DomRow): boolean {
  const section = row.parentElement!
  const table = section.parentElement as DomTable
  return (section.nodeName === 'THEAD' || table.rows[0] === row) && Array.from(row.cells).every(cell => cell.nodeName === 'TH')
}

function tableBorder(cell: DomElement): string {
  const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

// GFM cannot represent spanning cells; ignoring colspan keeps output proportional to the source.
turndown.addRule('tableCellWithoutSpanExpansion', {
  filter: ['th', 'td'],
  replacement(content, node) {
    const cell = node as DomElement
    const row = cell.parentNode!
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell))
  },
})
turndown.addRule('tableRowWithoutSpanExpansion', {
  filter: 'tr',
  replacement(content, node) {
    const row = node as DomRow
    const border = isTableHeadingRow(row) ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join('') : ''
    return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
  },
})

/** Nesting depth above which a page is not converted. */
export const MAX_CONVERSION_DEPTH = 512

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  return candidate
}

/** Lexical nesting depth check (unclosed tags count), without building a DOM. */
export function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase()
  const open: string[] = []
  let offset = 0
  let inComment = false
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (inComment) {
      const end = html.indexOf('-->', offset)
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false
        offset = end + 3
        continue
      }
    }
    if (start === -1) break
    if (!inComment && html.startsWith('<!--', start)) {
      inComment = true
      offset = start + 4
      continue
    }
    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }
    const name = lowerHtml.slice(nameStart, cursor)
    let quote: '"' | "'" | undefined
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break
    if (closing) {
      if (!inComment && open.at(-1) === name) open.pop()
    } else {
      let last = cursor - 2
      while (/\s/.test(html.charAt(last))) last -= 1
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        open.push(name)
        if (open.length > MAX_CONVERSION_DEPTH) return true
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    const code = ref[0] !== '#' ? undefined : ref[1]?.toLowerCase() === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
    if (code !== undefined) return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    return ENTITIES[ref.toLowerCase()] ?? whole
  })
}

/** The page `<title>`, whitespace collapsed; `''` when absent. */
export function htmlTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return match === null ? '' : decodeEntities(match[1]!).replace(/\s+/g, ' ').trim()
}

/** Convert a page; `undefined` when it cannot be converted safely (too deep, or the converter failed). */
export function htmlToMarkdown(html: string): string | undefined {
  if (exceedsConversionDepth(html)) return undefined
  try {
    return turndown.turndown(html)
  } catch {
    // turndown recurses per element; markup the lexical guard does not model can still overflow.
    return undefined
  }
}
