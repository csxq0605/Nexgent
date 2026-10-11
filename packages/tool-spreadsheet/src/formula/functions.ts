/**
 * The supported spreadsheet functions, with Excel's semantics for the cases
 * a task workbook meets (aggregates ignore text in ranges, criteria strings
 * like `">=10"` and wildcards, approximate lookups on sorted data, rounding
 * half away from zero at 15 significant digits). Anything not listed here is
 * refused rather than guessed. Volatile functions (`TODAY`, `NOW`, `RAND`)
 * are deliberately absent: their cached value would be stale the moment the
 * file is saved.
 */
import { FormulaUnsupported } from './lexer.js'
import type { Expr } from './parser.js'
import type { Arg, Evaluator, FormulaFunction } from './evaluate.js'
import { map1, map2 } from './evaluate.js'
import {
  ArrayValue,
  clean,
  compare,
  errors,
  finite,
  FormulaError,
  isError,
  parseNumber,
  toBoolean,
  toNumber,
  toScalar,
  toText,
  type Scalar,
  type Value,
} from './values.js'

type Fn = FormulaFunction

const table = new Map<string, Fn>()

function define(names: string | readonly string[], min: number, max: number, call: (args: readonly Expr[], ev: Evaluator) => Value): void {
  for (const name of typeof names === 'string' ? [names] : names) table.set(name, { min, max, call })
}

/** Evaluate every argument. */
function all(args: readonly Expr[], ev: Evaluator): Arg[] {
  return args.map(arg => ev.arg(arg))
}

/** A scalar argument (a 1×1 range collapses; a larger one is `#VALUE!`). */
function scalarArg(expr: Expr | undefined, ev: Evaluator): Scalar {
  return expr === undefined ? null : toScalar(ev.eval(expr))
}

function numberArg(expr: Expr | undefined, ev: Evaluator, fallback?: number): number | FormulaError {
  if (expr === undefined || expr.kind === 'missing') return fallback ?? 0
  return toNumber(scalarArg(expr, ev))
}

function textArg(expr: Expr | undefined, ev: Evaluator): string | FormulaError {
  return toText(scalarArg(expr, ev))
}

/** Values of an argument as a flat list; `ref` tells whether text / booleans in it are "from a range". */
function* scalars(arg: Arg): Generator<{ value: Scalar; ref: boolean }> {
  if (arg.value instanceof ArrayValue) {
    for (const value of arg.value.values()) yield { value, ref: true }
  } else if (!arg.missing) {
    yield { value: arg.value, ref: arg.isRef }
  }
}

/**
 * Numbers for SUM / AVERAGE / MIN / MAX / PRODUCT / MEDIAN: in ranges only
 * numbers count (text, booleans, blanks are skipped); typed arguments are
 * coerced. The first error wins.
 */
function numbers(args: readonly Arg[]): number[] | FormulaError {
  const out: number[] = []
  for (const arg of args) {
    for (const { value, ref } of scalars(arg)) {
      if (isError(value)) return value
      if (ref) {
        if (typeof value === 'number') out.push(value)
        continue
      }
      const number = toNumber(value)
      if (isError(number)) return number
      out.push(number)
    }
  }
  return out
}

function asArray(value: Value): ArrayValue {
  return value instanceof ArrayValue ? value : new ArrayValue([[value]])
}

/** Round half away from zero at `digits` decimals, after cleaning to 15 significant digits. */
function shift(value: number, places: number): number {
  const [mantissa, exponent] = value.toExponential().split('e')
  return Number(`${mantissa}e${Number(exponent) + places}`)
}

function roundWith(mode: 'nearest' | 'up' | 'down', value: number, digits: number): number {
  if (value === 0) return 0
  const sign = value < 0 ? -1 : 1
  const scaled = clean(shift(Math.abs(clean(value)), Math.trunc(digits)))
  const rounded = mode === 'nearest' ? Math.round(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled)
  return sign * shift(rounded, -Math.trunc(digits))
}

// ---------- math and aggregates ----------

