/**
 * Formula evaluation: operators with Excel's coercions and array
 * broadcasting, references through an {@link EvalContext}, and the function
 * table in `functions.ts`. Error values (`#DIV/0!`, …) are ordinary results
 * here; refusing them is the caller's decision. Unsupported features throw
 * {@link FormulaUnsupported}.
 */
import { FormulaUnsupported, quoteSheet, columnLetters } from './lexer.js'
import type { Expr } from './parser.js'
import {
  ArrayValue,
  compare,
  errors,
  finite,
  isError,
  toNumber,
  toText,
  type Scalar,
  type Value,
} from './values.js'

/** Most cells one range reference may span. */
export const MAX_RANGE_CELLS = 200_000

/** What evaluation needs from the workbook. */
export interface EvalContext {
  /** Sheet the formula belongs to (references without a sheet point here). */
  readonly sheet: string
  /** The workbook's own spelling of a sheet name (matched case-insensitively), or `undefined`. */
  resolveSheet(name: string): string | undefined
  /** A cell's value, evaluating its formula first when it has one. */
  cell(sheet: string, row: number, column: number): Scalar
}

/** An evaluated argument: its value and whether it came from a reference (which changes how some functions treat text). */
export interface Arg {
  readonly value: Value
  readonly isRef: boolean
  readonly missing: boolean
}

/** Evaluates sub-expressions for functions (lazy functions evaluate only the branches they need). */
export interface Evaluator {
  readonly context: EvalContext
  eval(expr: Expr): Value
  arg(expr: Expr): Arg
}

/** A spreadsheet function. */
export interface FormulaFunction {
  readonly min: number
  readonly max: number
  call(args: readonly Expr[], evaluator: Evaluator): Value
}

/** Evaluate an expression. */
export function evaluate(expr: Expr, context: EvalContext, functions: ReadonlyMap<string, FormulaFunction>): Value {
  const evaluator: Evaluator = {
    context,
    eval: node => evalNode(node),
    arg: node => ({
      value: node.kind === 'missing' ? null : evalNode(node),
      isRef: node.kind === 'ref',
      missing: node.kind === 'missing',
    }),
  }

  const sheetOf = (name: string | undefined): string => {
    if (name === undefined) return context.sheet
    const resolved = context.resolveSheet(name)
    if (resolved === undefined) throw new FormulaUnsupported(`the formula refers to a sheet that does not exist: ${quoteSheet(name)}`)
    return resolved
  }

  const evalNode = (node: Expr): Value => {
    switch (node.kind) {
      case 'number':
      case 'string':
      case 'bool':
        return node.value
      case 'error':
        return errors[({ '#DIV/0!': 'div0', '#VALUE!': 'value', '#REF!': 'ref', '#NAME?': 'name', '#NUM!': 'num', '#N/A': 'na', '#NULL!': 'null' } as const)[node.value]]
      case 'missing':
        return null
      case 'ref': {
        const sheet = sheetOf(node.sheet)
        if (node.to === undefined) return context.cell(sheet, node.from.row, node.from.column)
        const top = Math.min(node.from.row, node.to.row)
        const bottom = Math.max(node.from.row, node.to.row)
        const left = Math.min(node.from.column, node.to.column)
        const right = Math.max(node.from.column, node.to.column)
        if ((bottom - top + 1) * (right - left + 1) > MAX_RANGE_CELLS) {
          throw new FormulaUnsupported(`range ${columnLetters(left)}${top}:${columnLetters(right)}${bottom} spans more than ${MAX_RANGE_CELLS} cells`)
        }
        const rows: Scalar[][] = []
        for (let r = top; r <= bottom; r++) {
          const row: Scalar[] = []
          for (let c = left; c <= right; c++) row.push(context.cell(sheet, r, c))
          rows.push(row)
        }
        return new ArrayValue(rows)
      }
      case 'unary':
        return map1(evalNode(node.operand), value => {
          const number = toNumber(value)
          if (isError(number)) return number
          return node.op === '-' ? -number : number
        })
      case 'percent':
        return map1(evalNode(node.operand), value => {
          const number = toNumber(value)
          return isError(number) ? number : number / 100
        })
      case 'binary':
        return map2(evalNode(node.left), evalNode(node.right), (a, b) => binary(node.op, a, b))
      case 'call': {
        const fn = functions.get(node.name)
        if (fn === undefined) throw new FormulaUnsupported(`function ${node.name} is not supported`)
        if (node.args.length < fn.min || node.args.length > fn.max) {
          throw new FormulaUnsupported(`${node.name} takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max === Infinity ? 'any number of' : fn.max}`} arguments, got ${node.args.length}`)
        }
        return fn.call(node.args, evaluator)
      }
    }
  }

  return evalNode(expr)
}

/** Apply a scalar function to every element. */
export function map1(value: Value, f: (value: Scalar) => Scalar): Value {
  if (!(value instanceof ArrayValue)) return f(value)
  return new ArrayValue(value.rows.map(row => row.map(f)))
}

/**
 * Apply a binary scalar function with Excel's broadcasting: a single row or
 * column stretches along the other operand; cells outside both shapes are `#N/A`.
 */
export function map2(left: Value, right: Value, f: (a: Scalar, b: Scalar) => Scalar): Value {
  if (!(left instanceof ArrayValue) && !(right instanceof ArrayValue)) return f(left, right)
  const shape = (value: Value) => (value instanceof ArrayValue ? { h: value.height, w: value.width } : { h: 1, w: 1 })
  const a = shape(left)
  const b = shape(right)
  const height = Math.max(a.h, b.h)
  const width = Math.max(a.w, b.w)
  const pick = (value: Value, dims: { h: number; w: number }, r: number, c: number): Scalar | undefined => {
    if (!(value instanceof ArrayValue)) return value
    const row = dims.h === 1 ? 0 : r
    const column = dims.w === 1 ? 0 : c
    if (row >= dims.h || column >= dims.w) return undefined
    return value.at(row, column)
  }
  const rows: Scalar[][] = []
  for (let r = 0; r < height; r++) {
    const row: Scalar[] = []
    for (let c = 0; c < width; c++) {
      const x = pick(left, a, r, c)
      const y = pick(right, b, r, c)
      row.push(x === undefined || y === undefined ? errors.na : f(x, y))
    }
    rows.push(row)
  }
  return new ArrayValue(rows)
}

/** One binary operator on scalars. */
export function binary(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a
  if (isError(b)) return b
  switch (op) {
    case '&': {
      return `${toText(a) as string}${toText(b) as string}`
    }
    case '=':
    case '<>':
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const order = compare(a, b)
      return op === '=' ? order === 0 : op === '<>' ? order !== 0 : op === '<' ? order < 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order >= 0
    }
    default: {
      const x = toNumber(a)
      if (isError(x)) return x
      const y = toNumber(b)
      if (isError(y)) return y
      switch (op) {
        case '+':
          return finite(x + y)
        case '-':
          return finite(x - y)
        case '*':
          return finite(x * y)
        case '/':
          return y === 0 ? errors.div0 : finite(x / y)
        case '^':
          if (x === 0 && y === 0) return errors.num
          if (x === 0 && y < 0) return errors.div0
          return finite(x ** y)
        default:
          throw new FormulaUnsupported(`operator ${op} is not supported`)
      }
    }
  }
}
