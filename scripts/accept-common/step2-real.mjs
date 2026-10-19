/**
 * The real-model layer of accept-step2 (R01–R07): the step-2 real task
 * (docs/plan/step-2-work-partition.md §真实模型补验) driven through
 * `@nexgent/sdk` against the real Claude API — or, in tests, against the
 * scripted stand-in (step2-real-scripted.mjs) on a loopback server.
 *
 *   round 1   materials orders.csv + regions.xlsx → clean, summarize, a re-runnable
 *             Node script, report/summary.csv + README → present (v1)
 *   feedback  rating 3 on v1: Chinese region names, month-over-month growth,
 *             cleaning rules in the README → v2 (edits existing files)
 *   round 3   in a child process; killed as soon as the model streams (reasoning
 *             or text) → resumed by a fresh SDK → v3
 *
 * The scenario only observes; step2-real-judges.mjs decides, and the hidden
 * check (../real-task/step2-sales-hidden.mjs) judges the files. The key is
 * never logged or written: in-process it lives in the SDK's env object, the
 * child process reads it from its own environment (`keyFromEnv`).
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSalesProject } from '../real-task/step2-sales-hidden.mjs'
import { dataDirFor } from './data-dir.mjs'
import { DRIVER, sha256, treeHashes } from './step2-headless.mjs'
import { createStep2Sdk, loadStep2Packages, runTurn } from './step2-runtime.mjs'

export const MATERIALS_DIR = fileURLToPath(new URL('../real-task/step2-sales/', import.meta.url))

/** Sonnet 5.5 list prices, USD per million tokens (ADR 0002; cache write = 1.25 × input). */
export const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }

/** Per-task caps written to the project's config.json (permissions.md §费用上限). */
export const TASK_CAPS = { maxRequests: 80, maxTokens: 4_000_000 }

export const TASKS = {
  first: '资料里有订单明细 orders.csv 和地区对照表 regions.xlsx。请清洗订单数据，按地区和月份汇总销售额，写一个可重复运行的 Node 脚本生成 report/summary.csv 和 report/README.md，完成后把成果交给我。\n'
    + '具体要求：\n'
    + '- 先把 orders.csv 原样复制到 data/orders.csv，不要改动这份副本，清洗都在脚本里做。\n'
    + '- 脚本放在 scripts/build-report.mjs，只用 Node 自带模块，在项目根目录用 `node scripts/build-report.mjs` 运行。\n'
    + '- summary.csv 表头为 region,month,sales；month 用 YYYY-MM，sales 保留两位小数。\n'
    + '- 清洗规则：订单号重复的只保留第一条；地区为空的订单剔除；地区代码去掉首尾空格并转小写；金额去掉千分位逗号。\n'
    + '- 交付时把 report/summary.csv 和 report/README.md 一起交给我。',
  feedback: '地区要用对照表里的中文名；再加一列环比增长 mom_growth（同一地区相对上个月销售额的增长率，保留四位小数，首月留空）；README 里说明清洗规则。改完重新运行脚本，再交给我。',
  round3: '把重复订单的处理方式也写进 README（怎么判断重复、保留哪一条），然后重新交给我。',
  resume: '上一轮被中断了。请检查现在的文件，把没做完的部分补完（README 里写清重复订单的处理方式），然后重新交给我。',
}

const STREAM_EVENT = /"type":"(reasoning|text)\.delta"/

