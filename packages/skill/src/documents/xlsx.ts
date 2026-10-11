/**
 * `.xlsx` → tables: each worksheet as CSV-style text (RFC 4180 quoting),
 * cached values only (formulas are not evaluated, macros never run). Shared
 * and inline strings, booleans, errors and numbers are supported; numbers in
 * a date / time format become ISO-8601 text (1900 and 1904 date systems).
 */
import { DocumentError } from './errors.js'
import { localName, scanXml } from './xml.js'
import { partText, readZipParts, type ZipParts } from './zip.js'

/** Default rows per sheet. */
export const DEFAULT_MAX_ROWS = 500

/** One worksheet as read. */
export interface SheetTable {
  readonly name: string
  /** Rows from the first to the last used row; each row spans the used columns. */
  readonly rows: readonly (readonly string[])[]
  /** Rows in the used range before `maxRows` was applied. */
  readonly totalRows: number
  /** Used columns (`A` → 1). */
  readonly firstColumn: number
  readonly lastColumn: number
  /** 1-based number of the first used row. */
  readonly firstRow: number
}

/** Options of {@link extractXlsx}. */
export interface XlsxOptions {
  /** Only this sheet (exact name). */
  readonly sheet?: string
  /** Rows per sheet; default {@link DEFAULT_MAX_ROWS}. */
  readonly maxRows?: number
}

interface SheetEntry {
  readonly name: string
  readonly path: string
}

/** `A1` → `{ column: 1, row: 1 }`; `undefined` for a malformed reference. Pure. */
export function parseCellRef(ref: string): { column: number; row: number } | undefined {
  const match = /^([A-Z]{1,3})(\d+)$/.exec(ref.replace(/\$/g, '').toUpperCase())
  if (!match) return undefined
  let column = 0
  for (const ch of match[1]!) column = column * 26 + (ch.charCodeAt(0) - 64)
  return { column, row: Number(match[2]) }
}

/** `1` → `A`, `28` → `AB`. Pure. */
export function columnName(column: number): string {
  let name = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Quote a CSV field when needed. Pure. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

/** Whether a number format code shows a date or time. Pure. */
export function isDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '')
  return /[ymdhs]/i.test(stripped) && !/^general$/i.test(stripped.trim())
}

/**
 * Excel serial date → ISO text: date only for whole days, date-time
 * otherwise, time only below one day. Pure.
 */
export function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const ms = Math.round(serial * 86_400_000)
  const date = new Date(epoch + ms)
  const iso = date.toISOString()
  if (serial >= 0 && serial < 1 && !date1904) return iso.slice(11, 19)
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19)
}

function relationshipTargets(xml: string | undefined, base: string): Map<string, string> {
  const map = new Map<string, string>()
  if (xml === undefined) return map
  for (const event of scanXml(xml)) {
    if (event.kind !== 'open' || localName(event.name) !== 'Relationship') continue
    const id = event.attrs['Id']
    const target = event.attrs['Target']
    if (id === undefined || target === undefined) continue
    map.set(id, target.startsWith('/') ? target.slice(1) : normalizePath(`${base}/${target}`))
  }
  return map
}

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function readWorkbook(parts: ZipParts): { sheets: SheetEntry[]; date1904: boolean } {
  const xml = partText(parts, 'xl/workbook.xml')
  if (xml === undefined) throw new DocumentError('not a valid .xlsx file (no xl/workbook.xml part)')
  const rels = relationshipTargets(partText(parts, 'xl/_rels/workbook.xml.rels'), 'xl')
  const sheets: SheetEntry[] = []
  let date1904 = false
  for (const event of scanXml(xml)) {
    if (event.kind !== 'open') continue
    const name = localName(event.name)
    if (name === 'workbookPr') date1904 = event.attrs['date1904'] === '1' || event.attrs['date1904'] === 'true'
    if (name !== 'sheet') continue
    const rid = Object.entries(event.attrs).find(([key]) => localName(key) === 'id' && key.includes(':'))?.[1]
    const path = rid === undefined ? undefined : rels.get(rid)
    if (path !== undefined && event.attrs['name'] !== undefined) sheets.push({ name: event.attrs['name'], path })
  }
  return { sheets, date1904 }
}

function readSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return []
  const strings: string[] = []
  let current: string | undefined
  let inText = false
  let phoneticDepth = 0
  for (const event of scanXml(xml)) {
    if (event.kind === 'text') {
      if (inText && phoneticDepth === 0 && current !== undefined) current += event.text
      continue
    }
    const name = localName(event.name)
    if (event.kind === 'open') {
      if (name === 'si') current = event.selfClosing ? undefined : ''
      if (name === 'si' && event.selfClosing) strings.push('')
      if (name === 'rPh' && !event.selfClosing) phoneticDepth++
      if (name === 't') inText = !event.selfClosing
    } else {
      if (name === 'rPh') phoneticDepth = Math.max(0, phoneticDepth - 1)
      if (name === 't') inText = false
      if (name === 'si' && current !== undefined) {
        strings.push(current)
        current = undefined
      }
    }
  }
  return strings
}

/** Style index → whether that cell format shows a date. */
function readDateStyles(xml: string | undefined): boolean[] {
  if (xml === undefined) return []
  const custom = new Map<number, string>()
  const styles: boolean[] = []
  let inCellXfs = false
  for (const event of scanXml(xml)) {
    if (event.kind === 'text') continue
    const name = localName(event.name)
    if (event.kind === 'close') {
      if (name === 'cellXfs') inCellXfs = false
      continue
    }
    if (name === 'numFmt') {
      const id = Number(event.attrs['numFmtId'])
      if (Number.isInteger(id)) custom.set(id, event.attrs['formatCode'] ?? '')
    } else if (name === 'cellXfs') {
      inCellXfs = !event.selfClosing
    } else if (name === 'xf' && inCellXfs) {
      const id = Number(event.attrs['numFmtId'] ?? '0')
      const code = custom.get(id)
      styles.push(code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormat(code))
    }
  }
  return styles
}

interface CellContext {
  readonly shared: readonly string[]
  readonly dateStyles: readonly boolean[]
  readonly date1904: boolean
}

function cellValue(type: string, raw: string, inline: string | undefined, style: number, context: CellContext): string {
  switch (type) {
    case 's': {
      const index = Number(raw)
      return Number.isInteger(index) ? context.shared[index] ?? '' : ''
    }
    case 'inlineStr':
      return inline ?? ''
    case 'str':
    case 'e':
      return raw
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw
    case 'd':
      return raw
    default: {
      if (raw === '') return ''
      const number = Number(raw)
      if (Number.isFinite(number) && context.dateStyles[style] === true) return serialToIso(number, context.date1904)
      return raw
    }
  }
}

