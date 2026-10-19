/**
 * Load an `.xlsx` file into a {@link SheetData} workbook: typed cells from
 * `@nexgent/skill`'s reader, shared formulas expanded to each cell, error
 * caches turned into error values. Array and data-table formulas keep their
 * saved values (they are not recalculated).
 */
import { readXlsxCells, type XlsxCell } from '@nexgent/skill'
import { translateFormula, type ErrorCode, ERROR_CODES } from './formula/lexer.js'
import { FormulaError, type Scalar } from './formula/values.js'
import { cellKey, type CellEntry, type SheetData } from './workbook.js'

/** Most used cells a workbook may have to be read. */
export const MAX_READ_CELLS = 500_000

/** A loaded workbook plus what was kept as saved. */
export interface LoadedWorkbook {
  readonly sheets: SheetData[]
  readonly date1904: boolean
  /** Cells whose formula is kept as saved and not recalculated (array / data-table formulas). */
  readonly keptAsSaved: readonly { readonly sheet: string; readonly row: number; readonly column: number; readonly reason: string }[]
}

function cachedValue(cell: XlsxCell): Scalar {
  if (cell.error === true) {
    const code = String(cell.value).toUpperCase()
    return new FormulaError((ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : '#VALUE!')
  }
  return cell.value
}

/** Parse workbook bytes. @throws `DocumentError` (from `@nexgent/skill`) for a damaged file or one over {@link MAX_READ_CELLS}. */
export function loadWorkbook(data: Uint8Array): LoadedWorkbook {
  const book = readXlsxCells(data, { maxCells: MAX_READ_CELLS })
  const keptAsSaved: { sheet: string; row: number; column: number; reason: string }[] = []
  const sheets = book.sheets.map(sheet => {
    const masters = new Map<string, { text: string; row: number; column: number }>()
    for (const cell of sheet.cells) {
      if (cell.formula?.kind === 'shared' && cell.formula.text !== undefined && cell.formula.sharedIndex !== undefined) {
        masters.set(cell.formula.sharedIndex, { text: cell.formula.text, row: cell.row, column: cell.column })
      }
    }
    const cells = new Map<string, CellEntry>()
    for (const cell of sheet.cells) {
      const value = cachedValue(cell)
      const base = { value, ...(cell.date === true ? { date: true } : {}) }
      let formula: string | undefined
      const f = cell.formula
      if (f !== undefined) {
        if (f.kind === 'normal') formula = f.text
        else if (f.kind === 'shared') {
          const master = f.sharedIndex === undefined ? undefined : masters.get(f.sharedIndex)
          if (f.text !== undefined) formula = f.text
          else if (master !== undefined) {
            try {
              formula = translateFormula(master.text, cell.row - master.row, cell.column - master.column)
            } catch {
              // Untranslatable (refused syntax): keep the master's text so the calculator reports the same reason.
              formula = master.text
            }
          }
        } else if (f.kind === 'array' && (f.ref === undefined || !f.ref.includes(':')) && f.text !== undefined) {
          formula = f.text
        } else {
          keptAsSaved.push({ sheet: sheet.name, row: cell.row, column: cell.column, reason: `${f.kind === 'array' ? 'array' : 'data table'} formula kept as saved` })
        }
      }
      if (formula !== undefined && formula.trim() !== '') cells.set(cellKey(cell.row, cell.column), { ...base, formula })
      else if (value !== null) cells.set(cellKey(cell.row, cell.column), base)
    }
    return { name: sheet.name, cells }
  })
  return { sheets, date1904: book.date1904, keptAsSaved }
}
