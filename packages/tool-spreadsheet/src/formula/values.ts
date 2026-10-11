/**
 * Formula values and Excel's coercion rules: numbers, text, booleans, error
 * values, blanks (`null`), and rectangular arrays (what a range evaluates
 * to). Pure.
 */
import type { ErrorCode } from './lexer.js'

/** An error value (`#DIV/0!`, …); propagates through calculations like Excel's. */
export class FormulaError {
  constructor(readonly code: ErrorCode) {}
  toString(): string {
    return this.code
  }
}

/** One cell value; `null` is a blank cell. */
export type Scalar = number | string | boolean | FormulaError | null

/** A rectangular block of values (a range, or an array intermediate). */
export class ArrayValue {
  constructor(readonly rows: readonly (readonly Scalar[])[]) {}
  get height(): number {
    return this.rows.length
  }
  get width(): number {
    return this.rows[0]?.length ?? 0
  }
  at(row: number, column: number): Scalar {
    return this.rows[row]?.[column] ?? null
  }
  *values(): Generator<Scalar> {
    for (const row of this.rows) yield* row
  }
}

/** What an expression evaluates to. */
export type Value = Scalar | ArrayValue

export const errors = {
  div0: new FormulaError('#DIV/0!'),
  value: new FormulaError('#VALUE!'),
  ref: new FormulaError('#REF!'),
  name: new FormulaError('#NAME?'),
  num: new FormulaError('#NUM!'),
  na: new FormulaError('#N/A'),
  null: new FormulaError('#NULL!'),
} as const

export function isError(value: unknown): value is FormulaError {
  return value instanceof FormulaError
}

/** Clean a double to 15 significant digits (Excel's precision), e.g. `0.1 + 0.2` → `0.3`. */
export function clean(value: number): number {
  return value === 0 || !Number.isFinite(value) ? value : Number(value.toPrecision(15))
}

/** A finite number, else `#NUM!`. */
export function finite(value: number): number | FormulaError {
  return Number.isFinite(value) ? value : errors.num
}

/** Text → number the way Excel coerces typed text (`" 12 "`, `"1e3"`, `"50%"`); `undefined` when not numeric. */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const percent = trimmed.endsWith('%')
  const body = percent ? trimmed.slice(0, -1).trim() : trimmed
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(body)) return undefined
  const number = Number(body)
  return percent ? number / 100 : number
}

/** Scalar → number; blank is 0, booleans 1 / 0, numeric text parsed; otherwise `#VALUE!`. */
export function toNumber(value: Scalar): number | FormulaError {
  if (value === null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') return parseNumber(value) ?? errors.value
  return value
}

/** Number → text as Excel's General format shows it in a formula (up to 15 significant digits). */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const cleaned = clean(value)
  const text = String(cleaned)
  return text.includes('e') ? text.replace('e', 'E').replace(/E(\d)/, 'E+$1') : text
}

/** Scalar → text; blank is `""`, booleans `TRUE` / `FALSE`. */
export function toText(value: Scalar): string | FormulaError {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return value
}

/** Scalar → boolean; blank is FALSE, numbers non-zero, text `TRUE` / `FALSE`; otherwise `#VALUE!`. */
export function toBoolean(value: Scalar): boolean | FormulaError {
  if (value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase()
    if (upper === 'TRUE') return true
    if (upper === 'FALSE') return false
    return errors.value
  }
  return value
}

/** Reduce a value to a scalar: a 1×1 array is its cell; a larger array is `#VALUE!`. */
export function toScalar(value: Value): Scalar {
  if (!(value instanceof ArrayValue)) return value
  if (value.height === 1 && value.width === 1) return value.at(0, 0)
  return errors.value
}

/** Type rank for comparisons: numbers < text < booleans. */
function rank(value: number | string | boolean): number {
  return typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2
}

/**
 * Compare two non-error scalars as Excel's `=` / `<` do: a blank takes the
 * other side's empty value, text compares case-insensitively, and different
 * types order numbers < text < booleans. Returns -1, 0 or 1.
 */
export function compare(a: Exclude<Scalar, FormulaError>, b: Exclude<Scalar, FormulaError>): number {
  const left = a ?? (b === null ? 0 : typeof b === 'number' ? 0 : typeof b === 'string' ? '' : false)
  const right = b ?? (typeof left === 'number' ? 0 : typeof left === 'string' ? '' : false)
  if (rank(left) !== rank(right)) return rank(left) < rank(right) ? -1 : 1
  if (typeof left === 'string') {
    const x = left.toUpperCase()
    const y = (right as string).toUpperCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (typeof left === 'number') return left < (right as number) ? -1 : left > (right as number) ? 1 : 0
  return left === right ? 0 : left ? 1 : -1
}
