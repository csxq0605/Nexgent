// @ts-check
/**
 * Family `recompute`, 表格计算可复算: one or two CSV files of records (shipments,
 * timesheets, meter readings); the task is a grouped, rounded result table AND a script
 * `output/calc.mjs` that regenerates it from `data/`. A case carries 2–3 input problems
 * drawn from the pool below. What pays off is the habit of validating the inputs, making
 * the computation reproducible (the script is rerun on a different dataset of the same
 * shape) and saying what was done, not any one rule.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { picker } from '../../step6/rng.mjs'
import { firstTableDifference, no, ok, pad, parseCsv, problemLine, readText, sha256, toCsv, writeFiles } from '../common.mjs'

/**
 * @typedef {import('../common.mjs').Family} Family
 * @typedef {import('../common.mjs').InnerCase} InnerCase
 * @typedef {import('../common.mjs').Point} Point
 * @typedef {import('../common.mjs').Answer} Answer
 * @typedef {{ id: string, date: string, group: string, raw: string, unit: string }} Rec
 * @typedef {{ key: string, what: string, file: string, headers: string[], groupName: string, valueName: string, base: string, small: string, factor: number, prefix: string, groups: string[], outHeader: string, smallRe: RegExp }} Scenario
 * @typedef {{ files: Record<string, string>, rows: Rec[], table: string[][], trap: Record<string, any> }} Dataset
 */

/** Input problems a case may carry. */
export const TRAP_POOL = /** @type {const} */ (['invalid-value', 'duplicate-id', 'out-of-period', 'mixed-units', 'rounding-trap'])

/** @type {Scenario[]} */
const SCENARIOS = [
  { key: 'shipments', what: '各线路的运单记录', file: 'shipments', headers: ['运单号', '日期', '线路', '重量', '单位'], groupName: '线路', valueName: '重量', base: 'kg', small: 'g', factor: 1000, prefix: 'YD', groups: ['沪杭线', '宁苏线', '京津线', '成渝线', '穗深线', '汉长线', '青烟线'], outHeader: '线路,总重量(kg)', smallRe: /(^|[^a-z])g([^a-z]|$)|克/ },
  { key: 'timesheets', what: '各员工的工时记录', file: 'timesheets', headers: ['工单号', '日期', '员工', '工时', '单位'], groupName: '员工', valueName: '工时', base: '小时', small: '分钟', factor: 60, prefix: 'GS', groups: ['陈明', '林静', '赵磊', '周婷', '吴涛', '郑洁', '孙宇'], outHeader: '员工,总工时(小时)', smallRe: /分钟/ },
  { key: 'readings', what: '各小区的水表抄表记录', file: 'readings', headers: ['抄表号', '日期', '小区', '用水量', '单位'], groupName: '小区', valueName: '用水量', base: '立方米', small: '升', factor: 1000, prefix: 'CB', groups: ['枫林苑', '桂花园', '翠湖里', '云栖路', '松江府', '梧桐里'], outHeader: '小区,总用水量(立方米)', smallRe: /升|(^|[^a-z])l([^a-z]|$)/ },
]

const BAD_VALUES = ['', '待补', 'N/A', '-']
const sum = (/** @type {number[]} */ list) => list.reduce((s, x) => s + x, 0)
/** Hundredths as text. @param {number} h */
const fmt = h => `${Math.floor(h / 100)}.${pad(h % 100)}`
/** Thousandths rounded half up to hundredths. @param {number} m */
const hundredths = m => Math.floor((m + 5) / 10)

/**
 * The table a correct calculation gives: records of the month, an id once, readable numbers
 * only, converted to the base unit, rounded as `mode` says, sorted, with a 合计 row.
 * @param {Scenario} sc @param {Rec[]} rows @param {string} month @param {'row' | 'total'} mode @param {'desc' | 'asc'} dir
 * @returns {{ groups: Array<{ name: string, h: number }>, table: string[][] } | null} null when a group has no counted record or two totals tie
 */
