#!/usr/bin/env node
// @ts-check
/**
 * The rework measurement report: raw.json → Markdown, the same bytes for the same records
 * (no clock, no randomness beyond the seeded bootstrap already in the records).
 *
 *   node scripts/experiment/rework/report.mjs --records <raw.json> --out <report.md>
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { CRITERIA } from './stats.mjs'

const VERDICT = /** @type {Record<string, string>} */ ({ positive: '正', zero: '零', negative: '负', insufficient: '不足', met: '满足', 'not-met': '不满足', 'not-run': '没跑' })
const STATUS = /** @type {Record<string, string>} */ ({ ran: '已跑', unavailable: '不可用', 'stand-in': '演练替身' })

const num = (/** @type {number | null | undefined} */ x, digits = 1) => (x === null || x === undefined ? '—' : x.toFixed(digits))
const pct = (/** @type {number | null | undefined} */ x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)
const ci = (/** @type {[number, number] | null} */ c) => (c === null ? '—' : `[${c[0].toFixed(1)}, ${c[1].toFixed(1)}]`)
const cell = (/** @type {unknown} */ v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** @param {string[]} header @param {Array<Array<unknown>>} rows */
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n')

/** @param {any[]} runs @param {string} arm @param {string} [family] */
function armSummary(runs, arm, family) {
  const mine = runs.filter(r => r.arm === arm && (family === undefined || r.family === family))
  const known = mine.filter(r => r.score !== null)
  const costs = mine.map(r => r.costUsd).filter(c => typeof c === 'number')
  return {
    runs: mine.length,
    unknown: mine.length - known.length,
    score: known.length === 0 ? null : (known.reduce((s, r) => s + r.score, 0) / known.length) * 100,
    whole: known.length === 0 ? null : known.filter(r => r.pass).length / known.length,
    followUps: mine.filter(r => r.followUp).length,
    cost: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0),
  }
}

/**
 * The report text.
 * @param {any} records raw.json
 */
