// @ts-check
/**
 * Family `multi-step`, 多步分析验证中间结果: a detail table and a lookup table; the task is a
 * three-step analysis (clean, join, aggregate) with every intermediate result saved and a
 * log of the row count after each step. A case carries 2–3 input problems drawn from the
 * pool below, so what pays off is the habit of checking row counts after each step,
 * inspecting join keys and looking at the rows that drop out, not any one rule.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { picker } from '../../step6/rng.mjs'
import { firstTableDifference, no, normalize, ok, parseCsv, problemLine, readText, sha256, toCsv } from '../common.mjs'

/**
 * @typedef {import('../common.mjs').Family} Family
 * @typedef {import('../common.mjs').InnerCase} InnerCase
 * @typedef {import('../common.mjs').Point} Point
 * @typedef {import('../common.mjs').Answer} Answer
 * @typedef {{ id: string, key: string, date: string, val: number, status: string }} Rec
 * @typedef {{ key: string, name: string, group: string }} Dim
 * @typedef {{
 *   id: string, en: string, noun: string, dimNoun: string, mainFile: string, dimFile: string,
 *   rec: string, recPrefix: string, key: string, keyPrefix: string, date: string, val: string, stat: string,
 *   ok: string[], cancel: string, variants: string[], dimHead: string[],
 *   group: string, groupEn: string, cnt: string, sum: string, groups: string[], names: string[], lo: number, hi: number,
 * }} Scene
 */

/** Input problems a case may carry. */
export const TRAP_POOL = /** @type {const} */ (['key-format', 'orphan-rows', 'duplicate-rows', 'bad-date', 'status-variants'])

const PEOPLE_A = ['周明', '吴静', '郑华', '王磊', '李娜', '张伟', '刘洋', '陈敏', '杨帆', '赵婷']
const PEOPLE_B = ['孙浩', '马丽', '朱峰', '胡雪', '郭强', '何静', '高远', '林峰', '罗平', '梁颖']

/** @type {Scene[]} */
const SCENES = [
  {
    id: 'orders', en: 'orders', noun: '订单', dimNoun: '客户', mainFile: 'data/orders.csv', dimFile: 'data/customers.csv',
    rec: '订单号', recPrefix: 'OD', key: '客户编号', keyPrefix: 'C', date: '下单日期', val: '金额', stat: '状态',
    ok: ['已完成', '已发货'], cancel: '已取消', variants: ['取消', 'cancelled'], dimHead: ['客户编号', '客户名', '地区'],
    group: '地区', groupEn: 'region', cnt: '订单数', sum: '金额合计', groups: ['华东', '华北', '华南', '西南', '东北'], names: PEOPLE_A, lo: 80, hi: 2400,
  },
  {
    id: 'readings', en: 'readings', noun: '读数', dimNoun: '站点', mainFile: 'data/readings.csv', dimFile: 'data/stations.csv',
    rec: '读数编号', recPrefix: 'RD', key: '站点编号', keyPrefix: 'ST', date: '记录日期', val: '读数值', stat: '状态',
    ok: ['有效', '已复核'], cancel: '作废', variants: ['已作废', 'void'], dimHead: ['站点编号', '站点名', '片区'],
    group: '片区', groupEn: 'area', cnt: '读数条数', sum: '读数合计', groups: ['东片区', '西片区', '南片区', '北片区'],
    names: ['滨江站', '城北站', '南湖站', '西坝站', '东港站', '桥头站', '山口站', '河湾站', '林场站', '码头站'], lo: 10, hi: 300,
  },
  {
    id: 'tickets', en: 'tickets', noun: '工单', dimNoun: '员工', mainFile: 'data/tickets.csv', dimFile: 'data/staff.csv',
    rec: '工单号', recPrefix: 'TK', key: '员工编号', keyPrefix: 'E', date: '提交日期', val: '工时', stat: '状态',
    ok: ['已关闭', '处理中'], cancel: '已撤销', variants: ['撤销', 'withdrawn'], dimHead: ['员工编号', '姓名', '小组'],
    group: '小组', groupEn: 'team', cnt: '工单数', sum: '工时合计', groups: ['运维组', '客服组', '实施组', '研发组'], names: PEOPLE_B, lo: 1, hi: 16,
  },
]

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0')
const pad3 = (/** @type {number} */ n) => String(n).padStart(3, '0')

