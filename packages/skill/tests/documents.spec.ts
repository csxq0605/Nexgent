import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  columnName,
  csvField,
  decodeXmlText,
  DocumentError,
  documentFormat,
  extractDocument,
  isDateFormat,
  parseCellRef,
  parsePageRange,
  readXlsx,
  readXlsxCells,
  renderDocumentXml,
  scanXml,
  serialToIso,
} from '../src/index.js'
import { fixtureBytes } from './helpers.js'

describe('.docx', () => {
  it('extracts headings, paragraphs, list items and tables from a Word file', async () => {
    const text = await extractDocument('docx', await fixtureBytes('report.docx'))
    expect(text.split('\n')).toEqual([
      '# 季度报告 Quarterly report',
      'Revenue grew 12% in Q3; costs, as before, stayed "flat".',
      '- First item',
      '- Second item',
      '## Details',
      '| Region | Units | Note |',
      '| North | 120 | a\\|b |',
      '| 南区 | 80 |  |',
      'Tab\tseparated',
      'The end.',
    ])
  })

  it('skips tracked deletions and field codes, keeps line breaks', () => {
    const xml = '<w:document xmlns:w="w"><w:body>'
      + '<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:br/><w:t xml:space="preserve"> &amp; more</w:t></w:r></w:p>'
      + '<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>3</w:t></w:r></w:p>'
      + '</w:body></w:document>'
    expect(renderDocumentXml(xml)).toBe('kept\n & more\n3')
  })
})

describe('.xlsx', () => {
  it('reads every sheet as CSV of cached values, with dates as ISO text and booleans', async () => {
    const text = await extractDocument('xlsx', await fixtureBytes('orders.xlsx'))
    expect(text).toBe([
      '## Sheet: Orders (range A1:H4, 4 rows × 8 columns)',
      'id,customer,qty,price,date,total,,TRUE',
      '1,"Acme, Inc.",3,9.5,2026-10-01,28.5,,',
      '2,张三,5,2.25,2026-10-02,11.25,,',
      '3,"Line\nbreak",1,100,2026-10-03T14:30:00,100,,',
      '',
      '## Sheet: Summary (range B2:C2, 1 rows × 2 columns)',
      'Total,139.75',
    ].join('\n'))
  })

  it('selects a sheet, caps rows with a note, and names the sheets when one is missing', async () => {
    const data = await fixtureBytes('orders.xlsx')
    const summary = await extractDocument('xlsx', data, { sheet: 'Summary' })
    expect(summary).toBe('## Sheet: Summary (range B2:C2, 1 rows × 2 columns)\nTotal,139.75')
    const capped = await extractDocument('xlsx', data, { sheet: 'Orders', maxRows: 2 })
    expect(capped.split('\n')).toEqual([
      '## Sheet: Orders (range A1:H4, 4 rows × 8 columns)',
      'id,customer,qty,price,date,total,,TRUE',
      '1,"Acme, Inc.",3,9.5,2026-10-01,28.5,,',
      '[showing the first 2 of 4 rows; pass maxRows to see more]',
    ])
    expect(() => readXlsx(data, { sheet: 'Nope' })).toThrow(/no sheet named "Nope"; sheets: "Orders", "Summary"/)
  })

  it('reads inline strings and cells without references in a hand-made package', async () => {
    const zip = zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c t="inlineStr"><is><t>a</t></is></c><c t="e"><v>#DIV/0!</v></c></row><row r="3"><c r="C3"><v>1.5</v></c></row></sheetData></worksheet>'),
    })
    const [sheet] = readXlsx(zip)
    expect(sheet!.rows).toEqual([['a', '#DIV/0!', ''], ['', '', ''], ['', '', '1.5']])
  })

  it('reads typed cells with formulas: cached values, dates, errors, shared formulas', async () => {
    const book = readXlsxCells(await fixtureBytes('orders.xlsx'))
    expect(book.date1904).toBe(false)
    expect(book.sheets.map(sheet => sheet.name)).toEqual(['Orders', 'Summary'])
    const orders = book.sheets[0]!.cells
    expect(orders.find(cell => cell.row === 2 && cell.column === 6)).toEqual({ row: 2, column: 6, value: 28.5, formula: { kind: 'normal', text: 'C2*D2' } })
    expect(orders.find(cell => cell.row === 2 && cell.column === 5)).toEqual({ row: 2, column: 5, value: 46296, date: true })
    expect(orders.find(cell => cell.row === 3 && cell.column === 2)).toEqual({ row: 3, column: 2, value: '张三' })
    expect(book.sheets[1]!.cells).toEqual([
      { row: 2, column: 2, value: 'Total' },
      { row: 2, column: 3, value: 139.75, formula: { kind: 'normal', text: 'SUM(Orders!F2:F4)' } },
    ])
    const zip = zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c>'
        + '<c r="B1"><f t="shared" ref="B1:B2" si="0">A1+1</f><v>1</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c></row>'
        + '<row r="2"><c r="B2"><f t="shared" si="0"/></c><c r="C2"/></row></sheetData></worksheet>'),
    })
    expect(readXlsxCells(zip).sheets[0]!.cells).toEqual([
      { row: 1, column: 1, value: '#DIV/0!', error: true, formula: { kind: 'normal', text: '1/0' } },
      { row: 1, column: 2, value: 1, formula: { kind: 'shared', text: 'A1+1', sharedIndex: '0', ref: 'B1:B2' } },
      { row: 1, column: 3, value: true },
      { row: 1, column: 4, value: 'ab', formula: { kind: 'normal', text: '"a"&"b"' } },
      { row: 2, column: 2, value: null, formula: { kind: 'shared', sharedIndex: '0' } },
    ])
    expect(() => readXlsxCells(zip, { maxCells: 4 })).toThrow('workbook has more than 4 used cells')
  })

  it('cell references, CSV quoting and date formats', () => {
    expect(parseCellRef('B12')).toEqual({ column: 2, row: 12 })
    expect(parseCellRef('$AA$3')).toEqual({ column: 27, row: 3 })
    expect(parseCellRef('12')).toBeUndefined()
    expect([1, 26, 27, 702, 703].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField(' pad')).toBe('" pad"')
    expect(isDateFormat('yyyy-mm-dd')).toBe(true)
    expect(isDateFormat('[$-409]mmm-yy')).toBe(true)
    expect(isDateFormat('h:mm:ss')).toBe(true)
    expect(isDateFormat('0.00%')).toBe(false)
    expect(isDateFormat('#,##0 "days"')).toBe(false)
    expect(isDateFormat('[Red]0.0')).toBe(false)
    expect(isDateFormat('General')).toBe(false)
    expect(serialToIso(46296, false)).toBe('2026-10-01')
    expect(serialToIso(46298.5625, false)).toBe('2026-10-03T13:30:00')
    expect(serialToIso(0.5, false)).toBe('12:00:00')
    expect(serialToIso(0, true)).toBe('1904-01-01')
  })
})