export function buildReport(records) {
  const lines = []
  const scripted = records.backend === 'scripted'
  lines.push(`# 重做收益测量报告（${records.profile}）`, '')
  lines.push(`- 实验：${records.experiment}，配置 \`${records.profile}\`，后端 ${records.backend}（${records.model}）`)
  lines.push(`- 计划文件 SHA-256：${records.planSha256 ?? '（计划未冻结或与生成器不一致）'}`)
  if (scripted) lines.push('- **这是脚本化演练**：模型的回答是写死的，各臂的高低由脚本决定，不说明任何真实效果。')
  if (Object.values(records.arms ?? {}).some((/** @type {any} */ a) => a.standIn)) lines.push('- 标为“演练替身”的臂用的是固定文字，不是学到的内容；它们不进入任何比较。')
  if (records.stopped !== null) lines.push(`- **停在** ${records.stopped.step}：${records.stopped.reason}`)
  if (records.error !== null) lines.push(`- **出错** 在 ${records.error.step}（详见 observations.json）`)
  lines.push('')

  lines.push('## 判定器', '')
  if (records.judges === null) lines.push('没有运行。')
  else lines.push(`${records.judges.samples} 个好坏样本，${records.judges.pass ? '全部判对' : `${records.judges.failed.length} 个判错`}。`)
  for (const f of records.judges?.failed ?? []) lines.push(`- ${f.caseId} ${f.sample}：${f.detail}`)
  lines.push('')

  lines.push('## 训练流', '')
  if (records.stream === null) lines.push('没有运行。')
  else {
    const tasks = records.stream.tasks
    const known = tasks.filter((/** @type {any} */ t) => t.score !== null)
    lines.push(`- ${tasks.length} 题，学习${records.stream.learning ? '开' : '关'}；平均得分 ${known.length === 0 ? '—' : num((known.reduce((/** @type {number} */ s, /** @type {any} */ t) => s + t.score, 0) / known.length) * 100)}；追问成果 ${tasks.filter((/** @type {any} */ t) => t.followUp).length} 次`)
    lines.push(`- 反馈 ${tasks.reduce((/** @type {number} */ s, /** @type {any} */ t) => s + t.feedback.length, 0)} 条，其中计数 ${tasks.reduce((/** @type {number} */ s, /** @type {any} */ t) => s + t.feedback.filter((/** @type {any} */ e) => e.counted).length, 0)} 条`)
    if (records.notes !== null) lines.push(`- 笔记策略：${records.notes.entries} 条计数反馈，保留 ${records.notes.kept}，去掉 ${records.notes.dropped}`)
  }
  lines.push('')

  lines.push('## 留出隔离', '')
  if (records.isolation === null) lines.push('没有运行。')
  else lines.push(`扫描 ${records.isolation.scanned} 个文件（跳过 ${records.isolation.skipped} 个二进制或过大的），泄漏 ${records.isolation.leaks.length} 处。`)
  for (const leak of records.isolation?.leaks ?? []) lines.push(`- ${leak.caseId}：${leak.file}（${leak.fingerprint}）`)
  lines.push('')

  lines.push('## 各臂', '')
  const arms = Object.keys(records.arms ?? {})
  lines.push(table(['臂', '状态', '运行', '未知', '平均得分', '整题通过', '追问', '费用（美元）'], arms.map(arm => {
    const s = armSummary(records.runs, arm)
    const a = records.arms[arm]
    return [arm, STATUS[a.status] ?? a.status, s.runs, s.unknown, num(s.score), pct(s.whole), s.followUps, num(s.cost, 4)]
  })))
  for (const arm of arms.filter(a => records.arms[a].status === 'unavailable')) lines.push('', `- ${arm}：${records.arms[arm].reason}`)
  const families = [...new Set(records.runs.map((/** @type {any} */ r) => r.family))].sort()
  if (families.length > 1) {
    lines.push('', '按留出题族的平均得分：', '')
    lines.push(table(['臂', ...families], arms.map(arm => [arm, ...families.map(f => num(armSummary(records.runs, arm, f).score))])))
  }
  lines.push('')

  lines.push('## 判据（ADR 0019 第 8 条，开跑前冻结）', '')
  const c = records.criteria
  lines.push(table(['判据', '内容', '结论'], [
    ['1', CRITERIA[1], VERDICT[c[1]] ?? c[1]],
    ['2', CRITERIA[2], VERDICT[c[2]] ?? c[2]],
    ['3', CRITERIA[3], VERDICT[c[3]] ?? c[3]],
    ['4', CRITERIA[4], `${VERDICT[c[4]] ?? c[4]}${c.costOptimized === null ? '' : `；cost-optimized ${c.costOptimized} 次，不计入`}`],
    ['5', CRITERIA[5], c[5].length === 0 ? '没有变差的类别' : `${c[5].length} 处，见下`],
  ]))
  lines.push('')

  lines.push('## 比较（按题配对，两层自助法 95% 区间，单位：分）', '')
  if (records.comparisons.length === 0) lines.push('没有两臂都有运行的比较。')
  else {
    lines.push(table(['比较', '判据', '题数', '均值差', '95% 区间', '结论'], records.comparisons.map((/** @type {any} */ x) => [`${x.treatment} − ${x.control}`, x.criterion ?? '—', x.pooled.n, num(x.pooled.mean), ci(x.pooled.ci), VERDICT[x.pooled.verdict]])))
    lines.push('', '按留出题族：', '')
    lines.push(table(['比较', '题族', '题数', '均值差', '95% 区间', '结论'], records.comparisons.flatMap((/** @type {any} */ x) => x.byFamily.map((/** @type {any} */ d) => [`${x.treatment} − ${x.control}`, d.family, d.n, num(d.mean), ci(d.ci), VERDICT[d.verdict]]))))
    lines.push('', '按要点类型：', '')
    lines.push(table(['比较', '要点类型', '题数', '均值差', '95% 区间', '结论'], records.comparisons.flatMap((/** @type {any} */ x) => x.byPointType.map((/** @type {any} */ d) => [`${x.treatment} − ${x.control}`, d.pointType, d.n, num(d.mean), ci(d.ci), VERDICT[d.verdict]]))))
  }
  lines.push('')

  lines.push('## 变差的类别', '')
  if (c[5].length === 0) lines.push('没有。')
  else lines.push(table(['比较', '题族', '要点类型', '均值差', '结论'], c[5].map((/** @type {any} */ w) => [w.comparison, w.family ?? '全部', w.pointType ?? '全部', num(w.mean), VERDICT[w.verdict]])))
  lines.push('')

  lines.push('## 外部评审（只做报告）', '')
  const ag = records.agreement
  lines.push(`与确定性判定在 ${ag.known} / ${ag.items} 个要点上都有结论，一致率 ${pct(ag.rate)}；“看不出” ${records.reviews.filter((/** @type {any} */ r) => r.unclear).length} 个。`)
  lines.push('')

  lines.push('## 背答案率', '')
  const notes = records.learned.notes
  lines.push(`- 笔记：${notes.items} 条里 ${notes.withLiterals} 条带训练题的具体数值（${pct(notes.rate)}）。`)
  lines.push(`- 学习臂学到的内容：${records.learned.learningArms === null ? '没有可读的内容（学习臂未运行或适配未接上）' : pct(records.learned.learningArms.rate)}。`)
  lines.push('')

  lines.push('## 这份报告证明什么、不证明什么', '')
  lines.push('- 证明：在冻结的计划与判定下，这些运行得到了上面的分数与区间。')
  lines.push('- 不证明：没跑的臂与判据；脚本化演练不说明真实模型的任何效果；外部评审一致率不进入任何结论。')
  if ((records.runNotes ?? []).length > 0) {
    lines.push('', '运行备注：', '')
    for (const note of records.runNotes) lines.push(`- ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const value = (/** @type {string} */ name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const input = value('--records')
  const output = value('--out')
  if (input === undefined || output === undefined) {
    process.stderr.write('usage: rework/report.mjs --records <raw.json> --out <report.md>\n')
    process.exitCode = 2
  } else {
    await writeFile(output, buildReport(JSON.parse(await readFile(input, 'utf8'))))
  }
}
