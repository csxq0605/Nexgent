// @ts-check
/**
 * Family `cited-report`, 按资料写报告带引用: a folder of 4–6 short source files (minutes, a
 * supplier quote, a survey summary, a policy note, a schedule update…); the task is a report
 * that answers 3–4 numbered questions, one section per question, every factual answer citing
 * its source file name. A case carries 2–3 input problems drawn from the pool below, so what
 * pays off is the habit of cross-checking sources, preferring the newer authoritative one and
 * admitting gaps, not any one rule.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { picker } from '../../step6/rng.mjs'
import { amountForms, dateForms, hasAny, no, normalize, ok, pad, problemLine, readText, sha256 } from '../common.mjs'

/**
 * @typedef {import('../common.mjs').Family} Family
 * @typedef {import('../common.mjs').InnerCase} InnerCase
 * @typedef {import('../common.mjs').Point} Point
 * @typedef {import('../common.mjs').Answer} Answer
 * @typedef {ReturnType<typeof picker>} P
 * @typedef {{
 *   kind: string, type: 'amount' | 'date' | 'count' | 'percent' | 'person', unit?: string, topic: string, ask: string,
 *   line: (t: string) => string, gen: (p: P) => any, alt: (p: P, v: any) => any,
 * }} Fact
 * @typedef {{ n: number, key: string, role: 'simple' | 'gap' | 'none', topic: string, ask: string, display: string, wrong: string, forms: string[], sources: string[] }} Q
 */

/** Input problems a case may carry. */
export const TRAP_POOL = /** @type {const} */ (['conflicting-figures', 'superseded-source', 'unanswerable', 'unit-mismatch', 'irrelevant-source'])

