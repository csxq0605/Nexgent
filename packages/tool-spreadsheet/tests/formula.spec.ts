import { describe, expect, it } from 'vitest'
import {
  Calculator,
  cellKey,
  FormulaError,
  FormulaUnsupported,
  parseFormula,
  SUPPORTED_FUNCTIONS,
  toFileFormula,
  translateFormula,
  type CellEntry,
  type Scalar,
  type SheetData,
} from '../src/index.js'

/** Sheets from `{ A1: 1, B1: '=A1*2' }` maps; strings starting with `=` are formulas. */
function book(sheets: Record<string, Record<string, number | string | boolean>>): SheetData[] {
  return Object.entries(sheets).map(([name, cells]) => {
    const map = new Map<string, CellEntry>()
    for (const [ref, value] of Object.entries(cells)) {
      const match = /^([A-Z]+)(\d+)$/.exec(ref)!
      let column = 0
      for (const ch of match[1]!) column = column * 26 + ch.charCodeAt(0) - 64
      const key = cellKey(Number(match[2]), column)
      map.set(key, typeof value === 'string' && value.startsWith('=') ? { value: null, formula: value.slice(1) } : { value })
    }
    return { name, cells: map }
  })
}

/** Evaluate one formula in a scratch cell (Z99 of the first sheet) next to `cells`. */
function calc(formula: string, cells: Record<string, number | string | boolean> = {}, extra: Record<string, Record<string, number | string | boolean>> = {}): Scalar {
  const sheets = book({ Data: { ...cells, Z99: `=${formula}` }, ...extra })
  return new Calculator(sheets, { strict: false }).value('Data', 99, 26)
}

