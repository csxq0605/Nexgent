// @ts-check
/**
 * Minimal Office files for the step-6 pilot (ADR 0011): write and read the .xlsx and
 * .docx files the file-handling tasks start from and the judges inspect. Only what the
 * pilot needs: a zip container (stored entries on write; stored and deflated on read),
 * worksheets of strings and numbers, documents of headings, paragraphs and tables.
 *
 * Output is deterministic (fixed timestamps, fixed entry order), so the plan file that
 * embeds these files has a stable hash.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Uint8Array} data */
export function crc32(data) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** 1980-01-01 00:00, the zip epoch: a fixed stamp keeps the bytes stable. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/**
 * A zip of stored (uncompressed) entries, in the given order.
 * @param {Array<[string, string | Uint8Array]>} entries
 * @returns {Uint8Array}
 */
export function zip(entries) {
  /** @type {Buffer[]} */
  const parts = []
  /** @type {Buffer[]} */
  const central = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBytes, data)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014B50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(0, 10)
    head.writeUInt16LE(DOS_TIME, 12)
    head.writeUInt16LE(DOS_DATE, 14)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(data.length, 20)
    head.writeUInt32LE(data.length, 24)
    head.writeUInt16LE(nameBytes.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(head, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, ...central, end]))
}

/**
 * Entries of a zip (stored or deflated), read from the central directory.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
export function unzip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054B50) { end = i; break }
  }
  if (end < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  /** @type {Map<string, Uint8Array>} */
  const out = new Map()
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014B50) throw new Error('bad zip central directory')
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const raw = buf.subarray(dataAt, dataAt + size)
    if (method === 0) out.set(name, new Uint8Array(raw))
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)))
    else throw new Error(`zip entry ${name}: unsupported method ${method}`)
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** @param {string} text */
export const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** @param {string} text */
export const unescapeXml = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&amp;/g, '&')

/** Attribute value of the first `name="…"` in a tag. @param {string} tag @param {string} name */
const attr = (tag, name) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match === null ? undefined : unescapeXml(match[1])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

/**
 * @typedef {string | number | null} Cell
 * @typedef {{ name: string, rows: Cell[][] }} Sheet
 */

/** Column letters of a 0-based index. @param {number} index */
export function columnName(index) {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** 0-based column index of a cell reference such as `AB12`. @param {string} ref */
function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const char of letters) n = n * 26 + (char.charCodeAt(0) - 64)
  return n - 1
}

/**
 * An .xlsx workbook: strings are inline strings, numbers are numbers.
 * @param {Sheet[]} sheets
 * @returns {Uint8Array}
 */
export function writeXlsx(sheets) {
  const sheetXml = (/** @type {Sheet} */ sheet) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell === null || cell === '') return ''
        const ref = `${columnName(c)}${r + 1}`
        return typeof cell === 'number'
          ? `<c r="${ref}"><v>${cell}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`
      }).join('')
      return `<row r="${r + 1}">${cells}</row>`
    }).join('')
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  }
  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
  }</sheets></workbook>`
  const workbookRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  }</Relationships>`
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  }</Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  return zip([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ...sheets.map((sheet, i) => /** @type {[string, string]} */ ([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)])),
  ])
}

/** Text of an `<si>` or `<is>` element (all `<t>` runs). @param {string} xml */
const runsText = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(m => unescapeXml(m[1] ?? '')).join('')

/**
 * Sheets of an .xlsx in workbook order. Cells keep their stored type: numbers (`n`, or
 * no type) as numbers, shared / inline / formula strings and booleans as strings.
 * `types` gives the stored type per cell (`n` or `s`) so a judge can tell a number
 * stored as text.
 * @param {Uint8Array} bytes
 * @returns {Array<Sheet & { types: Array<Array<'n' | 's' | null>> }>}
 */