function compute(sc, rows, month, mode, dir) {
  const seen = new Set()
  /** @type {Map<string, number[]>} */
  const byGroup = new Map()
  for (const row of rows) {
    if (!row.date.startsWith(`2026-${month}-`) || seen.has(row.id) || !/^\d+(\.\d+)?$/.test(row.raw.trim())) continue
    seen.add(row.id)
    const v = Number(row.raw.trim())
    const m = Math.round(row.unit === sc.small ? (v * 1000) / sc.factor : v * 1000)
    byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), m])
  }
  const groups = [...byGroup].map(([name, ms]) => ({ name, h: mode === 'row' ? sum(ms.map(hundredths)) : hundredths(sum(ms)) }))
  groups.sort((a, b) => (dir === 'desc' ? b.h - a.h : a.h - b.h) || (a.name < b.name ? -1 : 1))
  if (new Set(groups.map(g => g.h)).size !== groups.length) return null
  const table = [sc.outHeader.split(','), ...groups.map(g => [g.name, fmt(g.h)]), ['合计', fmt(sum(groups.map(g => g.h)))]]
  return { groups, table }
}

/**
 * One dataset with the given problems, or null when this draw does not make them real.
 * @param {ReturnType<typeof picker>} p @param {Scenario} sc @param {string[]} traps @param {string} month
 * @param {string} code @param {number} nFiles @param {'row' | 'total'} mode @param {'desc' | 'asc'} dir
 * @returns {Dataset | null}
 */
function dataset(p, sc, traps, month, code, nFiles, mode, dir) {
  const tricky = traps.includes('rounding-trap')
  const names = p.shuffle(sc.groups).slice(0, p.int(3, 5))
  /** @type {Rec[]} */
  let rows = []
  let serial = 0
  for (const group of names) {
    for (let i = p.int(4, 6); i > 0; i -= 1) {
      serial += 1
      const milli = 10 * p.int(50, 1200) + (tricky ? p.pick([2, 4, 4, 4, 5, 6]) : 0)
      const raw = tricky ? (milli / 1000).toFixed(3) : p.next() < 0.3 ? String(milli / 1000) : (milli / 1000).toFixed(2)
      rows.push({ id: `${sc.prefix}${code}${pad(serial)}`, date: `2026-${month}-${pad(p.int(1, 28))}`, group, raw, unit: sc.base })
    }
  }
  rows = p.shuffle(rows)
  /** @type {Record<string, any>} */
  const trap = {}
  /** @type {Set<number>} */
  const used = new Set()
  const take = (/** @type {number} */ n) => {
    const free = p.shuffle(rows.map((_, i) => i).filter(i => !used.has(i))).slice(0, n)
    for (const i of free) used.add(i)
    return free
  }
  if (traps.includes('mixed-units')) {
    const idx = take(p.int(2, 3))
    for (const i of idx) {
      const v = sc.small === '分钟' ? (tricky ? 3 : 6) * p.int(tricky ? 10 : 5, tricky ? 160 : 80) : (tricky ? 1 : 10) * p.int(tricky ? 300 : 30, tricky ? 9000 : 900)
      rows[i] = { ...rows[i], raw: String(v), unit: sc.small }
    }
    trap.units = { unit: sc.small, ids: idx.map(i => rows[i].id) }
  }
  if (traps.includes('invalid-value')) {
    const idx = take(p.int(1, 2))
    for (const i of idx) rows[i] = { ...rows[i], raw: p.pick(BAD_VALUES) }
    trap.invalid = { ids: idx.map(i => rows[i].id) }
  }
  if (traps.includes('out-of-period')) {
    const idx = take(p.int(1, 2))
    for (const i of idx) rows[i] = { ...rows[i], date: `2026-${pad(Number(month) + p.pick([-1, 1]))}-${pad(p.int(1, 28))}` }
    trap.period = { ids: idx.map(i => rows[i].id) }
  }
  if (traps.includes('duplicate-id')) {
    const [i] = take(1)
    rows.splice(p.int(i + 1, rows.length), 0, { ...rows[i] })
    trap.duplicate = { id: rows[i].id }
  }
  const result = compute(sc, rows, month, mode, dir)
  if (result === null || result.groups.length !== names.length) return null
  if (tricky && compute(sc, rows, month, mode === 'row' ? 'total' : 'row', dir)?.table.join('|') === result.table.join('|')) return null
  const per = Math.ceil(rows.length / nFiles)
  /** @type {Record<string, string>} */
  const files = {}
  for (let f = 0; f < nFiles; f += 1) {
    const chunk = rows.slice(f * per, (f + 1) * per)
    files[`data/${sc.file}${nFiles === 1 ? '' : `-${f + 1}`}.csv`] = toCsv([sc.headers, ...chunk.map(r => [r.id, r.date, r.group, r.raw, r.unit])])
  }
  return { files, rows, table: result.table, trap }
}