function strictError(formula: string, cells: Record<string, number | string | boolean> = {}): string {
  const sheets = book({ Data: { ...cells, Z99: `=${formula}` } })
  try {
    new Calculator(sheets, { strict: true }).calculateAll()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error(`expected =${formula} to fail`)
}

const code = (value: Scalar): string | undefined => (value instanceof FormulaError ? value.code : undefined)

describe('operators and coercion', () => {
  it('follows Excel precedence: unary minus binds tighter than ^, ^ is left-associative, % is postfix', () => {
    expect(calc('-2^2')).toBe(4)
    expect(calc('2^3^2')).toBe(64)
    expect(calc('1+2*3-4/2')).toBe(5)
    expect(calc('50%*10')).toBe(5)
    expect(calc('(1+2)*3')).toBe(9)
    expect(calc('1+2=3')).toBe(true)
    expect(calc('"a"&1&TRUE')).toBe('a1TRUE')
    expect(calc('0.1+0.2')).toBeCloseTo(0.3, 15)
  })

  it('coerces like Excel: blanks are 0 / "", numeric text is a number, other text is #VALUE!', () => {
    expect(calc('A1+1')).toBe(1)
    expect(calc('A1&"x"')).toBe('x')
    expect(calc('A1')).toBe(0)
    expect(calc('A1*2', { A1: ' 21 ' })).toBe(42)
    expect(code(calc('A1*2', { A1: 'abc' }))).toBe('#VALUE!')
    expect(calc('TRUE+1')).toBe(2)
  })

  it('compares case-insensitively and orders numbers < text < booleans', () => {
    expect(calc('"abc"="ABC"')).toBe(true)
    expect(calc('1<"a"')).toBe(true)
    expect(calc('"z"<TRUE')).toBe(true)
    expect(calc('A1=0')).toBe(true)
    expect(calc('A1=""')).toBe(true)
  })

  it('produces and propagates error values', () => {
    expect(code(calc('1/0'))).toBe('#DIV/0!')
    expect(code(calc('A1+1', { A1: '=1/0' }))).toBe('#DIV/0!')
    expect(code(calc('0^0'))).toBe('#NUM!')
    expect(code(calc('#N/A'))).toBe('#N/A')
    expect(calc('IFERROR(1/0,"none")')).toBe('none')
    expect(calc('IFNA(#N/A,7)')).toBe(7)
    expect(code(calc('IFNA(1/0,7)'))).toBe('#DIV/0!')
  })

  it('broadcasts operators over ranges inside aggregates', () => {
    const cells = { A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 }
    expect(calc('SUMPRODUCT((A1:A3>1)*B1:B3)', cells)).toBe(50)
    expect(calc('SUM(A1:A3*B1:B3)', cells)).toBe(140)
  })
})

describe('functions', () => {
  it('aggregates skip text and booleans inside ranges but coerce typed arguments', () => {
    const cells = { A1: 1, A2: 'x', A3: true, A4: 4 }
    expect(calc('SUM(A1:A4)', cells)).toBe(5)
    expect(calc('SUM(A1:A4,"2",TRUE)', cells)).toBe(8)
    expect(code(calc('SUM("x")'))).toBe('#VALUE!')
    expect(calc('AVERAGE(A1:A4)', cells)).toBe(2.5)
    expect(calc('COUNT(A1:A4)', cells)).toBe(2)
    expect(calc('COUNTA(A1:A5)', cells)).toBe(4)
    expect(calc('COUNTBLANK(A1:A5)', cells)).toBe(1)
    expect(calc('MAX(A1:A4)', cells)).toBe(4)
    expect(calc('MIN(B1:B3)')).toBe(0)
    expect(code(calc('AVERAGE(B1:B3)'))).toBe('#DIV/0!')
    expect(calc('MEDIAN(1,5,3,9)')).toBe(4)
    expect(calc('PRODUCT(2,3,A4)', cells)).toBe(24)
    expect(code(calc('SUM(A1,A2)', { A1: 1, A2: '=1/0' }))).toBe('#DIV/0!')
  })

  it('rounds half away from zero at 15 significant digits', () => {
    expect(calc('ROUND(2.5,0)')).toBe(3)
    expect(calc('ROUND(-2.5,0)')).toBe(-3)
    expect(calc('ROUND(1.005,2)')).toBe(1.01)
    expect(calc('ROUND(1234.5,-2)')).toBe(1200)
    expect(calc('ROUNDUP(0.1*3*10,0)')).toBe(3)
    expect(calc('ROUNDUP(-1.1,0)')).toBe(-2)
    expect(calc('ROUNDDOWN(-1.9,0)')).toBe(-1)
    expect(calc('INT(-1.5)')).toBe(-2)
    expect(calc('TRUNC(-1.59,1)')).toBe(-1.5)
    expect(calc('MOD(-3,2)')).toBe(1)
    expect(code(calc('MOD(1,0)'))).toBe('#DIV/0!')
  })

  it('implements CEILING / FLOOR and their .MATH forms', () => {
    expect(calc('CEILING(2.1,1)')).toBe(3)
    expect(calc('CEILING(7,5)')).toBe(10)
    expect(calc('CEILING(-2.5,2)')).toBe(-2)
    expect(calc('CEILING(-2.5,-2)')).toBe(-4)
    expect(code(calc('CEILING(2.5,-2)'))).toBe('#NUM!')
    expect(calc('FLOOR(7.9,2)')).toBe(6)
    expect(calc('CEILING.MATH(-7.2,5)')).toBe(-5)
    expect(calc('CEILING.MATH(-7.2,5,1)')).toBe(-10)
    expect(calc('FLOOR.MATH(7.2,5)')).toBe(5)
    expect(calc('CEILING(0.1*3,0.1)')).toBe(0.3)
  })

  it('matches SUMIF / COUNTIF criteria: comparisons, wildcards, blanks, numbers as text', () => {
    const cells = { A1: 'apple', A2: 'Apricot', A3: 'pear', A4: 5, A5: '5', B1: 1, B2: 2, B3: 3, B4: 4, B5: 5 }
    expect(calc('COUNTIF(A1:A6,"ap*")', cells)).toBe(2)
    expect(calc('COUNTIF(A1:A6,"?ear")', cells)).toBe(1)
    expect(calc('COUNTIF(A1:A6,5)', cells)).toBe(2)
    expect(calc('COUNTIF(A1:A6,">4")', cells)).toBe(1)
    expect(calc('COUNTIF(A1:A6,"")', cells)).toBe(1)
    expect(calc('COUNTIF(A1:A6,"<>")', cells)).toBe(5)
    expect(calc('COUNTIF(A1:A6,"<>pear")', cells)).toBe(5)
    expect(calc('SUMIF(A1:A5,"a*",B1:B5)', cells)).toBe(3)
    expect(calc('SUMIF(B1:B5,">=3")', cells)).toBe(12)
    expect(calc('SUMIFS(B1:B5,A1:A5,"<>pear",B1:B5,">1")', cells)).toBe(11)
    expect(calc('COUNTIFS(A1:A5,"*p*",B1:B5,"<3")', cells)).toBe(2)
    expect(calc('AVERAGEIF(A1:A5,"a*",B1:B5)', cells)).toBe(1.5)
    expect(calc('MAXIFS(B1:B5,A1:A5,"a*")', cells)).toBe(2)
    expect(calc('MINIFS(B1:B5,A1:A5,"p*")', cells)).toBe(3)
    expect(code(calc('SUMIFS(B1:B5,A1:A4,"x")', cells))).toBe('#VALUE!')
  })

  it('looks up exactly and approximately', () => {
    const cells = { A1: 'P01', A2: 'P02', A3: 'P03', B1: 10, B2: 20, B3: 30, C1: 0, C2: 100, C3: 500, D1: 'low', D2: 'mid', D3: 'high' }
    expect(calc('VLOOKUP("p02",A1:B3,2,FALSE)', cells)).toBe(20)
    expect(code(calc('VLOOKUP("P09",A1:B3,2,FALSE)', cells))).toBe('#N/A')
    expect(calc('VLOOKUP(250,C1:D3,2)', cells)).toBe('mid')
    expect(calc('VLOOKUP(250,C1:D3,2,TRUE)', cells)).toBe('mid')
    expect(code(calc('VLOOKUP(-1,C1:D3,2)', cells))).toBe('#N/A')
    expect(code(calc('VLOOKUP("P01",A1:B3,3,FALSE)', cells))).toBe('#REF!')
    expect(calc('HLOOKUP("b",F1:H2,2,FALSE)', { F1: 'a', G1: 'b', H1: 'c', F2: 1, G2: 2, H2: 3 })).toBe(2)
    expect(calc('MATCH("P03",A1:A3,0)', cells)).toBe(3)
    expect(calc('MATCH(120,C1:C3)', cells)).toBe(2)
    expect(calc('MATCH("P0?",A1:A3,0)', cells)).toBe(1)
    expect(calc('INDEX(B1:B3,MATCH("P03",A1:A3,0))', cells)).toBe(30)
    expect(calc('INDEX(A1:D3,2,4)', cells)).toBe('mid')
    expect(calc('SUM(INDEX(A1:C3,0,2))', cells)).toBe(60)
    expect(code(calc('INDEX(A1:B3,4,1)', cells))).toBe('#REF!')
    expect(calc('XLOOKUP("P02",A1:A3,D1:D3)', cells)).toBe('mid')
    expect(calc('XLOOKUP("P09",A1:A3,D1:D3,"none")', cells)).toBe('none')
    expect(calc('CHOOSE(2,"a","b","c")')).toBe('b')
  })

  it('handles logic, text and dates', () => {
    expect(calc('IF(1>2,"y","n")')).toBe('n')
    expect(calc('IF(FALSE,1)')).toBe(false)
    expect(calc('IFS(1>2,"a",TRUE,"b")')).toBe('b')
    expect(calc('AND(TRUE,1,A1:A2)', { A1: true, A2: 'text' })).toBe(true)
    expect(calc('OR(FALSE,0)')).toBe(false)
    expect(calc('NOT(0)')).toBe(true)
    expect(calc('ISBLANK(A1)')).toBe(true)
    expect(calc('ISNUMBER(A1)', { A1: 3 })).toBe(true)
    expect(calc('ISERROR(1/0)')).toBe(true)
    expect(calc('CONCAT(A1:A2,"!")', { A1: 'a', A2: 'b' })).toBe('ab!')
    expect(calc('TEXTJOIN(", ",TRUE,A1:A3)', { A1: 'a', A3: 'c' })).toBe('a, c')
    expect(calc('LEFT("Nexgent",3)&RIGHT("Nexgent",4)&MID("Nexgent",2,2)')).toBe('Nexgentex')
    expect(calc('LEN(TRIM("  a   b "))')).toBe(3)
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c')
    expect(calc('UPPER("abc")&LOWER("DEF")')).toBe('ABCdef')
    expect(calc('VALUE("12.5")+1')).toBe(13.5)
    expect(calc('FIND("b","abcb",3)')).toBe(4)
    expect(calc('SEARCH("B","abc")')).toBe(2)
    expect(calc('DATE(2026,10,11)')).toBe(46306)
    expect(calc('YEAR(46306)*10000+MONTH(46306)*100+DAY(46306)')).toBe(20261011)
    expect(calc('DATE(2026,13,1)')).toBe(46388)
  })

  it('lists its functions and refuses others instead of guessing', () => {
    expect(SUPPORTED_FUNCTIONS).toEqual(expect.arrayContaining(['SUM', 'ROUNDUP', 'VLOOKUP', 'XLOOKUP', 'SUMIFS', 'IFERROR', 'TEXTJOIN']))
    expect(SUPPORTED_FUNCTIONS).not.toContain('TODAY')
    expect(strictError('UNKNOWNFUNCTION(A1)')).toContain('function UNKNOWNFUNCTION is not supported')
    expect(strictError('TODAY()')).toContain('function TODAY is not supported')
    expect(strictError('ROUND(1)')).toContain('ROUND takes 2 arguments')
  })
})

describe('references and refused syntax', () => {
  it('reads other sheets (quoted names, case-insensitive) and refuses missing ones', () => {
    const extra = { 'My Sheet': { B2: 7 }, Inputs: { A1: 3 } }
    expect(calc("'My Sheet'!B2*inputs!A1", {}, extra)).toBe(21)
    expect(strictError('Missing!A1')).toContain('sheet that does not exist')
  })

  it('refuses circular references, naming the cell', () => {
    expect(strictError('Z99+1')).toContain('circular reference')
    const sheets = book({ Data: { A1: '=B1+1', B1: '=A1+1' } })
    expect(() => new Calculator(sheets, { strict: true }).calculateAll()).toThrow(/Data!A1 .*circular reference/)
  })

  it('refuses names, external workbooks, structured, 3-D and whole-column references, intersections and arrays', () => {
    for (const [formula, message] of [
      ['Total*2', 'names are not supported'],
      ["'[outside.xlsx]Data'!A1", 'other workbooks'],
      ['[outside.xlsx]Data!A1', 'other workbooks'],
      ['Table1[Amount]', 'names are not supported'],
      ['SUM(Sheet1:Sheet3!A1)', '3-D'],
      ['SUM(A:A)', 'whole-column'],
      ['SUM(1:1)', 'whole-row'],
      ['SUM(A1:B2 B1:C2)', 'intersection'],
      ['SUM({1,2})', 'array constants'],
    ] as const) {
      expect(() => parseFormula(formula), formula).toThrow(FormulaUnsupported)
      expect(() => parseFormula(formula), formula).toThrow(message)
    }
    expect(() => parseFormula('SUM(1;2)')).toThrow(SyntaxError)
    expect(() => parseFormula('1+')).toThrow(SyntaxError)
    expect(() => parseFormula('"open')).toThrow(SyntaxError)
    expect(strictError('A1:A3', { A1: 1 })).toContain('array (spill) formulas are not supported')
  })

  it('translates shared formulas and prefixes newer functions for the file', () => {
    expect(translateFormula('A1*$B$1+Inputs!C2+SUM(A1:A3)', 2, 1)).toBe('B3*$B$1+Inputs!D4+SUM(B3:B5)')
    expect(translateFormula('$A1+B$1', 1, 1)).toBe('$A2+C$1')
    expect(translateFormula('A1', -1, 0)).toBe('#REF!')
    expect(translateFormula("'My Sheet'!A1", 1, 0)).toBe("'My Sheet'!A2")
    expect(toFileFormula('xlookup(1,A1:A2,B1:B2)+concat("a")+sum(1)')).toBe('_xlfn.XLOOKUP(1,A1:A2,B1:B2)+_xlfn.CONCAT("a")+SUM(1)')
    expect(parseFormula('_xlfn.XLOOKUP(1,A1:A2,B1:B2)')).toMatchObject({ kind: 'call', name: 'XLOOKUP' })
  })
})
