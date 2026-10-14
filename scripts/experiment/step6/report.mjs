#!/usr/bin/env node
// @ts-check
/**
 * Step-6 report generator (docs/plan/step-6-work-partition.md §测量 "可复现"): turns
 * one raw-records file into the Markdown report. The same records give the same bytes
 * (no clock, no unordered iteration, a seeded bootstrap); every number in the report
 * is computed from, and points back to, the records.
 *
 *   node scripts/experiment/step6/report.mjs --records <raw.json> --out <report.md>
 *
 * Raw records (written by the experiment runner):
 *   {
 *     manifest: { experimentId, epochId, model, thinking, effort?, planVersion?,
 *                 improvers?: { parent?, child? }, capabilities?: { base?, parent?, child? },
 *                 origins?: { <family>: string }, decisions?: { <family>: string } },
 *     runs:  [{ runId, family, caseId, arm: base|parent|child, repeat, pass: true|false|null,
 *               costUsd?, componentsUsed?: string[] }],          // holdout runs only
 *     costs: [{ kind, family?, usd, ref }],                      // everything else that cost money
 *     disagreements?: [{ family?, ref, note }],                  // feedback check vs hidden judge
 *     notes?: string[]
 *   }
 * `costs[].kind` ∈ history | dev | improvement | meta | comparison | calibration | other.
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { amortize, armCost, ARMS, pairedDiff, spread } from './stats.mjs'

/** Costs of improving itself (counted into amortization). */
export const INVESTMENT_KINDS = ['improvement', 'meta', 'comparison']

const VERDICT_TEXT = {
  positive: '正',
  zero: '零（样本内看不出差别）',
  negative: '负',
  insufficient: '缺测（没有可配对的用例）',
}