define('SUM', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  return isError(list) ? list : clean(list.reduce((sum, n) => sum + n, 0))
})
define('PRODUCT', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  return isError(list) ? list : list.length === 0 ? 0 : finite(list.reduce((p, n) => p * n, 1))
})
define('AVERAGE', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  if (isError(list)) return list
  return list.length === 0 ? errors.div0 : clean(list.reduce((sum, n) => sum + n, 0) / list.length)
})
define('MIN', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  return isError(list) ? list : list.length === 0 ? 0 : Math.min(...list)
})
define('MAX', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  return isError(list) ? list : list.length === 0 ? 0 : Math.max(...list)
})
define('MEDIAN', 1, 255, (args, ev) => {
  const list = numbers(all(args, ev))
  if (isError(list)) return list
  if (list.length === 0) return errors.num
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : clean((sorted[mid - 1]! + sorted[mid]!) / 2)
})
define('COUNT', 1, 255, (args, ev) => {
  let count = 0
  for (const arg of all(args, ev)) {
    for (const { value, ref } of scalars(arg)) {
      if (typeof value === 'number') count++
      else if (!ref && (typeof value === 'boolean' || (typeof value === 'string' && parseNumber(value) !== undefined))) count++
    }
  }
  return count
})
define('COUNTA', 1, 255, (args, ev) => {
  let count = 0
  for (const arg of all(args, ev)) for (const { value } of scalars(arg)) if (value !== null) count++
  return count
})
define('COUNTBLANK', 1, 1, (args, ev) => {
  let count = 0
  for (const value of asArray(ev.eval(args[0]!)).values()) if (value === null || value === '') count++
  return count
})

const unaryMath = (name: string, f: (n: number) => number | FormulaError): void => {
  define(name, 1, 1, (args, ev) => map1(ev.eval(args[0]!), value => {
    const n = toNumber(value)
    return isError(n) ? n : (() => {
      const result = f(n)
      return isError(result) ? result : finite(result)
    })()
  }))
}
unaryMath('ABS', Math.abs)
unaryMath('INT', n => Math.floor(clean(n)))
unaryMath('SIGN', Math.sign)
unaryMath('SQRT', n => (n < 0 ? errors.num : Math.sqrt(n)))
unaryMath('EXP', Math.exp)
unaryMath('LN', n => (n <= 0 ? errors.num : Math.log(n)))
unaryMath('LOG10', n => (n <= 0 ? errors.num : Math.log10(n)))
define('PI', 0, 0, () => Math.PI)

const binaryMath = (name: string, min: number, fallback: number, f: (a: number, b: number) => number | FormulaError): void => {
  define(name, min, 2, (args, ev) => {
    const right = args[1] === undefined || args[1].kind === 'missing' ? fallback : ev.eval(args[1])
    return map2(ev.eval(args[0]!), right, (a, b) => {
      const x = toNumber(a)
      if (isError(x)) return x
      const y = toNumber(b)
      if (isError(y)) return y
      const result = f(x, y)
      return isError(result) ? result : finite(result)
    })
  })
}
binaryMath('ROUND', 2, 0, (x, d) => roundWith('nearest', x, d))
binaryMath('ROUNDUP', 2, 0, (x, d) => roundWith('up', x, d))
binaryMath('ROUNDDOWN', 2, 0, (x, d) => roundWith('down', x, d))
binaryMath('TRUNC', 1, 0, (x, d) => roundWith('down', x, d))
binaryMath('MOD', 2, 0, (n, d) => (d === 0 ? errors.div0 : clean(n - d * Math.floor(n / d))))
binaryMath('POWER', 2, 0, (x, y) => (x === 0 && y === 0 ? errors.num : x === 0 && y < 0 ? errors.div0 : x ** y))
binaryMath('LOG', 1, 10, (x, base) => (x <= 0 || base <= 0 || base === 1 ? errors.num : Math.log(x) / Math.log(base)))
binaryMath('CEILING', 2, 1, (x, s) => {
  if (s === 0) return 0
  if (x > 0 && s < 0) return errors.num
  return s < 0 ? -Math.ceil(clean(-x / -s)) * -s : clean(Math.ceil(clean(x / s)) * s)
})
binaryMath('FLOOR', 2, 1, (x, s) => {
  if (s === 0) return x === 0 ? 0 : errors.div0
  if (x > 0 && s < 0) return errors.num
  return s < 0 ? -Math.floor(clean(-x / -s)) * -s : clean(Math.floor(clean(x / s)) * s)
})
for (const [name, up] of [['CEILING.MATH', true], ['FLOOR.MATH', false]] as const) {
  define(name, 1, 3, (args, ev) => {
    const x = numberArg(args[0], ev)
    if (isError(x)) return x
    const s = numberArg(args[1], ev, 1)
    if (isError(s)) return s
    const mode = numberArg(args[2], ev, 0)
    if (isError(mode)) return mode
    const step = Math.abs(s)
    if (step === 0) return 0
    const q = clean(x / step)
    // Negative numbers round toward zero unless mode is non-zero (then away from zero).
    const awayFromZero = x < 0 && mode !== 0
    const rounded = up ? (awayFromZero ? Math.floor(q) : Math.ceil(q)) : (awayFromZero ? Math.ceil(q) : Math.floor(q))
    return clean(rounded * step)
  })
}
define('SUMPRODUCT', 1, 255, (args, ev) => {
  const arrays = args.map(arg => asArray(ev.eval(arg)))
  const first = arrays[0]!
  if (arrays.some(a => a.height !== first.height || a.width !== first.width)) return errors.value
  let sum = 0
  for (let r = 0; r < first.height; r++) {
    for (let c = 0; c < first.width; c++) {
      let product = 1
      for (const array of arrays) {
        const value = array.at(r, c)
        if (isError(value)) return value
        product *= typeof value === 'number' ? value : 0
      }
      sum += product
    }
  }
  return clean(sum)
})

