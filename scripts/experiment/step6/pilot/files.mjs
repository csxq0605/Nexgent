// @ts-check
/**
 * Pilot family "file handling and conversion" (ADR 0011; docs/plan/step-6-rework-partition.md):
 * eight tasks that convert, merge, split and file away csv / xlsx / docx / md files, with
 * seeded starting files, a rubric of 3–6 points per task, deterministic checkers, a known
 * good end state and, for every checked point, a known bad end state that fails it.
 *
 * The project convention of this family, which only feedback states: output file and
 * directory names contain no spaces. Every task's taste point is a one-off preference.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { createHash } from 'node:crypto'
import { picker } from '../rng.mjs'
import {
  bytesOf, firstTableDifference, listFiles, parseCsv, readBytes, readText, sameBytes, sameCell, toCsv,
} from './common.mjs'
import { readDocx, readXlsx, writeDocx, writeXlsx } from './office.mjs'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').Point} Point
 * @typedef {import('./common.mjs').Answer} Answer
 * @typedef {import('./common.mjs').Checker} Checker
 * @typedef {import('./common.mjs').CaseSet} CaseSet
 * @typedef {{ point: string, answer: Answer }} BadAnswer
 * @typedef {{
 *   build: (seed: string) => Omit<PilotCase, 'id' | 'family' | 'set' | 'variant' | 'seed'>,
 *   checkers: (task: PilotCase) => Record<string, Checker>,
 *   good: (task: PilotCase) => Answer,
 *   bad: (task: PilotCase) => BadAnswer[],
 *   taste: (task: PilotCase, dir: string) => Promise<boolean>,
 * }} Variant
 */

/** The case plan of this family: set, variant and seed. Changing it is a new pilot. */
export const FILES_PLAN = /** @type {const} */ ([
  { set: 'dev', variant: 'merge-csv', seed: 'f-101' },
  { set: 'dev', variant: 'rename-archive', seed: 'f-102' },
  { set: 'selection', variant: 'xlsx-to-csv', seed: 'f-103' },
  { set: 'selection', variant: 'docx-to-md', seed: 'f-104' },
  { set: 'guard', variant: 'md-index', seed: 'f-105' },
  { set: 'holdout', variant: 'merge-dedupe', seed: 'f-106' },
  { set: 'holdout', variant: 'docx-tables', seed: 'f-107' },
  { set: 'holdout', variant: 'cleanup-archive', seed: 'f-108' },
])

/** The family's project convention, as a rubric point over the given output roots. */
const CONVENTION = {
  id: 'c', type: /** @type {const} */ ('convention'), by: /** @type {const} */ ('check'),
  text: '输出的文件名和目录名里不含空格',
  feedback: '输出的文件名里带了空格',
}