export function readXlsx(bytes) {
  const files = unzip(bytes)
  const text = (/** @type {string} */ path) => {
    const entry = files.get(path)
    return entry === undefined ? undefined : Buffer.from(entry).toString('utf8')
  }
  const workbook = text('xl/workbook.xml')
  if (workbook === undefined) throw new Error('xlsx without xl/workbook.xml')
  const rels = text('xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]))
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => runsText(m[1]))
  const out = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(match[0], 'name') ?? ''
    const target = targets.get(attr(match[0], 'r:id')) ?? ''
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    const xml = text(path) ?? ''
    /** @type {Cell[][]} */
    const rows = []
    /** @type {Array<Array<'n' | 's' | null>>} */
    const types = []
    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const r = Number(attr(`<row${rowMatch[1] ?? rowMatch[3]}>`, 'r') ?? rows.length + 1) - 1
      /** @type {Cell[]} */
      const row = []
      /** @type {Array<'n' | 's' | null>} */
      const rowTypes = []
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${cellMatch[1]}>`
        const ref = attr(tag, 'r')
        const c = ref === undefined ? row.length : columnIndex(ref)
        const t = attr(tag, 't')
        const body = cellMatch[2] ?? ''
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        /** @type {Cell} */
        let value = null
        /** @type {'n' | 's' | null} */
        let type = null
        if (t === 's') { value = shared[Number(v)] ?? ''; type = 's' }
        else if (t === 'inlineStr') { value = runsText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''); type = 's' }
        else if (t === 'str' || t === 'b' || t === 'e') { value = v === undefined ? '' : unescapeXml(v); type = 's' }
        else if (v !== undefined) { value = Number(v); type = 'n' }
        while (row.length < c) { row.push(null); rowTypes.push(null) }
        row[c] = value
        rowTypes[c] = type
      }
      while (rows.length < r) { rows.push([]); types.push([]) }
      rows[r] = row
      types[r] = rowTypes
    }
    out.push({ name, rows, types })
  }
  return out
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

/**
 * @typedef {{ kind: 'heading', level: 1 | 2 | 3, text: string }
 *   | { kind: 'paragraph', text: string }
 *   | { kind: 'table', rows: string[][] }} Block
 */

/**
 * A .docx of headings (styles Heading1–3), paragraphs and tables.
 * @param {Block[]} blocks
 * @returns {Uint8Array}
 */
export function writeDocx(blocks) {
  const run = (/** @type {string} */ text) => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
  const body = blocks.map(block => {
    if (block.kind === 'heading') return `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${run(block.text)}</w:p>`
    if (block.kind === 'paragraph') return `<w:p>${run(block.text)}</w:p>`
    const rows = block.rows.map(row => `<w:tr>${row.map(cell => `<w:tc><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`).join('')
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${rows}</w:tbl>`
  }).join('')
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  const styles = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${
    [1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`).join('')
  }</w:styles>`
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  const docRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  return zip([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rootRels],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', styles],
  ])
}

/**
 * Blocks of a .docx: headings (from `Heading1`–`3` / `Title` style ids or names), paragraphs
 * and tables, in document order. Empty paragraphs are dropped.
 * @param {Uint8Array} bytes
 * @returns {Block[]}
 */
export function readDocx(bytes) {
  const files = unzip(bytes)
  const entry = files.get('word/document.xml')
  if (entry === undefined) throw new Error('docx without word/document.xml')
  const xml = Buffer.from(entry).toString('utf8')
  const paragraphText = (/** @type {string} */ p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => unescapeXml(m[1])).join('')
  /** @type {Block[]} */
  const blocks = []
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml
  for (const match of body.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    if (match[1] !== undefined) {
      const rows = [...match[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)]
        .map(tr => [...tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map(tc => paragraphText(tc[1]).trim()))
      blocks.push({ kind: 'table', rows })
      continue
    }
    const inner = match[2] ?? ''
    const text = paragraphText(inner).trim()
    if (text === '') continue
    const style = /<w:pStyle w:val="([^"]+)"/.exec(inner)?.[1] ?? ''
    const level = /^(?:Heading|heading\s?)([1-3])$/.exec(style)?.[1] ?? (style === 'Title' ? '1' : undefined)
    blocks.push(level === undefined ? { kind: 'paragraph', text } : { kind: 'heading', level: /** @type {1 | 2 | 3} */ (Number(level)), text })
  }
  return blocks
}
