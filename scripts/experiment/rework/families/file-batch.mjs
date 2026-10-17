// @ts-check
/**
 * Family `file-batch`, 批量整理转换文件: an `inbox/` folder of CSV exports is converted to JSON
 * under a seeded output folder and naming rule, the originals stay untouched, and a manifest
 * lists what was made. A case carries 2–3 input problems drawn from the pool below, so what
 * pays off is the habit of looking at every input, counting rows in against rows out and never
 * dropping data silently, not any one rule.
 *
 * Note points are scored for at most two of a case's noted problems (the rubric holds six
 * scored points at most); every problem still changes the expected JSON or manifest, so the
 * result point covers all of them.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { isDeepStrictEqual } from 'node:util'
import { picker } from '../../step6/rng.mjs'
import { bytesOf, listFiles, no, normalize, ok, pad, parseCsv, problemLine, readBytes, readText, sameBytes, sha256, toCsv } from '../common.mjs'

/**
 * @typedef {import('../common.mjs').Family} Family
 * @typedef {import('../common.mjs').InnerCase} InnerCase
 * @typedef {import('../common.mjs').Point} Point
 * @typedef {import('../common.mjs').Answer} Answer
 * @typedef {{ name: string, kind: 'id' | 'word' | 'int' | 'dec' | 'date', prefix?: string, words?: string[], lo?: number, hi?: number }} Col
 * @typedef {{ stem: string, cols: Col[] }} Theme
 * @typedef {{
 *   file: string, cols: Col[], rows: string[][], delimiter: ',' | ';', bom: boolean,
 *   ragged: { idx: number, kind: 'short' | 'long' } | null,
 *   expected: Array<Record<string, string | number>>, target: string, collide: boolean,
 * }} Table
 */

/** Input problems a case may carry. */
export const TRAP_POOL = /** @type {const} */ (['bom-header', 'ragged-row', 'duplicate-file', 'name-collision', 'empty-file', 'semicolon-delimited'])

/** Problems whose handling the notes must explain (the others only change the JSON). */
const NOTED = ['ragged-row', 'duplicate-file', 'name-collision', 'empty-file']

/** @type {Theme[]} */
const THEMES = [
  { stem: 'Orders Q3', cols: [{ name: '订单号', kind: 'id', prefix: 'OD' }, { name: '客户', kind: 'word', words: ['林记商贸', '周氏百货', '启明文具', '鼎盛五金', '恒信贸易', '远航物流'] }, { name: '数量', kind: 'int', lo: 1, hi: 60 }, { name: '单价', kind: 'dec' }] },
  { stem: 'Stock List', cols: [{ name: '货号', kind: 'id', prefix: 'SK' }, { name: '品名', kind: 'word', words: ['笔记本', '订书机', '便签纸', '打印纸', '文件夹', '签字笔', '计算器'] }, { name: '库存', kind: 'int', lo: 0, hi: 480 }, { name: '仓库', kind: 'word', words: ['A仓', 'B仓', 'C仓'] }] },
  { stem: 'Visit Log', cols: [{ name: '记录号', kind: 'id', prefix: 'VL' }, { name: '门店', kind: 'word', words: ['东门店', '西湖店', '南站店', '北苑店'] }, { name: '客流', kind: 'int', lo: 40, hi: 900 }, { name: '成交', kind: 'int', lo: 5, hi: 200 }] },
  { stem: 'Expense Sheet', cols: [{ name: '单据号', kind: 'id', prefix: 'EX' }, { name: '部门', kind: 'word', words: ['销售部', '行政部', '采购部', '客服部'] }, { name: '金额', kind: 'dec' }, { name: '日期', kind: 'date' }] },
  { stem: 'Return Items', cols: [{ name: '退货号', kind: 'id', prefix: 'RT' }, { name: '货品', kind: 'word', words: ['台灯', '水杯', '键盘', '鼠标垫', '耳机'] }, { name: '件数', kind: 'int', lo: 1, hi: 9 }, { name: '原因', kind: 'word', words: ['质量问题', '发错货', '客户取消', '尺寸不符'] }] },
  { stem: 'Shipping Plan', cols: [{ name: '运单号', kind: 'id', prefix: 'SH' }, { name: '城市', kind: 'word', words: ['杭州', '宁波', '温州', '嘉兴', '绍兴'] }, { name: '重量', kind: 'dec' }, { name: '状态', kind: 'word', words: ['已发出', '待发货', '运输中'] }] },
  { stem: 'Support Tickets', cols: [{ name: '工单号', kind: 'id', prefix: 'TK' }, { name: '渠道', kind: 'word', words: ['电话', '邮件', '在线'] }, { name: '时长', kind: 'int', lo: 2, hi: 95 }, { name: '级别', kind: 'word', words: ['高', '中', '低'] }] },
  { stem: 'Staff Hours', cols: [{ name: '工号', kind: 'id', prefix: 'ST' }, { name: '姓名', kind: 'word', words: ['王磊', '李敏', '张伟', '刘洋', '陈静'] }, { name: '工时', kind: 'dec' }, { name: '班次', kind: 'word', words: ['早班', '晚班', '夜班'] }] },
  { stem: 'Refunds', cols: [{ name: '退款号', kind: 'id', prefix: 'RF' }, { name: '买家', kind: 'word', words: ['顾晨', '沈悦', '何宁', '许航'] }, { name: '退款额', kind: 'dec' }, { name: '日期', kind: 'date' }] },
  { stem: 'Inventory', cols: [{ name: '盘点号', kind: 'id', prefix: 'IV' }, { name: '品类', kind: 'word', words: ['文具', '数码', '家居', '饰品'] }, { name: '实盘', kind: 'int', lo: 0, hi: 300 }, { name: '备注', kind: 'word', words: ['正常', '破损', '待核'] }] },
]

