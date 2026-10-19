#!/usr/bin/env node
// @ts-check
/**
 * The pilot report (ADR 0011; partition §统计与报告): turns the pilot's raw records
 * (pilot/run.mjs `pilotRawRecords`) into Markdown. The same records give the same bytes: no
 * clock, sorted iteration, the seeded bootstrap of pilot/stats.mjs.
 *
 * It answers the pilot's two questions first — is the scoring reliable (criteria 1–3 of
 * reliability.mjs, agreement reported), can the `memory` arm run — then gives the three
 * comparisons (parent − base, memory − base, parent − memory) per family and both families
 * together, whole-case pass rates, repeat spread, "can't tell" and follow-up counts per arm,
 * adopted components by class with their instance-literal rate, the jobs, and the costs.
 * Zero or negative results are written as they are.
 *
 *   node scripts/experiment/step6/pilot/report.mjs --records <raw.json> --out <report.md>
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { CRITERIA, orderConsistency, pairAccuracy, reliabilityVerdict } from './reliability.mjs'
import { orderOutcome } from './reviewer.mjs'
import { agreementRate, COMPARISONS, followUpsByArm, pairedRateDiff, PILOT_ARMS, repeatSpread, unclearByArm, wholePass } from './stats.mjs'

const VERDICT_TEXT = /** @type {Record<string, string>} */ ({
  positive: '正',
  zero: '零（样本内看不出差别）',
  negative: '负',
  insufficient: '不足（没有可配对的用例）',
})
const ARM_TEXT = /** @type {Record<string, string>} */ ({ base: 'base', memory: 'memory', parent: 'parent' })