const comma = (/** @type {number} */ n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const sign = (/** @type {P} */ p) => (p.next() < 0.5 ? -1 : 1)
const NAMES = ['陈立群', '周明远', '吴思婷', '郑海涛', '许嘉宁', '孙晓峰', '何文静', '林国梁']
const PROJECTS = ['办公区网络改造', '数据中心空调更新', '实验室设备采购', '客服系统升级', '仓储货架更换', '会议室显示屏更新']
const SUPPLIERS = ['远景', '启明', '恒瑞', '新拓', '博润']

/** @type {Record<string, Fact>} */
const FACTS = {
  budget: {
    kind: 'minutes', type: 'amount', topic: '采购预算上限', ask: '本次采购的预算上限是多少元？',
    line: t => `会议决定：采购预算上限为 ${t}。`,
    gen: p => p.int(20, 90) * 10000,
    alt: (p, v) => { const w = v + sign(p) * p.int(2, 9) * 10000; return w >= 100000 ? w : v + 20000 },
  },
  owner: {
    kind: 'minutes', type: 'person', topic: '验收负责人', ask: '验收工作由谁负责？',
    line: t => `验收工作由 ${t} 负责。`,
    gen: p => p.pick(NAMES),
    alt: (p, v) => p.pick(NAMES.filter(x => x !== v)),
  },
  price: {
    kind: 'quote', type: 'amount', topic: '含税总价', ask: '供应商报价的含税总价是多少元？',
    line: t => `含税总价：${t}。`,
    gen: p => p.int(150, 890) * 1000 + p.int(1, 9) * 100,
    alt: (p, v) => v + sign(p) * p.int(2, 9) * 1000,
  },
  deadline: {
    kind: 'quote', type: 'date', topic: '最终交付日期', ask: '供应商承诺的最终交付日期是哪一天？',
    line: t => `最终交付日期：${t}。`,
    gen: p => `2026-${p.pick(['11', '12'])}-${pad(p.int(1, 28))}`,
    alt: (p, v) => { let w = v; while (w === v) w = `2026-${p.pick(['11', '12'])}-${pad(p.int(1, 28))}`; return w },
  },
  warranty: {
    kind: 'quote', type: 'count', unit: '个月', topic: '质保期', ask: '报价单约定的质保期是多少个月？',
    line: t => `质保期为 ${t}。`,
    gen: p => p.pick([12, 18, 24, 36]),
    alt: (p, v) => p.pick([12, 18, 24, 36].filter(x => x !== v)),
  },
  samples: {
    kind: 'survey', type: 'count', unit: '份', topic: '有效问卷份数', ask: '调研共回收了多少份有效问卷？',
    line: t => `共回收有效问卷 ${t}。`,
    gen: p => p.int(120, 420),
    alt: (p, v) => v + sign(p) * p.int(15, 60),
  },
  sat: {
    kind: 'survey', type: 'percent', topic: '满意度', ask: '选择“满意”及以上的受访者占比是多少？',
    line: t => `选择“满意”及以上的受访者占比为 ${t}。`,
    gen: p => (p.int(60, 97) * 10 + p.int(1, 9)) / 10,
    alt: (p, v) => { const w = Math.round((v + sign(p) * p.int(30, 90) / 10) * 10) / 10; return w >= 50 && w <= 99 ? w : Math.round((v - 4.3) * 10) / 10 },
  },
  threshold: {
    kind: 'policy', type: 'amount', topic: '审批金额线', ask: '单笔超过多少元的支出需要部门负责人审批？',
    line: t => `单笔超过 ${t} 的支出，须经部门负责人审批。`,
    gen: p => p.pick([2000, 3000, 5000, 8000, 20000]),
    alt: (p, v) => p.pick([2000, 3000, 5000, 8000, 20000].filter(x => x !== v)),
  },
  trial: {
    kind: 'schedule', type: 'date', topic: '试运行开始日期', ask: '试运行从哪一天开始？',
    line: t => `试运行开始日期为 ${t}。`,
    gen: p => `2026-${p.pick(['11', '12'])}-${pad(p.int(1, 28))}`,
    alt: (p, v) => { let w = v; while (w === v) w = `2026-${p.pick(['11', '12'])}-${pad(p.int(1, 28))}`; return w },
  },
}

const GAP_ASK = '供应商报价的含税总价比本次采购的预算上限低多少元？'

/** Document kinds: title, neutral lines that never state a fact. */
const KINDS = {
  minutes: { title: '项目例会纪要', filler: ['到会人员：采购、财务、使用部门代表。', '会议由采购部主持，纪要会后发给全体到会人员。', '议题包括采购范围和付款方式，各方无异议。'] },
  quote: { title: '供应商报价单', filler: ['付款方式：到货验收后支付。', '报价有效期自出具之日起 30 天。', '运输与安装由供应商负责。'] },
  survey: { title: '使用部门调研小结', filler: ['调研对象为使用部门员工，采用线上问卷。', '调研由行政部组织，结果仅供内部参考。', '问卷包含选择题和开放题。'] },
  policy: { title: '费用与审批制度说明', filler: ['本说明适用于公司内所有项目的采购与报销。', '本说明由财务部维护，每年修订一次。', '票据须在支出后及时提交。'] },
  schedule: { title: '进度通报', filler: ['本通报由项目经理汇总发出。', '各小组按周更新进度。', '现场条件已确认，具备施工条件。'] },
}

const docDate = (/** @type {number} */ off) => (off < 30 ? `2026-09-${pad(off + 1)}` : `2026-10-${pad(off - 29)}`)

/** @param {string} key @param {any} v @param {{ wan: boolean, style: string }} ctx */
function show(key, v, ctx) {
  const f = FACTS[key]
  if (f.type === 'amount') return ctx.wan && key === 'budget' ? `${v / 10000} 万元` : `${comma(v)} 元`
  if (f.type === 'date') return ctx.style === 'iso' ? v : `${v.slice(0, 4)}年${Number(v.slice(5, 7))}月${Number(v.slice(8, 10))}日`
  if (f.type === 'count') return `${v} ${f.unit}`
  if (f.type === 'percent') return `${v}%`
  return String(v)
}

/** Forms a correct answer may be written in. @param {string} key @param {any} v */
function formsOf(key, v) {
  const f = FACTS[key]
  if (f.type === 'amount') return amountForms(v)
  if (f.type === 'date') return dateForms(v)
  return [String(v)]
}

/** A value that is certainly wrong (and shares no form with the right one). @param {string} key @param {any} v */
function wrongOf(key, v) {
  const f = FACTS[key]
  if (f.type === 'amount') return v + 700
  if (f.type === 'date') return `${v.slice(0, 8)}${pad(Number(v.slice(8)) > 14 ? Number(v.slice(8)) - 3 : Number(v.slice(8)) + 3)}`
  if (f.type === 'count') return v + 7
  if (f.type === 'percent') return Math.round((v + (v > 50 ? -1 : 1) * 2.7) * 10) / 10
  return NAMES.find(x => x !== v) ?? '王某'
}

const rangeTo = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i)

/**
 * One try at a case; null when the drawn problems do not fit the drawn questions.
 * @param {string} seed @param {boolean} convention @param {number} attempt
 * @returns {InnerCase | null}
 */
