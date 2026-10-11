#!/usr/bin/env node
/**
 * Materials of the step-2 real task (docs/plan/step-2-work-partition.md
 * §真实模型补验): `orders.csv` (about 300 order lines with deliberate dirt:
 * repeated order ids, empty regions, region codes in mixed case with spaces,
 * amounts with thousands separators) and `regions.xlsx` (region code →
 * Chinese name). Deterministic: running it again rewrites the same bytes.
 *
 * The hidden check (../step2-sales-hidden.mjs) imports REGIONS from here and
 * computes the expected summary from orders.csv on its own.
 *
 * Usage: node scripts/real-task/step2-sales/generate.mjs   (writes next to itself)
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Region codes and the Chinese names in regions.xlsx. */
export const REGIONS = { north: '华北', south: '华南', east: '华东', west: '华西', central: '华中' }
export const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const csvCell = value => (/[",\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The orders.csv text. */
export function ordersCsv() {
  const random = rng(20261011)
  const codes = Object.keys(REGIONS)
  const variants = code => [code, code.toUpperCase(), ` ${code}`, `${code[0].toUpperCase()}${code.slice(1)} `]
  const rows = []
  let id = 10001
  // Every region has orders in every month, so month-over-month growth is defined after January.
  for (const month of MONTHS) {
    for (const code of codes) {
      const count = 8 + Math.floor(random() * 4)
      for (let i = 0; i < count; i += 1) {
        const day = String(1 + Math.floor(random() * 28)).padStart(2, '0')
        const cents = 2000 + Math.floor(random() * 350000)
        const amount = (cents / 100).toFixed(2)
        const region = random() < 0.2 ? variants(code)[1 + Math.floor(random() * 3)] : code
        const shown = cents >= 100000 && random() < 0.5 ? Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) : amount
        rows.push([`SO-${id}`, `${month}-${day}`, region, shown])
        id += 1
      }
    }
  }
  // Orders with an empty region (cannot be attributed).
  for (let i = 0; i < 6; i += 1) {
    const month = MONTHS[i % MONTHS.length]
    rows.push([`SO-${id}`, `${month}-15`, i % 2 === 0 ? '' : '  ', (100 + i * 37.5).toFixed(2)])
    id += 1
  }
  // Repeated order ids: exact copies of earlier lines.
  const copies = []
  for (let i = 0; i < 12; i += 1) copies.push([...rows[Math.floor(random() * (rows.length - 6))]])
  for (const copy of copies) rows.splice(Math.floor(random() * rows.length), 0, copy)
  return ['order_id,order_date,region,amount', ...rows.map(row => row.map(csvCell).join(','))].join('\n') + '\n'
}

// ---- a minimal .xlsx writer (stored zip, shared strings) --------------------------------------

function zip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(0, 8) // stored
    header.writeUInt32LE(0x00210000, 10) // fixed time/date: 1980-01-01
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt32LE(0x00210000, 12)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + data.length
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

const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** regions.xlsx: one sheet 地区对照 with 代码 / 地区名称. */
export function regionsXlsx() {
  const rows = [['代码', '地区名称'], ...Object.entries(REGIONS)]
  const strings = [...new Set(rows.flat())]
  const cell = (value, column, row) => `<c r="${column}${row}" t="s"><v>${strings.indexOf(value)}</v></c>`
  const sheetRows = rows.map((row, index) => `<row r="${index + 1}">${cell(row[0], 'A', index + 1)}${cell(row[1], 'B', index + 1)}</row>`).join('')
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="地区对照" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><sheetData>${sheetRows}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t>${xml(s)}</t></si>`).join('')}</sst>`],
  ])
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(HERE, 'orders.csv'), ordersCsv())
  writeFileSync(join(HERE, 'regions.xlsx'), regionsXlsx())
  process.stderr.write('step2-sales: wrote orders.csv and regions.xlsx\n')
}