const isNum = (/** @type {Col} */ col) => col.kind === 'int' || col.kind === 'dec'
const baseName = (/** @type {string} */ path) => path.trim().replace(/\\/g, '/').split('/').pop() ?? ''
const stemOf = (/** @type {string} */ file) => file.replace(/\.csv$/i, '')
const hasWord = (/** @type {string} */ text, /** @type {string[]} */ words) => words.some(w => text.includes(w))
const json2 = (/** @type {unknown} */ value) => `${JSON.stringify(value, null, 2)}\n`

/** The CSV text of a table. @param {Table} t */
function tableText(t) {
  const d = t.delimiter
  const lines = [t.cols.map(c => c.name).join(d)]
  t.rows.forEach((row, i) => {
    const cells = t.ragged?.idx === i ? (t.ragged.kind === 'short' ? row.slice(0, -1) : [...row, '多出一列']) : row
    lines.push(cells.join(d))
  })
  return `${t.bom ? '﻿' : ''}${lines.join('\n')}\n`
}

/**
 * Whether `value` is an acceptable conversion of `t`. The task leaves the malformed row's
 * handling open, so two handlings count: left out (`t.expected`), or kept with what it has
 * (a short row's missing last field empty, null or absent; a long row's extra field dropped
 * or kept under any extra key). Every other row must be exact.
 * @param {Table} t @param {unknown} value
 */
function acceptable(t, value) {
  if (isDeepStrictEqual(value, t.expected)) return true
  if (t.ragged === null || !Array.isArray(value) || value.length !== t.rows.length) return false
  const full = t.rows.map(row => Object.fromEntries(t.cols.map((c, k) => [c.name, isNum(c) ? Number(row[k]) : row[k]])))
  return value.every((got, i) => {
    if (i !== t.ragged?.idx) return isDeepStrictEqual(got, full[i])
    if (got === null || typeof got !== 'object' || Array.isArray(got)) return false
    const want = /** @type {Record<string, unknown>} */ (full[i])
    const last = t.cols[t.cols.length - 1].name
    return t.cols.every(c => {
      const v = /** @type {Record<string, unknown>} */ (got)[c.name]
      if (t.ragged?.kind === 'short' && c.name === last) return v === undefined || v === null || v === ''
      return isDeepStrictEqual(v, want[c.name])
    })
  })
}