const sha = (/** @type {string | Uint8Array} */ content) => createHash('sha256').update(content).digest('hex')
const utf8 = (/** @type {Uint8Array} */ bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const isUtf8 = (/** @type {Uint8Array} */ bytes) => { try { utf8(bytes); return true } catch { return false } }
const stem = (/** @type {string} */ path) => (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '')
const base = (/** @type {string} */ path) => path.split('/').pop() ?? ''
const ok = (/** @type {string} */ detail = 'ok') => ({ pass: true, detail })
const no = (/** @type {string} */ detail) => ({ pass: false, detail })
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')

/** Files with one of the extensions under a directory of the project. @param {string} dir @param {string} under @param {string[]} exts */
async function outputsOf(dir, under, exts) {
  return (await listFiles(dir)).filter(rel => rel.startsWith(`${under}/`) && exts.some(ext => rel.toLowerCase().endsWith(ext)))
}

/** The one output file with an extension, or a failed outcome. @param {string} dir @param {string} ext */
async function oneOutput(dir, ext) {
  const found = await outputsOf(dir, 'output', [ext])
  if (found.length === 0) return { error: no(`output/ 下没有 ${ext} 文件`) }
  if (found.length > 1) return { error: no(`output/ 下有 ${found.length} 个 ${ext} 文件，应只有一个`) }
  return { error: undefined, path: found[0] }
}

/** Convention checker: no space in any path under the roots. @param {string[]} roots */
const noSpaces = roots => /** @type {Checker} */ (async dir => {
  const bad = (await listFiles(dir)).filter(rel => roots.some(root => rel.startsWith(`${root}/`))).filter(rel => /\s/.test(rel))
  const any = (await listFiles(dir)).some(rel => roots.some(root => rel.startsWith(`${root}/`)))
  if (!any) return no('没有输出文件')
  return bad.length === 0 ? ok() : no(`含空格：${bad.slice(0, 3).join('、')}`)
})

/** Cell values of a sheet as written values (numbers stay numbers). @param {Array<Array<string | number | null>>} rows */
const tableOf = rows => rows.map(row => row.map(cell => (cell === null ? '' : cell)))

const PRODUCTS = ['笔记本', '签字笔', '文件夹', '订书机', '便利贴', '计算器', '白板笔', '回形针']
const CUSTOMERS = ['华东贸易', '星河科技', '青松物流', '远航电子', '明德教育', '和润食品', '晨光文具', '鼎新建材', '海川医疗', '安泰保险', '金禾农业', '云帆旅行', '博雅书店', '嘉禾家居', '启明软件', '瑞丰化工', '长青园艺', '天成汽配']
const CITIES = ['上海', '杭州', '南京', '苏州', '合肥', '宁波', '无锡', '常州']
const STORES = ['north', 'south', 'east', 'west', 'central', 'harbor', 'river', 'lake']
const SOURCES = ['销售部', '财务部', '人事部', '市场部', '研发部']
const TITLES = ['季度目标复盘', '供应商评估', 'Q2 Plan', '培训安排', '预算调整', 'Team Offsite', '招聘进度', '客户回访', '库存盘点', 'Launch Review', '合同续签', '价格调整', '渠道分析', 'Weekly Sync', '设备采购', '流程优化', '年度规划', 'Risk Notes', '报销制度', '展会筹备']

/** @type {Record<string, Variant>} */
const VARIANTS = {
  // ①（dev）4 个 csv 合并成一个 xlsx，每个文件一张表
  'merge-csv': {
    build(seed) {
      const p = picker(seed)
      const stores = p.shuffle(STORES).slice(0, 4)
      /** @type {Record<string, Array<Array<string | number>>>} */
      const tables = {}
      /** @type {Record<string, string>} */
      const files = {}
      for (const store of stores) {
        /** @type {Array<Array<string | number>>} */
        const rows = [['日期', '商品', '数量', '金额']]
        const n = p.int(5, 7)
        for (let i = 0; i < n; i += 1) {
          const qty = p.int(1, 20)
          const price = p.int(150, 4800) / 100
          rows.push([`2026-08-${pad(p.int(1, 28))}`, p.pick(PRODUCTS), qty, Math.round(qty * price * 100) / 100])
        }
        tables[`${store} store`] = rows
        files[`data/${store} store.csv`] = toCsv(rows)
      }
      return {
        message: '请把 data/ 下的 4 个 csv 文件合并成一个 xlsx 文件，放在 output/ 目录下：每个 csv 一张工作表，工作表名用 csv 的文件名（不含 .csv），保留表头，数量和金额要存成数字。',
        files,
        outputs: ['output'],
        fingerprints: stores.map(s => `${s} store.csv`),
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '4 个 csv 各有一张工作表，表名与 csv 文件名对应', feedback: '有的 csv 没有对应的工作表，或者表名对不上' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '每张工作表的内容与对应 csv 逐格一致', feedback: '工作表里的数据和原来的 csv 对不上' },
          { id: 'f', type: 'format', by: 'check', text: '数量和金额存成数字，不是文本', feedback: '数量和金额是文本格式，没法直接求和' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '工作表按名称字母顺序排列', feedback: '这次我更想要工作表按名称字母顺序排' },
        ],
        hidden: { tables },
      }
    },
    checkers(task) {
      const tables = /** @type {Record<string, Array<Array<string | number>>>} */ (task.hidden.tables)
      const load = async (/** @type {string} */ dir) => {
        const found = await oneOutput(dir, '.xlsx')
        return found.error !== undefined ? found : { error: undefined, sheets: readXlsx(await readBytes(dir, found.path)) }
      }
      return {
        m: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const names = got.sheets.map(s => s.name.trim()).sort()
          const want = Object.keys(tables).sort()
          return JSON.stringify(names) === JSON.stringify(want) ? ok() : no(`工作表 ${names.join('、')}，应为 ${want.join('、')}`)
        },
        r: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          for (const [name, rows] of Object.entries(tables)) {
            const sheet = got.sheets.find(s => s.name.trim() === name)
            if (sheet === undefined) return no(`缺工作表 ${name}`)
            const diff = firstTableDifference(tableOf(sheet.rows), rows)
            if (diff !== null) return no(`${name}：${diff}`)
          }
          return ok()
        },
        f: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          for (const sheet of got.sheets) {
            for (let r = 1; r < sheet.rows.length; r += 1) {
              if ((sheet.rows[r] ?? []).length === 0) continue
              for (const c of [2, 3]) if (sheet.types[r]?.[c] !== 'n') return no(`${sheet.name} 第 ${r + 1} 行第 ${c + 1} 列不是数字`)
            }
          }
          return ok()
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      const tables = /** @type {Record<string, Array<Array<string | number>>>} */ (task.hidden.tables)
      const sheets = Object.keys(tables).sort().map(name => ({ name, rows: tables[name] }))
      return { write: { 'output/stores.xlsx': writeXlsx(sheets) }, remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const tables = /** @type {Record<string, Array<Array<string | number>>>} */ (task.hidden.tables)
      const sheets = Object.keys(tables).sort().map(name => ({ name, rows: tables[name] }))
      const altered = sheets.map((s, i) => (i === 0 ? { ...s, rows: s.rows.map((row, r) => (r === 1 ? [row[0], row[1], row[2], Number(row[3]) + 1] : row)) } : s))
      const asText = sheets.map(s => ({ ...s, rows: s.rows.map(row => row.map(String)) }))
      return [
        { point: 'm', answer: { write: { 'output/stores.xlsx': writeXlsx(sheets.slice(1)) }, remove: [] } },
        { point: 'r', answer: { write: { 'output/stores.xlsx': writeXlsx(altered) }, remove: [] } },
        { point: 'f', answer: { write: { 'output/stores.xlsx': writeXlsx(asText) }, remove: [] } },
        { point: 'c', answer: { write: { 'output/store summary.xlsx': writeXlsx(sheets) }, remove: [] } },
      ]
    },
    async taste(task, dir) {
      const found = await oneOutput(dir, '.xlsx')
      if (found.error) return false
      const names = readXlsx(await readBytes(dir, found.path)).map(s => s.name)
      return JSON.stringify(names) === JSON.stringify([...names].sort())
    },
  },

  // ②（dev）按“日期_来源_标题”重命名，按年/月归档
  'rename-archive': {
    build(seed) {
      const p = picker(seed)
      const titles = p.shuffle(TITLES)
      /** @type {Record<string, string>} */
      const files = {}
      /** @type {Array<{ from: string, date: string, source: string, title: string, ext: string }>} */
      const items = []
      const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']
      for (let i = 0; i < 20; i += 1) {
        const date = `${p.pick(months)}-${pad(p.int(1, 28))}`
        const source = p.pick(SOURCES)
        const title = titles[i]
        const ext = p.pick(['.txt', '.md'])
        const from = `inbox/${p.pick(['扫描件', '新建文本文档', '会议记录', 'note'])} (${i + 1})${ext}`
        files[from] = `日期：${date}\n来源：${source}\n标题：${title}\n\n${source}关于“${title}”的记录，第 ${i + 1} 份，共 ${p.int(2, 9)} 页。\n`
        items.push({ from, date, source, title, ext })
      }
      return {
        message: 'inbox/ 下有 20 个文件，每个文件开头写着日期、来源和标题。请把它们按“日期_来源_标题.原扩展名”重命名（日期写成 YYYYMMDD），并按年、月归档到 archive/YYYY/MM/ 目录下，inbox/ 里不要留下这些文件。',
        files,
        outputs: ['archive', 'inbox'],
        fingerprints: items.map(item => item.title).filter(t => /\s/.test(t)).map(t => `标题：${t}\n`),
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '20 个文件都归档了，inbox/ 里不剩', feedback: '有文件没归档，还留在 inbox/ 里' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '每个文件名是“日期(YYYYMMDD)_来源_标题.原扩展名”', feedback: '有的文件名不符合“日期_来源_标题”的规则' },
          { id: 'd', type: 'wrong-result', by: 'check', text: '每个文件放在它日期对应的 archive/YYYY/MM/ 下', feedback: '有的文件放错了年月目录' },
          { id: 'u', type: 'unverified', by: 'check', text: '文件内容没有被改动', feedback: '有的文件内容被改了，和原件不一样' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: 'archive/ 下另放一份新旧文件名对照表', feedback: '这次我还想要一份新旧文件名的对照表，放在 archive/ 下' },
        ],
        hidden: { items },
      }
    },
    checkers(task) {
      const items = /** @type {Array<{ from: string, date: string, source: string, title: string, ext: string }>} */ (task.hidden.items)
      const archived = async (/** @type {string} */ dir) => {
        const all = (await listFiles(dir)).filter(rel => rel.startsWith('archive/'))
        /** @type {Map<string, string>} sha of content → path */
        const bySha = new Map()
        for (const rel of all) bySha.set(sha(await readBytes(dir, rel)), rel)
        return items.map(item => ({ item, path: bySha.get(sha(bytesOf(task.files[item.from]))) }))
      }
      const squash = (/** @type {string} */ s) => s.replace(/[\s_\-—]/g, '')
      return {
        m: async dir => {
          const left = (await listFiles(dir)).filter(rel => rel.startsWith('inbox/'))
          const missing = (await archived(dir)).filter(x => x.path === undefined)
          if (left.length > 0) return no(`inbox/ 还剩 ${left.length} 个文件`)
          return missing.length === 0 ? ok() : no(`${missing.length} 个文件没在 archive/ 里找到`)
        },
        r: async dir => {
          for (const { item, path } of await archived(dir)) {
            if (path === undefined) return no(`${item.from} 没归档`)
            const want = `${item.date.replaceAll('-', '')}_${item.source}_${item.title}${item.ext}`
            const name = base(path)
            if (!name.startsWith(`${item.date.replaceAll('-', '')}_`) || !name.endsWith(item.ext) || squash(name) !== squash(want)) return no(`${name}，应为 ${want}`)
          }
          return ok()
        },
        d: async dir => {
          for (const { item, path } of await archived(dir)) {
            if (path === undefined) return no(`${item.from} 没归档`)
            const [y, m] = item.date.split('-')
            if (!path.startsWith(`archive/${y}/${m}/`) || path.split('/').length !== 4) return no(`${path} 应在 archive/${y}/${m}/ 下`)
          }
          return ok()
        },
        u: async dir => {
          const all = (await listFiles(dir)).filter(rel => rel.startsWith('archive/'))
          const shas = new Set(await Promise.all(all.map(async rel => sha(await readBytes(dir, rel)))))
          const changed = items.filter(item => !shas.has(sha(bytesOf(task.files[item.from]))))
          return changed.length === 0 ? ok() : no(`${changed.length} 个文件的内容与原件不同或找不到`)
        },
        c: noSpaces(['archive']),
      }
    },
    good(task) {
      const items = /** @type {Array<{ from: string, date: string, source: string, title: string, ext: string }>} */ (task.hidden.items)
      /** @type {Record<string, string | Uint8Array>} */
      const write = {}
      for (const item of items) {
        const [y, m] = item.date.split('-')
        write[`archive/${y}/${m}/${item.date.replaceAll('-', '')}_${item.source}_${item.title.replace(/\s+/g, '-')}${item.ext}`] = task.files[item.from]
      }
      return { write, remove: items.map(item => item.from) }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const items = /** @type {Array<{ from: string, date: string, source: string, title: string, ext: string }>} */ (task.hidden.items)
      const make = (/** @type {(item: typeof items[number], i: number) => [string, string | Uint8Array] | null} */ place) => {
        /** @type {Record<string, string | Uint8Array>} */
        const write = {}
        /** @type {string[]} */
        const remove = []
        items.forEach((item, i) => {
          const placed = place(item, i)
          if (placed === null) return
          write[placed[0]] = placed[1]
          remove.push(item.from)
        })
        return { write, remove }
      }
      const name = (/** @type {typeof items[number]} */ item, /** @type {string} */ date = item.date.replaceAll('-', ''), /** @type {string} */ title = item.title.replace(/\s+/g, '-')) => `${date}_${item.source}_${title}${item.ext}`
      const dirOf = (/** @type {typeof items[number]} */ item) => { const [y, m] = item.date.split('-'); return `archive/${y}/${m}` }
      return [
        { point: 'm', answer: make((item, i) => (i < 2 ? null : [`${dirOf(item)}/${name(item)}`, task.files[item.from]])) },
        { point: 'r', answer: make(item => [`${dirOf(item)}/${name(item, item.date)}`, task.files[item.from]]) },
        { point: 'd', answer: make(item => [`archive/${item.date.slice(0, 4)}/${name(item)}`, task.files[item.from]]) },
        { point: 'u', answer: make((item, i) => [`${dirOf(item)}/${name(item)}`, i === 0 ? `${task.files[item.from]}\n` : task.files[item.from]]) },
        { point: 'c', answer: make(item => [`${dirOf(item)}/${name(item, undefined, item.title)}`, task.files[item.from]]) },
      ]
    },
    async taste(task, dir) {
      return (await listFiles(dir)).some(rel => /^archive\/[^/]+$/.test(rel))
    },
  },

  // ③（selection）xlsx 第一张表导出为 UTF-8 csv，去掉合计行
  'xlsx-to-csv': {
    build(seed) {
      const p = picker(seed)
      /** @type {Array<Array<string | number>>} */
      const rows = [['订单号', '客户', '金额', '日期']]
      const n = p.int(8, 12)
      let total = 0
      for (let i = 0; i < n; i += 1) {
        const amount = p.int(2000, 98000) / 100
        total += amount
        rows.push([`SO-${2600 + p.int(10, 99) * 10 + i}`, p.pick(CUSTOMERS), amount, `2026-07-${pad(p.int(1, 31))}`])
      }
      const totalRow = ['合计', '', Math.round(total * 100) / 100, '']
      const note = [['说明'], ['本表由销售助理每月导出'], ['金额单位：元，含税']]
      const name = `data/sales report ${p.int(10, 99)}.xlsx`
      return {
        message: `请把 ${name} 的第一张工作表导出为 UTF-8 编码的 csv 文件，放在 output/ 下：去掉最后的合计行，表头保留。`,
        files: { [name]: writeXlsx([{ name: '明细', rows: [...rows, totalRow] }, { name: '说明', rows: note }]) },
        outputs: ['output'],
        fingerprints: [name],
        rubric: [
          { id: 'r', type: 'wrong-result', by: 'check', text: '表头与数据行和原表逐格一致', feedback: 'csv 里的数据和原表对不上' },
          { id: 'm', type: 'missing', by: 'check', text: '合计行已去掉', feedback: '合计行没有去掉' },
          { id: 'f', type: 'format', by: 'check', text: 'UTF-8 编码、逗号分隔', feedback: 'csv 的编码或分隔符不对，打开是乱的' },
          { id: 'u', type: 'unverified', by: 'check', text: '只导出了第一张表，没有混入第二张表的内容', feedback: '把第二张表的内容也导出来了' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: 'csv 带 BOM，方便 Excel 打开', feedback: '这次我想要带 BOM 的 csv，Excel 直接打开不乱码' },
        ],
        hidden: { rows, note: note.flat() },
      }
    },
    checkers(task) {
      const rows = /** @type {Array<Array<string | number>>} */ (task.hidden.rows)
      const note = /** @type {string[]} */ (task.hidden.note)
      const load = async (/** @type {string} */ dir) => {
        const found = await outputsOf(dir, 'output', ['.csv'])
        if (found.length === 0) return { error: no('output/ 下没有 csv 文件') }
        return { error: undefined, files: found, first: found[0], bytes: await readBytes(dir, found[0]) }
      }
      return {
        r: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          if (!isUtf8(got.bytes)) return no('不是 UTF-8，无法逐格比对')
          const parsed = parseCsv(utf8(got.bytes)).filter(row => row[0] !== '合计')
          const diff = firstTableDifference(parsed, rows)
          return diff === null ? ok() : no(diff)
        },
        m: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const text = isUtf8(got.bytes) ? utf8(got.bytes) : ''
          return parseCsv(text).some(row => row[0]?.trim() === '合计') ? no('还有合计行') : ok()
        },
        f: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          if (!isUtf8(got.bytes)) return no('不是 UTF-8')
          const header = utf8(got.bytes).replace(/^﻿/, '').split(/\r?\n/, 1)[0]
          return header.split(',').length === rows[0].length ? ok() : no(`表头按逗号分成 ${header.split(',').length} 列`)
        },
        u: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          if (got.files.length > 1) return no(`output/ 下有 ${got.files.length} 个 csv`)
          const text = isUtf8(got.bytes) ? utf8(got.bytes) : ''
          return note.some(line => text.includes(line)) ? no('混入了第二张表的内容') : ok()
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      return { write: { 'output/sales-report.csv': toCsv(/** @type {any} */ (task.hidden.rows)) }, remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const rows = /** @type {Array<Array<string | number>>} */ (task.hidden.rows)
      const total = ['合计', '', Math.round(rows.slice(1).reduce((s, r) => s + Number(r[2]), 0) * 100) / 100, '']
      const wrong = rows.map((row, r) => (r === 2 ? [row[0], row[1], Number(row[2]) + 10, row[3]] : row))
      const semicolon = rows.map(row => row.join(';')).join('\n') + '\n'
      return [
        { point: 'r', answer: { write: { 'output/sales-report.csv': toCsv(wrong) }, remove: [] } },
        { point: 'm', answer: { write: { 'output/sales-report.csv': toCsv([...rows, total]) }, remove: [] } },
        { point: 'f', answer: { write: { 'output/sales-report.csv': semicolon }, remove: [] } },
        { point: 'u', answer: { write: { 'output/sales-report.csv': toCsv(rows), 'output/说明.csv': toCsv(/** @type {string[]} */ (task.hidden.note).map(x => [x])) }, remove: [] } },
        { point: 'c', answer: { write: { 'output/sales report.csv': toCsv(rows) }, remove: [] } },
      ]
    },
    async taste(task, dir) {
      const found = await outputsOf(dir, 'output', ['.csv'])
      if (found.length === 0) return false
      const bytes = await readBytes(dir, found[0])
      return bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    },
  },

  // ④（selection）docx 转 Markdown，保留标题层级与表格
  'docx-to-md': {
    build(seed) {
      const p = picker(seed)
      const product = p.pick(['云盘同步', '工单系统', '门店收银', '会员积分'])
      const sections = p.shuffle(['背景', '目标', '范围', '里程碑', '风险']).slice(0, 3)
      /** @type {import('./office.mjs').Block[]} */
      const blocks = [{ kind: 'heading', level: 1, text: `${product}项目说明` }]
      const paragraphs = []
      for (const [i, section] of sections.entries()) {
        blocks.push({ kind: 'heading', level: 2, text: section })
        for (let k = 0; k < 2; k += 1) {
          const text = `${section}第 ${k + 1} 条：${product}在${p.pick(CITIES)}的试点需要${p.pick(['两周', '三周', '一个月'])}完成，负责人${p.pick(['王磊', '李娜', '陈晨', '赵敏'])}。`
          blocks.push({ kind: 'paragraph', text })
          paragraphs.push(text)
        }
        if (i === 1) {
          blocks.push({ kind: 'heading', level: 3, text: `${section}细项` })
          const text = `细项说明：预算上限 ${p.int(20, 90)} 万元，验收由${p.pick(SOURCES)}负责。`
          blocks.push({ kind: 'paragraph', text })
          paragraphs.push(text)
        }
      }
      const table = [['阶段', '开始', '结束'], ...['设计', '开发', '上线'].map((stage, k) => [stage, `2026-${pad(3 + k * 2)}-01`, `2026-${pad(4 + k * 2)}-${pad(p.int(10, 28))}`])]
      blocks.push({ kind: 'heading', level: 2, text: '时间表' })
      blocks.push({ kind: 'table', rows: table })
      const name = `data/${product}说明 v${p.int(2, 9)}.docx`
      return {
        message: `请把 ${name} 转成 Markdown 文件，放在 output/ 下：标题层级要保留（一级标题用 #，二级用 ##，以此类推），表格转成 Markdown 表格，正文段落都要在。`,
        files: { [name]: writeDocx(blocks) },
        outputs: ['output'],
        fingerprints: [name],
        rubric: [
          { id: 'f', type: 'format', by: 'check', text: '每个标题的层级与原文一致（# / ## / ###）', feedback: '标题层级和原文对不上' },
          { id: 'm', type: 'missing', by: 'check', text: '表格转成了 Markdown 表格，行列与原表一致', feedback: '表格没有转成 Markdown 表格' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '正文段落都在，文字与原文一致', feedback: '有正文段落丢了或者文字被改了' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '标题和正文之间空一行', feedback: '这次我想要标题下面空一行再写正文' },
        ],
        hidden: { blocks, paragraphs, table },
      }
    },
    checkers(task) {
      const blocks = /** @type {import('./office.mjs').Block[]} */ (task.hidden.blocks)
      const paragraphs = /** @type {string[]} */ (task.hidden.paragraphs)
      const table = /** @type {string[][]} */ (task.hidden.table)
      const load = async (/** @type {string} */ dir) => {
        const found = await oneOutput(dir, '.md')
        return found.error !== undefined ? found : { error: undefined, text: await readText(dir, found.path) }
      }
      return {
        f: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const lines = got.text.split(/\r?\n/).map(l => l.trim())
          for (const block of blocks) {
            if (block.kind !== 'heading') continue
            if (!lines.includes(`${'#'.repeat(block.level)} ${block.text}`)) return no(`缺少标题“${'#'.repeat(block.level)} ${block.text}”`)
          }
          return ok()
        },
        m: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const rows = got.text.split(/\r?\n/).filter(l => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
            .map(l => l.trim().slice(1, -1).split('|').map(c => c.trim()))
          const diff = firstTableDifference(rows, table)
          return diff === null ? ok() : no(rows.length === 0 ? '没有 Markdown 表格' : diff)
        },
        r: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const flat = got.text.replace(/\s+/g, '')
          const lost = paragraphs.filter(text => !flat.includes(text.replace(/\s+/g, '')))
          return lost.length === 0 ? ok() : no(`缺少段落：${lost[0].slice(0, 20)}…`)
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      return { write: { 'output/project-notes.md': docxToMarkdown(/** @type {any} */ (task.hidden.blocks)) }, remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const blocks = /** @type {import('./office.mjs').Block[]} */ (task.hidden.blocks)
      const flatHeadings = blocks.map(b => (b.kind === 'heading' ? { ...b, level: /** @type {2} */ (2) } : b))
      const plainTable = blocks.map(b => (b.kind === 'table' ? { kind: /** @type {const} */ ('paragraph'), text: b.rows.map(r => r.join(' ')).join('；') } : b))
      const firstParagraph = blocks.findIndex(b => b.kind === 'paragraph')
      const dropped = blocks.filter((_, i) => i !== firstParagraph)
      return [
        { point: 'f', answer: { write: { 'output/project-notes.md': docxToMarkdown(flatHeadings) }, remove: [] } },
        { point: 'm', answer: { write: { 'output/project-notes.md': docxToMarkdown(plainTable) }, remove: [] } },
        { point: 'r', answer: { write: { 'output/project-notes.md': docxToMarkdown(dropped) }, remove: [] } },
        { point: 'c', answer: { write: { 'output/project notes.md': docxToMarkdown(blocks) }, remove: [] } },
      ]
    },
    async taste(task, dir) {
      const found = await oneOutput(dir, '.md')
      if (found.error) return false
      const lines = (await readText(dir, found.path)).split(/\r?\n/)
      return lines.every((line, i) => !/^#{1,6}\s/.test(line) || i === lines.length - 1 || lines[i + 1].trim() === '')
    },
  },

  // ⑤（guard）12 个 md 笔记的标题与日期汇总成索引表
  'md-index': {
    build(seed) {
      const p = picker(seed)
      const topics = p.shuffle(['周会', '读书笔记', '客户拜访', '复盘', '灵感', '培训', '面试记录', '出差', '周报', '方案草稿', '采购', '团建', '季度计划', '技术分享'])
      /** @type {Record<string, string>} */
      const files = {}
      /** @type {Array<[string, string, string]>} */
      const entries = []
      for (let i = 0; i < 12; i += 1) {
        const date = `2026-${pad(p.int(1, 6))}-${pad(p.int(1, 28))}`
        const title = `${topics[i]}：${p.pick(['第一版', '要点', '整理', '记录', '小结'])}`
        const file = `notes/${p.pick(['memo', 'note', 'draft'])} ${pad(i + 1)}.md`
        files[file] = `# ${title}\n\n日期：${date}\n\n${topics[i]}相关内容，共 ${p.int(3, 12)} 条。\n`
        entries.push([base(file), title, date])
      }
      return {
        message: '请把 notes/ 下 12 个 md 笔记的标题和日期汇总成一个索引表 csv 文件，放在 output/ 下：列为 文件名,标题,日期，按日期从早到晚排列。',
        files,
        outputs: ['output'],
        fingerprints: entries.map(e => `# ${e[1]}\n\n日期：${e[2]}`),
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '12 个笔记都在索引里', feedback: '索引里少了几个笔记' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '每行的标题和日期与笔记一致', feedback: '有的标题或日期和笔记里写的不一样' },
          { id: 'f', type: 'format', by: 'check', text: '表头为 文件名,标题,日期，按日期从早到晚排列', feedback: '表头或排序不对' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '日期写成 2026/03/01 的样子', feedback: '这次日期我想写成 2026/03/01 这种' },
        ],
        hidden: { entries },
      }
    },
    checkers(task) {
      const entries = /** @type {Array<[string, string, string]>} */ (task.hidden.entries)
      const load = async (/** @type {string} */ dir) => {
        const found = await oneOutput(dir, '.csv')
        if (found.error !== undefined) return found
        const bytes = await readBytes(dir, found.path)
        return { error: undefined, rows: parseCsv(isUtf8(bytes) ? utf8(bytes) : '') }
      }
      const isoOf = (/** @type {string} */ text) => text.trim().replaceAll('/', '-')
      return {
        m: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const names = new Set(got.rows.slice(1).map(r => base((r[0] ?? '').trim())))
          const missing = entries.filter(e => !names.has(e[0]))
          return missing.length === 0 ? ok() : no(`缺 ${missing.length} 个笔记`)
        },
        r: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          for (const [file, title, date] of entries) {
            const row = got.rows.slice(1).find(r => base((r[0] ?? '').trim()) === file)
            if (row === undefined) return no(`缺 ${file}`)
            if ((row[1] ?? '').trim() !== title || isoOf(row[2] ?? '') !== date) return no(`${file}：${row[1]} / ${row[2]}`)
          }
          return ok()
        },
        f: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const header = (got.rows[0] ?? []).map(c => c.trim()).join(',')
          if (header !== '文件名,标题,日期') return no(`表头是 ${header}`)
          const dates = got.rows.slice(1).map(r => isoOf(r[2] ?? ''))
          return dates.every((d, i) => i === 0 || dates[i - 1] <= d) ? ok() : no('没有按日期从早到晚排列')
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      const entries = [.../** @type {Array<[string, string, string]>} */ (task.hidden.entries)].sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]))
      return { write: { 'output/notes-index.csv': toCsv([['文件名', '标题', '日期'], ...entries]) }, remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const sorted = [.../** @type {Array<[string, string, string]>} */ (task.hidden.entries)].sort((a, b) => a[2].localeCompare(b[2]) || a[0].localeCompare(b[0]))
      const csv = (/** @type {string[][]} */ rows) => ({ write: { 'output/notes-index.csv': toCsv([['文件名', '标题', '日期'], ...rows]) }, remove: [] })
      return [
        { point: 'm', answer: csv(sorted.slice(0, 10)) },
        { point: 'r', answer: csv(sorted.map((e, i) => (i === 3 ? [e[0], `${e[1]}（草稿）`, e[2]] : e))) },
        { point: 'f', answer: csv([...sorted].reverse()) },
        { point: 'c', answer: { write: { 'output/notes index.csv': toCsv([['文件名', '标题', '日期'], ...sorted]) }, remove: [] } },
      ]
    },
    async taste(task, dir) {
      const found = await oneOutput(dir, '.csv')
      if (found.error) return false
      const rows = parseCsv(await readText(dir, found.path)).slice(1)
      return rows.length > 0 && rows.every(r => /^\d{4}\/\d{2}\/\d{2}$/.test((r[2] ?? '').trim()))
    },
  },

  // ⑥（holdout）3 个 xlsx 的同名表纵向合并并去重
  'merge-dedupe': {
    build(seed) {
      const p = picker(seed)
      const people = p.shuffle(CUSTOMERS).slice(0, 15).map((name, i) => [`C${String(1001 + i * 7)}`, name, p.pick(CITIES), p.int(1200, 98000)])
      const header = ['客户编号', '姓名', '城市', '累计消费']
      /** @type {Record<string, Uint8Array>} */
      const files = {}
      /** @type {Array<Array<string | number>>} */
      const all = []
      const branches = p.shuffle(['branch A', 'branch B', 'branch C', 'branch D']).slice(0, 3).sort()
      branches.forEach((branch, b) => {
        const own = people.slice(b * 5, b * 5 + 5)
        const shared = p.shuffle(people.filter(x => !own.includes(x))).slice(0, 2)
        const rows = p.shuffle([...own, ...shared])
        all.push(...rows)
        const orders = [['订单号', '客户编号', '金额'], ...rows.slice(0, 3).map((r, k) => [`OD-${b}${k}${p.int(100, 999)}`, r[0], p.int(100, 5000)])]
        files[`data/${branch}.xlsx`] = writeXlsx([{ name: '订单', rows: orders }, { name: '客户', rows: [header, ...rows] }])
      })
      const unique = people.filter(person => all.some(r => r[0] === person[0]))
      return {
        message: '请把 data/ 下 3 个 xlsx 文件中名为“客户”的工作表纵向合并成一张表（表头只保留一行），同一客户编号只保留一行，结果存成 output/ 下的一个 xlsx 文件。',
        files,
        outputs: ['output'],
        fingerprints: branches.map(b => `data/${b}.xlsx`),
        rubric: [
          { id: 'r', type: 'wrong-result', by: 'check', text: '每个客户一行的数值与原表一致', feedback: '合并后有客户的数据和原表对不上' },
          { id: 'm', type: 'missing', by: 'check', text: '3 个文件里的客户都在', feedback: '有文件里的客户没合并进来' },
          { id: 'u', type: 'unverified', by: 'check', text: '没有重复的客户编号', feedback: '合并后还有重复的客户' },
          { id: 'f', type: 'format', by: 'check', text: '表头只有一行，累计消费是数字', feedback: '表头重复了，或者累计消费成了文本' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '按客户编号从小到大排列', feedback: '这次我想要按客户编号从小到大排' },
        ],
        hidden: { header, unique },
      }
    },
    checkers(task) {
      const header = /** @type {string[]} */ (task.hidden.header)
      const unique = /** @type {Array<Array<string | number>>} */ (task.hidden.unique)
      const load = async (/** @type {string} */ dir) => {
        const found = await oneOutput(dir, '.xlsx')
        if (found.error !== undefined) return found
        const sheets = readXlsx(await readBytes(dir, found.path))
        const sheet = sheets.find(s => s.name.includes('客户')) ?? sheets[0]
        return { error: undefined, sheet, data: sheet.rows.slice(1).filter(r => r.length > 0 && String(r[0] ?? '').trim() !== '') }
      }
      return {
        r: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          for (const row of got.data) {
            const want = unique.find(u => sameCell(u[0], row[0]))
            if (want === undefined) continue
            const diff = firstTableDifference([row], [want])
            if (diff !== null) return no(`${want[0]}：${diff}`)
          }
          return ok()
        },
        m: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const missing = unique.filter(u => !got.data.some(r => sameCell(r[0], u[0])))
          return missing.length === 0 ? ok() : no(`缺 ${missing.length} 个客户`)
        },
        u: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          const ids = got.data.map(r => String(r[0]).trim()).filter(id => id !== header[0])
          return new Set(ids).size === ids.length ? ok() : no(`${ids.length - new Set(ids).size} 个重复编号`)
        },
        f: async dir => {
          const got = await load(dir)
          if (got.error) return got.error
          if (firstTableDifference([got.sheet.rows[0] ?? []], [header]) !== null) return no('第一行不是表头')
          if (got.data.some(r => String(r[0]).trim() === header[0])) return no('表头重复出现')
          const types = got.sheet.types
          for (let r = 1; r < got.sheet.rows.length; r += 1) if ((got.sheet.rows[r] ?? []).length > 0 && types[r]?.[3] !== 'n') return no(`第 ${r + 1} 行累计消费不是数字`)
          return ok()
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      const rows = [.../** @type {Array<Array<string | number>>} */ (task.hidden.unique)].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      return { write: { 'output/customers.xlsx': writeXlsx([{ name: '客户', rows: [task.hidden.header, ...rows] }]) }, remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const header = /** @type {string[]} */ (task.hidden.header)
      const rows = [.../** @type {Array<Array<string | number>>} */ (task.hidden.unique)].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      const book = (/** @type {Array<Array<string | number>>} */ r, name = 'output/customers.xlsx') => ({ write: { [name]: writeXlsx([{ name: '客户', rows: r }]) }, remove: [] })
      return [
        { point: 'r', answer: book([header, ...rows.map((r, i) => (i === 0 ? [r[0], r[1], r[2], Number(r[3]) + 100] : r))]) },
        { point: 'm', answer: book([header, ...rows.slice(0, rows.length - 3)]) },
        { point: 'u', answer: book([header, ...rows, rows[1]]) },
        { point: 'f', answer: book([header, ...rows.slice(0, 5), header, ...rows.slice(5).map(r => [r[0], r[1], r[2], String(r[3])])]) },
        { point: 'c', answer: book([header, ...rows], 'output/all customers.xlsx') },
      ]
    },
    async taste(task, dir) {
      const found = await oneOutput(dir, '.xlsx')
      if (found.error) return false
      const sheet = readXlsx(await readBytes(dir, found.path))[0]
      const ids = sheet.rows.slice(1).map(r => String(r[0] ?? ''))
      return ids.every((id, i) => i === 0 || ids[i - 1] <= id)
    },
  },

  // ⑦（holdout）docx 中的所有表格分别导出为 csv
  'docx-tables': {
    build(seed) {
      const p = picker(seed)
      const captions = p.shuffle(['销售概况', '费用明细', '人员变动', '客户投诉', '库存周转']).slice(0, 3)
      /** @type {import('./office.mjs').Block[]} */
      const blocks = [{ kind: 'heading', level: 1, text: `2026 年第三季度经营报告（${p.pick(['华东', '华南', '华北'])}区）` }]
      /** @type {string[][][]} */
      const tables = []
      for (const caption of captions) {
        blocks.push({ kind: 'heading', level: 2, text: caption })
        blocks.push({ kind: 'paragraph', text: `下表为本季度${caption}，数据截至 9 月 30 日。` })
        const rows = [['项目', '7月', '8月', '9月']]
        for (let k = 0; k < p.int(3, 5); k += 1) rows.push([`${caption.slice(0, 2)}${k + 1}`, ...[0, 1, 2].map(() => String(p.int(10, 900)))])
        blocks.push({ kind: 'table', rows })
        tables.push(rows)
      }
      blocks.push({ kind: 'paragraph', text: '以上数据经财务部复核。' })
      const name = `data/经营报告 Q3-${p.int(10, 99)}.docx`
      return {
        message: `请把 ${name} 里的所有表格分别导出为 csv 文件（UTF-8），放在 output/ 下，按表格在文档里出现的顺序在文件名里编号（例如 表1、表2）。`,
        files: { [name]: writeDocx(blocks) },
        outputs: ['output'],
        fingerprints: [name],
        rubric: [
          { id: 'm', type: 'missing', by: 'check', text: '每张表格都导出了一个 csv', feedback: '有的表格没有导出来' },
          { id: 'r', type: 'wrong-result', by: 'check', text: '每个 csv 的内容与对应表格逐格一致，编号与出现顺序一致', feedback: '导出的 csv 和文档里的表格对不上' },
          { id: 'f', type: 'format', by: 'check', text: 'csv 为 UTF-8、逗号分隔', feedback: 'csv 的编码或分隔符不对' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: '文件名里带上表格前面的小标题', feedback: '这次我想在文件名里带上表格的小标题，好找' },
        ],
        hidden: { tables, captions },
      }
    },
    checkers(task) {
      const tables = /** @type {string[][][]} */ (task.hidden.tables)
      const numbered = async (/** @type {string} */ dir) => {
        const found = await outputsOf(dir, 'output', ['.csv'])
        return Promise.all(found.map(async rel => ({ rel, n: Number(/\d+/.exec(base(rel))?.[0] ?? NaN), bytes: await readBytes(dir, rel) })))
      }
      return {
        m: async dir => {
          const found = await numbered(dir)
          return found.length >= tables.length ? ok() : no(`只有 ${found.length} 个 csv，文档里有 ${tables.length} 张表`)
        },
        r: async dir => {
          const found = await numbered(dir)
          for (let k = 0; k < tables.length; k += 1) {
            const file = found.find(f => f.n === k + 1)
            if (file === undefined) return no(`找不到编号 ${k + 1} 的 csv`)
            const diff = firstTableDifference(parseCsv(isUtf8(file.bytes) ? utf8(file.bytes) : ''), tables[k])
            if (diff !== null) return no(`${file.rel}：${diff}`)
          }
          return ok()
        },
        f: async dir => {
          const found = await numbered(dir)
          if (found.length === 0) return no('没有 csv')
          for (const file of found) {
            if (!isUtf8(file.bytes)) return no(`${file.rel} 不是 UTF-8`)
            if (utf8(file.bytes).replace(/^﻿/, '').split(/\r?\n/, 1)[0].split(',').length < 2) return no(`${file.rel} 不是逗号分隔`)
          }
          return ok()
        },
        c: noSpaces(['output']),
      }
    },
    good(task) {
      const tables = /** @type {string[][][]} */ (task.hidden.tables)
      return { write: Object.fromEntries(tables.map((rows, k) => [`output/表${k + 1}.csv`, toCsv(rows)])), remove: [] }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const tables = /** @type {string[][][]} */ (task.hidden.tables)
      const files = (/** @type {string[][][]} */ list, /** @type {(k: number) => string} */ name = k => `output/表${k + 1}.csv`) => ({ write: Object.fromEntries(list.map((rows, k) => [name(k), toCsv(rows)])), remove: [] })
      return [
        { point: 'm', answer: files(tables.slice(0, 2)) },
        { point: 'r', answer: files([tables[1], tables[0], ...tables.slice(2)]) },
        { point: 'f', answer: { write: Object.fromEntries(tables.map((rows, k) => [`output/表${k + 1}.csv`, `${rows.map(r => r.join('\t')).join('\n')}\n`.replace(/\t/g, ' | ')])), remove: [] } },
        { point: 'c', answer: files(tables, k => `output/表 ${k + 1}.csv`) },
      ]
    },
    async taste(task, dir) {
      const captions = /** @type {string[]} */ (task.hidden.captions)
      const found = await outputsOf(dir, 'output', ['.csv'])
      return captions.every(caption => found.some(rel => base(rel).includes(caption)))
    },
  },

  // ⑧（holdout，dev 里没有的变体）按扩展名和大小规则清理并归档一个混杂目录
  'cleanup-archive': {
    build(seed) {
      const p = picker(seed)
      /** @type {Record<string, string | Uint8Array>} */
      const files = {}
      /** @type {Array<{ from: string, to: string | null }>} */
      const plan = []
      const add = (/** @type {string} */ name, /** @type {string | Uint8Array} */ content, /** @type {string | null} */ to) => {
        files[`messy/${name}`] = content
        plan.push({ from: `messy/${name}`, to })
      }
      const fake = (/** @type {string} */ tag) => new Uint8Array(Buffer.from(`${tag}:${p.int(100000, 999999)}:${'x'.repeat(p.int(20, 60))}`))
      add('~$临时 1.tmp', 'lock', null)
      add(`cache ${p.int(10, 99)}.tmp`, 'cache-data', null)
      add('autosave.tmp', 'autosave', null)
      add('空白 文件.txt', '', null)
      add('old export.csv', '', null)
      add(`photo ${p.int(100, 999)}.png`, fake('png'), 'sorted/images')
      add('产品图 2.jpg', fake('jpg'), 'sorted/images')
      add('logo.png', fake('logo'), 'sorted/images')
      add('合同 扫描.pdf', fake('pdf'), 'sorted/docs')
      add('周报 9月.docx', fake('docx'), 'sorted/docs')
      add('readme draft.md', `# 草稿\n\n${p.pick(['待整理', '已过期', '备用'])}\n`, 'sorted/docs')
      add('库存 明细.csv', toCsv([['商品', '数量'], ['签字笔', p.int(10, 99)]]), 'sorted/data')
      add('预算表.xlsx', writeXlsx([{ name: '预算', rows: [['项目', '金额'], ['差旅', p.int(1000, 9999)]] }]), 'sorted/data')
      const line = (/** @type {number} */ i) => `2026-09-${pad(1 + (i % 28))} 10:${pad(i % 60)}:00 INFO request ${i} ok\n`
      let big = ''
      for (let i = 0; big.length < 12 * 1024; i += 1) big += line(i)
      add('server 1.log', big, 'sorted/logs/large')
      add('job.log', `${line(1)}${line(2)}`, 'sorted/logs')
      add('error log.log', `${line(3)}`, 'sorted/logs')
      return {
        message: '请整理 messy/ 目录：删除所有 .tmp 文件和 0 字节的文件；图片（.png、.jpg）移到 sorted/images/，文档（.pdf、.docx、.md）移到 sorted/docs/，表格（.csv、.xlsx）移到 sorted/data/；日志（.log）大于 10 KB 的移到 sorted/logs/large/，其余移到 sorted/logs/。移动时文件内容不能改，整理完 messy/ 里不留文件。',
        files,
        outputs: ['sorted', 'messy'],
        fingerprints: ['messy/server 1.log', 'messy/产品图 2.jpg'],
        rubric: [
          { id: 'r', type: 'wrong-result', by: 'check', text: '每个保留的文件都在规则对应的目录里', feedback: '有文件放错了目录' },
          { id: 'm', type: 'missing', by: 'check', text: '.tmp 文件和 0 字节文件都删掉了', feedback: '.tmp 或空文件没删干净' },
          { id: 'u', type: 'unverified', by: 'check', text: '保留的文件一个不少、内容没变，messy/ 里不剩文件', feedback: '有文件丢了或者内容变了，messy/ 里还有东西' },
          CONVENTION,
          { id: 't', type: 'taste', by: 'none', text: 'sorted/ 下另放一份整理记录', feedback: '这次我还想要一份整理记录，放在 sorted/ 下' },
        ],
        hidden: { plan },
      }
    },
    checkers(task) {
      const plan = /** @type {Array<{ from: string, to: string | null }>} */ (task.hidden.plan)
      const kept = plan.filter(x => x.to !== null)
      const located = async (/** @type {string} */ dir) => {
        const all = (await listFiles(dir)).filter(rel => rel.startsWith('sorted/') || rel.startsWith('messy/'))
        /** @type {Map<string, string[]>} */
        const bySha = new Map()
        for (const rel of all) {
          const key = sha(await readBytes(dir, rel))
          bySha.set(key, [...(bySha.get(key) ?? []), rel])
        }
        return { all, bySha }
      }
      return {
        r: async dir => {
          const { bySha } = await located(dir)
          for (const item of kept) {
            const where = bySha.get(sha(bytesOf(task.files[item.from]))) ?? []
            if (!where.some(rel => rel.slice(0, rel.lastIndexOf('/')) === item.to)) return no(`${base(item.from)} 应在 ${item.to}/`)
          }
          return ok()
        },
        m: async dir => {
          const { all } = await located(dir)
          const tmp = all.filter(rel => rel.toLowerCase().endsWith('.tmp'))
          if (tmp.length > 0) return no(`还有 .tmp：${base(tmp[0])}`)
          for (const rel of all) if ((await readBytes(dir, rel)).length === 0) return no(`还有空文件：${base(rel)}`)
          return ok()
        },
        u: async dir => {
          const { all, bySha } = await located(dir)
          const left = all.filter(rel => rel.startsWith('messy/'))
          if (left.length > 0) return no(`messy/ 还剩 ${left.length} 个文件`)
          const lost = kept.filter(item => !(bySha.get(sha(bytesOf(task.files[item.from]))) ?? []).some(rel => rel.startsWith('sorted/')))
          return lost.length === 0 ? ok() : no(`${lost.length} 个文件丢了或内容变了`)
        },
        c: noSpaces(['sorted']),
      }
    },
    good(task) {
      const plan = /** @type {Array<{ from: string, to: string | null }>} */ (task.hidden.plan)
      /** @type {Record<string, string | Uint8Array>} */
      const write = {}
      for (const item of plan) if (item.to !== null) write[`${item.to}/${base(item.from).replace(/\s+/g, '-')}`] = task.files[item.from]
      return { write, remove: plan.map(item => item.from) }
    },
    /** @returns {BadAnswer[]} */
    bad(task) {
      const plan = /** @type {Array<{ from: string, to: string | null }>} */ (task.hidden.plan)
      const make = (/** @type {(item: typeof plan[number]) => { to: string | null, keep?: boolean, content?: string | Uint8Array, name?: string }} */ f) => {
        /** @type {Record<string, string | Uint8Array>} */
        const write = {}
        const remove = []
        for (const item of plan) {
          const choice = f(item)
          if (choice.keep) continue
          remove.push(item.from)
          if (choice.to !== null) write[`${choice.to}/${choice.name ?? base(item.from).replace(/\s+/g, '-')}`] = choice.content ?? task.files[item.from]
        }
        return { write, remove }
      }
      const firstLog = plan.find(x => x.to === 'sorted/logs/large')
      const firstDoc = plan.find(x => x.to === 'sorted/docs')
      return [
        { point: 'r', answer: make(item => ({ to: item === firstLog ? 'sorted/logs' : item.to })) },
        { point: 'm', answer: make(item => (item.to === null && item.from.endsWith('.tmp') ? { to: 'sorted/docs' } : { to: item.to })) },
        { point: 'u', answer: make(item => (item === firstDoc ? { to: null } : { to: item.to })) },
        { point: 'c', answer: make(item => ({ to: item.to, name: base(item.from) })) },
      ]
    },
    async taste(task, dir) {
      return (await listFiles(dir)).some(rel => /^sorted\/[^/]+$/.test(rel))
    },
  },
}

