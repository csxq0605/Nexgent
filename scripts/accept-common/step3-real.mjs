/**
 * The real-model layer of accept-step3 (R01–R08, docs/plan/step-3-work-partition.md
 * §真实模型验收): the Excel restock task (scripts/real-task/step3-restock/)
 * driven through `@nexgent/sdk` against the real Claude API, once per form (the team run R03 was
 * dropped with the teammate tools on 2026-10-20; the ids stay):
 *
 *   R01 direct      the user asks for the work to be done directly
 *   R02 delegated   the user asks for a member (delegate) to do it
 *   R04 workflow    the user asks for a workflow with at least two members
 *   R05 unspecified no form named; the form the model picked is recorded
 *
 * Each run: one project with inventory.xlsx as a material → round 1 (the task)
 * → feedback on v1 (“P01 的现有库存应为 20，请更新。”) → v2. The hidden check
 * (../real-task/step3-restock-hidden.mjs) judges the v1 and v2 snapshots of
 * purchase.xlsx. Every approval is allowed once (members ask like the main
 * conversation). The scenario only observes; step3-real-judges.mjs decides.
 *
 * The key is never logged or written: it lives only in the SDK's env object.
 */
import { dataDirSync, registerHome } from './data-dir.mjs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeRestock, PURCHASE_PATH, sha256 } from '../real-task/step3-restock-hidden.mjs'
import { ledgerUsage } from './step2-real.mjs'
import { runTurn } from './step2-runtime.mjs'
import { budgetGate, REAL_MODEL, realModelKeySource } from './step3-checks.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'

export const MATERIAL_PATH = fileURLToPath(new URL('../real-task/step3-restock/inventory.xlsx', import.meta.url))

/** Per-task caps written to each run's project (permissions.md §费用上限). */
export const TASK_CAPS = { maxRequests: 150, maxTokens: 3_000_000 }

/** The task (plan §真实模型验收) and the feedback. */
export const TASK = '资料里有库存表 inventory.xlsx。根据库存表生成采购计划 purchase.xlsx：Plan 表用公式计算目标库存、补货量（向上取整）和金额，Summary 表汇总，完成后交给我。\n'
  + '规则：目标库存 = 周需求 × 交期(周) + 安全库存；补货量 = max(0, 向上取整(目标库存 − 现有库存))；金额 = 补货量 × 单价；Summary 汇总补货量合计与金额合计。'
export const FEEDBACK = 'P01 的现有库存应为 20，请更新。'

/** The four runs: id, form and what the user adds to the task. */
export const RUNS = [
  { id: 'R01', form: 'direct', ask: '请你自己直接完成，不要委派成员或使用工作流。' },
  { id: 'R02', form: 'delegated', ask: '请用 delegate 把这项工作委派给一名成员完成：由成员读取资料、写出 purchase.xlsx 并 present，你再把最终成果交给我。' },
  { id: 'R04', form: 'workflow', ask: '请用 workflow 工具组织至少两个成员完成（例如一个成员核对数据、一个成员写表格），最后由你把 purchase.xlsx 交给我。' },
  { id: 'R05', form: 'unspecified', ask: '用什么方式完成由你决定；开始前用一句话说明你选择的方式和理由。' },
]

function slim(event) {
  switch (event.type) {
    case 'tool.start': return { type: event.type, turn: event.turn, sessionId: event.sessionId, name: event.call.name, arguments: String(JSON.stringify(event.call.arguments)).slice(0, 2000) }
    case 'tool.result': return { type: event.type, turn: event.turn, sessionId: event.sessionId, name: event.name, isError: event.isError, content: String(event.content).slice(0, 400) }
    case 'turn.end': return { type: event.type, turn: event.turn, sessionId: event.sessionId, reason: event.reason }
    case 'error': return { type: event.type, sessionId: event.sessionId, error: event.error }
    default: return undefined
  }
}

/** Pick the deliverable holding purchase.xlsx: the most versions, the root's first. */
function purchaseDeliverable(deliverables) {
  const holding = deliverables.filter(d => d.versions.some(v => v.files.some(f => f.path === PURCHASE_PATH)))
  holding.sort((a, b) => (b.versions.length - a.versions.length) || (Number(a.versions[0]?.memberId !== undefined) - Number(b.versions[0]?.memberId !== undefined)))
  return holding[0]
}

