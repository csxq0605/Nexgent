/**
 * `.docx` → text: the main document part only (headers, footers, footnotes
 * and comments are not read). Paragraphs become lines; heading styles become
 * `#` prefixes, list paragraphs `- `; tables become `| a | b |` rows; deleted
 * revisions and field codes are skipped. Macros are never executed (nothing
 * in a package is executed).
 */
import { DocumentError } from './errors.js'
import { localName, scanXml } from './xml.js'
import { partText, readZipParts } from './zip.js'

const DOCUMENT_PART = 'word/document.xml'

interface TableState {
  rows: string[][]
  row: string[] | undefined
  cell: string[] | undefined
}

/** Extract the text of a `.docx` package. */
export function extractDocx(data: Uint8Array): string {
  const parts = readZipParts(data, path => path === DOCUMENT_PART, '.docx')
  const xml = partText(parts, DOCUMENT_PART)
  if (xml === undefined) throw new DocumentError(`not a valid .docx file (no ${DOCUMENT_PART} part)`)
  return renderDocumentXml(xml)
}

/** Render `word/document.xml`. Pure. */
export function renderDocumentXml(xml: string): string {
  const out: string[] = []
  const tables: TableState[] = []
  let paragraph: string | undefined
  let prefix = ''
  let inText = false
  let skipDepth = 0

  const emit = (line: string): void => {
    const table = tables[tables.length - 1]
    if (table?.cell !== undefined) table.cell.push(line)
    else out.push(line)
  }

  try {
    for (const event of scanXml(xml)) {
      if (event.kind === 'text') {
        if (inText && skipDepth === 0 && paragraph !== undefined) paragraph += event.text
        continue
      }
      const name = localName(event.name)
      if (event.kind === 'open') {
        switch (name) {
          case 'del':
          case 'instrText':
          case 'delText':
            if (!event.selfClosing) skipDepth++
            break
          case 'p':
            paragraph = ''
            prefix = ''
            if (event.selfClosing) {
              emit('')
              paragraph = undefined
            }
            break
          case 'pStyle': {
            const style = (event.attrs['w:val'] ?? '').toLowerCase()
            const heading = /^heading\s?([1-9])$/.exec(style)
            if (heading) prefix = `${'#'.repeat(Number(heading[1]))} `
            else if (style === 'title') prefix = '# '
            else if (/^list(bullet|number|paragraph)/.test(style)) prefix = '- '
            break
          }
          case 'numPr':
            if (prefix === '') prefix = '- '
            break
          case 't':
            inText = !event.selfClosing
            break
          case 'tab':
            if (paragraph !== undefined && skipDepth === 0) paragraph += '\t'
            break
          case 'br':
          case 'cr':
            if (paragraph !== undefined && skipDepth === 0) paragraph += '\n'
            break
          case 'noBreakHyphen':
            if (paragraph !== undefined && skipDepth === 0) paragraph += '-'
            break
          case 'tbl':
            tables.push({ rows: [], row: undefined, cell: undefined })
            break
          case 'tr': {
            const table = tables[tables.length - 1]
            if (table !== undefined) table.row = []
            break
          }
          case 'tc': {
            const table = tables[tables.length - 1]
            if (table !== undefined) table.cell = []
            break
          }
        }
        continue
      }
      switch (name) {
        case 'del':
        case 'instrText':
        case 'delText':
          skipDepth = Math.max(0, skipDepth - 1)
          break
        case 't':
          inText = false
          break
        case 'p':
          if (paragraph !== undefined) emit(prefix + paragraph)
          paragraph = undefined
          prefix = ''
          break
        case 'tc': {
          const table = tables[tables.length - 1]
          if (table?.cell !== undefined) {
            table.row?.push(table.cell.filter(line => line.trim() !== '').join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim())
            table.cell = undefined
          }
          break
        }
        case 'tr': {
          const table = tables[tables.length - 1]
          if (table?.row !== undefined) table.rows.push(table.row)
          if (table !== undefined) table.row = undefined
          break
        }
        case 'tbl': {
          const table = tables.pop()
          if (table === undefined) break
          const lines = table.rows.map(row => `| ${row.join(' | ')} |`)
          for (const line of lines) emit(line)
          break
        }
      }
    }
  } catch (error) {
    throw new DocumentError(`not a valid .docx file (${DOCUMENT_PART}: ${(error as Error).message})`)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
