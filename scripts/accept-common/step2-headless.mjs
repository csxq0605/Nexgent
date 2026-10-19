/**
 * The step-2 headless scenario (H checks): drives `@nexgent/sdk`
 * (step2-runtime.mjs), the kill driver (step2-driver.mjs) and
 * `nexgent export` through the phases of scenario-step2.mjs against the
 * scripted model server, and collects raw observations — request bodies,
 * agent events, session and ledger records, SDK query results, file hashes,
 * process ids. It judges nothing: the H judges (step2-judges.mjs) decide each
 * item from these observations, so a judge can be tested against a
 * deliberately broken copy.
 *
 * Each phase gets its own scripted server and a fresh SDK instance (every
 * phase is also a restart). Never calls a real model: every SDK is created
 * against a loopback server.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPACTION,
  MATERIALS,
  SCRIPTED_API_KEY,
  STALL_TEXT,
  TASKS,
  buildStep2Script,
} from './scenario-step2.mjs'
import { layoutFor, resolveRecorded, readLedgerRecordsAt, readSessionRecordsAt, scanSecrets, strayDataIn } from './data-dir.mjs'
import { CLI_BIN, createStep2Sdk, loadStep2Packages, runTurn } from './step2-runtime.mjs'

export const DRIVER = fileURLToPath(new URL('./step2-driver.mjs', import.meta.url))

/** The workspace instructions file the scenario writes (H05). */
export const AGENTS_MD = '# Project rules\n\nAGENTS-MD-MARKER: amounts are in CNY; keep two decimals.\n'

/** The CSV material's contents (H02). */
export const ORDERS_CSV = 'order_id,region,month,amount\n1,north,2026-09,"1,200.00"\n1,north,2026-09,"1,200.00"\n2,,2026-09,80.00\n'

/** The .xlsx material: the skill package's own test fixture. */
export const XLSX_SOURCE = fileURLToPath(new URL('../../packages/skill/tests/fixtures/orders.xlsx', import.meta.url))

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileSha(path) {
  try {
    return sha256(await readFile(path))
  } catch {
    return null
  }
}

/** `{ portablePath: sha256 }` of every project file outside `.nexgent/`. */
export async function treeHashes(root) {
  const out = {}
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (rel === '.nexgent') continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out[rel] = sha256(await readFile(full))
    }
  }
  await walk(root)
  return out
}

/** Every file under `dir` whose bytes contain `needle` (portable paths relative to `base`). */
export async function filesContaining(dir, needle, base = dir) {
  const hits = []
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && (await readFile(full)).includes(needle)) hits.push(relative(base, full).split(sep).join('/'))
    }
  }
  await walk(dir)
  return hits
}

/** The turn a session file leaves open (a `turn.start` without its `turn.end`), if any. */
export function openTurn(records) {
  const ended = new Set(records.filter(r => r.type === 'turn.end').map(r => r.turn))
  return records.filter(r => r.type === 'turn.start' && !ended.has(r.turn)).at(-1)?.turn
}

/** Keep the parts of an agent event the judges read (no big payloads). */
function slimEvent(event) {
  switch (event.type) {
    case 'tool.start': return { type: event.type, name: event.call.name, callId: event.call.id, arguments: String(event.call.arguments).slice(0, 2000) }
    case 'tool.result': return { type: event.type, name: event.result.name, callId: event.result.toolCallId, isError: event.result.isError, content: String(event.result.content).slice(0, 2000) }
    case 'text.delta': return { type: event.type, text: event.text }
    case 'turn.end': return { type: event.type, turn: event.turn, reason: event.reason }
    case 'turn.start': return { type: event.type, turn: event.turn }
    case 'request.start': return { type: event.type, requestId: event.requestId }
    case 'approval.request': return { type: event.type, request: event.request }
    case 'approval.decision': return { type: event.type, decision: event.decision }
    case 'error': return { type: event.type, error: event.error, fatal: event.fatal }
    default: return { type: event.type }
  }
}