/** The records a correct conversion holds (the ragged row left out). @param {Table} t */
function expectedOf(t) {
  return t.rows.filter((_, i) => t.ragged?.idx !== i).map(row => Object.fromEntries(t.cols.map((c, k) => [c.name, isNum(c) ? Number(row[k]) : row[k]])))
}

/** @type {Family['build']} */
function build(seed, { convention }) {
  const p = picker(`file-batch:${seed}`)
  // Ids carry a code derived from the seed, never the seed itself (it names the split).
  const code = sha256(seed).slice(0, 4).toUpperCase()
  const sep = p.pick(['-', '_'])
  const outDir = p.pick(['out', 'converted'])
  const notePath = `${outDir}/notes.md`
  const manifestPath = `${outDir}/manifest.csv`
  /** @type {string[]} */
  const drawn = p.shuffle(TRAP_POOL).slice(0, p.int(2, 3))
  if (!drawn.some(t => NOTED.includes(t))) drawn[drawn.length - 1] = p.pick(NOTED)
  const traps = [...drawn].sort((a, b) => TRAP_POOL.indexOf(/** @type {any} */ (a)) - TRAP_POOL.indexOf(/** @type {any} */ (b)))
  const has = (/** @type {string} */ t) => traps.includes(t)

  let serial = 0
  /** @param {Theme} theme @param {string} file @returns {Table} */
  const makeTable = (theme, file) => {
    const n = p.int(4, 9)
    const rows = Array.from({ length: n }, () => {
      serial += 1
      return theme.cols.map(c => {
        if (c.kind === 'id') return `${c.prefix}${code}${pad(serial)}`
        if (c.kind === 'word') return p.pick(/** @type {string[]} */ (c.words))
        if (c.kind === 'int') return String(p.int(/** @type {number} */ (c.lo), /** @type {number} */ (c.hi)))
        if (c.kind === 'dec') return (p.int(150, 99900) / 100).toFixed(2)
        return `2026-${pad(p.int(7, 11))}-${pad(p.int(1, 28))}`
      })
    })
    return { file, cols: theme.cols, rows, delimiter: ',', bom: false, ragged: null, expected: [], target: '', collide: false }
  }

  const baseThemes = p.shuffle(THEMES)
  const nBase = p.int(6, 7)
  const base = baseThemes.slice(0, nBase)
  const spare = baseThemes.slice(nBase)
  /** @type {Table[]} */
  const tables = base.map(theme => makeTable(theme, `${theme.stem}.csv`))
  const free = [...tables]
  const take = (/** @type {(t: Table) => boolean} */ pred = () => true) => {
    const at = free.findIndex(pred)
    if (at < 0) throw new Error('file-batch: no free table for a trap')
    return free.splice(at, 1)[0]
  }

  /** @type {Record<string, any>} */
  const trap = {}
  if (has('bom-header')) { const t = take(); t.bom = true; trap.bom = { file: t.file } }
  if (has('semicolon-delimited')) { const t = take(); t.delimiter = ';'; trap.semi = { file: t.file } }
  if (has('ragged-row')) {
    const t = take()
    t.ragged = { idx: p.int(1, t.rows.length - 2), kind: p.pick(/** @type {const} */ (['short', 'long'])) }
    trap.ragged = { file: t.file, line: t.ragged.idx + 2, kind: t.ragged.kind, fields: t.cols.length }
  }
  if (has('empty-file')) { const t = take(); t.rows = []; trap.empty = { file: t.file } }
  if (has('duplicate-file')) {
    const t = take()
    const copy = { ...t, file: `Export ${pad(p.int(1, 12))}${pad(p.int(1, 28))}.csv` }
    tables.push(copy)
    trap.dup = { orig: t.file, copy: copy.file }
  }
  if (has('name-collision')) {
    const t = take(x => x.file.includes(' '))
    const [w1, w2] = stemOf(t.file).split(' ')
    const other = makeTable(spare[0], `${w1}${sep}${w2}.csv`)
    tables.push(other)
    t.collide = true
    other.collide = true
    trap.collide = { a: t.file, b: other.file }
  }
  // Expected records and nominal targets once all edits are in.
  for (const t of tables) {
    t.expected = expectedOf(t)
    t.target = `${stemOf(t.file).toLowerCase().replace(/ /g, sep)}.json`
  }
  tables.sort((a, b) => (a.file < b.file ? -1 : 1))
  if (trap.collide !== undefined) trap.collide.target = tables.find(t => t.collide)?.target

  const ruleText = sep === '-' ? '文件名全小写，保留原来的名字（扩展名以外的部分），空格换成连字符“-”，扩展名改成 .json' : '文件名全小写，保留原来的名字（扩展名以外的部分），空格换成下划线“_”，扩展名改成 .json'
  const numeric = [...new Set(tables.flatMap(t => t.cols.filter(isNum).map(c => c.name)))]
  const ask = p.pick([
    `inbox/ 里是几份导出的 CSV（共 ${tables.length} 个，另有一个 export-log.txt 不用转换）。请把每个 CSV 转成一个 JSON 文件，内容是对象数组，每行一个对象、键用表头的列名；这些列是数值列，要写成 JSON 数字：${numeric.join('、')}，其余列保持字符串。转换结果放在 ${outDir}/ 下，${ruleText}。inbox/ 里的原文件不要改动、不要删除。再写一份清单 ${manifestPath}，表头 source,target,rows，每个转换的 CSV 一行：source 是 inbox 里的文件名，target 是生成的 JSON 文件名，rows 是 JSON 里的记录条数。`,
    `请整理 inbox/ 下的 ${tables.length} 份 CSV 导出（export-log.txt 只是日志，不用管）：每份转成一个 JSON 数组文件（对象的键是表头，${numeric.join('、')} 这几列是数值，要存成数字，别的列都是字符串），存到 ${outDir}/，${ruleText}。原文件保持原样，留在 inbox/。另外生成 ${manifestPath}，表头为 source,target,rows，一个 CSV 一行（source 为 inbox 里的文件名，target 为 JSON 文件名，rows 为 JSON 里的记录条数）。`,
  ])
  const log = [`导出批次 ${code}`, ...tables.map(t => `${t.file}  ${t.rows.length + 1} lines`), ''].join('\n')
  /** @type {Record<string, string | Uint8Array>} */
  const files = Object.fromEntries([...tables.map(t => [`inbox/${t.file}`, tableText(t)]), ['inbox/export-log.txt', log]])

  // Scored note points: the first two noted problems in pool order.
  const notedTraps = traps.filter(t => NOTED.includes(t)).slice(0, 2)
  /** @type {Point[]} */
  const rubric = [
    { id: '', type: 'wrong-result', by: 'check', weight: 3, text: `${outDir}/ 下每个 CSV 都有对应的 JSON，内容是表头为键的对象数组，数值列是数字（格式不对的行不转换或按现有字段保留都可以，其余行一行不少）`, feedback: '有的 JSON 内容和 CSV 对不上' },
    { id: '', type: 'format', by: 'check', weight: 2, text: `${manifestPath} 表头是 source,target,rows，每个 CSV 一行，target 是实际生成的 JSON 文件名，rows 是对应 JSON 里的记录条数`, feedback: '清单里的文件、对应的 JSON 文件名或行数不对' },
    { id: '', type: 'missing', by: 'check', weight: 1, text: 'inbox/ 里的原文件字节不变、一个不少', feedback: 'inbox 里的原文件被改动或删掉了' },
  ]
  /** @type {Record<string, string>} */
  const pointTrap = {}
  for (const t of notedTraps) {
    const text = {
      'ragged-row': `${notePath} 指出 ${trap.ragged?.file} 里字段数不对的那一行（行号或记录号都可以）及怎么处理的`,
      'duplicate-file': `${notePath} 指出 ${trap.dup?.orig} 和 ${trap.dup?.copy} 内容完全相同`,
      'name-collision': `${notePath} 指出 ${trap.collide?.a} 和 ${trap.collide?.b} 会得到同一个 JSON 文件名、已区分开`,
      'empty-file': `${notePath} 指出 ${trap.empty?.file} 只有表头、没有数据行`,
    }[/** @type {'ragged-row' | 'duplicate-file' | 'name-collision' | 'empty-file'} */ (t)]
    const feedback = {
      'ragged-row': '有一份 CSV 里有一行格式不对，说明里没写清是哪个文件的哪一行',
      'duplicate-file': '有两份输入文件内容一模一样，说明里没提',
      'name-collision': '有两份输入按命名规则会转成同一个文件名，说明里没提怎么处理',
      'empty-file': '有个输入文件没有数据行，说明里没提',
    }[/** @type {'ragged-row' | 'duplicate-file' | 'name-collision' | 'empty-file'} */ (t)]
    pointTrap[`${rubric.length}`] = t
    rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text, feedback })
  }
  if (convention) rubric.push({ id: '', type: 'convention', by: 'check', weight: 1, text: `${outDir}/ 下的 JSON 文件用两个空格缩进、文件末尾留一个换行`, feedback: 'JSON 文件的排版不统一，请统一用两个空格缩进，文件末尾留一个换行' })
  rubric.forEach((point, i) => { point.id = `r${i + 1}` })
  /** @type {Record<string, string>} */
  const noteOf = {}
  for (const [index, t] of Object.entries(pointTrap)) noteOf[`r${Number(index) + 1}`] = t

  return {
    variant: `${traps.length}-problems`,
    message: `${ask}${problemLine(notePath)}`,
    files,
    outputs: [outDir, manifestPath, notePath],
    rubric,
    traps,
    fingerprints: tables.slice(0, 3).map(t => t.rows[0]?.[0]).filter(x => x !== undefined).concat([`导出批次 ${code}`]),
    hidden: { tables, outDir, notePath, manifestPath, trap, noteOf, sep },
  }
}