/**
 * Markdown of docx blocks (the reference conversion).
 * @param {import('./office.mjs').Block[]} blocks
 */
export function docxToMarkdown(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.kind === 'heading') out.push(`${'#'.repeat(block.level)} ${block.text}`, '')
    else if (block.kind === 'paragraph') out.push(block.text, '')
    else {
      const [head, ...rest] = block.rows
      out.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rest.map(r => `| ${r.join(' | ')} |`), '')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

/** Every case of the family, in plan order. @returns {PilotCase[]} */
export function filesCases() {
  return FILES_PLAN.map(entry => ({
    id: `files/${entry.set}/${entry.variant}-${entry.seed}`,
    family: /** @type {const} */ ('files'),
    set: /** @type {CaseSet} */ (entry.set),
    variant: entry.variant,
    seed: entry.seed,
    ...VARIANTS[entry.variant].build(entry.seed),
  }))
}

/** @param {PilotCase} task */
const variantOf = task => {
  const variant = VARIANTS[task.variant]
  if (variant === undefined) throw new Error(`unknown files variant ${task.variant}`)
  return variant
}

/** Deterministic checkers of a case. @param {PilotCase} task */
export const filesCheckers = task => variantOf(task).checkers(task)
/** The known good end state. @param {PilotCase} task */
export const filesGood = task => variantOf(task).good(task)
/** Known bad end states, one per checked point. @param {PilotCase} task */
export const filesBad = task => variantOf(task).bad(task)
/** Whether the deliverable already matches the taste point (decides whether feedback mentions it). @param {PilotCase} task @param {string} dir */
export const filesTaste = (task, dir) => variantOf(task).taste(task, dir)