/** The scene of a built case. @param {InnerCase} task @returns {Scene} */
const sceneOf = task => /** @type {Scene} */ (SCENES.find(s => s.id === task.hidden.scene))

/** Join key in its one canonical form: no spaces or hyphens, upper case. @param {string} key */
const canonKey = key => key.replace(/[\s-]/g, '').toUpperCase()

/** A real calendar date written YYYY-MM-DD. @param {string} text */
function validDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m === null) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/**
 * What a correct three-step run gives, from the case's raw records.
 * @param {InnerCase} task
 */
function expectedOf(task) {
  const sc = sceneOf(task)
  /** @type {Rec[]} */
  const records = task.hidden.records
  /** @type {Dim[]} */
  const dim = task.hidden.dim
  const groupOf = new Map(dim.map(d => [canonKey(d.key), d.group]))
  const cancelled = new Set([sc.cancel, ...sc.variants])
  const seen = new Set()
  /** @type {Rec[]} */
  const step1 = []
  for (const r of records) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (cancelled.has(r.status.trim()) || !validDate(r.date)) continue
    step1.push(r)
  }
  const joined = step1.filter(r => groupOf.has(canonKey(r.key)))
  /** @type {Array<[string, string, number]>} */
  const step2 = joined.map(r => /** @type {[string, string, number]} */ ([r.id, groupOf.get(canonKey(r.key)) ?? '', r.val])).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  /** @type {Map<string, { n: number, total: number }>} */
  const by = new Map()
  for (const [, group, val] of step2) {
    const cur = by.get(group) ?? { n: 0, total: 0 }
    cur.n += 1
    cur.total += val
    by.set(group, cur)
  }
  const step3 = [...by.entries()].map(([group, v]) => ({ group, n: v.n, total: v.total })).sort((a, b) => b.total - a.total)
  const orphans = [...new Set(step1.filter(r => !groupOf.has(canonKey(r.key))).map(r => canonKey(r.key)))]
  const badIds = [...new Set(records.filter(r => !validDate(r.date)).map(r => r.id))]
  return { step1, step2, step3, orphans, badIds, raw: records.length }
}

/** @param {number} n */
const csvNum = n => String(n)