/** The script a correct answer ships. @param {Scenario} sc @param {string} month @param {'row' | 'total'} mode @param {'desc' | 'asc'} dir @param {string} resultPath @param {boolean} [header] */
function calcScript(sc, month, mode, dir, resultPath, header = true) {
  const [id, date, group, value, unit] = sc.headers
  return `${header ? `// 输入：data/ 下所有 CSV；输出：${resultPath}
// 运行：在案例文件夹里执行 node output/calc.mjs（不带参数）
` : ''}import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const MONTH = ${JSON.stringify(`2026-${month}-`)}
const SMALL = ${JSON.stringify(sc.small)}
const FACTOR = ${sc.factor}
const PER_ROW = ${mode === 'row'}
const DESC = ${dir === 'desc'}

const seen = new Set()
const byGroup = new Map()
for (const file of readdirSync(join(root, 'data')).filter(name => name.endsWith('.csv')).sort()) {
  const [head, ...lines] = readFileSync(join(root, 'data', file), 'utf8').replace(/^\\uFEFF/, '').split(/\\r?\\n/).filter(line => line.trim() !== '')
  const names = head.split(',').map(cell => cell.trim())
  const at = name => names.indexOf(name)
  for (const line of lines) {
    const cells = line.split(',').map(cell => cell.trim())
    const raw = cells[at(${JSON.stringify(value)})] ?? ''
    if (!cells[at(${JSON.stringify(date)})].startsWith(MONTH)) continue
    if (seen.has(cells[at(${JSON.stringify(id)})])) continue
    if (!/^\\d+(\\.\\d+)?$/.test(raw)) continue
    seen.add(cells[at(${JSON.stringify(id)})])
    const milli = Math.round(cells[at(${JSON.stringify(unit)})] === SMALL ? (Number(raw) * 1000) / FACTOR : Number(raw) * 1000)
    const key = cells[at(${JSON.stringify(group)})]
    byGroup.set(key, [...(byGroup.get(key) ?? []), milli])
  }
}

const half = milli => Math.floor((milli + 5) / 10)
const total = list => list.reduce((s, x) => s + x, 0)
const rows = [...byGroup].map(([name, list]) => [name, PER_ROW ? total(list.map(half)) : half(total(list))])
rows.sort((a, b) => (DESC ? b[1] - a[1] : a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
const text = h => \`\${Math.floor(h / 100)}.\${String(h % 100).padStart(2, '0')}\`
const out = [${JSON.stringify(sc.outHeader)}, ...rows.map(([name, h]) => name + ',' + text(h)), '合计,' + text(total(rows.map(row => row[1])))]
mkdirSync(dirname(join(root, ${JSON.stringify(resultPath)})), { recursive: true })
writeFileSync(join(root, ${JSON.stringify(resultPath)}), out.join('\\n') + '\\n')
`
}