/** Usage and estimated cost of one session's requests, from the ledger. */
export function ledgerUsage(ledger, sessionId) {
  const mine = ledger.filter(record => record.sessionId === sessionId || record.sessionId === undefined)
  const starts = mine.filter(record => record.type === 'llm.request.start')
  const ends = new Map(mine.filter(record => record.type === 'llm.request.end').map(record => [record.requestId, record]))
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
  const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const unknownRequestIds = []
  for (const start of starts) {
    const end = ends.get(start.requestId)
    if (end === undefined || keys.some(key => typeof end.usage?.[key] !== 'number')) unknownRequestIds.push(start.requestId)
    if (end === undefined) continue
    for (const [key, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens']]) {
      if (typeof end.usage?.[field] === 'number') known[key] += end.usage[field]
    }
  }
  const costUsd = (known.input * PRICE.input + known.output * PRICE.output + known.cacheRead * PRICE.cacheRead + known.cacheWrite * PRICE.cacheWrite) / 1e6
  return {
    callCount: starts.length,
    known,
    unknownCount: unknownRequestIds.length,
    unknownRequestIds,
    costUsd: Math.round(costUsd * 10000) / 10000,
    httpStatuses: [...ends.values()].map(end => end.httpStatus).filter(status => status !== undefined),
  }
}

function slim(event) {
  switch (event.type) {
    case 'tool.start': return { type: event.type, turn: event.turn, name: event.call.name, callId: event.call.id, arguments: String(event.call.arguments).slice(0, 4000) }
    case 'tool.result': return { type: event.type, turn: event.turn, name: event.result.name, callId: event.result.toolCallId, isError: event.result.isError, content: String(event.result.content).slice(0, 400) }
    case 'turn.start': return { type: event.type, turn: event.turn }
    case 'turn.end': return { type: event.type, turn: event.turn, reason: event.reason }
    case 'error': return { type: event.type, error: event.error, fatal: event.fatal }
    default: return undefined
  }
}

/**
 * Run the real task.
 * @param h - @nexgent/test-support (readSessionRecords, readLedgerRecords, spawnNode, waitFor).
 * @param work - an empty work directory (kept: it is the raw record of the run).
 * @param options - `env` for the SDK (NEXGENT_API_KEY, optional NEXGENT_API_BASE_URL and
 *   NEXGENT_COMPACTION_THRESHOLD); `keyFromEnv` (the env var the child process reads the
 *   key from; without it the child gets `env.NEXGENT_API_KEY` in its spec — scripted runs
 *   only); `realModel` (allow a non-loopback API); `runCapUsd` (stop between rounds once the
 *   estimate passes it); `turnTimeoutMs`; `log(line)`.
 * @returns observations for the R judges.
 */
export async function runRealScenario(h, work, options) {
  const { env, keyFromEnv, realModel = false, runCapUsd = Infinity, turnTimeoutMs = 20 * 60_000, log = () => {} } = options
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const root = join(work, 'project')
  const home = join(work, 'home')
  const src = join(work, 'materials')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(src, { recursive: true })
  for (const name of ['orders.csv', 'regions.xlsx']) await copyFile(join(MATERIALS_DIR, name), join(src, name))

  const sdkEnv = { ...env, NEXGENT_HOME: home }
  const obs = { platform: process.platform, phases: {}, approvals: [], realModel, baseUrl: env.NEXGENT_API_BASE_URL ?? null, runCapUsd: Number.isFinite(runCapUsd) ? runCapUsd : null }
  const approvals = async (request) => {
    obs.approvals.push({ tool: request.tool, summary: String(request.summary).slice(0, 200) })
    return { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
  }
  let sdk
  let projectId
  const open = async () => {
    sdk = createStep2Sdk(pkgs, { env: sdkEnv, home, approvals, realModel })
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    if (obs.sessionId !== undefined) await sdk.openSession({ projectId, sessionId: obs.sessionId })
  }
  const close = async () => {
    await sdk?.dispose()
    sdk = undefined
  }
  const usageSoFar = async () => ledgerUsage((await h.readLedgerRecords(root, { home })).records, obs.sessionId)
  const overCap = async (phase) => {
    const used = await usageSoFar()
    if (used.costUsd > runCapUsd) {
      obs.stoppedForCost = { after: phase, costUsd: used.costUsd }
      log(`estimated ${used.costUsd} USD passed the run cap ${runCapUsd} USD; stopping after ${phase}`)
      return true
    }
    return false
  }
  const withTimeout = async (promise, label) => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${turnTimeoutMs} ms`)), turnTimeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } catch (error) {
      await sdk?.cancelTurn({ projectId, sessionId: obs.sessionId }).catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const turn = async (phase, input) => {
    log(`phase ${phase}`)
    const { result, error, events } = await withTimeout(runTurn(sdk, { projectId, sessionId: obs.sessionId, ...input }), phase)
    obs.phases[phase] = { reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slim).filter(Boolean) }
  }
  const snapshotHashes = async (deliverable, version) => {
    const v = deliverable?.versions.find(entry => entry.version === version)
    if (v === undefined) return []
    return Promise.all(v.files.map(async (file) => {
      const path = join(await dataDirFor(root, home), 'outputs', deliverable.deliverableId, `v${version}`, 'files', ...file.path.split('/'))
      const bytes = await readFile(path).catch(() => null)
      return { path: file.path, recorded: file.sha256, actual: bytes === null ? null : sha256(bytes) }
    }))
  }

  try {
    // ---- project, settings, materials --------------------------------------------------------
    await open()
    const configFile = join(root, '.nexgent', 'config.json')
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    config.model = 'claude-sonnet-5-5'
    config.thinking = 'on'
    config.costCaps = { ...config.costCaps, perTask: TASK_CAPS }
    await close()
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)
    await open()
    obs.config = { model: config.model, thinking: config.thinking, costCaps: config.costCaps }
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-2 real task' })).sessionId
    const materials = []
    for (const name of ['orders.csv', 'regions.xlsx']) materials.push(await sdk.call('materials.add', { projectId, sourcePath: join(src, name), sessionId: obs.sessionId }))
    obs.materials = materials.map(m => ({ id: m.id, originalName: m.originalName, sha256: m.sha256 }))

    // ---- round 1 ------------------------------------------------------------------------------
    await turn('first', { text: TASKS.first, materialIds: materials.map(m => m.id) })
    const [v1Deliverable] = await sdk.call('deliverables.list', { projectId })
    obs.v1AtPresent = await snapshotHashes(v1Deliverable, 1)
    obs.treeAfterFirst = await treeHashes(root)
    await close()
    if (await overCap('first')) return obs

    // ---- feedback → v2 ------------------------------------------------------------------------
    await open()
    if (v1Deliverable !== undefined) {
      log('phase feedback')
      const events = []
      const unsubscribe = sdk.onAgentEvent((event) => {
        if (event.projectId === projectId) events.push(event)
      })
      try {
        await sdk.call('feedback.submit', { projectId, sessionId: obs.sessionId, deliverableId: v1Deliverable.deliverableId, version: 1, rating: 3, comment: TASKS.feedback })
        await h.waitFor(() => events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, obs.sessionId), { timeoutMs: turnTimeoutMs, intervalMs: 200, label: 'the feedback turn' })
      } finally {
        unsubscribe()
      }
      obs.phases.feedback = { reason: events.find(e => e.type === 'turn.end')?.reason, events: events.map(slim).filter(Boolean), treeBefore: obs.treeAfterFirst }
    } else {
      obs.phases.feedback = { skipped: 'no deliverable after round 1' }
    }
    await close()
    if (await overCap('feedback')) return obs

    // ---- round 3 in a child process, killed mid-stream -----------------------------------------
    log('phase kill')
    const { NEXGENT_API_KEY: inlineKey, ...childEnv } = sdkEnv
    const spec = {
      root,
      home,
      sessionId: obs.sessionId,
      text: TASKS.round3,
      env: keyFromEnv === undefined ? { ...childEnv, NEXGENT_API_KEY: inlineKey } : childEnv,
      ...(keyFromEnv === undefined ? {} : { keyFromEnv }),
      realModel,
      approvals: 'allow-once',
    }
    const handle = h.spawnNode([DRIVER, JSON.stringify(spec)], { cwd: work })
    const ready = await handle.waitForOutput(/"type":"driver\.ready"/, 120_000, 'stdout').then(() => true, () => false)
    const streamed = ready && await handle.waitForOutput(text => STREAM_EVENT.test(text) || /"type":"driver\.done"/.test(text), turnTimeoutMs, 'stdout').then(() => STREAM_EVENT.test(handle.stdout), () => false)
    const finishedBeforeKill = /"type":"driver\.done"/.test(handle.stdout)
    const requestIds = [...handle.stdout.matchAll(/"type":"request\.start","requestId":"([^"]+)"/g)].map(m => m[1])
    const exit = await handle.kill('SIGKILL', { tree: true })
    obs.phases.kill = {
      ready,
      streamed,
      finishedBeforeKill,
      requestIds,
      exit: { code: exit.code, signal: exit.signal },
      driverErrors: handle.stdout.split('\n').filter(line => line.includes('"driver.error"')).slice(0, 3),
    }

    // ---- resume -------------------------------------------------------------------------------
    // The killed turn is still open in the file; opening the session closes it as interrupted.
    const before = (await h.readSessionRecords(root, obs.sessionId, { home })).records
    const opened = before.filter(r => r.type === 'turn.start').map(r => r.turn).filter(t => !before.some(r => r.type === 'turn.end' && r.turn === t))
    await open()
    await turn('resume', { text: TASKS.resume })
    obs.phases.resume.openTurnBefore = opened.at(-1)
    const [final] = await sdk.call('deliverables.list', { projectId })
    obs.deliverable = final === undefined ? null : { deliverableId: final.deliverableId, versions: final.versions.map(v => v.version) }
    obs.v1AtEnd = await snapshotHashes(final, 1)
    await close()

    // ---- hidden check, records ----------------------------------------------------------------
    log('hidden check')
    obs.hidden = (await checkSalesProject(root, join(src, 'orders.csv'))).checks
  } catch (error) {
    obs.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    log(`scenario stopped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await close().catch(() => undefined)
    if (obs.sessionId !== undefined) {
      const session = await h.readSessionRecords(root, obs.sessionId, { home }).catch(() => ({ records: [] }))
      obs.records = session.records
      obs.ledger = (await h.readLedgerRecords(root, { home }).catch(() => ({ records: [] }))).records
      obs.usage = ledgerUsage(obs.ledger, obs.sessionId)
    }
    obs.projectRoot = relative(work, root).split(sep).join('/')
    // Kept with the raw records so the run can be judged again offline.
    await writeFile(join(work, 'observations.json'), `${JSON.stringify(obs, null, 1)}\n`).catch(() => undefined)
  }
  return obs
}
