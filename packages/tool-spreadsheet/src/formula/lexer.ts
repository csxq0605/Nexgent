/**
 * Formula tokenizer (A1 notation, Excel operators). Tokens keep their source
 * offsets so a formula can be rewritten token by token: shared formulas are
 * translated to their dependent cells ({@link translateFormula}) and newer
 * functions get the `_xlfn.` prefix the file format requires
 * ({@link toFileFormula}). What the engine does not support is refused here
 * with {@link FormulaUnsupported}: external workbooks, structured
 * references, defined names, 3-D references, whole-column / whole-row ranges
 * and the intersection operator.
 */

/** A formula feature this engine refuses; never a spreadsheet error value. */
export class FormulaUnsupported extends Error {
  override readonly name = 'FormulaUnsupported'
}

/** Largest column (`XFD`) and row of a worksheet. */
export const MAX_COLUMN = 16_384
export const MAX_ROW = 1_048_576

/** Spreadsheet error codes. */
export const ERROR_CODES = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** One end of a reference. */
export interface CellAddress {
  readonly row: number
  readonly column: number
  readonly rowAbsolute: boolean
  readonly columnAbsolute: boolean
}

/** A lexical token; `start` / `end` are offsets into the formula text. */
export type Token = { readonly start: number; readonly end: number } & (
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'error'; readonly value: ErrorCode }
  | { readonly kind: 'ref'; readonly sheet?: string; readonly from: CellAddress; readonly to?: CellAddress }
  | { readonly kind: 'func'; readonly name: string }
  | { readonly kind: 'op'; readonly value: string }
  | { readonly kind: 'lparen' | 'rparen' | 'comma' | 'space' }
)

/** `ABC` → 731. */
export function columnNumber(letters: string): number {
  let column = 0
  for (const ch of letters.toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64)
  return column
}