const pts = (/** @type {number | null} */ x) => (x === null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`)
const pct = (/** @type {number | null} */ x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)
const usd = (/** @type {number | null | undefined} */ x) => (x === null || x === undefined ? '未知' : x.toFixed(3))
const cell = (/** @type {unknown} */ x) => String(x ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')
const yes = (/** @type {boolean} */ ok) => (ok ? '满足' : '不满足')

/**
 * Problems that make the records unusable (empty when usable).
 * @param {any} raw
 */
export function validatePilotRecords(raw) {
  const problems = []
  if (typeof raw?.pilotId !== 'string') problems.push('pilotId is missing')
  if (typeof raw?.planSha256 !== 'string') problems.push('planSha256 is missing')
  if (!Array.isArray(raw?.runs)) problems.push('runs is not an array')
  if (!Array.isArray(raw?.costs)) problems.push('costs is not an array')
  if (typeof raw?.judges?.pass !== 'boolean') problems.push('judges.pass is missing')
  for (const [index, run] of (Array.isArray(raw?.runs) ? raw.runs : []).entries()) {
    if (!PILOT_ARMS.includes(run?.arm)) problems.push(`runs[${index}]: arm ${JSON.stringify(run?.arm)} is not base, memory or parent`)
    if (run?.rate !== null && (typeof run?.rate !== 'number' || run.rate < 0 || run.rate > 1)) problems.push(`runs[${index}]: rate must be a number in [0, 1] or null`)
  }
  const ids = (Array.isArray(raw?.runs) ? raw.runs : []).map((/** @type {any} */ run) => run?.runId)
  for (const id of [...new Set(ids)].sort()) if (ids.filter((/** @type {any} */ x) => x === id).length > 1) problems.push(`runId ${id} appears more than once`)
  return problems
}

/**
 * The report text.
 * @param {any} raw
 */
export function buildPilotReport(raw) {
  const problems = validatePilotRecords(raw)
  if (problems.length > 0) throw new Error(`pilot records are not usable:\n- ${problems.join('\n- ')}`)
  /** @type {import('./stats.mjs').PilotRun[]} */
  const runs = [...raw.runs].sort((a, b) => a.runId.localeCompare(b.runId))
  const families = Object.keys(raw.arms ?? {}).sort()
  const out = []

  out.push(`# 步骤 6 小试点报告（${raw.pilotId}）`, '')
  out.push(`- 计划文件 \`${raw.pilotId === 'step6-pilot-1' ? 'scripts/experiment/step6/pilot/pilot-plan.json' : `scripts/experiment/step6/pilot/pilot-plan-${raw.pilotId}.json`}\`，SHA-256 \`${raw.planSha256}\``)
  out.push(`- 后端：${raw.backend}；任务模型：${raw.model}`)
  out.push(`- 外部评审：${raw.reviewers.external.model}，thinking ${raw.reviewers.external.thinking}；循环内评审：${raw.reviewers.inLoop.model}，thinking ${raw.reviewers.inLoop.thinking}`)
  out.push(`- 纪元：${families.map(f => `${f} ${raw.epochs?.[f] ?? '未知'}`).join('；') || '—'}`)
  if (raw.backend === 'scripted') out.push('- 这是脚本化演练：模型的回答是事先写好的，下面的数字只说明流程和报告能走通，不说明真实模型的表现。')
  out.push('')

  // --- reliability
  const judges = raw.judges
  const pairs = pairAccuracy(raw.referencePairs ?? [])
  const order = orderConsistency([...(raw.referencePairs ?? []), ...(raw.armPairs ?? []).filter((/** @type {any} */ p) => p.missing !== true)])
  const verdict = reliabilityVerdict({ judges, pairs, order })
  const agreement = agreementRate((raw.agreement ?? []).map((/** @type {any} */ a) => ({ a: a.external, b: a.inLoop })))
  out.push('## 一、评分是否可靠', '')
  out.push(`结论：${verdict.reliable ? '可靠（判据 1、2、3 都满足）' : `不可靠，不满足的判据：${verdict.failed.map(key => ({ judges: '1', pairs: '2', order: '3' })[key]).join('、')}`}`, '')
  out.push('| 判据 | 要求 | 结果 | 是否满足 |', '| --- | --- | --- | --- |')
  out.push(`| 1 | ${CRITERIA.judges} | ${judges.samples} 个样本，${judges.failed.length} 个判错${judges.uncovered.length === 0 ? '' : `，${judges.uncovered.length} 个要点没有坏样本`} | ${yes(judges.pass)} |`)
  out.push(`| 2 | ${CRITERIA.pairs.text} | ${pairs.pairs} 组，选对 ${pairs.correct} 组 | ${yes(pairs.pass)} |`)
  out.push(`| 3 | ${CRITERIA.order.text} | ${order.pairs} 组，${order.known} 组两次都有回答，其中一致 ${order.consistent} 组（${pct(order.rate)}）${order.failedReplies === 0 ? '' : `，${order.failedReplies} 组回答缺失`} | ${yes(order.pass)} |`)
  out.push(`| 4 | ${CRITERIA.agreement} | ${agreement.items} 个要点判定，${agreement.known} 个两边都有，一致 ${agreement.agree} 个（${pct(agreement.rate)}） | 不设门槛 |`, '')
  for (const failed of judges.failed) out.push(`- 判错：${cell(failed)}`)
  if (judges.failed.length > 0) out.push('')
  if ((raw.referencePairs ?? []).length > 0) {
    out.push('参考成对样本（好文档在前时为 AB，在后时为 BA）：', '')
    out.push('| 样本 | 题 | 差的那份的问题 | AB | BA | 结果 |', '| --- | --- | --- | --- | --- | --- |')
    for (const p of raw.referencePairs) {
      const o = orderOutcome(p.ab, p.ba)
      out.push(`| ${cell(p.id)} | ${cell(p.caseId)} | ${cell(p.flaw)} | ${cell(p.ab)} | ${cell(p.ba)} | ${o.winner === 'first' ? '选对' : o.winner === 'second' ? '选错' : o.winner === 'tie' ? '打平' : '前后不一致或缺回答'} |`)
    }
    out.push('')
  }

  // --- memory arm
  out.push('## 二、memory 臂能否运行', '')
  out.push('| 类 | 能力版本 | 反馈条数（计数的） | 保留 / 去掉 | 全文 SHA-256 | holdout 运行 | 在这个版本上运行的 |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const family of families) {
    const m = raw.memory?.[family]
    const mine = runs.filter(r => r.family === family && r.arm === 'memory')
    const used = mine.filter(r => m !== null && m !== undefined && /** @type {any} */ (r).capabilityVersions?.length === 1 && /** @type {any} */ (r).capabilityVersions[0] === m.version).length
    out.push(m === null || m === undefined
      ? `| ${family} | 没建成 | — | — | — | ${mine.length} | — |`
      : `| ${family} | \`${m.version.slice(0, 16)}…\` | ${m.entries} | ${m.kept} / ${m.dropped} | \`${m.digest.slice(0, 16)}…\` | ${mine.length}（判定完成 ${mine.filter(r => r.rate !== null).length}） | ${used} |`)
  }
  out.push('')

  // --- comparisons
  out.push('## 三、三个比较（要点通过率之差，百分点）', '')
  out.push('按 holdout 题配对；两层自助法 95% 区间（先抽题，再在题内抽重复），2000 次，种子 `step6-pilot`。区间下限 > 0 记“正”，上限 < 0 记“负”，否则记“零”。', '')
  out.push('| 比较 | 范围 | 配对题数 | 平均差 | 95% 区间 | 结论 | 缺的臂 |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const [treatment, control] of COMPARISONS) {
    for (const family of [...families, undefined]) {
      const d = pairedRateDiff(runs, { treatment, control, ...(family === undefined ? {} : { family }) })
      out.push(`| ${treatment} − ${control} | ${family ?? '两类合并'} | ${d.n} | ${pts(d.mean)} | ${d.ci === null ? '—' : `[${pts(d.ci[0])}, ${pts(d.ci[1])}]`} | ${VERDICT_TEXT[d.verdict]} | ${d.missing.map(m => `${m.caseId} ${m.arm}`).join('；') || '—'} |`)
    }
  }
  out.push('')
  const armPairs = raw.armPairs ?? []
  if (armPairs.length > 0) {
    out.push('文档类 parent 与 memory 的两两偏好（第 1 次重复，parent 在前为 AB）：', '')
    out.push('| 题 | AB | BA | 结果 |', '| --- | --- | --- | --- |')
    for (const p of armPairs) {
      const o = orderOutcome(p.ab, p.ba)
      out.push(`| ${cell(p.caseId)} | ${cell(p.ab)} | ${cell(p.ba)} | ${p.missing === true ? '缺成果，没判' : o.winner === 'first' ? 'parent 好' : o.winner === 'second' ? 'memory 好' : o.winner === 'tie' ? '打平' : '前后不一致或缺回答'} |`)
    }
    out.push('')
  }
  // Both orders' reasons for every comparison whose two answers disagree (or one is missing), so the cause can be read.
  const disagreed = [
    ...(raw.referencePairs ?? []).map((/** @type {any} */ p) => ({ label: `参考 ${p.id}`, ...p })),
    ...armPairs.filter((/** @type {any} */ p) => p.missing !== true).map((/** @type {any} */ p) => ({ label: `${p.caseId}（parent 在前为 AB）`, ...p })),
  ].filter(p => orderOutcome(p.ab, p.ba).consistent !== true)
  if (disagreed.length > 0) {
    const replyText = (/** @type {any} */ r) => (r === undefined || r === null ? '没有记录' : r.failed !== undefined ? `调用失败：${r.failed}` : r.unreadable !== undefined ? `回复无法解析：${r.unreadable}` : `${r.reason}${(r.differences ?? []).length === 0 ? '（没有列出差别）' : `；差别：${r.differences.join('；')}`}`)
    out.push('两种顺序结论不一致的比较，两次的理由：', '')
    out.push('| 比较 | 顺序 | 结论 | 理由与差别 |', '| --- | --- | --- | --- |')
    for (const p of disagreed) {
      out.push(`| ${cell(p.label)} | AB | ${cell(p.ab)} | ${cell(replyText(p.replies?.ab))} |`)
      out.push(`| ${cell(p.label)} | BA | ${cell(p.ba)} | ${cell(replyText(p.replies?.ba))} |`)
    }
    out.push('')
  }

  // --- per arm
  out.push('## 四、各臂明细', '')
  out.push('| 类 | 臂 | 运行 | 判定完成 | 整题通过 | 平均要点通过率 | “看不出” | 追问成果 |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const family of families) {
    const mine = runs.filter(r => r.family === family)
    const unclear = unclearByArm(mine)
    const follow = followUpsByArm(mine)
    for (const arm of PILOT_ARMS) {
      const w = wholePass(mine, arm)
      const known = mine.filter(r => r.arm === arm && r.rate !== null).map(r => /** @type {number} */ (r.rate))
      out.push(`| ${family} | ${ARM_TEXT[arm]} | ${w.runs} | ${w.known} | ${w.passed}（${pct(w.rate)}） | ${known.length === 0 ? '—' : pct(known.reduce((s, x) => s + x, 0) / known.length)} | ${unclear[arm] ?? 0} | ${follow[arm]?.followUps ?? 0} |`)
    }
  }
  out.push('')
  out.push('每题每臂三次重复的要点通过率与波动：', '')
  out.push('| 题 | 臂 | 三次 | 波动（最大 − 最小） | 未知 |', '| --- | --- | --- | --- | --- |')
  for (const caseId of [...new Set(runs.map(r => r.caseId))].sort()) {
    for (const arm of PILOT_ARMS) {
      const s = repeatSpread(runs, caseId, arm)
      if (s.rates.length === 0 && s.unknown === 0) continue
      out.push(`| ${caseId} | ${ARM_TEXT[arm]} | ${s.rates.map(x => pct(x)).join('，') || '—'} | ${s.range === null ? '—' : pct(s.range)} | ${s.unknown} |`)
    }
  }
  out.push('')
  const failedPoints = new Map()
  for (const run of runs) for (const point of /** @type {any} */ (run).points ?? []) if (point.pass === false) {
    const key = `${run.caseId}\u0000${run.arm}\u0000${point.id}`
    failedPoints.set(key, (failedPoints.get(key) ?? 0) + 1)
  }
  if (failedPoints.size > 0) {
    out.push('没通过的要点（次数）：', '')
    out.push('| 题 | 臂 | 要点 | 次数 |', '| --- | --- | --- | --- |')
    for (const key of [...failedPoints.keys()].sort()) {
      const [caseId, arm, id] = key.split('\u0000')
      out.push(`| ${caseId} | ${arm} | ${id} | ${failedPoints.get(key)} |`)
    }
    out.push('')
  }

  // --- improvement and components
  out.push('## 五、改进作业与被采用组件', '')
  out.push('| 类 | 臂 | NEXGENT_HOME | 能力版本 | 改进器版本 |', '| --- | --- | --- | --- | --- |')
  for (const family of families) for (const arm of PILOT_ARMS) {
    const a = raw.arms[family]?.[arm]
    if (a !== undefined) out.push(`| ${family} | ${arm} | \`${cell(a.home)}\` | ${a.capabilityVersion === null ? '—' : `\`${String(a.capabilityVersion).slice(0, 16)}\``} | ${cell(a.improverVersion)} |`)
  }
  out.push('')
  out.push('| 类 | dev 题 | 主问题 | 反馈条数 | 作业结果 | 作业经过 |', '| --- | --- | --- | --- | --- | --- |')
  for (const family of families) {
    for (const dev of raw.dev?.[family] ?? []) {
      const job = (raw.jobs?.[family] ?? []).find((/** @type {any} */ j) => j.caseId === dev.caseId)
      out.push(`| ${family} | ${dev.caseId} | ${cell(dev.primary)} | ${dev.feedback.length} | ${cell(job?.status ?? '没有作业')} | ${cell((job?.history ?? []).join(' → '))} |`)
    }
  }
  out.push('')
  out.push('| 类 | 臂 | 组件 | 项目约定或事实 | 做事方法 | 含具体数值的组件（背答案率） |', '| --- | --- | --- | --- | --- | --- |')
  for (const family of families) for (const arm of PILOT_ARMS) {
    const c = raw.components?.[family]?.[arm]
    if (c === undefined) continue
    const list = c.components.map((/** @type {any} */ x) => `${x.kind}:${x.name}`).join('、') || '无'
    const n = (/** @type {string} */ cls) => c.components.filter((/** @type {any} */ x) => x.class === cls).length
    out.push(`| ${family} | ${arm} | ${cell(list)} | ${n('convention-or-fact')} | ${n('way-of-working')} | ${c.literal.withLiterals} / ${c.literal.components}（${pct(c.literal.rate)}） |`)
  }
  out.push('')
  out.push(`holdout 隔离：${families.map(f => (raw.isolation?.[f] === null || raw.isolation?.[f] === undefined ? `${f} 未查` : `${f} ${raw.isolation[f].leaks} 处泄漏（查 ${raw.isolation[f].scanned} 个文件，跳过 ${raw.isolation[f].skipped} 个）`)).join('；')}`, '')

  // --- costs
  out.push('## 六、费用（估算美元，含缓存读写）', '')
  /** @type {Map<string, { n: number, usd: number, unknown: number }>} */
  const byKind = new Map()
  for (const cost of [...raw.costs].sort((a, b) => `${a.kind}\u0000${a.family}\u0000${a.ref}`.localeCompare(`${b.kind}\u0000${b.family}\u0000${b.ref}`))) {
    const key = `${cost.family ?? '—'}\u0000${cost.kind}`
    const entry = byKind.get(key) ?? { n: 0, usd: 0, unknown: 0 }
    entry.n += 1
    if (typeof cost.usd === 'number') entry.usd += cost.usd
    else entry.unknown += 1
    byKind.set(key, entry)
  }
  out.push('| 类 | 项目 | 次数 | 美元 | 费用未知 |', '| --- | --- | --- | --- | --- |')
  let total = 0
  let unknown = 0
  for (const key of [...byKind.keys()].sort()) {
    const [family, kind] = key.split('\u0000')
    const entry = /** @type {{ n: number, usd: number, unknown: number }} */ (byKind.get(key))
    total += entry.usd
    unknown += entry.unknown
    out.push(`| ${family} | ${kind} | ${entry.n} | ${usd(entry.usd)} | ${entry.unknown} |`)
  }
  out.push(`| 合计 | | ${raw.costs.length} | ${usd(total)} | ${unknown} |`, '')

  // --- notes
  if ((raw.notes ?? []).length > 0) {
    out.push('## 七、备注', '')
    for (const note of raw.notes) out.push(`- ${cell(note)}`)
    out.push('')
  }
  return `${out.join('\n')}\n`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const value = (/** @type {string} */ name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const records = value('--records')
  if (records === undefined) {
    process.stderr.write('usage: pilot/report.mjs --records <raw.json> [--out <report.md>]\n')
    process.exitCode = 2
  } else {
    const text = buildPilotReport(JSON.parse(await readFile(records, 'utf8')))
    const target = value('--out')
    if (target === undefined) process.stdout.write(text)
    else await writeFile(target, text)
  }
}