// ---------- criteria (SUMIF, COUNTIFS, …) ----------

function wildcardPattern(text: string): RegExp {
  let source = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '~' && (text[i + 1] === '*' || text[i + 1] === '?' || text[i + 1] === '~')) {
      source += `\\${text[++i]!}`
    } else if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'is')
}

/** A criterion as SUMIF / COUNTIF read it: a value, or text like `">=10"`, `"<>x"`, `"a*"`. */
export function criterion(value: Scalar): (cell: Scalar) => boolean {
  if (isError(value)) return cell => isError(cell) && cell.code === value.code
  if (typeof value === 'number') return cell => (typeof cell === 'number' && cell === value) || (typeof cell === 'string' && parseNumber(cell) === value)
  if (typeof value === 'boolean') return cell => cell === value
  const text = value ?? ''
  const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(text)!
  const op = match[1] ?? ''
  const operand = match[2]!
  const number = parseNumber(operand)
  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    const test = (order: number) => (op === '<' ? order < 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order >= 0)
    if (number !== undefined) return cell => typeof cell === 'number' && test(compare(cell, number))
    return cell => typeof cell === 'string' && test(compare(cell, operand))
  }
  let equals: (cell: Scalar) => boolean
  if (operand === '') equals = op === '' ? cell => cell === null || cell === '' : cell => cell === null
  else if (number !== undefined) equals = cell => (typeof cell === 'number' && cell === number) || (typeof cell === 'string' && parseNumber(cell) === number)
  else if (/^(TRUE|FALSE)$/i.test(operand)) equals = cell => cell === (operand.toUpperCase() === 'TRUE')
  else {
    const pattern = wildcardPattern(operand)
    equals = cell => typeof cell === 'string' && pattern.test(cell)
  }
  if (op === '<>') return operand === '' ? cell => cell !== null && cell !== '' : cell => !equals(cell)
  return equals
}

/** Indices (row, column) of `range` cells that meet every criterion pair. */
function matchingCells(pairs: readonly [ArrayValue, Scalar][]): [number, number][] | FormulaError {
  const first = pairs[0]![0]
  if (pairs.some(([range]) => range.height !== first.height || range.width !== first.width)) return errors.value
  const tests = pairs.map(([range, crit]) => [range, criterion(crit)] as const)
  const hits: [number, number][] = []
  for (let r = 0; r < first.height; r++) {
    for (let c = 0; c < first.width; c++) {
      if (tests.every(([range, test]) => test(range.at(r, c)))) hits.push([r, c])
    }
  }
  return hits
}

function criteriaPairs(args: readonly Expr[], from: number, ev: Evaluator): [ArrayValue, Scalar][] | FormulaError {
  if ((args.length - from) % 2 !== 0) throw new FormulaUnsupported('criteria ranges and criteria must come in pairs')
  const pairs: [ArrayValue, Scalar][] = []
  for (let i = from; i < args.length; i += 2) {
    const crit = scalarArg(args[i + 1], ev)
    pairs.push([asArray(ev.eval(args[i]!)), crit])
  }
  return pairs
}