/** Parsed JSON of a file, or undefined. @param {string} dir @param {string} rel */
async function readJson(dir, rel) {
  try { return JSON.parse(await readText(dir, rel)) } catch { return undefined }
}

/** Texts around each place `needle` occurs. @param {string} text @param {string} needle @param {number} width */
function windows(text, needle, width) {
  const out = []
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(text.slice(Math.max(0, at - width), at + needle.length + width))
  return out
}

/** @type {Family['checkers']} */
function checkers(task) {
  /** @type {Table[]} */
  const tables = task.hidden.tables
  const { outDir, notePath, manifestPath, trap, noteOf } = task.hidden
  /** JSON files under the output folder. @param {string} dir */
  const outputs = async dir => {
    const found = []
    for (const rel of await listFiles(dir, outDir)) {
      if (!rel.toLowerCase().endsWith('.json')) continue
      const value = await readJson(dir, rel)
      if (value !== undefined) found.push({ rel, name: baseName(rel), value })
    }
    return found
  }
  /** @type {Record<string, import('../common.mjs').Checker>} */
  const out = {}
  for (const point of task.rubric) {
    if (point.type === 'wrong-result') {
      out[point.id] = async dir => {
        const found = await outputs(dir)
        for (const t of tables) {
          if (t.collide) {
            if (!found.some(f => acceptable(t, f.value))) return no(`没有 ${t.file} 的转换结果`)
          } else {
            const got = found.find(f => f.rel === `${outDir}/${t.target}`)
            if (got === undefined) return no(`没有 ${t.target}`)
            if (!acceptable(t, got.value)) return no(`${t.target} 内容不对`)
          }
        }
        return ok()
      }
    } else if (point.type === 'format') {
      out[point.id] = async dir => {
        let rows
        try { rows = parseCsv(await readText(dir, manifestPath)) } catch { return no(`没有 ${manifestPath}`) }
        if (rows[0]?.map(c => c.trim().toLowerCase()).join(',') !== 'source,target,rows') return no(`表头 ${rows[0]?.join(',')}`)
        const collideTargets = []
        for (const t of tables) {
          const row = rows.slice(1).find(r => baseName(r[0] ?? '') === t.file)
          if (row === undefined) return no(`清单里没有 ${t.file}`)
          const target = baseName(row[1] ?? '')
          // The count of the JSON actually written (either handling of a malformed row), else of the left-out handling.
          const written = await readJson(dir, `${outDir}/${target}`)
          const count = Array.isArray(written) && acceptable(t, written) ? written.length : t.expected.length
          if (String(row[2] ?? '').trim() !== String(count)) return no(`${t.file} 的行数 ${row[2]}`)
          if (t.collide) {
            if (target === '' || !acceptable(t, written)) return no(`${t.file} 的 target ${target} 不对`)
            collideTargets.push(target)
          } else if (target !== t.target) return no(`${t.file} 的 target ${target}`)
        }
        return new Set(collideTargets).size === collideTargets.length ? ok() : no('两个重名文件的 target 相同')
      }
    } else if (point.type === 'missing') {
      out[point.id] = async dir => {
        for (const [rel, content] of Object.entries(task.files)) {
          let got
          try { got = await readBytes(dir, rel) } catch { return no(`${rel} 不见了`) }
          if (!sameBytes(got, bytesOf(content))) return no(`${rel} 被改动`)
        }
        return ok()
      }
    } else if (point.type === 'convention') {
      out[point.id] = async dir => {
        const found = await outputs(dir)
        const pretty = found.filter(f => tables.some(t => acceptable(t, f.value)))
        if (pretty.length === 0) return no('没有可检查的 JSON')
        for (const f of pretty) {
          const text = await readText(dir, f.rel)
          const want = json2(f.value)
          // JSON with non-ASCII escaped (\uXXXX) is the same layout.
          const escaped = want.replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
          if (text !== want && text !== escaped) return no(`${f.name} 排版不是两个空格缩进加末尾换行`)
        }
        return ok()
      }
    } else if (point.type === 'unverified') {
      const kind = noteOf[point.id]
      out[point.id] = async dir => {
        const note = normalize(await readText(dir, notePath).catch(() => '')).toLowerCase()
        if (note === '') return no(`没有 ${notePath}`)
        if (kind === 'ragged-row') {
          // The row named by its file line, by its place among the data rows, or by its record id.
          const n = trap.ragged.line
          const at = (/** @type {number} */ k) => `第\\s*${k}\\s*(?:行|条)|(?<![\\d.])${k}\\s*(?:行|条)|行\\s*${k}(?!\\d)|(?:line|row)\\s*${k}(?!\\d)|[:#]\\s*${k}(?!\\d)|\\bl${k}(?!\\d)`
          const line = new RegExp(`${at(n)}|${at(n - 1)}`)
          const table = tables.find(t => t.file === trap.ragged.file)
          const id = String(table?.rows[table.ragged?.idx ?? -1]?.[0] ?? '\u0000').toLowerCase()
          const stem = stemOf(trap.ragged.file).toLowerCase()
          return windows(note, stem, 160).some(w => line.test(w) || w.includes(id)) || note.includes(id) && note.includes(stem) ? ok() : no('说明里没有写清是哪个文件的哪一行')
        }
        // File names match however the separator between words is written (space, _ or -).
        const loose = note.replace(/[ _-]+/g, ' ')
        const names = (/** @type {string} */ f) => loose.includes(stemOf(f).toLowerCase().replace(/[ _-]+/g, ' '))
        if (kind === 'duplicate-file') {
          const both = [trap.dup.orig, trap.dup.copy].every(names)
          return both && hasWord(note, ['重复', '相同', '一样', '一致', '副本', 'duplicate', 'identical', 'same']) ? ok() : no('说明里没有指出这对重复文件')
        }
        if (kind === 'name-collision') {
          const both = [trap.collide.a, trap.collide.b].every(names)
          return both && hasWord(note, ['冲突', '重名', '同名', '相同', '撞', '后缀', '区分', '覆盖', '改名', '重命名', '同一个', '编号', '另存', '不同的名字', 'collision', 'conflict', 'same name', 'suffix', 'overwrite']) ? ok() : no('说明里没有指出这对重名文件')
        }
        const stem = stemOf(trap.empty.file).toLowerCase()
        return windows(note, stem, 160).some(w => hasWord(w, ['空', '没有数据', '无数据', '只有表头', '仅有表头', '仅表头', '0 行', '0 条', '0行', '0条', '没有记录', '无记录', '没有内容', '零行', '0 records', 'zero rows', 'empty', 'header only', 'no data', 'no rows'])) ? ok() : no('说明里没有提到空文件')
      }
    }
  }
  return out
}