/** The generator proper; null when this draw is unusable (tied totals or too few groups). @param {string} seed @param {number} attempt @param {boolean} convention @returns {InnerCase | null} */
function generate(seed, attempt, convention) {
  const p = picker(`multi-step:${seed}:${attempt}`)
  const sc = p.pick(SCENES)
  const traps = p.shuffle(TRAP_POOL).slice(0, p.int(2, 3)).sort((a, b) => TRAP_POOL.indexOf(a) - TRAP_POOL.indexOf(b))
  // Ids carry a code derived from the seed, never the seed itself (it names the split).
  const code = sha256(seed).slice(0, 4).toUpperCase()
  const canon = (/** @type {number} */ num) => `${sc.keyPrefix}${pad3(num)}`
  const nums = p.shuffle(Array.from({ length: 40 }, (_, i) => i + 1)).slice(0, p.int(6, 9)).sort((a, b) => a - b)
  const names = p.shuffle(sc.names)
  /** @type {Dim[]} */
  const dim = nums.map((num, i) => ({ key: canon(num), name: names[i], group: p.pick(sc.groups) }))
  const dayOf = () => `2026-${pad2(p.int(1, 12))}-${pad2(p.int(1, 28))}`
  /** @type {Rec[]} */
  const rows = Array.from({ length: p.int(16, 22) }, (_, i) => ({
    id: `${sc.recPrefix}${code}${pad3(i + 1)}`, key: canon(p.pick(nums)), date: dayOf(), val: p.int(sc.lo, sc.hi), status: p.pick(sc.ok),
  }))
  const order = p.shuffle(rows.map((_, i) => i))
  const take = (/** @type {number} */ k) => order.splice(0, k)
  const variantsOn = traps.includes('status-variants')
  const cancelIdx = take(variantsOn ? 3 : p.int(2, 3))
  const badIdx = traps.includes('bad-date') ? take(2) : []
  const orphanIdx = traps.includes('orphan-rows') ? take(p.int(1, 2)) : []
  const formatIdx = traps.includes('key-format') ? take(p.int(3, 5)) : []
  const dupIdx = traps.includes('duplicate-rows') ? take(2) : []
  // The first spelling used is never the plain one, so a filter on the plain word misses some.
  const spellings = variantsOn ? [sc.variants[0], sc.cancel, sc.variants[1]] : [sc.cancel]
  cancelIdx.forEach((idx, i) => { rows[idx].status = spellings[i % spellings.length] })
  const badDates = p.shuffle(['2026-02-30', '2026-13-05', '2026-04-31', '待定', '2026-00-12', '2026-06-31'])
  badIdx.forEach((idx, i) => { rows[idx].date = badDates[i] })
  const unknown = p.shuffle(Array.from({ length: 50 }, (_, i) => 41 + i))
  orphanIdx.forEach((idx, i) => { rows[idx].key = canon(unknown[i]) })
  const writers = [
    (/** @type {string} */ k) => k.toLowerCase(),
    (/** @type {string} */ k) => `${sc.keyPrefix}-${k.slice(sc.keyPrefix.length)}`,
    (/** @type {string} */ k) => `${k} `,
  ]
  const shift = p.int(0, 2)
  formatIdx.forEach((idx, i) => { rows[idx].key = writers[(i + shift) % writers.length](rows[idx].key) })
  const records = [...rows]
  for (const idx of dupIdx) {
    const at = records.findIndex(r => r.id === rows[idx].id) + 1 + p.int(0, 3)
    records.splice(at, 0, { ...rows[idx] })
  }
  const logPath = p.pick(['output/checks.md', 'output/verify-log.md'])
  const p1 = `output/step1-${sc.en}-clean.csv`
  const p2 = `output/step2-${sc.en}-${sc.groupEn}.csv`
  const p3 = `output/step3-by-${sc.groupEn}.csv`
  const hidden = { scene: sc.id, records, dim, p1, p2, p3, logPath }
  /** @type {InnerCase} */
  const draft = { variant: '', message: '', files: {}, outputs: [], rubric: [], traps, fingerprints: [], hidden }
  const x = expectedOf(draft)
  const totals = x.step3.map(g => g.total)
  if (new Set(totals).size !== totals.length || x.step3.length < 3) return null

  const ask = [
    `请对 data/ 里的${sc.noun}明细（${sc.mainFile}）和${sc.dimNoun}资料（${sc.dimFile}）做三步分析，每一步的结果都要存成文件：`,
    `1. 清洗：去掉${sc.cancel}的${sc.noun}、${sc.date}不是有效日期的${sc.noun}，同一条${sc.noun}重复出现的只留一条；表头与原表相同，存到 ${p1}。`,
    `2. 连接：把清洗后的${sc.noun}按${sc.key}和 ${sc.dimFile} 连接，对不上${sc.dimNoun}的${sc.noun}不进这一步；结果只要三列，表头“${sc.rec},${sc.group},${sc.val}”，按${sc.rec}升序，存到 ${p2}。`,
    `3. 汇总：按${sc.group}统计${sc.cnt}和${sc.sum}，表头“${sc.group},${sc.cnt},${sc.sum}”，按${sc.sum}从大到小排，存到 ${p3}。`,
    `每一步做完请核对，并在 ${logPath} 里记下每一步结果的行数（不含表头）。`,
  ].join('\n')
  const files = {
    [sc.mainFile]: toCsv([[sc.rec, sc.key, sc.date, sc.val, sc.stat], ...records.map(r => [r.id, r.key, r.date, csvNum(r.val), r.status])]),
    [sc.dimFile]: toCsv([sc.dimHead, ...dim.map(d => [d.key, d.name, d.group])]),
  }
  /** @type {Point[]} */
  const rubric = [
    { id: '', type: 'wrong-result', by: 'check', weight: 3, text: `${p3} 的表头是“${sc.group},${sc.cnt},${sc.sum}”，每个${sc.group}一行，${sc.cnt}和${sc.sum}等于按规则清洗、连接后的统计，按${sc.sum}从大到小排`, feedback: '最后的汇总表和明细对不上' },
    { id: '', type: 'missing', by: 'check', weight: 2, text: `${p1} 和 ${p2} 都已生成：第一步只留清洗后该留的${sc.noun}（去掉的不留、重复的只一条），第二步是连得上${sc.dimNoun}的${sc.noun}及其${sc.group}、${sc.val}`, feedback: '第一步或第二步的中间文件缺了，或者行对不上' },
    { id: '', type: 'unverified', by: 'check', weight: 2, text: `${logPath} 按步骤记了三步结果的行数，与实际文件的行数一致，也是正确的行数`, feedback: '核对日志里的行数和实际文件对不上，或者有一步没记' },
  ]
  if (traps.includes('orphan-rows')) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${logPath} 指出连不上${sc.dimNoun}、没进第二步的${sc.key}：${x.orphans.join('、')}`, feedback: `有${sc.noun}连不上${sc.dimNoun}资料，日志里没写是哪些` })
  if (traps.includes('bad-date')) rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${logPath} 指出因${sc.date}无效而被去掉的${sc.noun}：${x.badIds.join('、')}`, feedback: `有${sc.noun}的日期有问题被去掉了，日志里没写是哪些` })
  if (convention) rubric.push({ id: '', type: 'convention', by: 'check', weight: 1, text: `${logPath} 里每一步写成一行“步骤 N：输入 X 行，输出 Y 行”`, feedback: '日志里每一步请写成一行“步骤 N：输入 X 行，输出 Y 行”' })
  rubric.forEach((point, i) => { point.id = `r${i + 1}` })
  return {
    variant: `${sc.id}-${traps.length}-problems`,
    message: `${ask}${problemLine(logPath)}`,
    files,
    outputs: [p1, p2, p3, logPath],
    rubric,
    traps,
    fingerprints: [records[0].id, records[1].id, records[2].id],
    hidden,
  }
}