function aggregateHits(target: ArrayValue, hits: readonly [number, number][], kind: 'sum' | 'average' | 'max' | 'min'): Scalar {
  const values: number[] = []
  for (const [r, c] of hits) {
    const value = target.at(r, c)
    if (isError(value)) return value
    if (typeof value === 'number') values.push(value)
  }
  switch (kind) {
    case 'sum':
      return clean(values.reduce((s, n) => s + n, 0))
    case 'average':
      return values.length === 0 ? errors.div0 : clean(values.reduce((s, n) => s + n, 0) / values.length)
    case 'max':
      return values.length === 0 ? 0 : Math.max(...values)
    case 'min':
      return values.length === 0 ? 0 : Math.min(...values)
  }
}

for (const [name, kind] of [['SUMIF', 'sum'], ['AVERAGEIF', 'average']] as const) {
  define(name, 2, 3, (args, ev) => {
    const range = asArray(ev.eval(args[0]!))
    const hits = matchingCells([[range, scalarArg(args[1], ev)]])
    if (isError(hits)) return hits
    const target = args[2] === undefined || args[2].kind === 'missing' ? range : asArray(ev.eval(args[2]))
    if (target.height < range.height || target.width < range.width) return errors.value
    return aggregateHits(target, hits, kind)
  })
}
for (const [name, kind] of [['SUMIFS', 'sum'], ['AVERAGEIFS', 'average'], ['MAXIFS', 'max'], ['MINIFS', 'min']] as const) {
  define(name, 3, 255, (args, ev) => {
    const target = asArray(ev.eval(args[0]!))
    const pairs = criteriaPairs(args, 1, ev)
    if (isError(pairs)) return pairs
    if (pairs.some(([range]) => range.height !== target.height || range.width !== target.width)) return errors.value
    const hits = matchingCells(pairs)
    return isError(hits) ? hits : aggregateHits(target, hits, kind)
  })
}
define('COUNTIF', 2, 2, (args, ev) => {
  const hits = matchingCells([[asArray(ev.eval(args[0]!)), scalarArg(args[1], ev)]])
  return isError(hits) ? hits : hits.length
})
define('COUNTIFS', 2, 255, (args, ev) => {
  const pairs = criteriaPairs(args, 0, ev)
  if (isError(pairs)) return pairs
  const hits = matchingCells(pairs)
  return isError(hits) ? hits : hits.length
})

// ---------- logic ----------

define('IF', 1, 3, (args, ev) => {
  const condition = toBoolean(scalarArg(args[0], ev))
  if (isError(condition)) return condition
  const branch = condition ? args[1] : args[2]
  if (branch === undefined) return condition ? true : false
  if (branch.kind === 'missing') return 0
  return ev.eval(branch)
})
define('IFS', 2, 254, (args, ev) => {
  if (args.length % 2 !== 0) throw new FormulaUnsupported('IFS takes condition / value pairs')
  for (let i = 0; i < args.length; i += 2) {
    const condition = toBoolean(scalarArg(args[i], ev))
    if (isError(condition)) return condition
    if (condition) return ev.eval(args[i + 1]!)
  }
  return errors.na
})
define('IFERROR', 2, 2, (args, ev) => {
  const value = ev.eval(args[0]!)
  return map1(value, v => (isError(v) ? toScalar(ev.eval(args[1]!)) : v))
})
define('IFNA', 2, 2, (args, ev) => {
  const value = ev.eval(args[0]!)
  return map1(value, v => (isError(v) && v.code === '#N/A' ? toScalar(ev.eval(args[1]!)) : v))
})
const logical = (name: string, reduce: (values: boolean[]) => boolean): void => {
  define(name, 1, 255, (args, ev) => {
    const values: boolean[] = []
    for (const arg of all(args, ev)) {
      for (const { value, ref } of scalars(arg)) {
        if (isError(value)) return value
        if (ref && (value === null || typeof value === 'string')) continue
        const b = toBoolean(value)
        if (isError(b)) return b
        values.push(b)
      }
    }
    return values.length === 0 ? errors.value : reduce(values)
  })
}
logical('AND', v => v.every(Boolean))
logical('OR', v => v.some(Boolean))
logical('XOR', v => v.filter(Boolean).length % 2 === 1)
define('NOT', 1, 1, (args, ev) => map1(ev.eval(args[0]!), v => {
  const b = toBoolean(v)
  return isError(b) ? b : !b
}))
define('TRUE', 0, 0, () => true)
define('FALSE', 0, 0, () => false)
const test = (name: string, f: (value: Scalar) => boolean): void => {
  define(name, 1, 1, (args, ev) => map1(ev.eval(args[0]!), f))
}
test('ISBLANK', v => v === null)
test('ISNUMBER', v => typeof v === 'number')
test('ISTEXT', v => typeof v === 'string')
test('ISLOGICAL', v => typeof v === 'boolean')
test('ISERROR', v => isError(v))
test('ISNA', v => isError(v) && v.code === '#N/A')