function attemptBuild(seed, convention, attempt) {
  const p = picker(`cited-report:${seed}:${attempt}`)
  // Names carry a code derived from the seed, never the seed itself (it names the split).
  const code = sha256(seed).slice(0, 4).toUpperCase()
  const low = code.toLowerCase()
  const traps = p.shuffle(TRAP_POOL).slice(0, p.int(2, 3)).sort((a, b) => TRAP_POOL.indexOf(a) - TRAP_POOL.indexOf(b))
  const has = (/** @type {string} */ t) => traps.includes(/** @type {any} */ (t))
  const nq = p.int(3, 4)
  const ctx = { wan: has('unit-mismatch'), style: p.pick(['iso', 'cn']) }
  const projects = p.shuffle(PROJECTS)
  const proj = `${projects[0]}·${code}`
  const proj2 = `${projects[1]}·${sha256(seed).slice(4, 8).toUpperCase()}`
  const ref = `CG-${code}-${p.int(1, 9)}${p.int(0, 9)}`
  const ref2 = `CG-${sha256(seed).slice(8, 12).toUpperCase()}-${p.int(1, 9)}${p.int(0, 9)}`
  const supplier = `${p.pick(SUPPLIERS)}${code}科技有限公司`
  const reportPath = p.pick(['output/report.md', 'output/answers.md', 'report/answer-report.md'])

  // Questions: a gap question (budget minus quote, in different units) and simple ones.
  /** @type {Array<{ key: string, role: 'simple' | 'gap' | 'none' }>} */
  let qs = []
  const kinds = new Set()
  if (has('unit-mismatch')) { qs.push({ key: 'gap', role: 'gap' }); kinds.add('minutes'); kinds.add('quote') }
  for (const key of p.shuffle(Object.keys(FACTS))) {
    if (qs.length >= nq) break
    if (has('unit-mismatch') && (key === 'budget' || key === 'price')) continue
    if (new Set([...kinds, FACTS[key].kind]).size > 3) continue
    kinds.add(FACTS[key].kind)
    qs.push({ key, role: 'simple' })
  }
  if (qs.length < nq) return null
  qs = p.shuffle(qs)
  const simple = qs.filter(q => q.role === 'simple')
  const none = has('unanswerable') ? p.pick(simple) : null
  if (none !== null) none.role = 'none'
  const answerable = qs.filter(q => q.role !== 'none')
  const answerableSimple = answerable.filter(q => q.role === 'simple')
  if (answerable.length < 2) return null
  const conflictQ = has('conflicting-figures') ? (answerableSimple.length > 0 ? p.pick(answerableSimple) : null) : null
  if (has('conflicting-figures') && conflictQ === null) return null
  const decoyPool = answerableSimple.filter(q => q !== conflictQ)
  const decoyQ = has('irrelevant-source') ? (decoyPool.length > 0 ? p.pick(decoyPool) : null) : null
  if (has('irrelevant-source') && decoyQ === null) return null
  const answerKinds = [...new Set(answerable.flatMap(q => (q.role === 'gap' ? ['minutes', 'quote'] : [FACTS[q.key].kind])))]
  const conflictKind = conflictQ === null ? null : FACTS[conflictQ.key].kind
  const supersedable = answerKinds.filter(k => k !== conflictKind)
  if (has('superseded-source') && supersedable.length === 0) return null
  const supKind = has('superseded-source') ? p.pick(supersedable) : null

  // Values.
  /** @type {Record<string, any>} */
  const vals = {}
  let gapDiff = 0
  for (const q of qs) if (q.role !== 'gap') vals[q.key] = FACTS[q.key].gen(p)
  if (has('unit-mismatch')) {
    gapDiff = p.int(8, 59) * 1000 + p.int(1, 9) * 100
    vals.budget = FACTS.budget.gen(p)
    vals.price = vals.budget - gapDiff
  }

  // Documents (skeletons first; dates, then names, then text).
  /** @type {Array<{ tag: string, kind: string, title: string, date: string, file: string, facts: Array<[string, any]>, extra: string[] }>} */
  const docs = []
  const doc = (/** @type {string} */ tag, /** @type {string} */ kind, /** @type {string} */ title) => {
    const d = { tag, kind, title, date: '', file: '', facts: /** @type {Array<[string, any]>} */ ([]), extra: /** @type {string[]} */ ([]) }
    docs.push(d)
    return d
  }
  const baseOf = (/** @type {string} */ kind) => /** @type {NonNullable<ReturnType<typeof doc>>} */ (docs.find(d => d.tag === 'base' && d.kind === kind))
  for (const kind of answerKinds) doc('base', kind, KINDS[/** @type {keyof typeof KINDS} */ (kind)].title)
  const answerKeys = answerable.flatMap(q => (q.role === 'gap' ? ['budget', 'price'] : [q.key]))
  for (const key of answerKeys) baseOf(FACTS[key].kind).facts.push([key, vals[key]])
  let notice = null
  let vOther = null
  if (conflictQ !== null) {
    notice = doc('notice', 'notice', '情况通报')
    vOther = FACTS[conflictQ.key].alt(p, vals[conflictQ.key])
    notice.facts.push([conflictQ.key, vOther])
  }
  let rev = null
  if (supKind !== null) {
    rev = doc('rev', supKind, `${KINDS[/** @type {keyof typeof KINDS} */ (supKind)].title}（修订版）`)
    for (const [key, v] of baseOf(supKind).facts) rev.facts.push([key, v])
    const old = baseOf(supKind)
    old.facts = old.facts.map(([key, v]) => [key, FACTS[key].alt(p, v)])
  }
  let weekly = null
  if (decoyQ !== null) {
    weekly = doc('weekly', 'weekly', `${proj2} 项目周报`)
    weekly.facts.push([decoyQ.key, FACTS[decoyQ.key].alt(p, vals[decoyQ.key])])
    weekly.extra.push(`本周报仅涉及「${proj2}」项目，与其他项目无关。`, `本周完成 ${p.int(2, 6)} 项现场勘察。`)
  }
  for (const kind of p.shuffle(Object.keys(KINDS).filter(k => !answerKinds.includes(k)))) {
    if (docs.length >= 4) break
    doc('filler', kind, KINDS[/** @type {keyof typeof KINDS} */ (kind)].title)
  }
  if (docs.length > 6) return null
  const offs = p.shuffle(rangeTo(45)).slice(0, docs.length)
  docs.forEach((d, i) => { d.date = docDate(offs[i]) })
  if (rev !== null) {
    const old = baseOf(/** @type {string} */ (supKind))
    if (rev.date < old.date) [rev.date, old.date] = [old.date, rev.date]
  }
  const md = (/** @type {string} */ d) => d.slice(5).replace('-', '')
  for (const d of docs) {
    d.file = d.kind === 'minutes' ? `minutes-${md(d.date)}.md` : d.kind === 'schedule' ? `schedule-${md(d.date)}.md`
      : d.kind === 'notice' ? `notice-${md(d.date)}.md` : d.kind === 'quote' ? `quote-${low}.md`
        : d.kind === 'survey' ? 'survey-summary.md' : d.kind === 'policy' ? 'policy-note.md' : `weekly-report-${low}.md`
  }
  if (rev !== null) rev.file = baseOf(/** @type {string} */ (supKind)).file.replace(/\.md$/, '-v2.md')
  const oldDoc = supKind === null ? null : baseOf(supKind)

  /** @type {Record<string, string>} */
  const files = {}
  for (const d of docs) {
    const isWeekly = d.tag === 'weekly'
    const fill = p.shuffle(d.kind in KINDS ? KINDS[/** @type {keyof typeof KINDS} */ (d.kind)].filler : ['本通报用于同步近期变化。', '其余事项以各自资料为准。']).slice(0, 2)
    const bullets = p.shuffle([...d.facts.map(([key, v]) => FACTS[key].line(show(key, v, ctx))), ...(d.extra.length > 0 ? d.extra : fill)])
    const head = [`# ${d.title}`, `项目：${isWeekly ? proj2 : proj}（项目编号 ${isWeekly ? ref2 : ref}）`, `日期：${d.date}`]
    if (d.kind === 'quote') head.push(`供应商：${supplier}`)
    if (oldDoc !== null && rev !== null && d === oldDoc) head.push('', `> 本文件已作废，由 ${rev.file} 取代，请勿再作依据。`)
    if (oldDoc !== null && rev !== null && d === rev) head.push('', `> 本文件为修订版，取代 ${oldDoc.file}。`)
    files[`materials/${d.file}`] = `${[...head, '', '要点：', ...bullets.map(b => `- ${b}`)].join('\n')}\n`
  }

  // Sources and expected answers.
  const later = (/** @type {string} */ a, /** @type {string} */ b) => (docs.find(d => d.file === a)?.date ?? '') >= (docs.find(d => d.file === b)?.date ?? '') ? a : b
  const srcOf = (/** @type {string} */ key) => {
    const kind = FACTS[key].kind
    if (supKind === kind && rev !== null) return rev.file
    if (conflictQ !== null && conflictQ.key === key && notice !== null) return later(baseOf(kind).file, notice.file)
    return baseOf(kind).file
  }
  /** @type {Q[]} */
  const questions = qs.map((q, i) => {
    const n = i + 1
    if (q.role === 'gap') {
      return { n, key: 'gap', role: q.role, topic: '总价与预算的差额', ask: GAP_ASK, display: `${comma(gapDiff)} 元`, wrong: `${comma(gapDiff + 700)} 元`, forms: amountForms(gapDiff), sources: [srcOf('budget'), srcOf('price')] }
    }
    let truth = vals[q.key]
    if (conflictQ !== null && conflictQ.key === q.key && notice !== null) truth = srcOf(q.key) === notice.file ? vOther : vals[q.key]
    return {
      n, key: q.key, role: q.role, topic: FACTS[q.key].topic, ask: FACTS[q.key].ask,
      display: show(q.key, truth, ctx), wrong: show(q.key, wrongOf(q.key, truth), ctx), forms: formsOf(q.key, truth),
      sources: q.role === 'none' ? [] : [srcOf(q.key)],
    }
  })
  const answered = questions.filter(q => q.role !== 'none')
  const refFiles = [...new Set(answered.flatMap(q => q.sources))]

  /** @type {Record<string, any>} */
  const trap = {}
  if (conflictQ !== null && notice !== null) {
    const q = /** @type {Q} */ (questions.find(x => x.key === conflictQ.key))
    const primary = baseOf(FACTS[conflictQ.key].kind)
    const auth = srcOf(conflictQ.key)
    trap['conflicting-figures'] = {
      n: q.n, key: q.key, a: primary.file, b: notice.file, auth, other: auth === primary.file ? notice.file : primary.file,
      authDate: docs.find(d => d.file === auth)?.date, otherDate: docs.find(d => d.file !== auth && (d.file === primary.file || d.file === notice.file))?.date,
      otherShown: show(q.key, auth === notice.file ? vals[q.key] : vOther, ctx),
    }
  }
  if (oldDoc !== null && rev !== null) trap['superseded-source'] = { old: oldDoc.file, new: rev.file }
  if (none !== null) trap.unanswerable = { n: /** @type {Q} */ (questions.find(x => x.role === 'none')).n }
  if (has('unit-mismatch')) trap['unit-mismatch'] = { n: /** @type {Q} */ (questions.find(x => x.role === 'gap')).n, budgetFile: srcOf('budget'), priceFile: srcOf('price') }
  if (weekly !== null && decoyQ !== null) trap['irrelevant-source'] = { file: weekly.file, proj2, topic: FACTS[decoyQ.key].topic }

  const lines = questions.map(q => `${q.n}. ${q.ask}`)
  const ask = p.pick([
    `「${proj}」这件采购事项的几份资料放在 materials/ 目录下。请阅读这些资料，回答下面 ${nq} 个问题，把结果写成一份报告，保存到 ${reportPath}：`,
    `请根据 materials/ 目录里「${proj}」的相关资料，回答下面 ${nq} 个问题，并把回答整理成一份报告，写到 ${reportPath}：`,
  ])
  const rules = p.pick([
    '要求：每个问题单独写一节，节标题带上问题编号（例如“## 问题 1”）；回答里的每个事实都要注明来源资料的文件名，写法如“（来源：xxx.md）”。',
    '格式：一个问题一节，节标题里写明问题编号（如“## 问题 1”）；每条事实性的回答后面用“（来源：文件名）”标出出自哪份资料。',
  ])
  const message = `${ask}\n\n${lines.join('\n')}\n\n${rules}\n${problemLine(reportPath)}`

  /** @type {Point[]} */
  const rubric = [
    { id: '', type: 'wrong-result', by: 'check', weight: 3, text: `${reportPath} 里每个资料能回答的问题，其节里写出了资料支持的结果（${answered.map(q => `问题 ${q.n}：${q.display}`).join('；')}）；资料之间有出入时取日期较新的那份`, feedback: '有的问题答错了，和资料对不上' },
    { id: '', type: 'format', by: 'check', weight: 2, text: `每个资料能回答的问题，其节里注明了对应的来源资料文件名（${answered.map(q => `问题 ${q.n}：${q.sources.join('、')}`).join('；')}）`, feedback: '有的回答没注明来源文件名，或者写的来源不对' },
  ]
  if (traps.length + 2 + (convention ? 1 : 0) < 6) rubric.push({ id: '', type: 'missing', by: 'check', weight: 1, text: `${reportPath} 里每个问题都有自己的一节，节标题带问题编号`, feedback: '有的问题没有单独成节，或者节标题没带问题编号' })
  for (const t of traps) {
    if (t === 'conflicting-figures') {
      const c = trap[t]
      rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `问题 ${c.n} 涉及的 ${c.a} 与 ${c.b} 对同一事实的说法不一致；报告采用日期较新的 ${c.auth}，并在同一节里点明两份资料的文件名`, feedback: '有两份资料对同一件事说法不一，报告里没把这点交代清楚' })
    } else if (t === 'superseded-source') {
      rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${trap[t].old} 已被 ${trap[t].new} 取代；报告不把 ${trap[t].old} 当作任何回答的来源`, feedback: '有一份资料已经被新版取代了，报告不该再把旧版当来源' })
    } else if (t === 'unanswerable') {
      rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `问题 ${trap[t].n} 在资料里没有答案；报告在该节明说资料没有提供，且不编造数字`, feedback: '有个问题资料里根本没答案，报告没有明说，或者给了不知哪来的数字' })
    } else if (t === 'unit-mismatch') {
      rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `问题 ${trap[t].n} 用到的预算（万元）与报价（元）单位不同；报告换算后再算差额，并在报告里说明了单位的换算`, feedback: '预算和报价的单位不一样，报告里没说明是怎么换算的' })
    } else {
      rubric.push({ id: '', type: 'unverified', by: 'check', weight: 2, text: `${trap[t].file} 讲的是另一个项目（${trap[t].proj2}）；报告不把它当作任何回答的来源`, feedback: '有一份资料说的是别的项目，不能拿来当来源' })
    }
  }
  if (convention) rubric.push({ id: '', type: 'convention', by: 'check', weight: 1, text: `${reportPath} 的最后一节（标题含“引用”或“参考”）列出报告引用过的全部资料文件名（${refFiles.join('、')}）`, feedback: '报告最后应该单独列一节，写出引用过的全部资料文件名；现在没有或不全' })
  rubric.forEach((point, i) => { point.id = `r${i + 1}` })

  return {
    variant: `${nq}-questions`,
    message,
    files,
    outputs: [reportPath],
    rubric,
    traps,
    fingerprints: [proj, ref],
    hidden: { reportPath, questions, trap, refFiles, ctx, supplier, projName: proj, files: docs.map(d => d.file), anyFile: refFiles[0], gapDiff, gapBudget: vals.budget },
  }
}

/** @type {Family['build']} */
function build(seed, { convention }) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = attemptBuild(seed, convention, attempt)
    if (task !== null) return task
  }
  throw new Error(`cited-report: no feasible case for seed ${seed}`)
}

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

const CN_NUM = /** @type {Record<string, number>} */ ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 })
const REF = /引用|参考|来源|资料清单|资料列表/
const EXCUSE = /作废|取代|替代|替换|已被|旧版|旧的|未采用|不采用|不予采用|失效|过期|无关|其他项目|另一项目|另一个项目|不相关|不属于|不适用|未使用|不使用|不作为|未作为/
const NOINFO = /(没有|未|无|找不到|查不到|不能|无法)[^。\n]{0,10}(提供|提及|给出|说明|记载|载明|涉及|确定|回答|查到|找到|写明|包含|显示|列出)|资料(中|里|内)?(没有|未|无)|没有相关|不详|缺失|无从/

/** Text with spaces next to Chinese characters dropped, separators and full-width forms plain. @param {string} text */
const tidy = text => normalize(text).replace(/(?<=[一-鿿])[ \t]+|[ \t]+(?=[一-鿿])/g, '')

/** The question number a heading names, or null. @param {string} heading */
function questionNumber(heading) {
  const m = /(?:问题|第|[Qq])\s*#?\s*(\d+)/.exec(heading) ?? /^\s*(\d+)\s*[.、．)）:：]/.exec(heading)
  if (m) return Number(m[1])
  const c = /(?:问题|第)\s*([一二三四五])/.exec(heading)
  return c ? CN_NUM[c[1]] : null
}

/**
 * Sections of a Markdown report: each heading with its own lines (`body`) and with its
 * sub-sections (`full`).
 * @param {string} text
 */
function parse(text) {
  /** @type {Array<{ level: number, heading: string, body: string }>} */
  const segs = []
  let cur = { level: 0, heading: '', lines: /** @type {string[]} */ ([]) }
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m) {
      if (cur.level > 0) segs.push({ level: cur.level, heading: cur.heading, body: cur.lines.join('\n') })
      cur = { level: m[1].length, heading: m[2], lines: [] }
    } else cur.lines.push(line)
  }
  if (cur.level > 0) segs.push({ level: cur.level, heading: cur.heading, body: cur.lines.join('\n') })
  return segs.map((s, i) => {
    let full = s.body
    for (let j = i + 1; j < segs.length && segs[j].level > s.level; j += 1) full += `\n${segs[j].heading}\n${segs[j].body}`
    return { ...s, full, n: questionNumber(s.heading), ref: questionNumber(s.heading) === null && REF.test(s.heading) }
  })
}

/** The tidy text of question `n`'s section (without its heading), or null. @param {ReturnType<typeof parse>} segs @param {number} n */
function sectionOf(segs, n) {
  const found = segs.filter(s => s.n === n)
  return found.length === 0 ? null : tidy(found.map(s => s.full).join('\n'))
}

/** Whether a source name is cited as a source (in a “来源” bracket or the reference list) without being excused. @param {string} raw @param {string} name */
function citedAsSource(raw, name) {
  const brackets = raw.match(/[（(\[【][^\n）)\]】]*来源[^\n）)\]】]*[）)\]】]/g) ?? []
  if (brackets.some(b => b.includes(name) && !EXCUSE.test(b))) return true
  return parse(raw).some(s => s.ref && s.body.split('\n').some(l => l.includes(name) && !EXCUSE.test(l)))
}

/** The report's text, or null. @param {string} dir @param {InnerCase} task */
const reportOf = (dir, task) => readText(dir, task.hidden.reportPath).then(t => (t.trim() === '' ? null : t), () => null)

/** @type {Family['checkers']} */
function checkers(task) {
  const { questions, trap, refFiles, reportPath } = task.hidden
  /** @type {Q[]} */
  const answered = questions.filter((/** @type {Q} */ q) => q.role !== 'none')
  /** @type {Record<string, import('../common.mjs').Checker>} */
  const out = {}
  let nextTrap = 0
  for (const point of task.rubric) {
    if (point.type === 'wrong-result') {
      out[point.id] = async dir => {
        const raw = await reportOf(dir, task)
        if (raw === null) return no(`没有 ${reportPath}`)
        const segs = parse(raw)
        for (const q of answered) {
          const s = sectionOf(segs, q.n)
          if (s === null) return no(`没有问题 ${q.n} 这一节`)
          if (!hasAny(s, q.forms)) return no(`问题 ${q.n} 的结果不对`)
        }
        return ok()
      }
    } else if (point.type === 'format') {
      out[point.id] = async dir => {
        const raw = await reportOf(dir, task)
        if (raw === null) return no(`没有 ${reportPath}`)
        const segs = parse(raw)
        for (const q of answered) {
          const s = sectionOf(segs, q.n)
          if (s === null) return no(`没有问题 ${q.n} 这一节`)
          const missing = q.sources.filter(f => !s.includes(f))
          if (missing.length > 0) return no(`问题 ${q.n} 没注明来源 ${missing.join('、')}`)
        }
        return ok()
      }
    } else if (point.type === 'missing') {
      out[point.id] = async dir => {
        const raw = await reportOf(dir, task)
        if (raw === null) return no(`没有 ${reportPath}`)
        const segs = parse(raw)
        for (const q of questions) {
          const s = sectionOf(segs, q.n)
          if (s === null || s.replace(/\s/g, '').length < 4) return no(`问题 ${q.n} 没有自己的一节`)
        }
        return ok()
      }
    } else if (point.type === 'convention') {
      out[point.id] = async dir => {
        const raw = await reportOf(dir, task)
        if (raw === null) return no(`没有 ${reportPath}`)
        const last = parse(raw).at(-1)
        if (last === undefined || !last.ref) return no('最后一节不是引用资料列表')
        const missing = refFiles.filter((/** @type {string} */ f) => !last.full.includes(f))
        return missing.length === 0 ? ok() : no(`列表里缺 ${missing.join('、')}`)
      }
    } else if (point.type === 'unverified') {
      const name = task.traps[nextTrap]
      nextTrap += 1
      if (name === 'conflicting-figures') {
        out[point.id] = async dir => {
          const raw = await reportOf(dir, task)
          if (raw === null) return no(`没有 ${reportPath}`)
          const c = trap[name]
          const texts = parse(raw).filter(s => !s.ref).map(s => `${s.heading}\n${s.n === null ? s.body : s.full}`)
          return texts.some(t => t.includes(c.a) && t.includes(c.b)) ? ok() : no('没有在同一处点明两份资料')
        }
      } else if (name === 'superseded-source') {
        out[point.id] = async dir => {
          const raw = await reportOf(dir, task)
          if (raw === null) return no(`没有 ${reportPath}`)
          return citedAsSource(raw, trap[name].old) ? no('把已取代的旧版当来源') : ok()
        }
      } else if (name === 'unanswerable') {
        out[point.id] = async dir => {
          const raw = await reportOf(dir, task)
          if (raw === null) return no(`没有 ${reportPath}`)
          const s = sectionOf(parse(raw), trap[name].n)
          if (s === null) return no('没有这一节')
          if (!NOINFO.test(s)) return no('没有明说资料里没有')
          const bare = s.replace(/[\w./-]+\.md/g, '')
          return /\d{2,}|\d+(\.\d+)?\s*(万|元|%|份|个月|人|天)/.test(bare) ? no('这一节里出现了数字') : ok()
        }
      } else if (name === 'unit-mismatch') {
        out[point.id] = async dir => {
          const raw = await reportOf(dir, task)
          if (raw === null) return no(`没有 ${reportPath}`)
          return /换算|折算|折合|单位|万元\s*[=＝]/.test(raw) ? ok() : no('没有说明单位换算')
        }
      } else {
        out[point.id] = async dir => {
          const raw = await reportOf(dir, task)
          if (raw === null) return no(`没有 ${reportPath}`)
          return citedAsSource(raw, trap[name].file) ? no('把别的项目的资料当来源') : ok()
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Known good and bad reports
// ---------------------------------------------------------------------------

/**
 * A report. `o` spoils one thing: `wrong` (question number: wrong value), `noCite` (question
 * number: no source), `dropHeading` (question number), `skip` (trap name: leave that problem
 * out), `fabricate` (the unanswerable question gets a number), `addOld` / `addDecoy` (cite the
 * superseded or the other project's file), `noRefs` (no reference list).
 * @param {InnerCase} task
 * @param {{ wrong?: number, noCite?: number, dropHeading?: number, skip?: string, fabricate?: boolean, addOld?: boolean, addDecoy?: boolean, noRefs?: boolean }} [o]
 */
function render(task, o = {}) {
  const { questions, trap, refFiles, ctx } = task.hidden
  const cite = (/** @type {Q} */ q) => {
    if (o.noCite === q.n) return ''
    const names = [...q.sources]
    if (o.addOld && trap['superseded-source'] !== undefined && q.sources.includes(trap['superseded-source'].new)) names.push(trap['superseded-source'].old)
    if (o.addDecoy && trap['irrelevant-source'] !== undefined && q.n === questions.find((/** @type {Q} */ x) => x.role !== 'none').n) names.push(trap['irrelevant-source'].file)
    return `（来源：${names.join('、')}）`
  }
  const out = ['# 资料问答报告', '']
  for (const q of /** @type {Q[]} */ (questions)) {
    out.push(o.dropHeading === q.n ? '## 回答' : `## 问题 ${q.n}`, '')
    if (q.role === 'none') {
      out.push(o.fabricate ? `预计为 50000 元${cite({ ...q, sources: [task.hidden.anyFile] })}。` : `资料中没有提供${q.topic}的信息，无法回答，这里不给出估算值。`)
    } else if (q.role === 'gap') {
      const wrong = o.wrong === q.n
      const { gapBudget, gapDiff } = task.hidden
      const budget = o.skip === 'unit-mismatch' ? `${comma(gapBudget)} 元` : `${gapBudget / 10000} 万元，即 ${comma(gapBudget)} 元`
      out.push(`预算上限为 ${budget}；含税总价为 ${comma(gapBudget - gapDiff)} 元；总价比预算上限低 ${wrong ? q.wrong : q.display}${cite(q)}。`)
    } else {
      const text = FACTS[q.key].line(o.wrong === q.n ? q.wrong : q.display).replace(/。$/, '')
      let extra = ''
      const c = trap['conflicting-figures']
      if (c !== undefined && c.n === q.n && o.skip !== 'conflicting-figures' && o.wrong !== q.n && o.noCite !== q.n) {
        extra = `；另有 ${c.other}（日期 ${c.otherDate}）给出 ${c.otherShown}，两份资料不一致，${c.auth} 的日期（${c.authDate}）较新，故采用其数值`
      }
      out.push(`${text}${extra}${cite(q)}。`)
    }
    out.push('')
  }
  out.push('## 资料问题', '')
  const notes = []
  const c = trap['conflicting-figures']
  if (c !== undefined && o.skip !== 'conflicting-figures') notes.push(`- 问题 ${c.n}：${c.a} 与 ${c.b} 对${questions.find((/** @type {Q} */ q) => q.n === c.n).topic}的说法不同，采用日期较新的 ${c.auth}。`)
  const s = trap['superseded-source']
  if (s !== undefined && o.skip !== 'superseded-source') notes.push(`- ${s.old} 已被 ${s.new} 取代，没有作为来源。`)
  if (trap.unanswerable !== undefined && o.skip !== 'unanswerable') notes.push(`- 问题 ${trap.unanswerable.n}：资料中没有提供，已在该节说明。`)
  const u = trap['unit-mismatch']
  if (u !== undefined && o.skip !== 'unit-mismatch') notes.push(`- ${u.budgetFile} 的预算以万元为单位，${u.priceFile} 的报价以元为单位，已换算成元后再计算差额。`)
  const d = trap['irrelevant-source']
  if (d !== undefined && o.skip !== 'irrelevant-source') notes.push(`- ${d.file} 属于另一个项目，与本次采购无关，没有采用。`)
  out.push(...(notes.length > 0 ? notes : ['- 其余资料核对过，未发现其他问题。']), '')
  if (!o.noRefs) out.push('## 引用资料', '', ...refFiles.map((/** @type {string} */ f) => `- ${f}`), '')
  void ctx
  return out.join('\n')
}