/** @type {Family['build']} */
function build(seed, { convention }) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const made = generate(seed, attempt, convention)
    if (made !== null) return made
  }
  throw new Error(`multi-step: no usable draw for ${seed}`)
}

/** @param {string} dir @param {string} path @returns {Promise<string[][] | null>} */
async function tableOf(dir, path) {
  try {
    return parseCsv(await readText(dir, path))
  } catch {
    return null
  }
}

/** Cell cleaned for comparing: trimmed, full-width and thousands separators normalized. @param {string} cell */
const clean = cell => normalize(String(cell ?? '').trim())

/** First difference of the step-1 file from the right one, or null: same set of ids, each once, same value per id. @param {string[][]} rows @param {InnerCase} task */
function step1Difference(rows, task) {
  const sc = sceneOf(task)
  const want = expectedOf(task).step1
  const header = rows[0].map(c => c.trim())
  const idCol = header.indexOf(sc.rec)
  const valCol = header.indexOf(sc.val)
  if (idCol < 0 || valCol < 0) return `表头里没有“${sc.rec}”或“${sc.val}”`
  const body = rows.slice(1)
  if (body.length !== want.length) return `${body.length} 行，应为 ${want.length} 行`
  const ids = body.map(r => clean(r[idCol] ?? ''))
  if (new Set(ids).size !== ids.length) return '有重复的编号'
  const byId = new Map(want.map(r => [r.id, r.val]))
  for (const [i, id] of ids.entries()) {
    if (!byId.has(id)) return `多出了 ${id}`
    if (Number(clean(body[i][valCol] ?? '')) !== byId.get(id)) return `${id} 的${sc.val}不对`
  }
  return null
}

/** First difference of the step-2 file from the right one (row order does not matter; the header does), or null. @param {string[][]} rows @param {InnerCase} task */
function step2Difference(rows, task) {
  const sc = sceneOf(task)
  const want = expectedOf(task).step2
  const sorted = (/** @type {string[][]} */ list) => [...list].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const got = [rows[0].map(clean), ...sorted(rows.slice(1).map(r => r.map(clean)))]
  return firstTableDifference(got, [[sc.rec, sc.group, sc.val], ...want.map(r => [r[0], r[1], String(r[2])])])
}

/** The text of one step in the log: its marker line up to the next step's marker or heading, or null. @param {string} text normalized log @param {number} n */
function stepSegment(text, n) {
  const CN = ['', '一', '二', '三']
  const marker = (/** @type {number} */ k) => new RegExp(`(?:步骤\\s*|第\\s*|step\\s*)(?:${k}|${CN[k]})(?!\\d)|^\\s*\\|?\\s*${k}\\s*[|.、]`, 'i')
  const lines = text.split('\n')
  const start = lines.findIndex(line => marker(n).test(line))
  if (start < 0) return null
  const others = [1, 2, 3].filter(k => k !== n).map(marker)
  const seg = [lines[start]]
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line) || others.some(re => re.test(line))) break
    seg.push(line)
  }
  return seg.join('\n').replace(marker(n), ' ')
}