/** @type {Family['build']} */
function build(seed, { convention }) {
  const p = picker(`recompute:${seed}`)
  const sc = p.pick(SCENARIOS)
  const month = pad(p.int(3, 10))
  const nFiles = p.int(1, 2)
  const traps = p.shuffle(TRAP_POOL).slice(0, p.int(2, 3)).sort((a, b) => TRAP_POOL.indexOf(a) - TRAP_POOL.indexOf(b))
  const mode = /** @type {'row' | 'total'} */ (traps.includes('rounding-trap') ? p.pick(['row', 'total']) : 'total')
  const dir = /** @type {'desc' | 'asc'} */ (p.pick(['desc', 'asc']))
  const resultPath = p.pick(['output/result.csv', 'output/summary.csv'])
  const notePath = p.pick(['output/notes.md', 'output/check-notes.md'])
  // Ids carry a code derived from the seed, never the seed itself (it names the split).
  const code = sha256(seed).slice(0, 4).toUpperCase()
  /** @type {Dataset | null} */
  let main = null
  for (let k = 0; main === null && k < 200; k += 1) main = dataset(picker(`recompute:${seed}:main:${k}`), sc, traps, month, code, nFiles, mode, dir)
  /** @type {Dataset | null} */
  let alt = null
  const altCode = sha256(`${seed}:other`).slice(0, 4).toUpperCase()
  for (let k = 0; alt === null && k < 200; k += 1) alt = dataset(picker(`recompute:${seed}:other:${k}`), sc, traps, month, altCode, nFiles, mode, dir)
  if (main === null || alt === null) throw new Error(`recompute: no dataset for ${seed}`)

  const roundingRule = !traps.includes('rounding-trap') ? '保留两位小数（四舍五入）'
    : mode === 'row' ? '每条记录先四舍五入到两位小数、再按组相加（不要先加再舍入）'
      : '按组相加之后再四舍五入到两位小数（不要逐条舍入）'
  const ask = `请把 data/ 下${sc.what}（CSV，可能不止一个文件）统计成一张表，写到 ${resultPath}：表头“${sc.outHeader}”，按${sc.groupName}汇总${sc.valueName}，${sc.valueName}统一用${sc.base}，${roundingRule}，行按总量从${dir === 'desc' ? '多到少' : '少到多'}排列，最后一行是“合计”（各行相加）。统计范围是 2026 年 ${Number(month)} 月；同一编号的记录只算一次，读不出数字的记录不计入。`
    + `另外请写一个脚本 output/calc.mjs：在案例文件夹里直接运行 node output/calc.mjs（不带参数），就能读 data/ 下的 CSV 重新生成 ${resultPath}，方便别人复算。`
  const monthText = `${Number(month)} 月`
  /** @type {Array<{ kind: string, point: Point }>} */
  const noteItems = []
  const t = main.trap
  if (t.invalid !== undefined) noteItems.push({ kind: 'invalid', point: { id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出编号 ${t.invalid.ids.join('、')} 的数值缺失或不是数字、没有计入`, feedback: '有记录的数值读不出来，说明里没提' } })
  if (t.duplicate !== undefined) noteItems.push({ kind: 'duplicate', point: { id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出编号 ${t.duplicate.id} 的记录重复、只算了一次`, feedback: '有重复的记录，说明里没提' } })
  if (t.period !== undefined) noteItems.push({ kind: 'period', point: { id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出编号 ${t.period.ids.join('、')} 的日期不在 ${monthText}、没有计入`, feedback: '有记录不在统计的月份里，说明里没提' } })
  if (t.units !== undefined) noteItems.push({ kind: 'units', point: { id: '', type: 'unverified', by: 'check', weight: 2, text: `${notePath} 指出有记录的单位是${sc.small}、已换算成${sc.base}`, feedback: '有记录的单位和别的不一样，说明里没提' } })
  // At most 6 scored points: with a convention point one note point is left out (its problem is still in the data).
  const drop = convention && noteItems.length > 2 ? p.int(0, noteItems.length - 1) : -1
  const kept = noteItems.filter((_, i) => i !== drop)
  /** @type {Point[]} */
  const rubric = [
    { id: '', type: 'wrong-result', by: 'check', weight: 3, text: `${resultPath} 里每个${sc.groupName}的${sc.valueName}总量和合计正确（只算${monthText}、同一编号一次、读得出数字的记录，统一单位，按要求舍入）`, feedback: '结果表里的数和数据对不上' },
    { id: '', type: 'wrong-result', by: 'check', weight: 2, text: '换一份同样结构的 data/ 后，运行 node output/calc.mjs 能重新生成正确的结果表（脚本不是把数写死）', feedback: '换一份数据重新运行脚本，得不到正确的结果' },
    { id: '', type: 'format', by: 'check', weight: 1, text: `${resultPath} 表头是“${sc.outHeader}”，行按总量从${dir === 'desc' ? '多到少' : '少到多'}排列，最后一行是“合计”且等于各行之和`, feedback: '结果表的表头、行的顺序或合计行不对' },
    ...kept.map(item => item.point),
  ]
  /** @type {Record<string, string>} */
  const kinds = {}
  kept.forEach((item, i) => { kinds[`r${4 + i}`] = item.kind })
  if (convention) rubric.push({ id: '', type: 'convention', by: 'check', weight: 1, text: 'output/calc.mjs 开头的注释写明输入（data/）、输出和运行方法', feedback: '脚本开头缺少说明输入、输出和运行方法的注释' })
  rubric.forEach((point, i) => { point.id = `r${i + 1}` })
  return {
    variant: `${sc.key}-${traps.length}-problems`,
    message: `${ask}${problemLine(notePath)}`,
    files: main.files,
    outputs: [resultPath, 'output/calc.mjs', notePath],
    rubric,
    traps,
    fingerprints: main.rows.slice(0, 3).map(r => r.id),
    hidden: { scenario: sc.key, month, mode, dir, resultPath, notePath, trap: main.trap, table: main.table, kinds, alt: { files: alt.files, table: alt.table } },
  }
}

/** @param {InnerCase} task */
const scenarioOf = task => /** @type {Scenario} */ (SCENARIOS.find(sc => sc.key === task.hidden.scenario))

/**
 * Result rows reduced to a form that ignores the order of groups: header dropped, groups
 * sorted by name, 合计 last. @param {string[][]} rows
 */
function canonical(rows) {
  const body = rows.slice(1).filter(r => r.some(c => c.trim() !== ''))
  const total = body.filter(r => r[0]?.trim() === '合计')
  const groups = body.filter(r => r[0]?.trim() !== '合计').sort((a, b) => ((a[0] ?? '').trim() < (b[0] ?? '').trim() ? -1 : 1))
  return [...groups, ...total].map(r => r.map(c => c.trim()))
}

/** Difference between a result file's text and an expected table, or null. @param {string} text @param {string[][]} table */
function tableDifference(text, table) {
  return firstTableDifference(canonical(parseCsv(text)), canonical(table))
}

/** The leading comment lines of a script (after an optional shebang). @param {string} text */
function leadingComment(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.startsWith('#!')) lines.shift()
  const out = []
  let block = false
  for (const line of lines) {
    const s = line.trim()
    if (block) { out.push(s); if (s.includes('*/')) block = false; continue }
    if (s === '' && out.length === 0) continue
    if (s.startsWith('//')) out.push(s)
    else if (s.startsWith('/*')) { out.push(s); block = !s.includes('*/') }
    else break
  }
  return out.join('\n')
}

/** @type {Family['checkers']} */
function checkers(task) {
  const sc = scenarioOf(task)
  const { resultPath, notePath, table, alt, trap, kinds, mode, dir } = task.hidden
  /** @type {Record<string, import('../common.mjs').Checker>} */
  const out = {}
  const wrongResults = task.rubric.filter(p => p.type === 'wrong-result').map(p => p.id)
  for (const point of task.rubric) {
    if (point.type === 'wrong-result') {
      out[point.id] = point.id === wrongResults[0]
        ? async dir => {
          const text = await readText(dir, resultPath).catch(() => null)
          if (text === null) return no(`没有 ${resultPath}`)
          const diff = tableDifference(text, table)
          return diff === null ? ok() : no(diff)
        }
        : async dir => {
          const tmp = await mkdtemp(join(tmpdir(), 'nx-recompute-'))
          try {
            await cp(dir, tmp, { recursive: true })
            await rm(join(tmp, 'data'), { recursive: true, force: true })
            await writeFiles(tmp, alt.files)
            await rm(join(tmp, resultPath), { force: true })
            if (await readText(tmp, 'output/calc.mjs').catch(() => null) === null) return no('没有 output/calc.mjs')
            const run = spawnSync(process.execPath, ['output/calc.mjs'], { cwd: tmp, timeout: 30000 })
            if (run.error !== undefined || run.status !== 0) return no(`脚本运行失败：${run.error?.message ?? String(run.stderr).slice(0, 150)}`)
            const text = await readText(tmp, resultPath).catch(() => null)
            if (text === null) return no(`脚本没有生成 ${resultPath}`)
            const diff = tableDifference(text, alt.table)
            return diff === null ? ok() : no(`换数据后：${diff}`)
          } finally {
            await rm(tmp, { recursive: true, force: true })
          }
        }
    } else if (point.type === 'format') {
      out[point.id] = async folder => {
        const text = await readText(folder, resultPath).catch(() => null)
        if (text === null) return no(`没有 ${resultPath}`)
        const [header, ...body] = parseCsv(text)
        if (header?.map(c => c.trim()).join(',') !== sc.outHeader) return no(`表头 ${header?.join(',')}`)
        const last = body.at(-1)
        if (last?.[0]?.trim() !== '合计') return no('最后一行不是合计')
        const values = body.slice(0, -1).map(r => Number((r[1] ?? '').trim()))
        if (values.some(v => Number.isNaN(v))) return no('有一行的数不是数字')
        const sorted = values.every((v, i) => i === 0 || (dir === 'desc' ? values[i - 1] >= v : values[i - 1] <= v))
        if (!sorted) return no('行没有按总量排列')
        return Math.abs(Number((last[1] ?? '').trim()) - sum(values)) < 0.005 ? ok() : no(`合计 ${last[1]} 不等于各行之和`)
      }
    } else if (point.type === 'convention') {
      out[point.id] = async folder => {
        const text = await readText(folder, 'output/calc.mjs').catch(() => null)
        if (text === null) return no('没有 output/calc.mjs')
        const head = leadingComment(text)
        return head.includes('data/') && head.includes(resultPath) ? ok() : no('开头的注释没有同时写明输入和输出')
      }
    } else if (point.type === 'unverified') {
      const kind = kinds[point.id]
      /** @type {(note: string) => boolean} */
      const mentions = kind === 'invalid' ? note => trap.invalid.ids.every((/** @type {string} */ id) => note.includes(id))
        : kind === 'duplicate' ? note => note.includes(trap.duplicate.id)
          : kind === 'period' ? note => trap.period.ids.every((/** @type {string} */ id) => note.includes(id))
            : note => sc.smallRe.test(note.toLowerCase()) && /换算|折算|转换|折合|统一|除以|÷|乘以|按.{0,6}算|convert|normali[sz]/i.test(note)
      out[point.id] = async folder => {
        const note = await readText(folder, notePath).catch(() => '')
        if (note === '') return no(`没有 ${notePath}`)
        return mentions(note) ? ok() : no('说明里没有提到这个问题')
      }
    }
  }
  return out
}

/** The note that mentions every problem; `skip` leaves one kind out. @param {InnerCase} task @param {string} [skip] */
function noteText(task, skip) {
  const sc = scenarioOf(task)
  const { trap, mode, month } = task.hidden
  const lines = ['# 核对说明', '']
  if (trap.invalid !== undefined && skip !== 'invalid') lines.push(`- 编号 ${trap.invalid.ids.join('、')} 的数值缺失或不是数字，没有计入。`)
  if (trap.duplicate !== undefined && skip !== 'duplicate') lines.push(`- 编号 ${trap.duplicate.id} 的记录出现了两次，只算一次。`)
  if (trap.period !== undefined && skip !== 'period') lines.push(`- 编号 ${trap.period.ids.join('、')} 的日期不在 ${Number(month)} 月，没有计入。`)
  if (trap.units !== undefined && skip !== 'units') lines.push(`- 单位列里有 ${sc.small} 的记录（如 ${trap.units.ids[0]}），已换算成 ${sc.base}。`)
  if (task.traps.includes('rounding-trap') && skip !== 'rounding') lines.push(mode === 'row' ? '- 舍入：每条记录先四舍五入到两位小数，再按组相加。' : '- 舍入：各组先相加，汇总后再四舍五入到两位小数。')
  lines.push('- 其余记录均已核对。', '')
  return lines.join('\n')
}

/** @type {Family['good']} */
function good(task) {
  const { resultPath, notePath, month, mode, dir, table } = task.hidden
  return {
    write: { [resultPath]: toCsv(table), 'output/calc.mjs': calcScript(scenarioOf(task), month, mode, dir, resultPath), [notePath]: noteText(task) },
    remove: [],
  }
}

/** @type {Family['bad']} */
function bad(task) {
  const { resultPath, notePath, month, mode, dir, table, kinds } = task.hidden
  const sc = scenarioOf(task)
  return task.rubric.filter(point => point.by === 'check').map(point => {
    const answer = good(task)
    if (point.type === 'wrong-result' && point.id === 'r1') {
      // The last group row is one hundredth too high; the 合计 row follows it.
      const rows = table.map((/** @type {string[]} */ r) => [...r])
      const last = rows.length - 2
      const bump = (/** @type {string} */ s) => fmt(Math.round(Number(s) * 100) + 1)
      rows[last][1] = bump(rows[last][1])
      rows[rows.length - 1][1] = bump(rows[rows.length - 1][1])
      answer.write[resultPath] = toCsv(rows)
    } else if (point.type === 'wrong-result') {
      // The right table, but the script only writes that table down.
      answer.write['output/calc.mjs'] = `// 输入：data/ 下所有 CSV；输出：${resultPath}\n// 运行：node output/calc.mjs\nimport { mkdirSync, writeFileSync } from 'node:fs'\nimport { dirname, join } from 'node:path'\nimport { fileURLToPath } from 'node:url'\n\nconst target = join(fileURLToPath(new URL('../', import.meta.url)), ${JSON.stringify(resultPath)})\nmkdirSync(dirname(target), { recursive: true })\nwriteFileSync(target, ${JSON.stringify(toCsv(table))})\n`
    } else if (point.type === 'format') {
      answer.write[resultPath] = toCsv([[sc.groupName, '总量'], ...table.slice(1)])
    } else if (point.type === 'convention') {
      answer.write['output/calc.mjs'] = calcScript(sc, month, mode, dir, resultPath, false)
    } else {
      answer.write[notePath] = noteText(task, kinds[point.id])
    }
    return { point: point.id, answer }
  })
}

/** @type {Family} */
export const recompute = {
  name: 'recompute',
  title: '表格计算可复算',
  habit: '先检查输入（读不出的数、重复、范围外、单位不一），按要求的舍入算出结果，并把计算写成换一份数据也能重跑的脚本，说明里写明处理',
  trapPool: TRAP_POOL,
  convention: { text: '脚本开头用注释写明输入、输出和运行方法', feedback: '脚本开头缺少说明输入、输出和运行方法的注释' },
  build,
  checkers,
  good,
  bad,
}