/** 731 → `ABC`. */
export function columnLetters(column: number): string {
  let name = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/

/** Parse `$B$2` / `b2`; `undefined` when not a cell address within the sheet limits. */
export function parseAddress(text: string): CellAddress | undefined {
  const match = CELL.exec(text)
  if (!match) return undefined
  const column = columnNumber(match[2]!)
  const row = Number(match[4])
  if (column < 1 || column > MAX_COLUMN || !Number.isSafeInteger(row) || row < 1 || row > MAX_ROW) return undefined
  return { column, row, columnAbsolute: match[1] === '$', rowAbsolute: match[3] === '$' }
}

/** Render an address with its `$` markers. */
export function formatAddress(address: CellAddress): string {
  return `${address.columnAbsolute ? '$' : ''}${columnLetters(address.column)}${address.rowAbsolute ? '$' : ''}${address.row}`
}

/** Quote a sheet name for a reference when needed (`'My sheet'!`). */
export function quoteSheet(name: string): string {
  return /^[A-Za-z_ -￿][\w. -￿]*$/.test(name) && parseAddress(name) === undefined && !/^(TRUE|FALSE)$/i.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`
}

const IDENT = /[A-Za-z0-9_.$\\ -￿]/
const NUMBER = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/
const OPERATORS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%']

/**
 * Tokenize a formula (without its leading `=`).
 * @throws {@link FormulaUnsupported} for refused syntax, `SyntaxError` for malformed text.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  const at = (offset = 0): string => text[pos + offset] ?? ''

  const readRefAfterSheet = (start: number, sheet: string): void => {
    if (at() === '[' || at() === '#') throw new FormulaUnsupported('structured or external references are not supported')
    let end = pos
    while (end < text.length && /[A-Za-z0-9$]/.test(text[end]!)) end++
    const first = text.slice(pos, end)
    const from = parseAddress(first)
    if (from === undefined) {
      if (/^\$?[A-Za-z]{1,3}$/.test(first) || /^\$?\d+$/.test(first)) throw new FormulaUnsupported(`whole-column and whole-row references (${sheet}!${first}…) are not supported; use a bounded range like A1:A100`)
      throw new SyntaxError(`bad reference after ${sheet}!`)
    }
    pos = end
    finishRef(start, sheet, from)
  }

  const finishRef = (start: number, sheet: string | undefined, from: CellAddress): void => {
    let to: CellAddress | undefined
    if (at() === ':') {
      let end = pos + 1
      while (end < text.length && /[A-Za-z0-9$]/.test(text[end]!)) end++
      const second = text.slice(pos + 1, end)
      if (text[end] === '!') throw new FormulaUnsupported('3-D references across sheets are not supported')
      to = parseAddress(second)
      if (to === undefined) throw new SyntaxError(`bad range end ${JSON.stringify(second)}`)
      pos = end
    }
    if (IDENT.test(at()) || at() === '(') throw new SyntaxError(`unexpected text after reference at ${pos + 1}`)
    tokens.push({ kind: 'ref', start, end: pos, ...(sheet === undefined ? {} : { sheet }), from, ...(to === undefined ? {} : { to }) })
  }

  while (pos < text.length) {
    const start = pos
    const ch = at()
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      while (/[ \n\r\t]/.test(at()) && pos < text.length) pos++
      tokens.push({ kind: 'space', start, end: pos })
      continue
    }
    if (ch === '"') {
      let value = ''
      pos++
      for (;;) {
        if (pos >= text.length) throw new SyntaxError('unterminated string')
        if (at() === '"') {
          if (at(1) === '"') {
            value += '"'
            pos += 2
            continue
          }
          pos++
          break
        }
        value += at()
        pos++
      }
      tokens.push({ kind: 'string', start, end: pos, value })
      continue
    }
    if (ch === '#') {
      const code = ERROR_CODES.find(candidate => text.startsWith(candidate, pos) || text.slice(pos, pos + candidate.length).toUpperCase() === candidate)
      if (code === undefined) throw new SyntaxError(`unknown error literal at ${pos + 1}`)
      pos += code.length
      tokens.push({ kind: 'error', start, end: pos, value: code })
      continue
    }
    if (ch === "'") {
      let name = ''
      pos++
      for (;;) {
        if (pos >= text.length) throw new SyntaxError('unterminated quoted sheet name')
        if (at() === "'") {
          if (at(1) === "'") {
            name += "'"
            pos += 2
            continue
          }
          pos++
          break
        }
        name += at()
        pos++
      }
      if (/^\[|\]/.test(name)) throw new FormulaUnsupported('references to other workbooks are not supported')
      if (at() !== '!') throw new SyntaxError(`quoted sheet name ${JSON.stringify(name)} must be followed by !`)
      if (name.includes(':')) throw new FormulaUnsupported('3-D references across sheets are not supported')
      pos++
      readRefAfterSheet(start, name)
      continue
    }
    if (ch === '[') throw new FormulaUnsupported('references to other workbooks or tables ([...]) are not supported')
    if (/[0-9.]/.test(ch)) {
      const match = NUMBER.exec(text.slice(pos))
      if (match === null) throw new SyntaxError(`bad number at ${pos + 1}`)
      if (text[pos + match[0].length] === ':' && /^\d+$/.test(match[0])) throw new FormulaUnsupported('whole-row references are not supported; use a bounded range like A1:F1')
      pos += match[0].length
      tokens.push({ kind: 'number', start, end: pos, value: Number(match[0]) })
      continue
    }
    if (IDENT.test(ch)) {
      let end = pos
      while (end < text.length && IDENT.test(text[end]!)) end++
      const word = text.slice(pos, end)
      const next = text[end]
      if (next === '(') {
        pos = end + 1
        tokens.push({ kind: 'func', start, end: pos, name: word.toUpperCase().replace(/^_XLFN\.(_XLWS\.)?/, '').replace(/^_XLWS\./, '') })
        continue
      }
      if (next === ':' && /^:[A-Za-z0-9_. -￿]+!/.test(text.slice(end))) {
        throw new FormulaUnsupported('3-D references across sheets are not supported')
      }
      if (next === '!') {
        pos = end + 1
        readRefAfterSheet(start, word)
        continue
      }
      if (next === ':' && /^\$?[A-Za-z]{1,3}$/.test(word)) throw new FormulaUnsupported(`whole-column references (${word}:…) are not supported; use a bounded range like A1:A100`)
      const address = parseAddress(word)
      if (address !== undefined) {
        pos = end
        finishRef(start, undefined, address)
        continue
      }
      if (/^(TRUE|FALSE)$/i.test(word)) {
        pos = end
        tokens.push({ kind: 'bool', start, end: pos, value: word.toUpperCase() === 'TRUE' })
        continue
      }
      throw new FormulaUnsupported(`names are not supported (${word}); use cell references like A1 or Sheet!B2`)
    }
    if (ch === '(') tokens.push({ kind: 'lparen', start, end: ++pos })
    else if (ch === ')') tokens.push({ kind: 'rparen', start, end: ++pos })
    else if (ch === ',') tokens.push({ kind: 'comma', start, end: ++pos })
    else if (ch === '{') throw new FormulaUnsupported('array constants ({...}) are not supported')
    else if (ch === ';') throw new SyntaxError('use "," to separate function arguments')
    else {
      const op = OPERATORS.find(candidate => text.startsWith(candidate, pos))
      if (op === undefined) throw new SyntaxError(`unexpected character ${JSON.stringify(ch)} at ${pos + 1}`)
      pos += op.length
      tokens.push({ kind: 'op', start, end: pos, value: op })
    }
  }
  return tokens
}

/** Functions that need the `_xlfn.` prefix in a file (added after Excel 2007). */
export const XLFN_FUNCTIONS: ReadonlySet<string> = new Set(['CONCAT', 'TEXTJOIN', 'IFS', 'MAXIFS', 'MINIFS', 'XLOOKUP', 'IFNA', 'CEILING.MATH', 'FLOOR.MATH', 'XOR'])

function rewrite(text: string, tokens: readonly Token[], replace: (token: Token) => string | undefined): string {
  let out = ''
  let cursor = 0
  for (const token of tokens) {
    const replacement = replace(token)
    if (replacement === undefined) continue
    out += text.slice(cursor, token.start) + replacement
    cursor = token.end
  }
  return out + text.slice(cursor)
}

/** The formula as stored in a file: function names upper-cased, newer ones `_xlfn.`-prefixed. */
export function toFileFormula(text: string): string {
  return rewrite(text, tokenize(text), token =>
    token.kind === 'func' ? `${XLFN_FUNCTIONS.has(token.name) ? '_xlfn.' : ''}${token.name}(` : undefined)
}

/**
 * Move a shared formula from its master cell by `rows` / `columns`: relative
 * row / column parts shift, `$`-anchored parts stay. A part that leaves the
 * sheet becomes `#REF!`.
 */
export function translateFormula(text: string, rows: number, columns: number): string {
  const move = (address: CellAddress): CellAddress | undefined => {
    const row = address.rowAbsolute ? address.row : address.row + rows
    const column = address.columnAbsolute ? address.column : address.column + columns
    if (row < 1 || row > MAX_ROW || column < 1 || column > MAX_COLUMN) return undefined
    return { ...address, row, column }
  }
  return rewrite(text, tokenize(text), token => {
    if (token.kind !== 'ref') return undefined
    const from = move(token.from)
    const to = token.to === undefined ? undefined : move(token.to)
    if (from === undefined || (token.to !== undefined && to === undefined)) return '#REF!'
    const sheet = token.sheet === undefined ? '' : `${quoteSheet(token.sheet)}!`
    return `${sheet}${formatAddress(from)}${to === undefined ? '' : `:${formatAddress(to)}`}`
  })
}