/**
 * One run of the restock task.
 * @param h - @nexgent/test-support (readSessionRecords, readLedgerRecords, waitFor).
 * @param pkgs - from loadStep3Packages.
 * @param work - this run's work directory (kept: the raw record of the run).
 * @param run - an entry of {@link RUNS}.
 * @param options - `env` (NEXGENT_API_KEY, optional NEXGENT_API_BASE_URL), `realModel`, `turnTimeoutMs`, `log`.
 */
export async function runRestock(h, pkgs, work, run, { env, realModel = false, turnTimeoutMs = 30 * 60_000, log = () => {} }) {
  const root = join(work, 'project')
  const home = join(work, 'home')
  registerHome(root, home)
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  const source = join(work, 'inventory.xlsx')
  await copyFile(MATERIAL_PATH, source)
  const obs = { id: run.id, form: run.form, platform: process.platform, realModel, phases: {}, approvals: [] }
  const approvals = async (request) => {
    obs.approvals.push({ tool: request.tool, summary: String(request.summary).slice(0, 200), member: request.member?.name ?? null })
    return { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
  }
  const sdk = createStep3Sdk(pkgs, { env: { ...env, NEXGENT_HOME: home }, home, approvals, realModel })
  let projectId
  const withTimeout = async (promise, label) => {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${turnTimeoutMs} ms`)), turnTimeoutMs) })
    try {
      return await Promise.race([promise, timeout])
    } catch (error) {
      await sdk.cancelTurn({ projectId, sessionId: obs.sessionId }).catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const snapshot = async (deliverable, version) => {
    const v = deliverable?.versions.find(entry => entry.version === version)
    const file = v?.files.find(f => f.path === PURCHASE_PATH)
    if (file === undefined) return undefined
    const bytes = await readFile(join(dataDirSync(root), 'outputs', deliverable.deliverableId, `v${version}`, 'files', PURCHASE_PATH)).catch(() => undefined)
    return { bytes, recorded: file.sha256 }
  }
  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    await sdk.call('settings.update', { projectId, patch: { model: REAL_MODEL.model, thinking: REAL_MODEL.thinking, costCaps: { perTask: TASK_CAPS } } })
    obs.config = { model: REAL_MODEL.model, thinking: REAL_MODEL.thinking, costCaps: { perTask: TASK_CAPS } }
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: `step-3 real ${run.id}` })).sessionId
    const material = await sdk.call('materials.add', { projectId, sourcePath: source, sessionId: obs.sessionId })

    log(`${run.id} round 1 (${run.form})`)
    const first = await withTimeout(runTurn(sdk, { projectId, sessionId: obs.sessionId, text: `${TASK}\n${run.ask}`, materialIds: [material.id] }), `${run.id} round 1`)
    obs.phases.first = { reason: first.result?.reason, error: first.error === undefined ? undefined : String(first.error), events: first.events.map(slim).filter(Boolean) }
    const afterFirst = purchaseDeliverable(await sdk.call('deliverables.list', { projectId }))
    const v1AtPresent = await snapshot(afterFirst, 1)

    if (afterFirst !== undefined) {
      log(`${run.id} feedback`)
      const events = []
      const unsubscribe = sdk.onAgentEvent((event) => { if (event.projectId === projectId) events.push(event) })
      try {
        await sdk.call('feedback.submit', { projectId, sessionId: obs.sessionId, deliverableId: afterFirst.deliverableId, version: 1, comment: FEEDBACK })
        await withTimeout(h.waitFor(() => events.some(e => e.type === 'turn.end' && e.sessionId === obs.sessionId) && !sdk.isRunning(projectId, obs.sessionId), { timeoutMs: turnTimeoutMs, intervalMs: 500, label: 'the feedback turn' }), `${run.id} feedback`)
      } finally {
        unsubscribe()
      }
      obs.phases.feedback = { reason: events.find(e => e.type === 'turn.end' && e.sessionId === obs.sessionId)?.reason, events: events.map(slim).filter(Boolean) }
    } else {
      obs.phases.feedback = { skipped: 'no purchase.xlsx deliverable after round 1' }
    }

    const deliverables = await sdk.call('deliverables.list', { projectId })
    obs.deliverables = deliverables.map(d => ({ deliverableId: d.deliverableId, versions: d.versions.map(v => ({ version: v.version, sessionId: v.sessionId, memberName: v.memberName ?? null, files: v.files.map(f => f.path) })) }))
    const final = purchaseDeliverable(deliverables)
    const last = final?.versions.at(-1)?.version
    const v1End = await snapshot(final, 1)
    const v2 = last !== undefined && last > 1 ? await snapshot(final, last) : undefined
    obs.purchase = final === undefined ? null : { deliverableId: final.deliverableId, versions: final.versions.map(v => v.version), presentedBy: final.versions.map(v => v.memberName ?? 'main') }
    obs.hidden = judgeRestock({
      v1: v1End?.bytes,
      v2: v2?.bytes,
      v1ShaAtPresent: v1AtPresent?.bytes === undefined ? undefined : sha256(v1AtPresent.bytes),
      v1ShaAtEnd: v1End?.bytes === undefined ? undefined : sha256(v1End.bytes),
    })
    obs.hidden = { pass: obs.hidden.pass, problems: obs.hidden.problems }
    obs.collaboration = await sdk.call('sessions.collaboration', { projectId, sessionId: obs.sessionId })
    obs.children = (await sdk.call('sessions.children', { projectId, sessionId: obs.sessionId })).map(c => ({ sessionId: c.sessionId, member: c.member }))
  } catch (error) {
    obs.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    log(`${run.id} stopped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await sdk.dispose().catch(() => undefined)
    if (obs.sessionId !== undefined) {
      const records = (await h.readSessionRecords(root, obs.sessionId, { home }).catch(() => ({ records: [] }))).records
      obs.rootTexts = records.filter(r => r.type === 'assistant.message' && typeof r.content === 'string' && r.content.trim() !== '').map(r => ({ turn: r.turn, text: r.content.slice(0, 600) })).slice(0, 6)
      const ledger = (await h.readLedgerRecords(root, { home }).catch(() => ({ records: [] }))).records
      obs.formsUsed = ledger.filter(r => r.type === 'task.outcome' && r.sessionId === obs.sessionId).map(r => r.formsUsed ?? null)
      // The whole project: the root and every member (ledgerUsage keeps records without a sessionId).
      obs.usage = ledgerUsage(ledger.map(({ sessionId, ...rest }) => rest), undefined)
      obs.ledgerSessions = [...new Set(ledger.map(r => r.sessionId).filter(Boolean))].length
    }
    await writeFile(join(work, 'observations.json'), `${JSON.stringify(obs, null, 1)}\n`).catch(() => undefined)
  }
  return obs
}

/**
 * The four runs, in order, stopping before a run once the estimated total would pass the cap.
 * @param options - as {@link runRestock}, plus `budgetUsd`, `spent` (earlier costs), `runCapUsd`, `only` (run ids).
 * @returns `{ runs, totalCostUsd, stoppedForBudget? }`.
 */
export async function runRealScenario(h, work, { env, realModel, budgetUsd = REAL_MODEL.budgetUsd, spent = [], runCapUsd = REAL_MODEL.runCapUsd, only, turnTimeoutMs, log = () => {} }) {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const out = { runs: {}, budgetUsd, runCapUsd }
  const earlier = spent.reduce((sum, cost) => sum + (typeof cost === 'number' ? cost : 0), 0)
  let total = 0
  for (const run of RUNS) {
    if (only !== undefined && !only.includes(run.id)) continue
    // Refuse to start a run that could take the total past the cap.
    if (earlier + total + runCapUsd > budgetUsd) {
      out.stoppedForBudget = { before: run.id, spentUsd: Math.round((earlier + total) * 10000) / 10000 }
      log(`not starting ${run.id}: ${(earlier + total).toFixed(2)} USD spent, a run may cost up to ${runCapUsd} USD, cap ${budgetUsd} USD`)
      break
    }
    const dir = join(work, run.id)
    await mkdir(dir, { recursive: true })
    const obs = await runRestock(h, loaded.pkgs, dir, run, { env, realModel, turnTimeoutMs, log })
    out.runs[run.id] = obs
    total += obs.usage?.costUsd ?? runCapUsd
    log(`${run.id}: hidden ${obs.hidden?.pass ? 'pass' : 'fail'}, ${obs.usage?.callCount ?? '?'} requests, ~${obs.usage?.costUsd ?? '?'} USD`)
  }
  out.totalCostUsd = Math.round(total * 10000) / 10000
  out.spentBeforeUsd = earlier
  return out
}

/**
 * Real-layer prerequisites, in order: a key in the environment, budget left for a run.
 * @param env - process environment (only variable names are read out).
 * @param budgetUsd - total cap.
 * @param spent - estimated costs of earlier runs.
 * @returns `{ ok: true, keySource, remainingUsd }` or `{ ok: false, reason }` — never the key value.
 */
export function realPrerequisites(env, budgetUsd, spent) {
  const keySource = realModelKeySource(env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(budgetUsd, spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: true, keySource, remainingUsd: gate.remainingUsd }
}