describe('.pdf', () => {
  it('extracts text per page, CJK included', async () => {
    const text = await extractDocument('pdf', await fixtureBytes('report.pdf'))
    expect(text.split('\n')[0]).toBe('## Page 1 of 1')
    for (const line of ['季度报告 Quarterly report', 'Revenue grew 12% in Q3; costs, as before, stayed "flat".', 'North 120 a|b', '南区 80', 'The end.']) {
      expect(text).toContain(line)
    }
  })

  it('reads a page range', async () => {
    const data = await fixtureBytes('pages.pdf')
    expect(await extractDocument('pdf', data, { pages: '2-3' })).toBe(
      '## Page 2 of 3\nPage 2 heading\nBody text of page 2.\n\n## Page 3 of 3\nPage 3 heading\nBody text of page 3.',
    )
    expect(await extractDocument('pdf', data, { pages: '3,1' })).toMatch(/^## Page 1 of 3[\s\S]*## Page 3 of 3/)
    await expect(extractDocument('pdf', data, { pages: '4' })).rejects.toThrow(/beyond the last page \(3\)/)
  })

  it('parses page ranges', () => {
    expect(parsePageRange('1-3', 10)).toEqual([1, 2, 3])
    expect(parsePageRange('5, 2-3, 3', 10)).toEqual([2, 3, 5])
    expect(parsePageRange('8-20', 10)).toEqual([8, 9, 10])
    for (const bad of ['', 'a', '0', '3-1', '1-', '-2']) expect(() => parsePageRange(bad, 10)).toThrow(DocumentError)
  })
})

describe('damaged and unsupported input', () => {
  it.each([
    ['docx', 'a truncated package', async () => (await fixtureBytes('report.docx')).subarray(0, 2000), /not a valid \.docx file/],
    ['docx', 'a ZIP without word/document.xml', async () => Buffer.from(zipSync({ 'a.txt': strToU8('x') })), /no word\/document\.xml/],
    ['xlsx', 'random bytes', async () => Buffer.from('this is not a zip file at all'), /not a valid \.xlsx file/],
    ['xlsx', 'a broken sheet', async () => Buffer.from(zipSync({
      'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1"><v>1</v'),
    })), /not a valid \.xlsx file/],
    ['pdf', 'a truncated PDF', async () => (await fixtureBytes('pages.pdf')).subarray(0, 300), /\.pdf/],
    ['pdf', 'random bytes', async () => Buffer.from('%PDF-1.7 garbage'), /\.pdf/],
  ] as const)('%s: %s → DocumentError', async (format, _label, bytes, message) => {
    const error = await extractDocument(format, await bytes()).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(DocumentError)
    expect((error as Error).message).toMatch(message)
  })

  it('knows its formats by extension', () => {
    expect(['a.DOCX', 'b.xlsx', 'c.Pdf', 'd.xls', 'e.xlsm', 'f'].map(documentFormat)).toEqual(['docx', 'xlsx', 'pdf', undefined, undefined, undefined])
  })
})

describe('xml scanner', () => {
  it('decodes entities, keeps CDATA, skips comments and declarations', () => {
    const events = [...scanXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- c --><a x=\'1 &gt; 0\'><![CDATA[<raw>]]>t&#x4e2d;&#25991;<b/></a>')]
    expect(events).toEqual([
      { kind: 'open', name: 'a', attrs: { x: '1 > 0' }, selfClosing: false },
      { kind: 'text', text: '<raw>' },
      { kind: 'text', text: 't中文' },
      { kind: 'open', name: 'b', attrs: {}, selfClosing: true },
      { kind: 'close', name: 'a' },
    ])
    expect(decodeXmlText('&unknown; &#xFFFFFF;')).toBe('&unknown; &#xFFFFFF;')
    expect(() => [...scanXml('<a')]).toThrow(/unterminated tag/)
  })
})