// ---------- lookup ----------

function lookupEquals(needle: Scalar, value: Scalar): boolean {
  if (isError(needle) || isError(value)) return false
  if (typeof needle === 'string' && /[*?~]/.test(needle)) return typeof value === 'string' && wildcardPattern(needle).test(value)
  if (typeof needle !== typeof value || needle === null) return false
  return compare(needle, value as Exclude<Scalar, FormulaError>) === 0
}

/** Position of `needle` in a list: exact (0), largest ≤ (1, sorted ascending) or smallest ≥ (-1, sorted descending). */
function findIn(list: readonly Scalar[], needle: Scalar, mode: number): number {
  if (mode === 0) return list.findIndex(value => lookupEquals(needle, value))
  let found = -1
  for (let i = 0; i < list.length; i++) {
    const value = list[i]!
    if (isError(value) || value === null || isError(needle) || needle === null || typeof value !== typeof needle) continue
    const order = compare(value, needle)
    if (mode > 0 ? order <= 0 : order >= 0) found = i
    else if (mode > 0) break
  }
  return found
}

function vector(array: ArrayValue): Scalar[] | FormulaError {
  if (array.height === 1) return [...array.rows[0]!]
  if (array.width === 1) return array.rows.map(row => row[0]!)
  return errors.na
}

