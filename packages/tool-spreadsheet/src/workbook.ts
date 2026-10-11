/**
 * The in-memory workbook (sheets of literal and formula cells) and its
 * calculator. Formula cells are evaluated on demand with memoisation and
 * cycle detection.
 *
 * - `strict` (writing): every formula must parse, use only supported
 *   features and evaluate to a non-error scalar, or the whole calculation
 *   fails with {@link CalculationError} naming the cell. A file is never
 *   written with a made-up cached value.
 * - lenient (reading): a formula the engine cannot evaluate keeps the value
 *   last saved in the file and is reported in {@link Calculator.issues};
 *   error values are ordinary results.
 */
import { evaluate, type EvalContext } from './formula/evaluate.js'
import { FUNCTIONS } from './formula/functions.js'
import { columnLetters, FormulaUnsupported, quoteSheet } from './formula/lexer.js'
import { parseFormula, type Expr } from './formula/parser.js'
import { ArrayValue, errors, FormulaError, isError, type Scalar } from './formula/values.js'

/** One stored cell: a literal, or a formula with the value last saved for it. */
export interface CellEntry {
  /** Literal value, or the cached result of `formula` (`null` when none). */
  readonly value: Scalar
  /** Formula text without the leading `=`. */
  readonly formula?: string
  /** The cell's number format shows a date. */
  readonly date?: boolean
}

/** One worksheet. */
export interface SheetData {
  readonly name: string
  /** Cells by {@link cellKey}. */
  readonly cells: Map<string, CellEntry>
}

/** `row,column` key of a cell. */
export function cellKey(row: number, column: number): string {
  return `${row},${column}`
}

/** `Sheet!B2` (sheet quoted when needed). */
export function cellLabel(sheet: string, row: number, column: number): string {
  return `${quoteSheet(sheet)}!${columnLetters(column)}${row}`
}

/** Used bounds of a sheet (1-based, inclusive); `undefined` for an empty sheet. */
export function usedBounds(sheet: SheetData): { top: number; left: number; bottom: number; right: number } | undefined {
  let top = Infinity
  let left = Infinity
  let bottom = 0
  let right = 0
  for (const key of sheet.cells.keys()) {
    const [r, c] = key.split(',').map(Number) as [number, number]
    top = Math.min(top, r)
    left = Math.min(left, c)
    bottom = Math.max(bottom, r)
    right = Math.max(right, c)
  }
  return bottom === 0 ? undefined : { top, left, bottom, right }
}

/** A formula that could not be calculated. */
export interface CalculationIssue {
  readonly sheet: string
  readonly row: number
  readonly column: number
  readonly formula: string
  readonly message: string
}

/** Strict-mode failure: the cell and why. */
export class CalculationError extends Error {
  override readonly name = 'CalculationError'
  constructor(readonly issue: CalculationIssue) {
    super(`${cellLabel(issue.sheet, issue.row, issue.column)} (=${issue.formula}): ${issue.message}`)
  }
}

class Cycle extends Error {}

/** Evaluates a workbook's formulas. */
export class Calculator {
  readonly issues: CalculationIssue[] = []
  private readonly bySheet = new Map<string, SheetData>()
  private readonly values = new Map<string, Scalar>()
  private readonly parsed = new Map<string, Expr>()
  private readonly active = new Set<string>()

  constructor(readonly sheets: readonly SheetData[], private readonly options: { readonly strict: boolean }) {
    for (const sheet of sheets) this.bySheet.set(sheet.name.toUpperCase(), sheet)
  }

  /** The workbook's spelling of a sheet name, matched case-insensitively. */
  resolveSheet(name: string): string | undefined {
    return this.bySheet.get(name.toUpperCase())?.name
  }

  /** A cell's value; formula cells are evaluated (once). Blank cells are `null`. */
  value(sheetName: string, row: number, column: number): Scalar {
    const sheet = this.bySheet.get(sheetName.toUpperCase())
    if (sheet === undefined) return errors.ref
    const entry = sheet.cells.get(cellKey(row, column))
    if (entry === undefined) return null
    if (entry.formula === undefined) return entry.value
    const key = `${sheet.name.toUpperCase()}!${cellKey(row, column)}`
    const known = this.values.get(key)
    if (known !== undefined || this.values.has(key)) return known ?? null
    if (this.active.has(key)) throw new Cycle(`circular reference through ${cellLabel(sheet.name, row, column)}`)
    this.active.add(key)
    let result: Scalar
    try {
      result = this.compute(sheet, row, column, entry.formula)
    } catch (error) {
      if (error instanceof Cycle && this.active.size > 1) throw error
      const message = error instanceof Cycle || error instanceof FormulaUnsupported || error instanceof SyntaxError
        ? (error instanceof SyntaxError ? `cannot parse the formula: ${error.message}` : error.message)
        : error instanceof RangeError
          ? 'the chain of formulas is too deep to calculate'
          : error instanceof CalculationError
            ? error.message
            : `cannot calculate: ${(error as Error).message}`
      const issue: CalculationIssue = { sheet: sheet.name, row, column, formula: entry.formula, message }
      if (this.options.strict) {
        if (error instanceof CalculationError) throw error
        throw new CalculationError(issue)
      }
      this.issues.push(issue)
      result = entry.value ?? errors.name
    } finally {
      this.active.delete(key)
    }
    this.values.set(key, result)
    return result
  }

  /** Calculate every formula cell, sheet by sheet in row-major order; returns the values by sheet. */
  calculateAll(): Map<string, Map<string, Scalar>> {
    const out = new Map<string, Map<string, Scalar>>()
    for (const sheet of this.sheets) {
      const values = new Map<string, Scalar>()
      const keys = [...sheet.cells.entries()]
        .filter(([, entry]) => entry.formula !== undefined)
        .map(([key]) => key.split(',').map(Number) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      for (const [row, column] of keys) values.set(cellKey(row, column), this.value(sheet.name, row, column))
      out.set(sheet.name, values)
    }
    return out
  }

  private compute(sheet: SheetData, row: number, column: number, formula: string): Scalar {
    let expr = this.parsed.get(formula)
    if (expr === undefined) {
      expr = parseFormula(formula)
      this.parsed.set(formula, expr)
    }
    const context: EvalContext = {
      sheet: sheet.name,
      resolveSheet: name => this.resolveSheet(name),
      cell: (name, r, c) => this.value(name, r, c),
    }
    const raw = evaluate(expr, context, FUNCTIONS)
    let result: Scalar
    if (raw instanceof ArrayValue) {
      if (raw.height !== 1 || raw.width !== 1) {
        throw new FormulaUnsupported(`the formula returns a ${raw.height}×${raw.width} array; array (spill) formulas are not supported — aggregate it (SUM, INDEX, …) or write one formula per cell`)
      }
      result = raw.at(0, 0)
    } else {
      result = raw
    }
    if (result === null) result = 0
    if (typeof result === 'number' && Object.is(result, -0)) result = 0
    if (this.options.strict && isError(result)) {
      throw new CalculationError({ sheet: sheet.name, row, column, formula, message: `the formula evaluates to ${result.code}` })
    }
    return result
  }
}

/** Display text of a value: numbers as JavaScript prints them, booleans `TRUE` / `FALSE`, errors by code. */
export function displayValue(value: Scalar): string {
  if (value === null) return ''
  if (value instanceof FormulaError) return value.code
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}
