import { describe, expect, it } from 'vitest'
import { readXlsx } from '@nexgent/skill'
import {
  buildWorkbook,
  CalculationError,
  Calculator,
  FormulaError,
  loadWorkbook,
  SpreadsheetInputError,
  WRITE_LIMITS,
} from '../src/index.js'
import { partOf, rawXlsx, withPart } from './helpers.js'

/** The two-sheet example the Python tests used (`organization_spreadsheets` tests). */
function tables(quantity: number | string = 3) {
  return [
    { name: 'Summary', rows: [['Item', 'Total'], ['A', '=Inputs!B2*Inputs!C2']] },
    { name: 'Inputs', rows: [['Item', 'Quantity', 'Price'], ['A', quantity, 10]] },
  ]
}

function recalc(bytes: Uint8Array) {
  const book = loadWorkbook(bytes)
  const calculator = new Calculator(book.sheets, { strict: false })
  return { book, calculator, values: calculator.calculateAll() }
}

describe('writing a workbook', () => {
  it('stores live formulas with their calculated values (cached values match an independent reader)', () => {
    const written = buildWorkbook(tables())
    expect(written.values).toEqual({ Summary: { B2: 30 }, Inputs: {} })
    expect(written.sheets).toEqual([
      { name: 'Summary', rows: 2, columns: 2, formulas: 1 },
      { name: 'Inputs', rows: 2, columns: 3, formulas: 0 },
    ])
    expect(partOf(written.bytes, 'xl/worksheets/sheet1.xml')).toContain('<c r="B2"><f>Inputs!B2*Inputs!C2</f><v>30</v></c>')
    expect(partOf(written.bytes, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    // read_document's reader (cached values only) sees the real number.
    expect(readXlsx(written.bytes, { sheet: 'Summary' })[0]!.rows).toEqual([['Item', 'Total'], ['A', '30']])
    expect(recalc(written.bytes).values.get('Summary')!.get('2,2')).toBe(30)
    expect(buildWorkbook(tables()).bytes).toEqual(written.bytes)
  })

  it('a zero input still calculates (0 is a value, not a missing one)', () => {
    expect(buildWorkbook(tables(0)).values.Summary).toEqual({ B2: 0 })
  })

  it.each([
    ['=1/0', '#DIV/0!'],
    ['=Missing!A1', 'sheet that does not exist'],
    ['=B2', 'circular reference'],
    ["='[outside.xlsx]Data'!A1", 'other workbooks'],
    ['=UNKNOWNFUNCTION(A1)', 'function UNKNOWNFUNCTION is not supported'],
    ['=A2+', 'cannot parse the formula'],
  ])('refuses %s without producing a workbook', (formula, message) => {
    let error: unknown
    try {
      buildWorkbook([{ name: 'Data', rows: [['Input', 'Result'], [2, formula]] }])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CalculationError)
    expect((error as CalculationError).message).toContain('Data!B2')
    expect((error as CalculationError).message).toContain(message)
  })

  it('writes text, booleans, empty cells, literal "=" text and newer functions', () => {
    const written = buildWorkbook([{
      name: 'Notes & data',
      headerRow: false,
      rows: [['a <b> & "c"', true, null, "'=not a formula", '=_xlfn.CONCAT("x",A2)', '=TEXTJOIN("-",TRUE,A1:A2)'], ['line\nbreak', false, '', ' padded ']],
    }])
    const sheet = partOf(written.bytes, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<f>_xlfn.CONCAT(&quot;x&quot;,A2)</f><v>xline\nbreak</v>')
    expect(sheet).not.toContain('<pane')
    expect(partOf(written.bytes, 'xl/sharedStrings.xml')).toContain('<t>a &lt;b&gt; &amp; &quot;c&quot;</t>')
    const { book } = recalc(written.bytes)
    const cells = book.sheets[0]!.cells
    expect(cells.get('1,4')).toEqual({ value: '=not a formula' })
    expect(cells.get('1,2')).toEqual({ value: true })
    expect(cells.has('1,3')).toBe(false)
    expect(cells.get('2,4')).toEqual({ value: ' padded ' })
    expect(written.values['Notes & data']).toEqual({ E1: 'xline\nbreak', F1: 'a <b> & "c"-line\nbreak' })
  })

  it('validates sheet names, shapes and limits before calculating', () => {
    const bad = (input: unknown) => () => buildWorkbook(input)
    expect(bad([])).toThrow(SpreadsheetInputError)
    expect(bad([{ name: 'a/b', rows: [[1]] }])).toThrow('may not contain')
    expect(bad([{ name: 'x'.repeat(32), rows: [[1]] }])).toThrow('1–31 characters')
    expect(bad([{ name: 'Data', rows: [[1]] }, { name: 'data', rows: [[1]] }])).toThrow('duplicate sheet name')
    expect(bad([{ name: 'History', rows: [[1]] }])).toThrow('reserved')
    expect(bad([{ name: 'Data', rows: [] }])).toThrow('non-empty array of rows')
    expect(bad([{ name: 'Data', rows: [[{}]] }])).toThrow('Data!A1: cells must be')
    expect(bad([{ name: 'Data', rows: [[Number.NaN]] }])).toThrow('finite')
    expect(bad([{ name: 'Data', rows: [['a\u0001b']] }])).toThrow('control characters')
    expect(bad([{ name: 'Data', rows: [new Array(WRITE_LIMITS.columnsPerSheet + 1).fill(1)] }])).toThrow(`at most ${WRITE_LIMITS.columnsPerSheet} columns`)
    expect(bad(Array.from({ length: WRITE_LIMITS.sheets + 1 }, (_, i) => ({ name: `S${i}`, rows: [[1]] })))).toThrow(`at most ${WRITE_LIMITS.sheets} sheets`)
  })
})

describe('reading a workbook', () => {
  it('recalculates when an input changed after the file was saved (stale cache)', () => {
    const written = buildWorkbook(tables())
    const inputs = partOf(written.bytes, 'xl/worksheets/sheet2.xml').replace('<c r="B2"><v>3</v></c>', '<c r="B2"><v>5</v></c>')
    const edited = withPart(written.bytes, 'xl/worksheets/sheet2.xml', inputs)
    const { book, values } = recalc(edited)
    expect(book.sheets[0]!.cells.get('2,2')).toMatchObject({ value: 30, formula: 'Inputs!B2*Inputs!C2' })
    expect(values.get('Summary')!.get('2,2')).toBe(50)
  })

  it('reads a sheet without a <dimension> element', () => {
    const written = buildWorkbook(tables())
    const summary = partOf(written.bytes, 'xl/worksheets/sheet1.xml').replace(/<dimension\b[^>]*\/>/, '')
    expect(recalc(withPart(written.bytes, 'xl/worksheets/sheet1.xml', summary)).values.get('Summary')!.get('2,2')).toBe(30)
  })

  it('expands shared formulas to each cell and keeps array formulas as saved', () => {
    const bytes = rawXlsx({
      Data: '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*10</f><v>10</v></c><c r="C1"><f t="array" ref="C1:C2">A1:A2*2</f><v>2</v></c></row>'
        + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>0</v></c><c r="C2"><v>4</v></c></row>'
        + '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/></c></row>',
    })
    const { book, values } = recalc(bytes)
    expect(book.sheets[0]!.cells.get('3,2')).toMatchObject({ formula: 'A3*10' })
    expect([...values.get('Data')!]).toEqual([['1,2', 10], ['2,2', 20], ['3,2', 30]])
    expect(book.keptAsSaved).toEqual([{ sheet: 'Data', row: 1, column: 3, reason: 'array formula kept as saved' }])
    expect(book.sheets[0]!.cells.get('1,3')).toEqual({ value: 2 })
  })

  it('keeps the saved value of a formula it cannot calculate, and reports it', () => {
    const bytes = rawXlsx({
      Data: '<row r="1"><c r="A1"><f>TEXT(B1,"0.0")</f><v>12</v></c><c r="B1"><v>12</v></c><c r="C1"><f>A1&amp;"!"</f><v>12!</v></c><c r="D1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>',
    })
    const { calculator, values } = recalc(bytes)
    expect(values.get('Data')!.get('1,1')).toBe(12)
    expect(values.get('Data')!.get('1,3')).toBe('12!')
    expect(values.get('Data')!.get('1,4')).toBeInstanceOf(FormulaError)
    expect(calculator.issues).toEqual([{ sheet: 'Data', row: 1, column: 1, formula: 'TEXT(B1,"0.0")', message: 'function TEXT is not supported' }])
  })
})
