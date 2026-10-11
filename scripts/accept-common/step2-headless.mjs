/**
 * The step-2 headless scenario (H checks): drives the in-process runtime
 * (step2-runtime.mjs) and the kill driver (step2-driver.mjs) through the
 * phases of scenario-step2.mjs against the scripted model server, and
 * collects raw observations — request bodies, agent events, session and
 * ledger records, file hashes, process ids. It judges nothing: the H judges
 * (step2-judges.mjs) decide each item from these observations, so a judge
 * can be tested against a deliberately broken copy.
 *
 * Never calls a real model: every app boots against a loopback server.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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
import { bootStep2, loadStep2Packages, runTurn } from './step2-runtime.mjs'

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

  const obs = {
    platform: process.platform,
    root,
    key: SCRIPTED_API_KEY,
    phases: {},
    closes: 0,
  }
  const servers = []
  const context = { compaction: { thresholdTokens: COMPACTION.threshold } }
  const envFor = server => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })

  /** One scripted server per phase, so each phase's requests are its own. */
  const serverFor = async (phase) => {
    const server = await h.scriptedModelServer({ script: script[phase] })
    servers.push(server)
    return server
  }
  const record = (phase, server, extra) => {
    obs.phases[phase] = { ...obs.phases[phase], requests: server.requests.map(r => r.body), ...extra }
  }

  const approvalLog = []
  let approvalCount = 0
  const responder = async (request) => {
    approvalCount += 1
    // The first approval is granted once; every later one is denied.
    const decision = approvalCount === 1
      ? { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
      : { id: request.id, decision: 'deny', scope: 'once', decidedBy: 'user' }
    approvalLog.push({ request, decision })
    return decision
  }

  try {
    // ---- in-process phases, one app per server ------------------------------------------
    let booted
    let agent
    const open = async (phase) => {
      const server = await serverFor(phase)
      booted = await bootStep2(pkgs, { root, env: envFor(server), context, approvals: responder })
      agent = obs.sessionId === undefined ? await booted.app.agents.create({ title: 'step-2 acceptance' }) : await booted.app.agents.resume(obs.sessionId)
      obs.sessionId ??= agent.sessionId
      return server
    }
    const close = async () => {
      await agent.close()
      obs.closes += 1
      await booted.app.dispose()
    }
    const turn = async (phase, input, server, options) => {
      log(`phase ${phase}`)
      const { result, error, events } = await runTurn(agent, input, options)
      record(phase, server, { reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent) })
      return result
    }

    // init + materials
    let server = await open('first')
    obs.init = {
      configFile: booted.ctx.workspace.layout.configFile,
      configExists: (await fileSha(booted.ctx.workspace.layout.configFile)) !== null,
      layout: Object.fromEntries(await Promise.all(['sessions', 'materials', 'outputs', 'ledgers'].map(async name => [name, await readdir(booted.ctx.workspace.layout[name]).then(() => true, () => false)]))),
    }
    const materials = []
    for (const kind of ['csv', 'xlsx']) {
      const meta = await booted.tasking.materials.add({ sourcePath: sources[kind], sessionId: obs.sessionId })
      await agent.appendHostRecord(pkgs.tasking.materialAddedRecord(meta))
      materials.push(meta)
    }
    obs.materials = materials.map((meta, index) => ({ meta, kind: index === 0 ? 'csv' : 'xlsx' }))

    // first
    const beforeFirst = await treeHashes(root)
    await turn('first', { text: TASKS.first, materialIds: materials.map(m => m.id) }, server)
    obs.phases.first.treeBefore = beforeFirst
    obs.phases.first.treeAfter = await treeHashes(root)

    // feedback
    const [deliverable] = await booted.tasking.deliverables.list()
    obs.deliverableAfterFirst = deliverable
    const v1Files = deliverable === undefined ? [] : deliverable.versions[0].files.map(file => ({
      path: file.path,
      recorded: file.sha256,
      snapshot: booted.tasking.deliverables.snapshotPath(deliverable.id ?? deliverable.versions[0].deliverableId, 1, file.path),
    }))
    for (const file of v1Files) file.afterV1 = await fileSha(file.snapshot)
    await close()
    server = await open('feedback')
    if (deliverable !== undefined) {
      const feedback = await pkgs.tasking.createFeedbackEntry({ deliverableId: deliverable.versions[0].deliverableId, version: 1, rating: 3, comment: TASKS.feedback }, booted.tasking.deliverables)
      obs.feedbackEntry = feedback
      await turn('feedback', { source: 'feedback', feedback }, server)
      const [after] = await booted.tasking.deliverables.list()
      obs.deliverableAfterFeedback = after
      for (const file of v1Files) file.atEnd = await fileSha(file.snapshot)
      obs.v1Files = v1Files.map(({ snapshot, ...rest }) => ({ ...rest, snapshot: relative(root, snapshot).split(sep).join('/') }))
      try {
        obs.diff = await booted.tasking.deliverables.diff(deliverable.versions[0].deliverableId, 1, 2)
      } catch (error) {
        obs.diffError = String(error)
      }
    } else {
      obs.phases.feedback = { skipped: 'no deliverable after the first turn' }
    }
    await close()

    // goal
    server = await open('goal')
    obs.goalSet = await booted.tasking.goals.set(agent.appendHostRecord, TASKS.goalText)
    await turn('goal', { text: TASKS.goal }, server)
    obs.goalUpdated = await booted.tasking.goals.update(agent.appendHostRecord, obs.sessionId, { status: 'completed', note: 'report delivered' })
    obs.goalAtEnd = await booted.tasking.goals.get(obs.sessionId)
    await close()

    // pause, compaction (failing first, then succeeding), approvals
    for (const [phase, text] of [['pause', TASKS.pause], ['compactFail', TASKS.compactFail], ['compact', TASKS.compact], ['approvals', TASKS.approvals]]) {
      server = await open(phase)
      await turn(phase, { text }, server)
      await close()
    }
    obs.approvals = {
      log: approvalLog.map(({ request, decision }) => ({ tool: request.tool, summary: request.summary, options: request.options, decision: decision.decision, scope: decision.scope })),
      envContent: await readFile(join(root, '.env'), 'utf8').catch(() => null),
      outsideExists: (await fileSha(join(root, '..', 'outside-the-project.txt'))) !== null,
    }

    // in-process cancel: mid-stream, then mid-tool (H12)
    server = await open('cancelStream')
    let streamed = ''
    await turn('cancelStream', { text: TASKS.cancelStream }, server, {
      onEvent(event, a) {
        if (event.type === 'text.delta') {
          streamed += event.text
          if (streamed.includes(STALL_TEXT.cancel)) a.cancel('user')
        }
      },
    })
    obs.phases.cancelStream.streamed = streamed
    await close()
    server = await open('cancelTool')
    let cancelled
    const toolStarted = new Promise(resolve => { cancelled = resolve })
    const turnDone = turn('cancelTool', { text: TASKS.cancelTool }, server, {
      onEvent(event) {
        if (event.type === 'tool.start') cancelled()
      },
    })
    await toolStarted
    // Let the shell start its command, then look at our own descendants (the tool's processes).
    let before = []
    await h.waitFor(async () => (before = await h.descendantPids(process.pid)).length > 0, { timeoutMs: 15_000, intervalMs: 100, label: 'the slow command to start' }).catch(() => undefined)
    agent.cancel('user')
    await turnDone
    await new Promise(resolve => setTimeout(resolve, 500))
    obs.phases.cancelTool.descendantsBefore = before
    obs.phases.cancelTool.survivors = before.filter(h.isProcessAlive)
    await close()

    // ---- kills, each in a child process, then resume in-process --------------------------
    const driverRun = async (phase, text) => {
      const s = await serverFor(phase)
      const spec = { root, sessionId: obs.sessionId, text, env: envFor(s), context }
      return { server: s, handle: h.spawnNode([DRIVER, JSON.stringify(spec)], { cwd: work }) }
    }
    const resumeTurn = async (phase, text) => {
      const s = await serverFor(phase)
      booted = await bootStep2(pkgs, { root, env: envFor(s), context, approvals: responder })
      const metaBefore = await booted.ctx.session.resume(obs.sessionId)
      const openTurn = metaBefore.metadata.openTurn
      agent = await booted.app.agents.resume(obs.sessionId)
      log(`phase ${phase}`)
      const { result, error, events } = await runTurn(agent, { text })
      record(phase, s, { openTurnBefore: openTurn, reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent) })
      await close()
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

    // ---- records, ledger, secret scan --------------------------------------------------------
    const session = await h.readSessionRecords(root, obs.sessionId)
    obs.records = session.records
    obs.recordsTruncated = session.truncated ?? null
    obs.ledger = (await h.readLedgerRecords(root)).records
    obs.secretHits = await filesContaining(join(root, '.nexgent'), SCRIPTED_API_KEY, root)
    obs.materials = await Promise.all(obs.materials.map(async m => ({
      ...m,
      copySha: await fileSha(join(root, ...m.meta.path.split('/'))),
      sourceShaBefore: sourceShaBefore[m.kind],
      sourceShaAfter: await fileSha(sources[m.kind]),
    })))

    // ---- H21: a second project whose perProject cap is one request -------------------------
    obs.budget = await runBudgetProject(h, pkgs, script, join(work, 'budget-project'), home, log, servers)
    return obs
  } finally {
    await Promise.all(servers.map(s => s.close().catch(() => undefined)))
    await h.killAllSpawned().catch(() => undefined)
  }
}

