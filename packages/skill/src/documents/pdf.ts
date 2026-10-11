/**
 * `.pdf` → text per page with `unpdf` (a serverless build of PDF.js; no
 * native modules, scripts in the PDF are not run). Scanned pages without a
 * text layer come out empty and are reported as such.
 */
import { getDocumentProxy } from 'unpdf'
import { DocumentError } from './errors.js'

/** Options of {@link extractPdf}. */
export interface PdfOptions {
  /** Page range like `"1-3"`, `"2"` or `"1,4-5"`; default all pages. */
  readonly pages?: string
}

/**
 * Parse a page range against a page count. Pure.
 * @throws {@link DocumentError} for a malformed range or pages beyond the document.
 */
export function parsePageRange(range: string, totalPages: number): number[] {
  const pages = new Set<number>()
  for (const part of range.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part)
    if (!match) throw new DocumentError(`invalid page range ${JSON.stringify(range)}; use forms like "3", "1-3" or "1,4-5"`)
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (from < 1 || to < from) throw new DocumentError(`invalid page range ${JSON.stringify(range)}`)
    if (from > totalPages) throw new DocumentError(`page ${from} is beyond the last page (${totalPages})`)
    for (let page = from; page <= Math.min(to, totalPages); page++) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}

interface TextItemLike {
  readonly str?: string
  readonly hasEOL?: boolean
}

/** Extract the text of a PDF, page by page. */
export async function extractPdf(data: Uint8Array, options: PdfOptions = {}): Promise<string> {
  let document
  try {
    // PDF.js may detach the buffer it is given; pass a copy.
    document = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 })
  } catch (error) {
    const name = (error as Error).name
    if (name === 'PasswordException') throw new DocumentError('the PDF is encrypted with a password; it cannot be read')
    throw new DocumentError(`not a valid .pdf file (${(error as Error).message})`)
  }
  try {
    const total = document.numPages
    const pages = options.pages === undefined ? Array.from({ length: total }, (_, i) => i + 1) : parsePageRange(options.pages, total)
    const out: string[] = []
    let empty = 0
    for (const number of pages) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items as TextItemLike[]) {
        if (typeof item.str !== 'string') continue
        text += item.str
        if (item.hasEOL === true) text += '\n'
      }
      text = text.replace(/[ \t]+\n/g, '\n').trim()
      if (text === '') empty++
      out.push(`## Page ${number} of ${total}\n${text === '' ? '(no text layer on this page)' : text}`)
    }
    if (empty > 0 && empty === pages.length) {
      out.push(`[no page in this range has a text layer; the PDF is probably scanned images, which read_document cannot read]`)
    }
    return out.join('\n\n')
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(`cannot read the .pdf file (${(error as Error).message})`)
  } finally {
    await document.loadingTask.destroy().catch(() => undefined)
  }
}