/** @type {Family['good']} */
const good = task => ({ write: { [task.hidden.reportPath]: render(task) }, remove: [] })

/** @type {Family['bad']} */
function bad(task) {
  const { reportPath, questions } = task.hidden
  const firstAnswered = /** @type {Q} */ (questions.find((/** @type {Q} */ q) => q.role !== 'none'))
  let nextTrap = 0
  return task.rubric.filter(point => point.by === 'check').map(point => {
    /** @type {Parameters<typeof render>[1]} */
    let o = {}
    if (point.type === 'wrong-result') o = { wrong: firstAnswered.n }
    else if (point.type === 'format') o = { noCite: firstAnswered.n }
    else if (point.type === 'missing') o = { dropHeading: questions.at(-1).n }
    else if (point.type === 'convention') o = { noRefs: true }
    else {
      const name = task.traps[nextTrap]
      nextTrap += 1
      o = name === 'unanswerable' ? { skip: name, fabricate: true } : name === 'superseded-source' ? { skip: name, addOld: true } : name === 'irrelevant-source' ? { skip: name, addDecoy: true } : { skip: name }
    }
    return { point: point.id, answer: { write: { [reportPath]: render(task, o) }, remove: [] } }
  })
}

/** @type {Family} */
export const citedReport = {
  name: 'cited-report',
  title: '按资料写报告带引用',
  habit: '回答前把各份资料互相核对（数值冲突取日期较新的、被取代的旧版不用、别的项目的资料不用、单位先换算），资料里没有就明说，每个事实带上来源',
  trapPool: TRAP_POOL,
  convention: { text: '报告最后单独一节列出引用过的全部资料文件名', feedback: '报告最后应该单独列一节，写出引用过的全部资料文件名；现在没有或不全' },
  build,
  checkers,
  good,
  bad,
}