const pts = (/** @type {number | null} */ x) => (x === null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`)
const usd = (/** @type {number | null} */ x) => (x === null ? '—' : x.toFixed(3))
const cell = (/** @type {unknown} */ x) => String(x ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')

/**
 * Validate raw records; returns problems (empty when usable).
 * @param {any} raw
 */
export function validateRecords(raw) {
  const problems = []
  if (typeof raw?.manifest?.experimentId !== 'string') problems.push('manifest.experimentId is missing')
  if (!Array.isArray(raw?.runs)) problems.push('runs is not an array')
  if (!Array.isArray(raw?.costs)) problems.push('costs is not an array')
  for (const [index, run] of (Array.isArray(raw?.runs) ? raw.runs : []).entries()) {
    if (typeof run?.runId !== 'string' || typeof run?.caseId !== 'string' || typeof run?.family !== 'string') problems.push(`runs[${index}]: runId, caseId and family must be strings`)
    if (!ARMS.includes(run?.arm)) problems.push(`runs[${index}]: arm ${JSON.stringify(run?.arm)} is not base, parent or child`)
    if (run?.pass !== true && run?.pass !== false && run?.pass !== null) problems.push(`runs[${index}]: pass must be true, false or null (unknown)`)
  }
  const ids = (Array.isArray(raw?.runs) ? raw.runs : []).map((/** @type {any} */ run) => run?.runId)
  for (const id of new Set(ids)) if (ids.filter((/** @type {any} */ x) => x === id).length > 1) problems.push(`runId ${id} appears more than once`)
  for (const [index, cost] of (Array.isArray(raw?.costs) ? raw.costs : []).entries()) {
    if (typeof cost?.usd !== 'number' || !Number.isFinite(cost.usd)) problems.push(`costs[${index}]: usd is not a number`)
  }
  return problems
}

/**
 * The report text.
 * @param {any} raw
 * @param {{ iterations?: number, seed?: string }} [options]
 */
export function buildReport(raw, { iterations = 10_000, seed = 'step6-bootstrap' } = {}) {
  const problems = validateRecords(raw)
  if (problems.length > 0) throw new Error(`raw records are not usable:\n- ${problems.join('\n- ')}`)
  /** @type {import('./stats.mjs').RunRecord[]} */
  const runs = raw.runs
  /** @type {Array<{ kind: string, family?: string, usd: number, ref: string }>} */
  const costs = raw.costs
  const families = [...new Set(runs.map(run => run.family))].sort()
  const m = raw.manifest
  const out = []
  out.push(`# 步骤 6 收益报告：${m.experimentId}`, '')
  out.push('本报告由 `scripts/experiment/step6/report.mjs` 从原始记录生成；同一份原始记录重跑得到逐字节相同的报告。模型输出本身不可复现，重复之间的波动见“每用例明细”。', '')

  out.push('## 实验清单', '', '| 项 | 值 |', '| --- | --- |')
  const manifestRows = [
    ['实验 id', m.experimentId], ['纪元 id', m.epochId], ['模型', m.model], ['thinking', m.thinking], ['effort', m.effort],
    ['用例计划版本', m.planVersion],
    ['改进器（父）', m.improvers?.parent], ['改进器（子）', m.improvers?.child],
    ['能力版本（base）', m.capabilities?.base], ['能力版本（parent）', m.capabilities?.parent], ['能力版本（child）', m.capabilities?.child],
    ...Object.keys(m.origins ?? {}).sort().map(family => [`父子比较起点（${family}）`, m.origins[family]]),
    ...Object.keys(m.decisions ?? {}).sort().map(family => [`父子比较结论（${family}）`, m.decisions[family]]),
    ['holdout 运行数', runs.length], ['自助法重抽次数', iterations], ['自助法种子', seed],
  ]
  for (const [key, value] of manifestRows) out.push(`| ${key} | ${cell(value)} |`)
  out.push('')

  out.push('## 结论', '', '主指标：隐藏判定通过率（百分点）。按 holdout 用例配对；95% 区间用两层自助法（先抽用例，再在用例内抽重复）。区间下限 > 0 记“正”，上限 < 0 记“负”，否则记“零”。', '')
  out.push('| 范围 | 比较 | 用例数 | 均值差 | 95% 区间 | 结论 |', '| --- | --- | --- | --- | --- | --- |')
  /** @type {Record<string, ReturnType<typeof pairedDiff>>} */
  const diffs = {}
  for (const scope of [...families, null]) {
    for (const [treatment, control] of /** @type {const} */ ([['child', 'parent'], ['parent', 'base'], ['child', 'base']])) {
      const result = pairedDiff(runs, { treatment, control, family: scope ?? undefined, iterations, seed })
      diffs[`${scope ?? 'all'}:${treatment}-${control}`] = result
      const ci = result.ci === null ? '—' : `[${pts(result.ci[0])}, ${pts(result.ci[1])}]`
      out.push(`| ${scope ?? '两族合并'} | ${treatment} − ${control} | ${result.n} | ${pts(result.mean)} | ${ci} | ${VERDICT_TEXT[result.verdict]} |`)
    }
  }
  out.push('')
  const headline = diffs['all:child-parent']
  out.push(headline.verdict === 'positive'
    ? `子改进器相对父改进器：正（均值 ${pts(headline.mean)} 个百分点）。`
    : headline.verdict === 'negative'
      ? `子改进器相对父改进器：负（均值 ${pts(headline.mean)} 个百分点）。`
      : headline.verdict === 'zero'
        ? `子改进器相对父改进器：零，样本内看不出差别（均值 ${pts(headline.mean)} 个百分点，区间跨过 0）。没有可确认的收益。`
        : '子改进器相对父改进器：缺测，没有可配对的用例。', '')

  out.push('## 每用例明细', '', '每格为“通过 / 已知结果数”，未知结果另计（未知不算通过）。', '')
  out.push('| 用例 | base | parent | child | 运行 id |', '| --- | --- | --- | --- | --- |')
  for (const caseId of [...new Set(runs.map(run => run.caseId))].sort()) {
    const cells = ARMS.map(arm => {
      const s = spread(runs, caseId, arm)
      return s.known + s.unknown === 0 ? '—' : `${s.passes}/${s.known}${s.unknown > 0 ? `（未知 ${s.unknown}）` : ''}`
    })
    const ids = ARMS.flatMap(arm => spread(runs, caseId, arm).runIds)
    out.push(`| ${cell(caseId)} | ${cells.join(' | ')} | ${cell(ids.join(', '))} |`)
  }
  out.push('')

  if (runs.some((/** @type {any} */ run) => run.followUp !== undefined)) {
    out.push('## 追问成果', '', '任务回合没交成果时，编排在同一会话里追问一次；按臂计数。', '', '| 臂 | 运行数 | 追问次数 |', '| --- | --- | --- |')
    for (const arm of ARMS) {
      const mine = runs.filter(run => run.arm === arm)
      if (mine.length > 0) out.push(`| ${arm} | ${mine.length} | ${mine.filter((/** @type {any} */ run) => run.followUp === true).length} |`)
    }
    out.push('')
  }

  out.push('## 费用', '', '所有金额为估算美元（含缓存读写），不是账单。', '', '### holdout 每次运行的平均费用', '')
  out.push('| 任务族 | 臂 | 运行数 | 有费用的 | 平均 | 合计 |', '| --- | --- | --- | --- | --- | --- |')
  for (const family of families) {
    for (const arm of ARMS) {
      const c = armCost(runs, arm, family)
      if (c.runs > 0) out.push(`| ${family} | ${arm} | ${c.runs} | ${c.priced} | ${usd(c.meanUsd)} | ${usd(c.totalUsd)} |`)
    }
  }
  out.push('', '### 其他费用（按类别）', '')
  out.push('| 任务族 | 类别 | 次数 | 合计 | 记录 |', '| --- | --- | --- | --- | --- |')
  const groups = new Map()
  for (const cost of costs) {
    const key = `${cost.family ?? '—'}\0${cost.kind}`
    const g = groups.get(key) ?? { family: cost.family ?? '—', kind: cost.kind, n: 0, usd: 0, refs: [] }
    g.n += 1
    g.usd += cost.usd
    g.refs.push(cost.ref)
    groups.set(key, g)
  }
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)
    out.push(`| ${cell(g.family)} | ${cell(g.kind)} | ${g.n} | ${usd(Math.round(g.usd * 1e6) / 1e6)} | ${cell(g.refs.sort().join(', '))} |`)
  }
  const holdoutTotal = ARMS.reduce((sum, arm) => sum + armCost(runs, arm).totalUsd, 0)
  const otherTotal = costs.reduce((sum, cost) => sum + cost.usd, 0)
  out.push('', `实验总费用：${usd(Math.round((holdoutTotal + otherTotal) * 1e6) / 1e6)} 美元（holdout ${usd(Math.round(holdoutTotal * 1e6) / 1e6)}，其他 ${usd(Math.round(otherTotal * 1e6) / 1e6)}）。`, '')

  out.push('## 摊薄', '', '投入 = 改进作业 + 元改进作业 + 父子比较的费用（`improvement`、`meta`、`comparison`）。parent 只计 `improvement`。', '')
  out.push('| 任务族 | 臂 | 投入 | 每次省 | 几次任务省回 | 每提高 1 个百分点 |', '| --- | --- | --- | --- | --- | --- |')
  for (const family of families) {
    const base = armCost(runs, 'base', family).meanUsd
    for (const arm of /** @type {const} */ (['parent', 'child'])) {
      const kinds = arm === 'parent' ? ['improvement'] : INVESTMENT_KINDS
      const investment = costs.filter(cost => cost.family === family && kinds.includes(cost.kind)).reduce((sum, cost) => sum + cost.usd, 0)
      const gain = diffs[`${family}:${arm}-base`]?.mean ?? null
      const a = amortize({ investmentUsd: investment, baseCostPerTask: base, treatedCostPerTask: armCost(runs, arm, family).meanUsd, gainPoints: gain })
      if (a.investmentUsd === 0) {
        out.push(`| ${family} | ${arm} | 没有投入记录 | ${usd(a.savingsPerTaskUsd)} | — | — |`)
        continue
      }
      out.push(`| ${family} | ${arm} | ${usd(a.investmentUsd)} | ${usd(a.savingsPerTaskUsd)} | ${a.tasksToBreakEven ?? '省不回（每次不省钱）'} | ${a.usdPerPoint === null ? '没有质量提高' : usd(a.usdPerPoint)} |`)
    }
  }
  out.push('')

  out.push('## 能力激活证据', '', '每臂 holdout 运行中加载并调用过组件的次数（`componentsUsed` 非空）。', '')
  out.push('| 任务族 | 臂 | 运行数 | 用到组件的 | 组件 |', '| --- | --- | --- | --- | --- |')
  for (const family of families) {
    for (const arm of ARMS) {
      const mine = runs.filter(run => run.family === family && run.arm === arm)
      if (mine.length === 0) continue
      const used = mine.filter(run => (run.componentsUsed ?? []).length > 0)
      const names = [...new Set(used.flatMap(run => run.componentsUsed ?? []))].sort()
      out.push(`| ${family} | ${arm} | ${mine.length} | ${used.length} | ${cell(names.join(', ') || '—')} |`)
    }
  }
  out.push('')

  const disagreements = Array.isArray(raw.disagreements) ? raw.disagreements : []
  out.push('## 反馈检查与隐藏判定不一致', '', `共 ${disagreements.length} 次。`, '')
  for (const d of [...disagreements].sort((a, b) => String(a.ref).localeCompare(String(b.ref)))) out.push(`- ${cell(d.family)}：${cell(d.ref)}：${cell(d.note)}`)
  if (disagreements.length > 0) out.push('')

  out.push('## 失败与缺测', '')
  const unknown = runs.filter(run => run.pass === null).map(run => run.runId).sort()
  const failed = runs.filter(run => run.pass === false).length
  out.push(`- 隐藏判定未通过：${failed} 次。`)
  out.push(`- 结果未知（不算通过）：${unknown.length} 次${unknown.length > 0 ? `：${unknown.join(', ')}` : ''}。`)
  const missing = new Set()
  for (const result of Object.values(diffs)) for (const item of result.missing) missing.add(`${item.caseId}（${item.arm}）`)
  out.push(`- 缺少某臂已知结果的用例：${missing.size === 0 ? '无' : [...missing].sort().join('、')}。`)
  const thin = []
  for (const caseId of [...new Set(runs.map(run => run.caseId))].sort()) {
    for (const arm of ARMS) {
      const s = spread(runs, caseId, arm)
      if (s.known + s.unknown > 0 && s.known < 3) thin.push(`${caseId}（${arm}，已知 ${s.known} 次）`)
    }
  }
  out.push(`- 已知结果少于 3 次的用例与臂：${thin.length === 0 ? '无' : thin.join('、')}。`, '')

  const notes = Array.isArray(raw.notes) ? raw.notes : []
  if (notes.length > 0) {
    out.push('## 备注', '')
    for (const note of notes) out.push(`- ${cell(note)}`)
    out.push('')
  }
  return `${out.join('\n')}`
}

/** @param {string[]} argv */
async function main(argv) {
  const arg = (/** @type {string} */ name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const records = arg('--records')
  const out = arg('--out')
  if (records === undefined || out === undefined) {
    process.stderr.write('usage: report.mjs --records <raw.json> --out <report.md> [--iterations N]\n')
    return 2
  }
  const raw = JSON.parse(await readFile(records, 'utf8'))
  const iterations = arg('--iterations') === undefined ? undefined : Number(arg('--iterations'))
  await writeFile(out, buildReport(raw, { iterations }))
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