for (const [name, vertical] of [['VLOOKUP', true], ['HLOOKUP', false]] as const) {
  define(name, 3, 4, (args, ev) => {
    const needle = scalarArg(args[0], ev)
    if (isError(needle)) return needle
    const table = asArray(ev.eval(args[1]!))
    const index = numberArg(args[2], ev)
    if (isError(index)) return index
    const approximate = args[3] === undefined || args[3].kind === 'missing' ? true : toBoolean(scalarArg(args[3], ev))
    if (isError(approximate)) return approximate
    const n = Math.trunc(index)
    if (n < 1) return errors.value
    if (n > (vertical ? table.width : table.height)) return errors.ref
    const keys = vertical ? table.rows.map(row => row[0]!) : [...table.rows[0]!]
    const at = findIn(keys, needle, approximate ? 1 : 0)
    if (at < 0) return errors.na
    return (vertical ? table.at(at, n - 1) : table.at(n - 1, at)) ?? 0
  })
}
define('MATCH', 2, 3, (args, ev) => {
  const needle = scalarArg(args[0], ev)
  if (isError(needle)) return needle
  const list = vector(asArray(ev.eval(args[1]!)))
  if (isError(list)) return list
  const mode = numberArg(args[2], ev, 1)
  if (isError(mode)) return mode
  const at = findIn(list, needle, Math.sign(Math.trunc(mode)))
  return at < 0 ? errors.na : at + 1
})
define('INDEX', 2, 3, (args, ev) => {
  const array = asArray(ev.eval(args[0]!))
  const row = numberArg(args[1], ev, 0)
  if (isError(row)) return row
  const column = numberArg(args[2], ev, 0)
  if (isError(column)) return column
  let r = Math.trunc(row)
  let c = Math.trunc(column)
  if (r < 0 || c < 0) return errors.value
  // INDEX(row_vector, n) picks the nth item of a single row.
  if (array.height === 1 && (args[2] === undefined || args[2].kind === 'missing') && r > 0) {
    c = r
    r = 1
  }
  if (r > array.height || c > array.width) return errors.ref
  if (r === 0 && c === 0) return array
  if (r === 0) return new ArrayValue(array.rows.map(cells => [cells[c - 1]!]))
  if (c === 0) {
    if (array.width === 1) return array.at(r - 1, 0) ?? 0
    return new ArrayValue([array.rows[r - 1]!])
  }
  return array.at(r - 1, c - 1) ?? 0
})
define('XLOOKUP', 3, 6, (args, ev) => {
  const needle = scalarArg(args[0], ev)
  if (isError(needle)) return needle
  const keys = asArray(ev.eval(args[1]!))
  const results = asArray(ev.eval(args[2]!))
  const matchMode = numberArg(args[4], ev, 0)
  const searchMode = numberArg(args[5], ev, 1)
  if (isError(matchMode)) return matchMode
  if (isError(searchMode)) return searchMode
  if (matchMode !== 0 && matchMode !== 2) throw new FormulaUnsupported('XLOOKUP supports exact match (match_mode 0 or 2) only')
  if (searchMode !== 1 && searchMode !== -1) throw new FormulaUnsupported('XLOOKUP supports search_mode 1 or -1 only')
  const list = vector(keys)
  if (isError(list)) return errors.value
  const vertical = keys.width === 1 && keys.height !== 1 ? true : keys.height === 1 && keys.width !== 1 ? false : keys.width === 1
  if (vertical ? results.height !== keys.height : results.width !== keys.width) return errors.value
  const order = searchMode === 1 ? list.map((_, i) => i) : list.map((_, i) => list.length - 1 - i)
  const at = order.find(i => lookupEquals(needle, list[i]!))
  if (at === undefined) {
    if (args[3] === undefined || args[3].kind === 'missing') return errors.na
    return ev.eval(args[3])
  }
  if (vertical) return results.width === 1 ? results.at(at, 0) ?? 0 : new ArrayValue([results.rows[at]!])
  return results.height === 1 ? results.at(0, at) ?? 0 : new ArrayValue(results.rows.map(row => [row[at]!]))
})
define('CHOOSE', 2, 255, (args, ev) => {
  const index = numberArg(args[0], ev)
  if (isError(index)) return index
  const n = Math.trunc(index)
  if (n < 1 || n >= args.length) return errors.value
  return ev.eval(args[n]!)
})

// ---------- text ----------