function readSheet(name: string, xml: string, context: CellContext, maxRows: number): SheetTable {
  const cells = new Map<number, Map<number, string>>()
  let firstRow = Number.POSITIVE_INFINITY
  let lastRow = 0
  let firstColumn = Number.POSITIVE_INFINITY
  let lastColumn = 0
  let rowNumber = 0
  let columnCursor = 0
  let cell: { column: number; row: number; type: string; style: number } | undefined
  let raw = ''
  let inline: string | undefined
  let capture: 'v' | 't' | undefined

  for (const event of scanXml(xml)) {
    if (event.kind === 'text') {
      if (capture === 'v') raw += event.text
      else if (capture === 't' && inline !== undefined) inline += event.text
      continue
    }
    const local = localName(event.name)
    if (event.kind === 'open') {
      if (local === 'row') {
        const r = Number(event.attrs['r'])
        rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1
        columnCursor = 0
      } else if (local === 'c') {
        const ref = event.attrs['r'] === undefined ? undefined : parseCellRef(event.attrs['r'])
        const column = ref?.column ?? columnCursor + 1
        columnCursor = column
        cell = { column, row: ref?.row ?? rowNumber, type: event.attrs['t'] ?? 'n', style: Number(event.attrs['s'] ?? '0') }
        raw = ''
        inline = undefined
        if (event.selfClosing) cell = undefined
      } else if (local === 'v' && cell !== undefined) {
        capture = event.selfClosing ? undefined : 'v'
      } else if (local === 'is' && cell !== undefined) {
        inline = ''
      } else if (local === 't' && inline !== undefined) {
        capture = event.selfClosing ? undefined : 't'
      }
      continue
    }
    if (local === 'v' || local === 't') capture = undefined
    if (local === 'c' && cell !== undefined) {
      const value = cellValue(cell.type, raw, inline, cell.style, context)
      if (value !== '') {
        let row = cells.get(cell.row)
        if (row === undefined) cells.set(cell.row, (row = new Map()))
        row.set(cell.column, value)
        firstRow = Math.min(firstRow, cell.row)
        lastRow = Math.max(lastRow, cell.row)
        firstColumn = Math.min(firstColumn, cell.column)
        lastColumn = Math.max(lastColumn, cell.column)
      }
      cell = undefined
    }
  }
  if (lastRow === 0) return { name, rows: [], totalRows: 0, firstColumn: 1, lastColumn: 0, firstRow: 1 }
  const totalRows = lastRow - firstRow + 1
  const rows: string[][] = []
  for (let r = firstRow; r <= lastRow && rows.length < maxRows; r++) {
    const source = cells.get(r)
    const row: string[] = []
    for (let c = firstColumn; c <= lastColumn; c++) row.push(source?.get(c) ?? '')
    rows.push(row)
  }
  return { name, rows, totalRows, firstColumn, lastColumn, firstRow }
}

/** Read the sheets of an `.xlsx` package. @throws {@link DocumentError}. */
export function readXlsx(data: Uint8Array, options: XlsxOptions = {}): SheetTable[] {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const parts = readZipParts(data, path => path.startsWith('xl/') && (path.endsWith('.xml') || path.endsWith('.rels')), '.xlsx')
  try {
    const { sheets, date1904 } = readWorkbook(parts)
    const selected = options.sheet === undefined ? sheets : sheets.filter(sheet => sheet.name === options.sheet)
    if (options.sheet !== undefined && selected.length === 0) {
      throw new DocumentError(`no sheet named ${JSON.stringify(options.sheet)}; sheets: ${sheets.map(sheet => JSON.stringify(sheet.name)).join(', ') || '(none)'}`)
    }
    const context: CellContext = {
      shared: readSharedStrings(partText(parts, 'xl/sharedStrings.xml')),
      dateStyles: readDateStyles(partText(parts, 'xl/styles.xml')),
      date1904,
    }
    return selected.map(sheet => {
      const xml = partText(parts, sheet.path)
      if (xml === undefined) throw new DocumentError(`not a valid .xlsx file (sheet ${JSON.stringify(sheet.name)} has no part ${sheet.path})`)
      return readSheet(sheet.name, xml, context, maxRows)
    })
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(`not a valid .xlsx file (${(error as Error).message})`)
  }
}

/** Render sheets as text: a heading per sheet, then CSV rows. Pure. */
export function renderSheets(sheets: readonly SheetTable[]): string {
  return sheets.map(sheet => {
    if (sheet.rows.length === 0) return `## Sheet: ${sheet.name}\n(empty)`
    const range = `${columnName(sheet.firstColumn)}${sheet.firstRow}:${columnName(sheet.lastColumn)}${sheet.firstRow + sheet.totalRows - 1}`
    const lines = [`## Sheet: ${sheet.name} (range ${range}, ${sheet.totalRows} rows × ${sheet.lastColumn - sheet.firstColumn + 1} columns)`]
    for (const row of sheet.rows) lines.push(row.map(csvField).join(','))
    if (sheet.rows.length < sheet.totalRows) {
      lines.push(`[showing the first ${sheet.rows.length} of ${sheet.totalRows} rows; pass maxRows to see more]`)
    }
    return lines.join('\n')
  }).join('\n\n')
}

/** Extract an `.xlsx` package as text. */
export function extractXlsx(data: Uint8Array, options: XlsxOptions = {}): string {
  return renderSheets(readXlsx(data, options))
}