/** What the SDK shows of a session (H18): history, materials, deliverables, feedback, goal. */
async function sdkView(sdk, projectId, sessionId) {
  const view = await sdk.call('sessions.open', { projectId, sessionId })
  const deliverables = await sdk.call('deliverables.list', { projectId })
  return {
    items: view.items.map(item => ({ kind: item.kind, turn: item.turn, text: item.text ?? item.comment ?? undefined })),
    materials: (await sdk.call('materials.list', { projectId })).map(m => ({ id: m.id, sha256: m.sha256, originalName: m.originalName })),
    deliverables: deliverables.map(d => ({ deliverableId: d.deliverableId, versions: d.versions.map(v => ({ version: v.version, files: v.files.map(f => [f.path, f.sha256]) })) })),
    feedback: (await sdk.call('feedback.list', { projectId, sessionId })).map(f => ({ id: f.feedback?.id ?? f.id, deliverableId: f.feedback?.deliverableId ?? f.deliverableId, version: f.feedback?.version ?? f.version })),
    goal: await sdk.call('goals.get', { projectId, sessionId }),
  }
}

/**
 * Run the scenario.
 * @param h - the loaded test-support harness.
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 * @returns the observations.
 */
export async function runHeadlessScenario(h, work, { log = () => {} } = {}) {
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const script = buildStep2Script(h)
  const root = join(work, 'project')
  const home = join(work, 'home')
  const src = join(work, 'src')
  await mkdir(src, { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), AGENTS_MD)
  const sources = { csv: join(src, MATERIALS.csv), xlsx: join(src, MATERIALS.xlsx) }
  await writeFile(sources.csv, ORDERS_CSV)
  await copyFile(XLSX_SOURCE, sources.xlsx)
  const sourceShaBefore = { csv: await fileSha(sources.csv), xlsx: await fileSha(sources.xlsx) }

  const obs = { platform: process.platform, root, key: SCRIPTED_API_KEY, phases: {} }
  const servers = []
  const envFor = server => ({
    NEXGENT_API_BASE_URL: server.baseUrl,
    NEXGENT_API_KEY: SCRIPTED_API_KEY,
    NEXGENT_HOME: home,
    NEXGENT_COMPACTION_THRESHOLD: String(COMPACTION.threshold),
  })
  const serverFor = async (phase) => {
    const server = await h.scriptedModelServer({ script: script[phase] })
    servers.push(server)
    return server
  }
  const record = (phase, server, extra) => {
    obs.phases[phase] = { ...obs.phases[phase], requests: server.requests.map(r => r.body), ...extra }
  }

  const approvalLog = []
  const responder = async (request) => {
    // A write outside the project asks (ADR 0022) and is denied; of the rest the first is granted once and every later one denied.
    const outside = request.summary.includes('outside-the-project')
    const granted = approvalLog.filter(entry => !entry.request.summary.includes('outside-the-project')).length
    const decision = !outside && granted === 0
      ? { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
      : { id: request.id, decision: 'deny', scope: 'once', decidedBy: 'user' }
    approvalLog.push({ request, decision })
    return decision
  }

  let sdk
  let projectId
  try {
    /** A fresh SDK against this phase's server, with the project and the session open. */
    const open = async (phase) => {
      const server = await serverFor(phase)
      sdk = createStep2Sdk(pkgs, { env: envFor(server), home, approvals: responder })
      projectId = (await sdk.call('projects.open', { root, create: true })).projectId
      if (obs.sessionId === undefined) obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-2 acceptance' })).sessionId
      else await sdk.openSession({ projectId, sessionId: obs.sessionId })
      return server
    }
    const close = async () => {
      await sdk.dispose()
      sdk = undefined
    }
    const turn = async (phase, input, server, options) => {
      log(`phase ${phase}`)
      const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, ...input }, options)
      record(phase, server, { reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent) })
      return result
    }

    // ---- init + materials -------------------------------------------------------------------
    let server = await open('first')
    const configFile = join(root, '.nexgent', 'config.json')
    const layout = await layoutFor(root, home)
    obs.init = {
      configExists: (await fileSha(configFile)) !== null,
      layout: Object.fromEntries(await Promise.all(['sessions', 'materials', 'outputs', 'ledgers'].map(async name => [name, await readdir(layout[name]).then(() => true, () => false)]))),
      dataDir: layout.dataDir,
      strayInProject: await strayDataIn(root),
      realRoot: await realpath(root),
      recent: (await sdk.call('projects.recent', {})).map(p => p.root),
    }
    const materials = []
    for (const kind of ['csv', 'xlsx']) {
      materials.push(await sdk.call('materials.add', { projectId, sourcePath: sources[kind], sessionId: obs.sessionId }))
    }
    obs.materials = materials.map((meta, index) => ({ meta, kind: index === 0 ? 'csv' : 'xlsx' }))

    // ---- first: materials → skill → writes → present v1 ---------------------------------------
    const beforeFirst = await treeHashes(root)
    await turn('first', { text: TASKS.first, materialIds: materials.map(m => m.id) }, server)
    obs.phases.first.treeBefore = beforeFirst
    obs.phases.first.treeAfter = await treeHashes(root)
    const [deliverable] = await sdk.call('deliverables.list', { projectId })
    obs.deliverableAfterFirst = deliverable
    const v1 = deliverable?.versions[0]
    // data-formats.md: `<dataDir>/outputs/<deliverableId>/v<n>/files/<path>`
    const snapshot = file => join(layout.outputs, v1.deliverableId, 'v1', 'files', ...file.path.split('/'))
    const v1Files = v1 === undefined ? [] : await Promise.all(v1.files.map(async file => ({ path: file.path, recorded: file.sha256, snapshot: snapshot(file), afterV1: await fileSha(snapshot(file)) })))
    await close()

    // ---- feedback → v2 ------------------------------------------------------------------------
    server = await open('feedback')
    if (v1 !== undefined) {
      log('phase feedback')
      const events = []
      const unsubscribe = sdk.onAgentEvent(event => { if (event.projectId === projectId) events.push(event) })
      try {
        await sdk.call('feedback.submit', { projectId, sessionId: obs.sessionId, deliverableId: v1.deliverableId, version: 1, rating: 3, comment: TASKS.feedback })
        await h.waitFor(() => events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, obs.sessionId), { timeoutMs: 60_000, intervalMs: 20, label: 'the feedback turn' })
      } finally {
        unsubscribe()
      }
      record('feedback', server, { reason: events.find(e => e.type === 'turn.end')?.reason, events: events.map(slimEvent) })
      const [after] = await sdk.call('deliverables.list', { projectId })
      obs.deliverableAfterFeedback = after
      for (const file of v1Files) file.atEnd = await fileSha(file.snapshot)
      try {
        obs.diff = await sdk.call('deliverables.diff', { projectId, deliverableId: v1.deliverableId, from: 1, to: 2 })
      } catch (error) {
        obs.diffError = String(error)
      }
    } else {
      obs.phases.feedback = { skipped: 'no deliverable after the first turn' }
    }
    obs.v1Files = v1Files.map(({ snapshot: path, ...rest }) => ({ ...rest, snapshot: relative(root, path).split(sep).join('/') }))
    await close()

    // ---- goal ---------------------------------------------------------------------------------
    server = await open('goal')
    obs.goalSet = await sdk.call('goals.set', { projectId, sessionId: obs.sessionId, text: TASKS.goalText })
    await turn('goal', { text: TASKS.goal }, server)
    obs.goalUpdated = await sdk.call('goals.update', { projectId, sessionId: obs.sessionId, status: 'completed', note: 'report delivered' })
    obs.goalAtEnd = await sdk.call('goals.get', { projectId, sessionId: obs.sessionId })
    await close()

    // ---- pause, compaction (failing first, then succeeding), approvals ------------------------
    for (const [phase, text] of [['pause', TASKS.pause], ['compactFail', TASKS.compactFail], ['compact', TASKS.compact], ['approvals', TASKS.approvals]]) {
      server = await open(phase)
      await turn(phase, { text }, server)
      await close()
    }
    obs.approvals = {
      log: approvalLog.map(({ request, decision }) => ({ tool: request.tool, summary: request.summary, risk: request.risk, options: request.options, pattern: request.pattern ?? null, decision: decision.decision, scope: decision.scope })),
      envContent: await readFile(join(root, '.env'), 'utf8').catch(() => null),
      outsideExists: (await fileSha(join(root, '..', 'outside-the-project.txt'))) !== null,
    }

    // ---- in-process cancel: mid-stream, then mid-tool (H12) -----------------------------------
    server = await open('cancelStream')
    let streamed = ''
    let cancelling
    await turn('cancelStream', { text: TASKS.cancelStream }, server, {
      onEvent(event) {
        if (event.type !== 'text.delta') return
        streamed += event.text
        if (cancelling === undefined && streamed.includes(STALL_TEXT.cancel)) cancelling = sdk.cancelTurn({ projectId, sessionId: obs.sessionId, cause: 'user' })
      },
    })
    await cancelling
    obs.phases.cancelStream.streamed = streamed
    await close()

    server = await open('cancelTool')
    // Processes the host keeps for its whole life (the OS sandbox's network bridge, ADR 0022) are not the tool's.
    const hostPids = await h.descendantPids(process.pid)
    let toolStarted
    const started = new Promise(resolve => { toolStarted = resolve })
    const turnDone = turn('cancelTool', { text: TASKS.cancelTool }, server, { onEvent(event) { if (event.type === 'tool.start') toolStarted() } })
    await started
    // Let the shell start its command, then look at our own descendants (the tool's processes).
    let before = []
    await h.waitFor(async () => (before = (await h.descendantPids(process.pid)).filter(pid => !hostPids.includes(pid))).length > 0, { timeoutMs: 15_000, intervalMs: 100, label: 'the slow command to start' }).catch(() => undefined)
    await sdk.cancelTurn({ projectId, sessionId: obs.sessionId, cause: 'user' })
    await turnDone
    await new Promise(resolve => setTimeout(resolve, 500))
    obs.phases.cancelTool.descendantsBefore = before
    obs.phases.cancelTool.survivors = before.filter(h.isProcessAlive)
    obs.viewBeforeKills = await sdkView(sdk, projectId, obs.sessionId)
    await close()

    // ---- kills, each in a child process, then resume through a fresh SDK ----------------------
    const driverRun = async (phase, text) => {
      const s = await serverFor(phase)
      const spec = { root, home, sessionId: obs.sessionId, text, env: envFor(s) }
      return { server: s, handle: h.spawnNode([DRIVER, JSON.stringify(spec)], { cwd: work }) }
    }
    const resumeTurn = async (phase, text) => {
      const beforeRecords = (await readSessionRecordsAt(h, root, home, obs.sessionId)).records
      const openTurnBefore = openTurn(beforeRecords)
      // As the kill left it: recovery on resume may later close dangling calls with a synthetic result.
      const toolResultsBefore = beforeRecords.filter(record => record.turn === openTurnBefore && record.type === 'tool.result').length
      const s = await open(phase)
      log(`phase ${phase}`)
      const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text })
      record(phase, s, { openTurnBefore, toolResultsBefore, reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent) })
    }

    // H15: kill the whole tree while the model is streaming
    {
      log('phase streamKill')
      const { server: s, handle } = await driverRun('streamKill', TASKS.streamKill)
      const ready = await handle.waitForOutput(/"type":"driver\.ready"[^\n]*/, 60_000, 'stdout')
      const sawText = await handle.waitForOutput(new RegExp(STALL_TEXT.kill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60_000, 'stdout').then(() => true, () => false)
      const requestIds = [...handle.stdout.matchAll(/"type":"request\.start","requestId":"([^"]+)"/g)].map(m => m[1])
      const descendantsBefore = await h.descendantPids(handle.pid)
      const exit = await handle.kill('SIGKILL', { tree: true })
      await new Promise(resolve => setTimeout(resolve, 500))
      record('streamKill', s, {
        ready: ready.match?.[0] !== undefined,
        sawText,
        requestIds,
        exit: { code: exit.code, signal: exit.signal },
        mainAlive: h.isProcessAlive(handle.pid),
        descendantsBefore,
        survivors: descendantsBefore.filter(h.isProcessAlive),
      })
    }
    await resumeTurn('resumeAfterStream', TASKS.resumeAfterStream)
    await close()

    // H16: kill only the main process while a shell command runs
    {
      log('phase toolKill')
      const { server: s, handle } = await driverRun('toolKill', TASKS.toolKill)
      const crash = await h.crashDuringTool(handle, { timeoutMs: 60_000, settleMs: 1_000 })
      record('toolKill', s, { crash: { tool: crash.tool, descendantsBefore: crash.descendantsBefore, survivors: crash.survivors, exit: { code: crash.exit.code, signal: crash.exit.signal } } })
      // Orphans (POSIX) are evidence, not something to leave behind.
      for (const pid of crash.survivors) await h.killProcessTree(pid).catch(() => undefined)
    }
    await resumeTurn('resumeAfterTool', TASKS.resumeAfterTool)
    // H18: the same queries after two kills and restarts.
    obs.viewAfterKills = await sdkView(sdk, projectId, obs.sessionId)
    await close()

    // ---- H22: nexgent export, through the CLI -------------------------------------------------
    const exportDir = join(work, 'export')
    log('phase export')
    const cli = h.spawnNode([CLI_BIN, 'export', obs.sessionId, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
    const cliExit = await cli.exit
    const exported = {}
    for (const name of await readdir(exportDir).catch(() => [])) exported[name] = await readFile(join(exportDir, name), 'utf8')
    obs.export = { code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: exported }

    // ---- records, ledger, secret scan ---------------------------------------------------------
    const session = await readSessionRecordsAt(h, root, home, obs.sessionId)
    obs.records = session.records
    obs.recordsTruncated = session.truncated ?? null
    obs.ledger = (await readLedgerRecordsAt(h, root, home)).records
    obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
    obs.exportSecretHits = await filesContaining(exportDir, SCRIPTED_API_KEY, work)
    obs.materials = await Promise.all(obs.materials.map(async m => ({
      ...m,
      copySha: await fileSha(await resolveRecorded(root, home, m.meta.path)),
      sourceShaBefore: sourceShaBefore[m.kind],
      sourceShaAfter: await fileSha(sources[m.kind]),
    })))

    // ---- H21: a second project whose perProject cap is one request ----------------------------
    obs.budget = await runBudgetProject(h, pkgs, script, join(work, 'budget-project'), home, envFor, log, servers)
    return obs
  } finally {
    await sdk?.dispose().catch(() => undefined)
    await Promise.all(servers.map(s => s.close().catch(() => undefined)))
    await h.killAllSpawned().catch(() => undefined)
  }
}

async function runBudgetProject(h, pkgs, script, root, home, envFor, log, servers) {
  log('phase budget')
  const server = await h.scriptedModelServer({ script: script.budget })
  servers.push(server)
  const out = { turns: [] }
  // Two sessions: the cap is per project, so the second session must be stopped by the first one's usage.
  for (let index = 0; index < 2; index += 1) {
    const sdk = createStep2Sdk(pkgs, { env: envFor(server), home })
    try {
      const { projectId } = await sdk.call('projects.open', { root, create: true })
      if (index === 0) {
        const configFile = join(root, '.nexgent', 'config.json')
        const config = JSON.parse(await readFile(configFile, 'utf8'))
        await writeFile(configFile, `${JSON.stringify({ ...config, costCaps: { ...config.costCaps, perProject: { maxRequests: 1 } } }, null, 2)}\n`)
      }
      const { sessionId } = await sdk.call('sessions.create', { projectId, title: `budget ${index + 1}` })
      const { result, error, events } = await runTurn(sdk, { projectId, sessionId, text: TASKS.budget })
      const records = (await readSessionRecordsAt(h, root, home, sessionId)).records
      out.turns.push({ sessionId, reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent), records })
    } finally {
      await sdk.dispose()
    }
  }
  out.requests = server.requests.map(r => r.body)
  out.ledger = (await readLedgerRecordsAt(h, root, home)).records
  return out
}