/** The JSON file name a table gets in the good answer. @param {Table[]} tables @param {Table} t */
function targetOf(tables, t) {
  if (!t.collide) return t.target
  const first = tables.find(x => x.collide)
  return first === t ? t.target : t.target.replace(/\.json$/, '-2.json')
}

/** The notes that mention every problem; `skip` leaves one out. @param {InnerCase} task @param {string} [skip] */
function noteText(task, skip) {
  const { trap } = task.hidden
  const lines = ['# 转换说明', '']
  if (trap.bom !== undefined && skip !== 'bom-header') lines.push(`- ${trap.bom.file} 开头带 UTF-8 BOM，读取时已去掉，键名里没有它。`)
  if (trap.semi !== undefined && skip !== 'semicolon-delimited') lines.push(`- ${trap.semi.file} 用分号分隔，按分号解析。`)
  if (trap.ragged !== undefined && skip !== 'ragged-row') lines.push(`- ${trap.ragged.file} 第 ${trap.ragged.line} 行的字段数和表头不一致（表头 ${trap.ragged.fields} 列），没有转换，JSON 里去掉了这一条，其余行照常。`)
  if (trap.dup !== undefined && skip !== 'duplicate-file') lines.push(`- ${trap.dup.copy} 和 ${trap.dup.orig} 内容完全相同（重复文件），两份都转换了。`)
  if (trap.collide !== undefined && skip !== 'name-collision') lines.push(`- ${trap.collide.a} 和 ${trap.collide.b} 按命名规则都会得到 ${trap.collide.target}，重名冲突：先到的用原名，另一个加了后缀 -2。`)
  if (trap.empty !== undefined && skip !== 'empty-file') lines.push(`- ${trap.empty.file} 只有表头、没有数据行（空文件），转成了 []，清单里行数为 0。`)
  lines.push('- 其余文件逐个核对过行数，转换前后一致。', '')
  return lines.join('\n')
}

