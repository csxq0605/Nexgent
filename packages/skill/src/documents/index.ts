/**
 * Document extraction for `read_document`: `.docx` → text, `.xlsx` → CSV-style
 * tables per sheet, `.pdf` → text per page. Pure JS (`fflate`, `unpdf`), no
 * native modules, nothing in a document is executed.
 */
import { extname } from 'node:path'
import { DocumentError } from './errors.js'
import { extractDocx } from './docx.js'
import { extractPdf } from './pdf.js'
import { extractXlsx } from './xlsx.js'

export { DocumentError } from './errors.js'
export { extractDocx, renderDocumentXml } from './docx.js'
export { columnName, csvField, DEFAULT_MAX_ROWS, extractXlsx, isDateFormat, parseCellRef, readXlsx, readXlsxCells, renderSheets, serialToIso } from './xlsx.js'
export type { SheetTable, XlsxCell, XlsxFormulaKind, XlsxOptions, XlsxSheetCells, XlsxWorkbookCells } from './xlsx.js'
export { extractPdf, parsePageRange } from './pdf.js'
export type { PdfOptions } from './pdf.js'
export { decodeXmlText, localName, scanXml } from './xml.js'
export type { XmlEvent } from './xml.js'
export { MAX_PART_BYTES, readZipParts } from './zip.js'

/** Formats `read_document` reads. */
export type DocumentFormat = 'docx' | 'xlsx' | 'pdf'

/** Format of a path by extension (case-insensitive), or `undefined`. Pure. */
export function documentFormat(path: string): DocumentFormat | undefined {
  const extension = extname(path).toLowerCase()
  return extension === '.docx' ? 'docx' : extension === '.xlsx' ? 'xlsx' : extension === '.pdf' ? 'pdf' : undefined
}

/** Options that apply per format; the others are ignored. */
export interface ExtractOptions {
  readonly sheet?: string
  readonly maxRows?: number
  readonly pages?: string
}

/** Extract a document's text. @throws {@link DocumentError}. */
export async function extractDocument(format: DocumentFormat, data: Uint8Array, options: ExtractOptions = {}): Promise<string> {
  switch (format) {
    case 'docx':
      return extractDocx(data)
    case 'xlsx':
      return extractXlsx(data, {
        ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
        ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
      })
    case 'pdf':
      return extractPdf(data, options.pages === undefined ? {} : { pages: options.pages })
    default:
      throw new DocumentError(`unsupported format ${String(format)}`)
  }
}