const textJoin = (values: Iterable<Scalar>): string | FormulaError => {
  let out = ''
  for (const value of values) {
    const text = toText(value)
    if (isError(text)) return text
    out += text
  }
  return out
}
define('CONCATENATE', 1, 255, (args, ev) => textJoin(args.map(arg => scalarArg(arg, ev))))
define('CONCAT', 1, 255, (args, ev) => textJoin(all(args, ev).flatMap(arg => [...scalars(arg)].map(item => item.value))))
define('TEXTJOIN', 3, 255, (args, ev) => {
  const delimiter = textArg(args[0], ev)
  if (isError(delimiter)) return delimiter
  const ignoreEmpty = toBoolean(scalarArg(args[1], ev))
  if (isError(ignoreEmpty)) return ignoreEmpty
  const parts: string[] = []
  for (const arg of all(args.slice(2), ev)) {
    for (const { value } of scalars(arg)) {
      const text = toText(value)
      if (isError(text)) return text
      if (ignoreEmpty && text === '') continue
      parts.push(text)
    }
  }
  return parts.join(delimiter)
})
const textFn = (name: string, min: number, max: number, f: (text: string, numbers: number[]) => Scalar): void => {
  define(name, min, max, (args, ev) => {
    const text = textArg(args[0], ev)
    if (isError(text)) return text
    const rest: number[] = []
    for (const arg of args.slice(1)) {
      const n = numberArg(arg, ev)
      if (isError(n)) return n
      rest.push(n)
    }
    return f(text, rest)
  })
}
textFn('LEN', 1, 1, text => [...text].length)
textFn('UPPER', 1, 1, text => text.toUpperCase())
textFn('LOWER', 1, 1, text => text.toLowerCase())
textFn('TRIM', 1, 1, text => text.replace(/ +/g, ' ').trim())
textFn('LEFT', 1, 2, (text, [n]) => (args1(n, 1) < 0 ? errors.value : [...text].slice(0, args1(n, 1)).join('')))
textFn('RIGHT', 1, 2, (text, [n]) => {
  const count = args1(n, 1)
  if (count < 0) return errors.value
  const chars = [...text]
  return count === 0 ? '' : chars.slice(Math.max(0, chars.length - count)).join('')
})
textFn('MID', 3, 3, (text, [start, count]) => {
  const s = Math.trunc(start!)
  const n = Math.trunc(count!)
  if (s < 1 || n < 0) return errors.value
  return [...text].slice(s - 1, s - 1 + n).join('')
})
textFn('REPT', 2, 2, (text, [n]) => (n! < 0 ? errors.value : text.repeat(Math.trunc(n!))))
textFn('VALUE', 1, 1, text => parseNumber(text) ?? errors.value)
function args1(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.trunc(value)
}
define('EXACT', 2, 2, (args, ev) => {
  const a = textArg(args[0], ev)
  if (isError(a)) return a
  const b = textArg(args[1], ev)
  return isError(b) ? b : a === b
})
define('SUBSTITUTE', 3, 4, (args, ev) => {
  const text = textArg(args[0], ev)
  const from = textArg(args[1], ev)
  const to = textArg(args[2], ev)
  if (isError(text)) return text
  if (isError(from)) return from
  if (isError(to)) return to
  if (from === '') return text
  if (args[3] === undefined) return text.split(from).join(to)
  const instance = numberArg(args[3], ev)
  if (isError(instance)) return instance
  if (instance < 1) return errors.value
  let index = -1
  for (let i = 0; i < Math.trunc(instance); i++) {
    index = text.indexOf(from, index + 1)
    if (index === -1) return text
  }
  return text.slice(0, index) + to + text.slice(index + from.length)
})
for (const [name, caseSensitive] of [['FIND', true], ['SEARCH', false]] as const) {
  define(name, 2, 3, (args, ev) => {
    const needle = textArg(args[0], ev)
    const haystack = textArg(args[1], ev)
    if (isError(needle)) return needle
    if (isError(haystack)) return haystack
    const start = numberArg(args[2], ev, 1)
    if (isError(start)) return start
    if (start < 1 || start > haystack.length + 1) return errors.value
    const index = caseSensitive
      ? haystack.indexOf(needle, Math.trunc(start) - 1)
      : haystack.toUpperCase().indexOf(needle.toUpperCase(), Math.trunc(start) - 1)
    return index === -1 ? errors.value : index + 1
  })
}

// ---------- dates (1900 date system serial numbers) ----------

const EPOCH = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

function serialOf(year: number, month: number, day: number): number | FormulaError {
  let y = Math.trunc(year)
  if (y < 0 || y > 9999) return errors.num
  if (y < 1900) y += 1900
  const serial = Math.round((Date.UTC(y, Math.trunc(month) - 1, Math.trunc(day)) - EPOCH) / DAY_MS)
  // Excel counts the non-existent 1900-02-29, so dates before March 1900 are one lower.
  const excel = serial < 61 ? serial - 1 : serial
  return excel < 0 ? errors.num : excel
}

function dateOf(serial: number): Date | FormulaError {
  if (serial < 0 || serial > 2_958_465) return errors.num
  const whole = Math.floor(serial)
  return new Date(EPOCH + (whole < 60 ? whole + 1 : whole) * DAY_MS)
}

define('DATE', 3, 3, (args, ev) => {
  const parts: number[] = []
  for (const arg of args) {
    const n = numberArg(arg, ev)
    if (isError(n)) return n
    parts.push(n)
  }
  return serialOf(parts[0]!, parts[1]!, parts[2]!)
})
for (const [name, part] of [['YEAR', 'y'], ['MONTH', 'm'], ['DAY', 'd']] as const) {
  define(name, 1, 1, (args, ev) => {
    const n = numberArg(args[0], ev)
    if (isError(n)) return n
    const date = dateOf(n)
    if (isError(date)) return date
    return part === 'y' ? date.getUTCFullYear() : part === 'm' ? date.getUTCMonth() + 1 : date.getUTCDate()
  })
}

/** The function table, by upper-case name (`_xlfn.` prefixes are stripped before lookup). */
export const FUNCTIONS: ReadonlyMap<string, FormulaFunction> = table

/** Names of the supported functions, sorted. */
export const SUPPORTED_FUNCTIONS: readonly string[] = [...table.keys()].sort()