/** @param {InnerCase} task @param {Table} t */
const jsonPath = (task, t) => `${task.hidden.outDir}/${targetOf(task.hidden.tables, t)}`

/** @type {Family['good']} */
function good(task) {
  /** @type {Table[]} */
  const tables = task.hidden.tables
  /** @type {Record<string, string>} */
  const write = {}
  for (const t of tables) write[jsonPath(task, t)] = json2(t.expected)
  write[task.hidden.manifestPath] = toCsv([['source', 'target', 'rows'], ...tables.map(t => [t.file, targetOf(tables, t), String(t.expected.length)])])
  write[task.hidden.notePath] = noteText(task)
  return { write, remove: [] }
}

/** @type {Family['bad']} */
function bad(task) {
  /** @type {Table[]} */
  const tables = task.hidden.tables
  return task.rubric.filter(point => point.by === 'check').map(point => {
    const answer = good(task)
    if (point.type === 'wrong-result') {
      const t = /** @type {Table} */ (tables.find(x => !x.collide && x.expected.length > 0))
      answer.write[jsonPath(task, t)] = json2(t.expected.slice(0, -1))
    } else if (point.type === 'format') {
      const rows = parseCsv(String(answer.write[task.hidden.manifestPath]))
      answer.write[task.hidden.manifestPath] = toCsv(rows.slice(0, -1))
    } else if (point.type === 'missing') {
      answer.remove.push(`inbox/${tables[0].file}`)
    } else if (point.type === 'convention') {
      for (const t of tables) answer.write[jsonPath(task, t)] = JSON.stringify(t.expected)
    } else {
      answer.write[task.hidden.notePath] = noteText(task, task.hidden.noteOf[point.id])
    }
    return { point: point.id, answer }
  })
}

/** @type {Family} */
export const fileBatch = {
  name: 'file-batch',
  title: '批量整理转换文件',
  habit: '批量处理前先看每个输入，转换前后核对条数，不静默丢数据，遇到格式不对、重复、重名要保留并写明',
  trapPool: TRAP_POOL,
  convention: { text: 'JSON 文件用两个空格缩进、结尾换行', feedback: 'JSON 文件的排版不统一，请统一用两个空格缩进，文件末尾留一个换行' },
  build,
  checkers,
  good,
  bad,
}
