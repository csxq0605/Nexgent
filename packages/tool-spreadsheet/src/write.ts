/**
 * Build an `.xlsx` file from sheets of rows: literals and live formulas,
 * each formula stored with the value the calculator computed for it (so
 * readers that do not recalculate, `read_document` included, see real
 * numbers), and `fullCalcOnLoad` set so Excel / LibreOffice recalculate on
 * open. Validation and calculation happen before any byte is produced: a
 * workbook that cannot be calculated is refused, never written with
 * made-up caches.
 */
import { zipSync, strToU8 } from 'fflate'
import { columnLetters, toFileFormula } from './formula/lexer.js'
import { FormulaError, type Scalar } from './formula/values.js'
import { Calculator, cellKey, type CellEntry, type SheetData } from './workbook.js'

/** Limits of one written workbook. */
export const WRITE_LIMITS = {
  sheets: 32,
  rowsPerSheet: 10_000,
  columnsPerSheet: 256,
  cells: 100_000,
  textLength: 32_767,
} as const

/** A JSON cell: a number, text (`=…` is a formula, `'=…` is literal text starting with `=`), a boolean, or `null` for empty. */
export type CellInput = number | string | boolean | null

/** One sheet to write. */
export interface SheetInput {
  readonly name: string
  readonly rows: readonly (readonly CellInput[])[]
  /** Show the first row bold and keep it visible when scrolling (default true). */
  readonly headerRow?: boolean
}

/** Invalid input, with a message for the model. */
export class SpreadsheetInputError extends Error {
  override readonly name = 'SpreadsheetInputError'
}

/** What was written. */
export interface WrittenWorkbook {
  readonly bytes: Uint8Array
  readonly sheets: readonly { readonly name: string; readonly rows: number; readonly columns: number; readonly formulas: number }[]
  /** Calculated values of the formula cells, by sheet then `A1` address. */
  readonly values: Readonly<Record<string, Readonly<Record<string, Scalar>>>>
}

const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

function checkSheetName(name: unknown, seen: Set<string>): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > 31) throw new SpreadsheetInputError('sheet names must be 1–31 characters')
  if (/[[\]:*?/\\]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
    throw new SpreadsheetInputError(`sheet name ${JSON.stringify(name)} may not contain [ ] : * ? / \\ or start / end with an apostrophe`)
  }
  if (INVALID_XML.test(name)) throw new SpreadsheetInputError(`sheet name ${JSON.stringify(name)} contains control characters`)
  if (name.toLowerCase() === 'history') throw new SpreadsheetInputError('"History" is reserved by Excel; choose another sheet name')
  if (seen.has(name.toUpperCase())) throw new SpreadsheetInputError(`duplicate sheet name ${JSON.stringify(name)} (names are case-insensitive)`)
  seen.add(name.toUpperCase())
  return name
}

/** Validate sheets and turn them into calculator input. @throws {@link SpreadsheetInputError}. */
export function sheetsFromInput(input: unknown): { sheets: SheetData[]; headerRows: boolean[] } {
  if (!Array.isArray(input) || input.length === 0) throw new SpreadsheetInputError('"sheets" must be a non-empty array')
  if (input.length > WRITE_LIMITS.sheets) throw new SpreadsheetInputError(`at most ${WRITE_LIMITS.sheets} sheets`)
  const seen = new Set<string>()
  let total = 0
  const sheets: SheetData[] = []
  const headerRows: boolean[] = []
  for (const raw of input as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SpreadsheetInputError('each sheet must be an object { name, rows }')
    const sheet = raw as Record<string, unknown>
    const name = checkSheetName(sheet.name, seen)
    const rows = sheet.rows
    if (!Array.isArray(rows) || rows.length === 0) throw new SpreadsheetInputError(`sheet ${JSON.stringify(name)}: "rows" must be a non-empty array of rows`)
    if (rows.length > WRITE_LIMITS.rowsPerSheet) throw new SpreadsheetInputError(`sheet ${JSON.stringify(name)}: at most ${WRITE_LIMITS.rowsPerSheet} rows`)
    if (sheet.headerRow !== undefined && typeof sheet.headerRow !== 'boolean') throw new SpreadsheetInputError(`sheet ${JSON.stringify(name)}: "headerRow" must be a boolean`)
    const cells = new Map<string, CellEntry>()
    rows.forEach((row: unknown, r) => {
      if (!Array.isArray(row)) throw new SpreadsheetInputError(`sheet ${JSON.stringify(name)} row ${r + 1}: each row must be an array of cells`)
      if (row.length > WRITE_LIMITS.columnsPerSheet) throw new SpreadsheetInputError(`sheet ${JSON.stringify(name)} row ${r + 1}: at most ${WRITE_LIMITS.columnsPerSheet} columns`)
      row.forEach((value: unknown, c) => {
        const at = `${name}!${columnLetters(c + 1)}${r + 1}`
        if (value === null || value === undefined || value === '') return
        if (++total > WRITE_LIMITS.cells) throw new SpreadsheetInputError(`at most ${WRITE_LIMITS.cells} non-empty cells per workbook`)
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new SpreadsheetInputError(`${at}: numbers must be finite`)
          cells.set(cellKey(r + 1, c + 1), { value: Object.is(value, -0) ? 0 : value })
        } else if (typeof value === 'boolean') {
          cells.set(cellKey(r + 1, c + 1), { value })
        } else if (typeof value === 'string') {
          if (value.length > WRITE_LIMITS.textLength) throw new SpreadsheetInputError(`${at}: text is longer than ${WRITE_LIMITS.textLength} characters`)
          if (INVALID_XML.test(value)) throw new SpreadsheetInputError(`${at}: text contains control characters`)
          if (value.startsWith('=') && value.length > 1) cells.set(cellKey(r + 1, c + 1), { value: null, formula: value.slice(1) })
          else cells.set(cellKey(r + 1, c + 1), { value: value.startsWith("'=") ? value.slice(1) : value })
        } else {
          throw new SpreadsheetInputError(`${at}: cells must be numbers, text, booleans or null`)
        }
      })
    })
    sheets.push({ name, cells })
    headerRows.push(sheet.headerRow !== false)
  }
  return { sheets, headerRows }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>'

