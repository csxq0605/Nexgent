/**
 * A minimal .xlsx reader and writer for the step-3 restock task: enough to
 * generate the material deterministically and to read back what the model
 * produced — sheet names, cell values (numbers, shared and inline strings,
 * booleans), formulas and their cached values. No dependencies (node:zlib);
 * not a general spreadsheet library.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

// ---- zip -------------------------------------------------------------------------------------

/**
 * Build a zip archive with fixed timestamps (deterministic bytes).
 * @param files - `[name, text | Buffer]` in order.
 * @param options - `compress` deflates entries (method 8) instead of storing them.
 */
export function zip(files, { compress = false } = {}) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const body = compress ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(compress ? 8 : 0, 8)
    header.writeUInt32LE(0x00210000, 10)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(compress ? 8 : 0, 10)
    entry.writeUInt32LE(0x00210000, 12)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

/**
 * Read every entry of a zip archive (stored or deflated) from its central directory.
 * @returns `Map<name, Buffer>`.
 */
export function unzip(bytes) {
  const buf = Buffer.from(bytes)
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip archive (no end of central directory)')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const out = new Map()
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const raw = buf.subarray(dataStart, dataStart + size)
    if (method === 0) out.set(name, Buffer.from(raw))
    else if (method === 8) out.set(name, inflateRawSync(raw))
    else throw new Error(`zip entry ${name}: unsupported compression method ${method}`)
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

// ---- xml helpers -----------------------------------------------------------------------------

const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unescapeXml = value => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&amp;/g, '&')
/** Attributes of an XML start tag's attribute text, prefixes dropped (`r:id` → `id` also kept as `r:id`). */
function attributes(text) {
  const out = {}
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const value = unescapeXml(match[3] ?? match[4] ?? '')
    out[match[1]] = value
    const local = match[1].split(':').pop()
    if (!(local in out)) out[local] = value
  }
  return out
}
/** Concatenated text of every `<t>` element (shared or inline rich text). */
const textOf = xml => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => unescapeXml(m[1])).join('')

// ---- reading -----------------------------------------------------------------------------------

/** `A1` → `{ column: 1, row: 1 }` (1-based). */
export function parseRef(ref) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(ref))
  if (match === null) throw new Error(`bad cell reference ${ref}`)
  let column = 0
  for (const ch of match[1]) column = column * 26 + (ch.charCodeAt(0) - 64)
  return { column, row: Number(match[2]) }
}

/** 1-based column number → letters. */
export function columnName(column) {
  let name = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/**
 * Read a workbook.
 * @returns `{ sheets: [{ name, cells: Map<ref, { value, formula? }> }] }`; `value` is a
 *   number, string, boolean or `null` (no cached value), `formula` the formula text without `=`.
 */
export function readWorkbook(bytes) {
  const files = unzip(bytes)
  const text = name => files.get(name)?.toString('utf8')
  const workbook = text('xl/workbook.xml')
  if (workbook === undefined) throw new Error('not an .xlsx workbook (no xl/workbook.xml)')
  const rels = new Map()
  for (const match of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attributes(match[1])
    rels.set(a.Id, a.Target)
  }
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => textOf(m[1]))
  const sheets = []
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const a = attributes(match[1])
    const target = rels.get(a['r:id'] ?? a.id)
    if (target === undefined) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    sheets.push({ name: a.name, cells: readSheet(text(path) ?? '', shared) })
  }
  return { sheets }
}

function readSheet(xml, shared) {
  const cells = new Map()
  for (const match of xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
    const a = attributes(match[1])
    const inner = match[2] ?? ''
    const formula = /<(?:\w+:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?f>/.exec(inner)?.[1]
    const raw = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1]
    let value = null
    if (a.t === 'inlineStr') value = textOf(inner)
    else if (raw !== undefined) {
      const v = unescapeXml(raw)
      if (a.t === 's') value = shared[Number(v)] ?? null
      else if (a.t === 'str' || a.t === 'e') value = v
      else if (a.t === 'b') value = v === '1'
      else value = Number(v)
    }
    cells.set(a.r, formula === undefined ? { value } : { value, formula: unescapeXml(formula) })
  }
  return cells
}

/** A sheet as rows of cells: `rows[r-1][c-1]` (sparse rows are padded with `undefined`). */
export function sheetRows(sheet) {
  const rows = []
  for (const [ref, cell] of sheet.cells) {
    const { row, column } = parseRef(ref)
    rows[row - 1] ??= []
    rows[row - 1][column - 1] = { ref, ...cell }
  }
  return rows
}

// ---- writing -----------------------------------------------------------------------------------

/**
 * Write a workbook.
 * @param sheets - `[{ name, rows: [[cell]] }]`; a cell is a number, a string, `null`, or
 *   `{ formula, value }` (formula without `=`, value the cached result).
 * @param options - `compress` deflates the zip entries.
 */
export function writeWorkbook(sheets, { compress = false } = {}) {
  const strings = []
  const stringIndex = new Map()
  const intern = (s) => {
    if (!stringIndex.has(s)) {
      stringIndex.set(s, strings.length)
      strings.push(s)
    }
    return stringIndex.get(s)
  }
  const cellXml = (cell, ref) => {
    if (cell === null || cell === undefined) return ''
    if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
    if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${intern(cell)}</v></c>`
    const cached = cell.value
    if (typeof cached === 'string') return `<c r="${ref}" t="str"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cached)}</v></c>`
    return `<c r="${ref}"><f>${escapeXml(cell.formula)}</f>${cached === undefined || cached === null ? '' : `<v>${cached}</v>`}</c>`
  }
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const sheetFiles = sheets.map((sheet, index) => {
    const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => cellXml(cell, `${columnName(c + 1)}${r + 1}`)).join('')}</row>`).join('')
    return [`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><sheetData>${rows}</sheetData></worksheet>`]
  })
  const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ...sheetFiles,
    ['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('')}</sst>`],
  ], { compress })
}