/** Whether a step's text gives the count: the number after "输出" (last one), else after another result word, else any number. @param {string} seg @param {number} count */
function givesCount(seg, count) {
  const after = (/** @type {RegExp} */ re) => [...seg.matchAll(re)].map(m => Number(m[1]))
  const out = after(/输出[^\d\n]{0,6}(\d+)/g)
  if (out.length > 0) return out.at(-1) === count
  const other = after(/(?:得到|剩下|剩余|剩|留下|保留|结果|共|→|->|=>)[^\d\n]{0,6}(\d+)/g)
  if (other.length > 0) return other.at(-1) === count
  return after(/(\d+)/g).includes(count)
}

/** @type {Family['checkers']} */
function checkers(task) {
  const { p1, p2, p3, logPath } = task.hidden
  const sc = sceneOf(task)
  const x = expectedOf(task)
  /** @type {Record<string, import('../common.mjs').Checker>} */
  const out = {}
  for (const point of task.rubric) {
    if (point.type === 'wrong-result') {
      out[point.id] = async dir => {
        const rows = await tableOf(dir, p3)
        if (rows === null) return no(`没有 ${p3}`)
        const want = [[sc.group, sc.cnt, sc.sum], ...x.step3.map(g => [g.group, String(g.n), String(g.total)])]
        const diff = firstTableDifference(rows.map(r => r.map(clean)), want)
        return diff === null ? ok() : no(diff)
      }
    } else if (point.type === 'missing') {
      out[point.id] = async dir => {
        const t1 = await tableOf(dir, p1)
        if (t1 === null || t1.length === 0) return no(`没有 ${p1}`)
        const d1 = step1Difference(t1, task)
        if (d1 !== null) return no(`第一步：${d1}`)
        const t2 = await tableOf(dir, p2)
        if (t2 === null || t2.length === 0) return no(`没有 ${p2}`)
        const d2 = step2Difference(t2, task)
        return d2 === null ? ok() : no(`第二步：${d2}`)
      }
    } else if (point.type === 'convention') {
      out[point.id] = async dir => {
        const text = normalize(await readText(dir, logPath).catch(() => ''))
        if (text === '') return no(`没有 ${logPath}`)
        const missing = [1, 2, 3].filter(n => !new RegExp(`步骤[ \\t]*${n}[ \\t]*:[ \\t]*输入[ \\t]*\\d+[ \\t]*行[ \\t]*,[ \\t]*输出[ \\t]*\\d+[ \\t]*行`).test(text))
        return missing.length === 0 ? ok() : no(`步骤 ${missing.join('、')} 不是约定的写法`)
      }
    } else if (point.text.includes('行数')) {
      out[point.id] = async dir => {
        const text = normalize(await readText(dir, logPath).catch(() => ''))
        if (text === '') return no(`没有 ${logPath}`)
        const want = [x.step1.length, x.step2.length, x.step3.length]
        for (const [i, path] of [p1, p2, p3].entries()) {
          const rows = await tableOf(dir, path)
          if (rows === null) return no(`没有 ${path}，日志无从核对`)
          if (rows.length - 1 !== want[i]) return no(`${path} 的行数不对（${rows.length - 1}）`)
          const seg = stepSegment(text, i + 1)
          if (seg === null) return no(`日志里没有步骤 ${i + 1}`)
          if (!givesCount(seg, want[i])) return no(`日志里步骤 ${i + 1} 的行数不对`)
        }
        return ok()
      }
    } else {
      const orphan = point.text.includes(sc.key)
      const names = orphan ? x.orphans : x.badIds
      out[point.id] = async dir => {
        const text = normalize(await readText(dir, logPath).catch(() => '')).toUpperCase().replace(/(?<=[A-Z])-(?=\d)/g, '')
        if (text === '') return no(`没有 ${logPath}`)
        const absent = names.filter(name => !text.includes(name.toUpperCase()))
        return absent.length === 0 ? ok() : no(`日志里没有提到：${absent.join('、')}`)
      }
    }
  }
  return out
}

/**
 * The correct log; `skip` leaves one finding out, `wrong` miscounts step 2, `plain` drops the agreed line format.
 * @param {InnerCase} task
 * @param {{ skip?: 'orphan' | 'bad', wrong?: boolean, plain?: boolean }} [opts]
 */