async function runBudgetProject(h, pkgs, script, root, home, log, servers) {
  log('phase budget')
  const server = await h.scriptedModelServer({ script: script.budget })
  servers.push(server)
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  await mkdir(root, { recursive: true })
  await pkgs.cli.initProjectLayout(root)
  const configFile = join(root, '.nexgent', 'config.json')
  const config = JSON.parse(await readFile(configFile, 'utf8').catch(() => '{}'))
  await writeFile(configFile, `${JSON.stringify({ ...config, costCaps: { ...config.costCaps, perProject: { maxRequests: 1 } } }, null, 2)}\n`)
  const out = { turns: [] }
  // Two sessions: the cap is per project, so the second session must be stopped by the first one's usage.
  for (let index = 0; index < 2; index += 1) {
    const booted = await bootStep2(pkgs, { root, env })
    const agent = await booted.app.agents.create({ title: `budget ${index + 1}` })
    const { result, error, events } = await runTurn(agent, { text: TASKS.budget })
    await agent.close()
    await booted.app.dispose()
    const records = (await h.readSessionRecords(root, agent.sessionId)).records
    out.turns.push({ sessionId: agent.sessionId, reason: result?.reason, error: error === undefined ? undefined : String(error), events: events.map(slimEvent), records })
  }
  out.requests = server.requests.map(r => r.body)
  out.ledger = (await h.readLedgerRecords(root)).records
  return out
}