/** Fixed timestamp for the archive entries, so equal input gives equal bytes. */
const ZIP_TIME = new Date('2026-01-01T00:00:00Z')

/**
 * Calculate and serialise a workbook.
 * @throws {@link SpreadsheetInputError} for invalid input; `CalculationError` when a formula cannot be calculated.
 */
export function buildWorkbook(input: unknown): WrittenWorkbook {
  const { sheets, headerRows } = sheetsFromInput(input)
  const calculated = new Calculator(sheets, { strict: true }).calculateAll()
  const shared: string[] = []
  const sharedIndex = new Map<string, number>()
  const stringId = (text: string): number => {
    let id = sharedIndex.get(text)
    if (id === undefined) {
      id = shared.length
      shared.push(text)
      sharedIndex.set(text, id)
    }
    return id
  }
  const files: Record<string, Uint8Array> = {}
  const summary: { name: string; rows: number; columns: number; formulas: number }[] = []
  const values: Record<string, Record<string, Scalar>> = {}
  sheets.forEach((sheet, index) => {
    const formulaValues = calculated.get(sheet.name)!
    const sheetValues: Record<string, Scalar> = {}
    const header = headerRows[index]!
    const byRow = new Map<number, [number, CellEntry][]>()
    let maxRow = 0
    let maxColumn = 0
    for (const [key, entry] of sheet.cells) {
      const [r, c] = key.split(',').map(Number) as [number, number]
      maxRow = Math.max(maxRow, r)
      maxColumn = Math.max(maxColumn, c)
      let list = byRow.get(r)
      if (list === undefined) byRow.set(r, (list = []))
      list.push([c, entry])
    }
    const widths = new Map<number, number>()
    let rowsXml = ''
    for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
      let cellsXml = ''
      for (const [c, entry] of byRow.get(r)!.sort((a, b) => a[0] - b[0])) {
        const ref = `${columnLetters(c)}${r}`
        const style = header && r === 1 ? ' s="1"' : ''
        let display: string
        if (entry.formula !== undefined) {
          const value = formulaValues.get(cellKey(r, c))!
          sheetValues[ref] = value
          const f = `<f>${escapeXml(toFileFormula(entry.formula))}</f>`
          if (typeof value === 'number') cellsXml += `<c r="${ref}"${style}>${f}<v>${String(value)}</v></c>`
          else if (typeof value === 'boolean') cellsXml += `<c r="${ref}"${style} t="b">${f}<v>${value ? 1 : 0}</v></c>`
          else if (typeof value === 'string') cellsXml += `<c r="${ref}"${style} t="str">${f}<v>${escapeXml(value)}</v></c>`
          else throw new Error(`unexpected value at ${ref}: ${value instanceof FormulaError ? value.code : String(value)}`)
          display = String(value)
        } else if (typeof entry.value === 'number') {
          cellsXml += `<c r="${ref}"${style}><v>${String(entry.value)}</v></c>`
          display = String(entry.value)
        } else if (typeof entry.value === 'boolean') {
          cellsXml += `<c r="${ref}"${style} t="b"><v>${entry.value ? 1 : 0}</v></c>`
          display = entry.value ? 'TRUE' : 'FALSE'
        } else {
          const text = String(entry.value)
          cellsXml += `<c r="${ref}"${style} t="s"><v>${stringId(text)}</v></c>`
          display = text
        }
        widths.set(c, Math.max(widths.get(c) ?? 0, Math.min(60, Math.max(...display.split('\n').map(line => line.length)))))
      }
      rowsXml += `<row r="${r}">${cellsXml}</row>`
    }
    const dimension = maxRow === 0 ? 'A1' : `A1:${columnLetters(maxColumn)}${maxRow}`
    const pane = header && maxRow > 1
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
      : ''
    const cols = [...widths.entries()].sort((a, b) => a[0] - b[0])
      .map(([c, w]) => `<col min="${c}" max="${c}" width="${Math.max(9, Math.round((w + 2) * 1.1))}" customWidth="1"/>`).join('')
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(`${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
      + `<dimension ref="${dimension}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + (cols === '' ? '' : `<cols>${cols}</cols>`)
      + `<sheetData>${rowsXml}</sheetData>`
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + '</worksheet>')
    summary.push({ name: sheet.name, rows: maxRow, columns: maxColumn, formulas: formulaValues.size })
    values[sheet.name] = sheetValues
  })

  const sheetEntries = sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  const workbook = `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews>`
    + `<sheets>${sheetEntries}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`
  const rels = `${XML_HEAD}<Relationships xmlns="${PKG_REL}">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>'
  const sharedXml = `${XML_HEAD}<sst xmlns="${MAIN}" count="${shared.length}" uniqueCount="${shared.length}">`
    + shared.map(text => `<si><t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ''}>${escapeXml(text)}</t></si>`).join('')
    + '</sst>'
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '</Types>'
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(`${XML_HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/styles.xml': strToU8(STYLES),
    'xl/sharedStrings.xml': strToU8(sharedXml),
    ...files,
  }, { level: 6, mtime: ZIP_TIME })
  return { bytes, sheets: summary, values }
}