function logText(task, opts = {}) {
  const sc = sceneOf(task)
  const x = expectedOf(task)
  const ins = [x.raw, x.step1.length, x.step2.length]
  const outs = [x.step1.length, x.step2.length, x.step3.length]
  if (opts.wrong) outs[1] += 1
  const steps = [0, 1, 2].map(i => (opts.plain ? `第 ${i + 1} 步：共 ${outs[i]} 行` : `步骤 ${i + 1}：输入 ${ins[i]} 行，输出 ${outs[i]} 行`))
  const lines = ['# 核对日志', '', '## 各步行数', ...steps, '', '## 发现的问题']
  const dups = x.raw - new Set(task.hidden.records.map((/** @type {Rec} */ r) => r.id)).size
  if (dups > 0) lines.push(`- 重复记录去掉 ${dups} 条。`)
  if (task.traps.includes('status-variants')) lines.push(`- 状态有几种写法，都按${sc.cancel}处理。`)
  if (task.traps.includes('key-format')) lines.push(`- ${sc.key}的写法不一致（大小写、连字符、空格），统一后再连接。`)
  if (task.traps.includes('bad-date') && opts.skip !== 'bad') lines.push(`- 日期无效已去掉：${x.badIds.join('、')}。`)
  if (task.traps.includes('orphan-rows') && opts.skip !== 'orphan') lines.push(`- 对不上${sc.dimNoun}、没有进入第二步的${sc.key}：${x.orphans.join('、')}。`)
  lines.push('- 其余逐行核对过。', '')
  return lines.join('\n')
}

/** Step-1 rows as written. @param {InnerCase} task */
function step1Rows(task) {
  const sc = sceneOf(task)
  return [[sc.rec, sc.key, sc.date, sc.val, sc.stat], ...expectedOf(task).step1.map(r => [r.id, canonKey(r.key), r.date, String(r.val), r.status])]
}

/** @type {Family['good']} */
function good(task) {
  const sc = sceneOf(task)
  const x = expectedOf(task)
  const { p1, p2, p3, logPath } = task.hidden
  return {
    write: {
      [p1]: toCsv(step1Rows(task)),
      [p2]: toCsv([[sc.rec, sc.group, sc.val], ...x.step2.map(r => [r[0], r[1], String(r[2])])]),
      [p3]: toCsv([[sc.group, sc.cnt, sc.sum], ...x.step3.map(g => [g.group, String(g.n), String(g.total)])]),
      [logPath]: logText(task),
    },
    remove: [],
  }
}

/** @type {Family['bad']} */
function bad(task) {
  const sc = sceneOf(task)
  const { p1, p3, logPath } = task.hidden
  return task.rubric.filter(point => point.by === 'check').map(point => {
    const answer = good(task)
    if (point.type === 'wrong-result') {
      const rows = step3Rows(task)
      rows[1][2] = String(Number(rows[1][2]) + 1)
      answer.write[p3] = toCsv(rows)
    } else if (point.type === 'missing') {
      // Same row count, one wrong record: the log still agrees with the file.
      const rows = step1Rows(task)
      rows[rows.length - 1][0] = `${rows[rows.length - 1][0]}Z`
      answer.write[p1] = toCsv(rows)
    } else if (point.type === 'convention') {
      answer.write[logPath] = logText(task, { plain: true })
    } else if (point.text.includes('行数')) {
      answer.write[logPath] = logText(task, { wrong: true })
    } else {
      answer.write[logPath] = logText(task, { skip: point.text.includes(sc.key) ? 'orphan' : 'bad' })
    }
    return { point: point.id, answer }
  })
}

/** Step-3 rows as written. @param {InnerCase} task */
function step3Rows(task) {
  const sc = sceneOf(task)
  return [[sc.group, sc.cnt, sc.sum], ...expectedOf(task).step3.map(g => [g.group, String(g.n), String(g.total)])]
}

/** @type {Family} */
export const multiStep = {
  name: 'multi-step',
  title: '多步分析验证中间结果',
  habit: '多步处理每一步都核对行数，连接前先看键的写法，检查掉出去的记录，并把核对结果写进日志',
  trapPool: TRAP_POOL,
  convention: { text: '日志里每一步写成一行“步骤 N：输入 X 行，输出 Y 行”', feedback: '日志里每一步请写成一行“步骤 N：输入 X 行，输出 Y 行”' },
  build,
  checkers,
  good,
  bad,
}
