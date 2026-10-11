/**
 * Formula parser: tokens → expression tree, with Excel's operator
 * precedence (low to high): comparison, `&`, `+ -`, `* /`, `^`, postfix `%`,
 * prefix `- +` (so `-2^2` is 4, as in Excel). Binary operators are
 * left-associative.
 */
import { FormulaUnsupported, tokenize, type CellAddress, type ErrorCode, type Token } from './lexer.js'

/** Expression tree. */
export type Expr =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'error'; readonly value: ErrorCode }
  | { readonly kind: 'ref'; readonly sheet?: string; readonly from: CellAddress; readonly to?: CellAddress }
  | { readonly kind: 'unary'; readonly op: '-' | '+'; readonly operand: Expr }
  | { readonly kind: 'percent'; readonly operand: Expr }
  | { readonly kind: 'binary'; readonly op: string; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Expr[] }
  | { readonly kind: 'missing' }

const BINARY: Readonly<Record<string, number>> = {
  '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '&': 2,
  '+': 3, '-': 3,
  '*': 4, '/': 4,
  '^': 5,
}
const PERCENT = 6
const PREFIX = 7

/** Largest formula text accepted (Excel's own limit is 8 192). */
export const MAX_FORMULA_LENGTH = 8_192

/**
 * Parse a formula (without its leading `=`).
 * @throws {@link FormulaUnsupported} or `SyntaxError`.
 */
export function parseFormula(text: string): Expr {
  if (text.length > MAX_FORMULA_LENGTH) throw new FormulaUnsupported(`formula is longer than ${MAX_FORMULA_LENGTH} characters`)
  const all = tokenize(text)
  // Whitespace is allowed around operators and arguments; between two operands it is Excel's
  // intersection operator, which is refused.
  const tokens: Token[] = []
  for (let i = 0; i < all.length; i++) {
    const token = all[i]!
    if (token.kind !== 'space') {
      tokens.push(token)
      continue
    }
    const before = tokens[tokens.length - 1]
    const after = all[i + 1]
    const endsOperand = before !== undefined && (before.kind === 'ref' || before.kind === 'rparen')
    const startsOperand = after !== undefined && (after.kind === 'ref' || after.kind === 'lparen' || after.kind === 'func')
    if (endsOperand && startsOperand) throw new FormulaUnsupported('the intersection operator (a space between references) is not supported')
  }
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]

  const expect = (kind: Token['kind'], what: string): Token => {
    const token = tokens[pos]
    if (token === undefined || token.kind !== kind) throw new SyntaxError(`expected ${what}${token === undefined ? ' at the end' : ` at ${token.start + 1}`}`)
    pos++
    return token
  }

  const parseExpr = (min: number): Expr => {
    let left = parsePrefix()
    for (;;) {
      const token = peek()
      if (token === undefined || token.kind !== 'op') break
      if (token.value === '%') {
        if (PERCENT < min) break
        pos++
        left = { kind: 'percent', operand: left }
        continue
      }
      const precedence = BINARY[token.value]
      if (precedence === undefined || precedence < min) break
      pos++
      const right = parseExpr(precedence + 1)
      left = { kind: 'binary', op: token.value, left, right }
    }
    return left
  }

  const parsePrefix = (): Expr => {
    const token = peek()
    if (token === undefined) throw new SyntaxError('formula ends early')
    if (token.kind === 'op' && (token.value === '-' || token.value === '+')) {
      pos++
      return { kind: 'unary', op: token.value, operand: parseExpr(PREFIX) }
    }
    return parsePrimary()
  }

  const parsePrimary = (): Expr => {
    const token = tokens[pos++]
    if (token === undefined) throw new SyntaxError('formula ends early')
    switch (token.kind) {
      case 'number':
      case 'string':
      case 'bool':
      case 'error':
        return { kind: token.kind, value: token.value } as Expr
      case 'ref':
        return { kind: 'ref', ...(token.sheet === undefined ? {} : { sheet: token.sheet }), from: token.from, ...(token.to === undefined ? {} : { to: token.to }) }
      case 'lparen': {
        const inner = parseExpr(0)
        expect('rparen', '")"')
        return inner
      }
      case 'func': {
        const args: Expr[] = []
        if (peek()?.kind === 'rparen') {
          pos++
          return { kind: 'call', name: token.name, args }
        }
        for (;;) {
          const next = peek()
          if (next?.kind === 'comma' || next?.kind === 'rparen') args.push({ kind: 'missing' })
          else args.push(parseExpr(0))
          const separator = tokens[pos++]
          if (separator?.kind === 'rparen') break
          if (separator?.kind !== 'comma') throw new SyntaxError(`expected "," or ")" in ${token.name}(…)${separator === undefined ? '' : ` at ${separator.start + 1}`}`)
        }
        return { kind: 'call', name: token.name, args }
      }
      default:
        throw new SyntaxError(`unexpected ${token.kind === 'op' ? JSON.stringify(token.value) : token.kind} at ${token.start + 1}`)
    }
  }

  if (tokens.length === 0) throw new SyntaxError('empty formula')
  const expr = parseExpr(0)
  if (pos < tokens.length) throw new SyntaxError(`unexpected text at ${tokens[pos]!.start + 1}`)
  return expr
}

/** Every function name an expression calls. */
export function calledFunctions(expr: Expr, into: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'unary':
    case 'percent':
      return calledFunctions(expr.operand, into)
    case 'binary':
      calledFunctions(expr.left, into)
      return calledFunctions(expr.right, into)
    case 'call':
      into.add(expr.name)
      for (const arg of expr.args) calledFunctions(arg, into)
      return into
    default:
      return into
  }
}
