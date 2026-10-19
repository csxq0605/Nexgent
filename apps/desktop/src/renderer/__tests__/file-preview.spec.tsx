// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FilePreview, parseCsv, parseSheets } from '../components/FilePreview.js'

describe('deliverable file preview', () => {
  it('parses CSV with quoted commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"1,200","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['1,200', 'say "hi"\nthere']])
  })

  it('splits a spreadsheet\'s text into named sheets and puts the row cap in words', () => {
    const text = '## Sheet: 地区汇总 (range A1:B3, 3 rows × 2 columns)\n地区,销售额\n华南,12427.2\n华东,4877.9\n\n## Sheet: 空表\n(empty)\n\n## Sheet: 明细 (range A1:A900, 900 rows × 1 columns)\n订单\nSO1\n[showing the first 2 of 900 rows; pass maxRows to see more]'
    const sheets = parseSheets(text)
    expect(sheets.map(sheet => sheet.heading)).toEqual(['地区汇总', '空表', '明细'])
    expect(sheets[0]!.rows).toEqual([['地区', '销售额'], ['华南', '12427.2'], ['华东', '4877.9']])
    expect(sheets[1]!.rows).toEqual([])
    expect(sheets[2]!.rows).toEqual([['订单'], ['SO1']])
    expect(sheets[2]!.note).toBe('只显示前 2 行，共 900 行；完整内容请在文件管理器中打开。')
  })

  it('shows a workbook as one table per sheet and other text as is', () => {
    const { unmount } = render(<FilePreview path="out/汇总.xlsx" text={'## Sheet: 地区汇总 (range A1:B2, 2 rows × 2 columns)\n地区,销售额\n华南,12427.2'} />)
    expect(screen.getAllByTestId('preview-sheet')).toHaveLength(1)
    expect([...screen.getByTestId('file-content').querySelectorAll('th')].map(th => th.textContent)).toEqual(['地区', '销售额'])
    expect([...screen.getByTestId('file-content').querySelectorAll('td')].map(td => td.textContent)).toEqual(['华南', '12427.2'])
    unmount()
    render(<FilePreview path="notes.md" text="# 标题" />)
    expect(screen.getByTestId('file-content').tagName).toBe('PRE')
  })
})
