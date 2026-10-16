/**
 * The headless scenario of accept-step3: drives `@nexgent/sdk` through the
 * phases of step3-scenario.mjs against the scripted model server (requests
 * routed per session by the member line) and collects raw observations —
 * request bodies, session files and records, ledger lines, deliverables, the
 * `nexgent export` output, secret scans, the repository inventory. It judges
 * nothing: step3-judges.mjs decides each item from these observations.
 *
 * Never calls a real model: every SDK is created against a loopback server.
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from './harness.mjs'
import { BUDGET, CANCEL_MEMBERS, MATERIAL, MEMBER_ENV, PAGE, SKILLS, SCRIPTED_API_KEY, STALL_TEXT, TASKS, TOOL_FILES, WF_STALL_TEXT, buildStep3Script, readonlyPresets } from './step3-scenario.mjs'
import { filesContaining } from './step2-headless.mjs'
import { layoutFor, readLedgerRecordsAt, readSessionRecordsAt, scanSecrets } from './data-dir.mjs'
import { CLI_BIN, runTurn } from './step2-runtime.mjs'
import { TEST_WEB_ADDRESS, TEST_WEB_HOST, createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'

/** The kill driver: one SDK turn in a child process (step3-driver.mjs). */
export const DRIVER = fileURLToPath(new URL('./step3-driver.mjs', import.meta.url))

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'reference'])

/** Every file under `root`, repo-relative with `/`, skipping VCS, dependencies, build output and the DSH submodule. */
async function walk(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, join(dir, entry.name), out)
    } else {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return out
}

/**
 * The repository's files: `git ls-files` when the root is a checkout, else a
 * directory walk (a source archive). Both use `/` separators.
 * @returns `{ source, files }`.
 */
export async function repoInventory(root = REPO_ROOT) {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (git.status === 0 && git.stdout.length > 0) {
    return { source: 'git ls-files', files: git.stdout.split('\0').filter(Boolean) }
  }
  return { source: 'directory walk', files: await walk(root) }
}

/** Session ids that have a session file (data-formats.md: `<dataDir>/sessions/<sessionId>/session.jsonl`). */
async function sessionFiles(root, home) {
  const dir = (await layoutFor(root, home)).sessions
  const ids = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && (await readdir(join(dir, entry.name)).catch(() => [])).includes('session.jsonl')) ids.push(entry.name)
  }
  return ids.sort()
}

/**
 * The direct-execution phase (H01, H10, H22): one session, one turn, no members.
 * @returns the phase's observations.
 */
async function runDirect(h, pkgs, work, script, servers, log) {
  const root = join(work, 'direct-project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  const server = await h.scriptedModelServer({ script: script.direct.lead, routes: script.direct.routes, routeKey: h.routeByMember(h.sessionText) })
  servers.push(server)
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  const sdk = createStep3Sdk(pkgs, { env, home })
  const obs = { root, key: SCRIPTED_API_KEY }
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 direct' })).sessionId
    log('phase direct')
    const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.direct })
    obs.reason = result?.reason
    obs.error = error === undefined ? undefined : String(error)
    obs.toolCalls = events.filter(e => e.type === 'tool.result').map(e => ({ name: e.result.name, isError: e.result.isError }))
    obs.listed = (await sdk.call('sessions.list', { projectId })).map(s => ({ sessionId: s.sessionId, parentSessionId: s.parentSessionId, childCount: s.childCount }))
    obs.deliverables = (await sdk.call('deliverables.list', { projectId })).map(d => ({ deliverableId: d.deliverableId, versions: d.versions.map(v => ({ version: v.version, sessionId: v.sessionId, memberId: v.memberId, files: v.files.map(f => f.path) })) }))
  } finally {
    await sdk.dispose()
  }
  obs.requests = server.requests.map(r => ({ route: r.route ?? null, outcome: r.outcome, status: r.outcome === 'completed' ? 'ok' : r.outcome }))
  obs.unconsumed = server.remainingByRoute()
  obs.sessionFiles = await sessionFiles(root, home)
  obs.sessions = {}
  for (const id of obs.sessionFiles) {
    const read = await readSessionRecordsAt(h, root, home, id)
    obs.sessions[id] = { records: read.records, truncated: read.truncated ?? null }
  }
  obs.ledger = (await readLedgerRecordsAt(h, root, home)).records

  const exportDir = join(work, 'direct-export')
  log('phase direct export')
  const cli = h.spawnNode([CLI_BIN, 'export', obs.sessionId, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
  const cliExit = await cli.exit
  const exported = {}
  for (const name of await readdir(exportDir).catch(() => [])) exported[name] = await readFile(join(exportDir, name), 'utf8')
  obs.export = { code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: exported }
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  obs.exportSecretHits = await filesContaining(exportDir, SCRIPTED_API_KEY, work)
  return obs
}

/** Tool results of a turn's events (the root's and its members'). */
const toolResultsOf = events => events.filter(e => e.type === 'tool.result').map(e => ({
  sessionId: e.sessionId,
  name: e.result.name,
  callId: e.result.toolCallId ?? e.result.callId ?? e.result.id,
  isError: e.result.isError,
  code: e.error?.code ?? e.result.error?.code,
  content: typeof e.result.content === 'string' ? e.result.content : JSON.stringify(e.result.content),
}))

/**
 * The local page server of H19, on {@link TEST_WEB_ADDRESS}: `/stock.html` is the page,
 * `/redirect` sends a 302 to the same page on 127.0.0.1. Counts requests per path.
 */
async function pageServer() {
  const hits = {}
  let port
  const server = createServer((req, res) => {
    hits[req.url] = (hits[req.url] ?? 0) + 1
    if (req.url === '/stock.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE.html)
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/stock.html` })
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, TEST_WEB_ADDRESS, resolve))
  port = server.address().port
  return {
    hits,
    pageUrl: `http://${TEST_WEB_HOST}:${port}/stock.html`,
    loopbackUrl: `http://127.0.0.1:${port}/stock.html`,
    redirectUrl: `http://${TEST_WEB_HOST}:${port}/redirect`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** Tool names a request offered the model. */
const toolNames = body => (Array.isArray(body?.tools) ? body.tools.map(t => t?.name).filter(n => typeof n === 'string') : [])

/** One server request, slimmed: its route, the session text (system prompt + first user message), full text, tools. */
function slimRequest(h, phase, r) {
  return {
    phase,
    route: r.route ?? null,
    outcome: r.outcome,
    chunksSent: r.chunksSent,
    sessionText: h.sessionText(r.body ?? {}),
    text: h.requestText(r.body ?? {}),
    tools: toolNames(r.body),
  }
}

/** Every session file of a project, its records and torn tail. */
async function readSessions(h, root, home) {
  const files = await sessionFiles(root, home)
  const sessions = {}
  for (const id of files) {
    const read = await readSessionRecordsAt(h, root, home, id)
    sessions[id] = { records: read.records, truncated: read.truncated ?? null }
  }
  return { sessionFiles: files, sessions }
}

const slimDeliverables = async (sdk, projectId) => (await sdk.call('deliverables.list', { projectId })).map(d => ({
  deliverableId: d.deliverableId,
  versions: d.versions.map(v => ({ version: v.version, sessionId: v.sessionId, memberId: v.memberId, files: v.files.map(f => f.path) })),
}))

/**
 * The delegation project (H02, H03, H04, H15, H16): one root session; setup, fresh, fork and
 * same-name turns in process; a fork member killed in a child process; a resume turn after it.
 */
async function runDelegation(h, pkgs, work, servers, log) {
  const root = join(work, 'delegation-project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  const source = join(work, MATERIAL.name)
  await writeFile(source, MATERIAL.content)
  const state = {}
  const script = buildStep3Script(h, state)
  const obs = { root, phases: {}, requests: [] }
  const serverFor = async (phase) => {
    const server = await h.scriptedModelServer({ script: script[phase].lead, routes: script[phase].routes, routeKey: h.routeByMember(h.sessionText) })
    servers.push({ phase, server })
    return server
  }
  const envFor = server => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })
  const collect = (phase, server, extra = {}) => {
    obs.requests.push(...server.requests.map(r => slimRequest(h, phase, r)))
    obs.phases[phase] = { ...(obs.phases[phase] ?? {}), ...extra, unconsumed: server.remainingByRoute() }
  }
  const turn = async (sdk, projectId, phase, text, materialIds) => {
    log(`phase ${phase}`)
    const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text, ...(materialIds === undefined ? {} : { materialIds }) })
    return {
      reason: result?.reason,
      error: error === undefined ? undefined : String(error),
      toolResults: toolResultsOf(events),
    }
  }

  // ---- in process: setup, fresh, fork, sameName (one server for the delegation phase) ------------
  const server = await serverFor('delegation')
  let sdk = createStep3Sdk(pkgs, { env: envFor(server), home })
  let projectId
  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 delegation' })).sessionId
    const material = await sdk.call('materials.add', { projectId, sourcePath: source, sessionId: obs.sessionId })
    state.materialId = material.id
    obs.materialId = material.id
    for (const phase of ['setup', 'fresh', 'fork', 'sameName']) {
      obs.phases[phase] = await turn(sdk, projectId, phase, TASKS[phase])
    }
  } finally {
    await sdk.dispose()
  }
  collect('delegation', server)

  // ---- forkKill: a fork member stalls mid-stream in a child process; kill the whole tree ---------
  {
    log('phase forkKill')
    const s = await serverFor('forkKill')
    const spec = { root, home, sessionId: obs.sessionId, text: TASKS.forkKill, env: envFor(s) }
    const handle = h.spawnNode([DRIVER, JSON.stringify(spec)], { cwd: work })
    const ready = await handle.waitForOutput(/"type":"driver\.ready"[^\n]*/, 60_000, 'stdout').then(() => true, () => false)
    const streaming = await h.waitFor(() => s.requests.find(r => r.route === 'forker-two' && r.chunksSent >= 1), { timeoutMs: 60_000, label: 'forker-two streaming' }).then(() => true, () => false)
    const exit = await handle.kill('SIGKILL', { tree: true })
    await new Promise(resolve => setTimeout(resolve, 300))
    collect('forkKill', s, { ready, streaming, stallText: STALL_TEXT, exit: { code: exit.code, signal: exit.signal }, mainAlive: h.isProcessAlive(handle.pid) })
  }
  obs.afterKill = await readSessions(h, root, home)

  // ---- resume: a fresh SDK reopens the root session and runs a plain turn ------------------------
  {
    const s = await serverFor('resume')
    sdk = createStep3Sdk(pkgs, { env: envFor(s), home })
    try {
      projectId = (await sdk.call('projects.open', { root })).projectId
      await sdk.openSession({ projectId, sessionId: obs.sessionId })
      obs.phases.resume = await turn(sdk, projectId, 'resume', TASKS.resume)
      obs.listed = (await sdk.call('sessions.list', { projectId })).map(x => ({ sessionId: x.sessionId, parentSessionId: x.parentSessionId, childCount: x.childCount }))
      obs.deliverables = await slimDeliverables(sdk, projectId)
    } finally {
      await sdk.dispose()
    }
    collect('resume', s)
  }
  Object.assign(obs, await readSessions(h, root, home))
  obs.ledger = (await readLedgerRecordsAt(h, root, home)).records
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  return obs
}

/**
 * The read-only project (H12): sandbox read-only, two project presets; one turn that delegates
 * with a wider preset (refused) and with a preset that denies the shell.
 */
async function runReadonly(h, pkgs, work, servers, log, web) {
  const root = join(work, 'readonly-project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  const script = buildStep3Script(h, { pageUrl: web.pageUrl })
  const presets = readonlyPresets()
  const obs = { root, shell: presets.shell, requests: [] }
  const server = await h.scriptedModelServer({ script: script.readonly.lead, routes: script.readonly.routes, routeKey: h.routeByMember(h.sessionText) })
  servers.push({ phase: 'readonly', server })
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  // Create the project, then make it read-only and add the presets before a fresh SDK opens it.
  let sdk = createStep3Sdk(pkgs, { env, home })
  try {
    await sdk.call('projects.open', { root, create: true })
  } finally {
    await sdk.dispose()
  }
  const configFile = join(root, '.nexgent', 'config.json')
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  await writeFile(configFile, `${JSON.stringify({ ...config, sandboxMode: 'read-only' }, null, 2)}\n`)
  await mkdir(join(root, '.nexgent', 'presets'), { recursive: true })
  for (const [name, preset] of Object.entries(presets.files)) {
    await writeFile(join(root, '.nexgent', 'presets', `${name}.json`), `${JSON.stringify(preset, null, 2)}\n`)
  }
  sdk = createStep3Sdk(pkgs, { env, home })
  try {
    const { projectId } = await sdk.call('projects.open', { root })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 read-only' })).sessionId
    log('phase readonly')
    const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.readonly })
    obs.reason = result?.reason
    obs.error = error === undefined ? undefined : String(error)
    obs.toolResults = toolResultsOf(events)
  } finally {
    await sdk.dispose()
  }
  obs.requests = server.requests.map(r => slimRequest(h, 'readonly', r))
  obs.unconsumed = server.remainingByRoute()
  Object.assign(obs, await readSessions(h, root, home))
  obs.ledger = (await readLedgerRecordsAt(h, root, home)).records
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  return obs
}

/**
 * The tools project (H17, H18, H19): one root session, direct turns using run_code,
 * write_spreadsheet and the test web_fetch row.
 */
async function runTools(h, pkgs, work, servers, log, web) {
  const root = join(work, 'tools-project')
  const home = join(work, 'home')
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, TOOL_FILES.input.path), TOOL_FILES.input.content)
  const outsidePath = join(work, TOOL_FILES.outside)
  await writeFile(outsidePath, 'OUTSIDE-SECRET\n')
  const script = buildStep3Script(h, { pageUrl: web.pageUrl, loopbackUrl: web.loopbackUrl, redirectUrl: web.redirectUrl, outsidePath })
  const server = await h.scriptedModelServer({ script: script.tools.lead, routes: script.tools.routes, routeKey: h.routeByMember(h.sessionText) })
  servers.push({ phase: 'tools', server })
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  const obs = { root, outsidePath, phases: {}, approvals: [] }
  const sdk = createStep3Sdk(pkgs, { env, home, web: 'test' })
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 tools' })).sessionId
    for (const phase of ['ptc', 'sheet', 'web']) {
      log(`phase ${phase}`)
      // ADR 0022 decision 2: reading outside the project asks; the caller says no.
      const onEvent = (event) => {
        if (event.type !== 'approval.request') return
        const entry = { phase, request: event.request }
        obs.approvals.push(entry)
        entry.answered = sdk.call('approvals.respond', { projectId, sessionId: event.request.sessionId, decision: { id: event.request.id, decision: 'deny', scope: 'once' } })
          .then(ok => ok, error => `error: ${error instanceof Error ? error.message : String(error)}`)
      }
      const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS[phase] }, { onEvent })
      for (const entry of obs.approvals) entry.answered = await entry.answered
      obs.phases[phase] = { reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events) }
      if (phase === 'ptc') {
        // The timed-out program printed its pid; it must be gone once the tool returned.
        const pid = Number(/PTC-PID=(\d+)/.exec(obs.phases.ptc.toolResults.find(t => t.callId === 'call-ptc-timeout')?.content ?? '')?.[1])
        obs.phases.ptc.timeoutPid = Number.isInteger(pid) ? pid : null
        obs.phases.ptc.timeoutPidAlive = Number.isInteger(pid) ? h.isProcessAlive(pid) : null
        obs.phases.ptc.descendants = await h.descendantPids(process.pid)
      }
    }
  } finally {
    await sdk.dispose()
  }
  obs.requests = server.requests.map(r => slimRequest(h, 'tools', r))
  obs.unconsumed = server.remainingByRoute()
  obs.files = {}
  for (const path of [TOOL_FILES.output, TOOL_FILES.sheet, ...TOOL_FILES.rejected]) {
    obs.files[path] = await readFile(join(root, path)).then(bytes => bytes.toString('base64'), () => null)
  }
  obs.webHits = { ...web.hits }
  Object.assign(obs, await readSessions(h, root, home))
  obs.ledger = (await readLedgerRecordsAt(h, root, home)).records
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  return obs
}

/**
 * The workflow project (H07, H08, H09): a script workflow and graphs in process; a workflow
 * killed in a child process while its second member streams; a resume turn after it.
 */
async function runWorkflowProject(h, pkgs, work, servers, log) {
  const root = join(work, 'workflow-project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  const script = buildStep3Script(h)
  const obs = { root, phases: {}, requests: [] }
  const serverFor = async (phase) => {
    const server = await h.scriptedModelServer({ script: script[phase].lead, routes: script[phase].routes, routeKey: h.routeByMember(h.sessionText) })
    servers.push({ phase, server })
    return server
  }
  const envFor = server => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })
  const collect = (phase, server, extra = {}) => {
    obs.requests.push(...server.requests.map(r => slimRequest(h, phase, r)))
    obs.phases[phase] = { ...(obs.phases[phase] ?? {}), ...extra, unconsumed: server.remainingByRoute() }
  }
  const turn = async (sdk, projectId, phase) => {
    log(`phase ${phase}`)
    const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS[phase] })
    obs.phases[phase] = { reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events) }
  }

  const server = await serverFor('workflow')
  let sdk = createStep3Sdk(pkgs, { env: envFor(server), home })
  let projectId
  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 workflow' })).sessionId
    await turn(sdk, projectId, 'wfScript')
    await turn(sdk, projectId, 'wfGraph')
  } finally {
    await sdk.dispose()
  }
  collect('workflow', server)
  obs.architectures = await readdir(join(root, '.nexgent', 'architectures')).catch(() => [])

  {
    log('phase wfKill')
    const s = await serverFor('wfKill')
    const spec = { root, home, sessionId: obs.sessionId, text: TASKS.wfKill, env: envFor(s) }
    const handle = h.spawnNode([DRIVER, JSON.stringify(spec)], { cwd: work })
    const ready = await handle.waitForOutput(/"type":"driver\.ready"[^\n]*/, 60_000, 'stdout').then(() => true, () => false)
    const streaming = await h.waitFor(() => s.requests.find(r => r.route === 'late' && r.chunksSent >= 1), { timeoutMs: 60_000, label: 'late member streaming' }).then(() => true, () => false)
    const descendantsBefore = await h.descendantPids(handle.pid)
    const exit = await handle.kill('SIGKILL', { tree: true })
    // The workflow script runs in its own process group (@nexgent/ptc); it must notice the host is gone.
    const survivorsAt = async () => descendantsBefore.filter(h.isProcessAlive)
    const settled = await h.waitFor(async () => (await survivorsAt()).length === 0, { timeoutMs: 5_000, label: 'workflow processes gone' }).then(() => true, () => false)
    const survivors = await survivorsAt()
    for (const pid of survivors) await h.killProcessTree(pid).catch(() => undefined)
    collect('wfKill', s, { ready, streaming, stallText: WF_STALL_TEXT, exit: { code: exit.code, signal: exit.signal }, mainAlive: h.isProcessAlive(handle.pid), descendantsBefore, survivors, settled })
  }
  obs.afterKill = await readSessions(h, root, home)

  {
    const s = await serverFor('wfResume')
    sdk = createStep3Sdk(pkgs, { env: envFor(s), home })
    try {
      projectId = (await sdk.call('projects.open', { root })).projectId
      await sdk.openSession({ projectId, sessionId: obs.sessionId })
      await turn(sdk, projectId, 'wfResume')
      obs.deliverables = await slimDeliverables(sdk, projectId)
    } finally {
      await sdk.dispose()
    }
    collect('wfResume', s)
  }
  Object.assign(obs, await readSessions(h, root, home))
  obs.ledger = (await readLedgerRecordsAt(h, root, home)).records
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  return obs
}

/** Server, SDK and collection helpers for one project of the scenario. */
function projectKit(h, pkgs, work, servers, script, obs, home) {
  const serverFor = async (phase) => {
    const server = await h.scriptedModelServer({ script: script[phase].lead, routes: script[phase].routes, routeKey: h.routeByMember(h.sessionText) })
    servers.push({ phase, server })
    return server
  }
  const envFor = server => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })
  const collect = (phase, server, extra = {}) => {
    obs.requests.push(...server.requests.map(r => slimRequest(h, phase, r)))
    obs.phases[phase] = { ...(obs.phases[phase] ?? {}), ...extra, unconsumed: server.remainingByRoute() }
  }
  const finish = async () => {
    Object.assign(obs, await readSessions(h, obs.root, home))
    obs.ledger = (await readLedgerRecordsAt(h, obs.root, home)).records
    obs.secretHits = await scanSecrets(filesContaining, obs.root, home, SCRIPTED_API_KEY)
  }
  return { serverFor, envFor, collect, finish, sdkFor: server => createStep3Sdk(pkgs, { env: envFor(server), home }) }
}

/** The team state the Lead's records give (@nexgent/team `reduceTeam`), as plain data. */
function teamState(pkgs, records) {
  const state = pkgs.team.reduceTeam(records)
  return { members: [...state.members.values()], tasks: [...state.tasks.values()], messages: [...state.messages.values()] }
}

/** The team project (H05): one Lead turn with two teammates. */
async function runTeam(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'team-project'), phases: {}, requests: [] }
  await mkdir(obs.root, { recursive: true })
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, join(work, 'home'))
  const server = await kit.serverFor('teamWork')
  const sdk = kit.sdkFor(server)
  try {
    const { projectId } = await sdk.call('projects.open', { root: obs.root, create: true })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 team' })).sessionId
    log('phase teamWork')
    const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.teamWork })
    obs.phases.teamWork = { reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events) }
    obs.deliverables = await slimDeliverables(sdk, projectId)
  } finally {
    await sdk.dispose()
  }
  kit.collect('teamWork', server)
  obs.files = {}
  for (const path of ['alice/a.md', 'bob/b.md']) obs.files[path] = await readFile(join(obs.root, path), 'utf8').catch(() => null)
  await kit.finish()
  obs.teamState = teamState(pkgs, obs.sessions[obs.sessionId]?.records ?? [])
  return obs
}

/** The team-kill project (H06): a Lead killed in a child process with two messages queued, then resumed. */
async function runTeamKill(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'team-kill-project'), phases: {}, requests: [] }
  await mkdir(obs.root, { recursive: true })
  const home = join(work, 'home')
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, home)
  {
    const s = await kit.serverFor('teamKill')
    const sdk = kit.sdkFor(s)
    try {
      const { projectId } = await sdk.call('projects.open', { root: obs.root, create: true })
      obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 team kill' })).sessionId
    } finally {
      await sdk.dispose()
    }
    log('phase teamKill')
    const handle = h.spawnNode([DRIVER, JSON.stringify({ root: obs.root, home, sessionId: obs.sessionId, text: TASKS.teamKill, env: kit.envFor(s) })], { cwd: work })
    const ready = await handle.waitForOutput(/"type":"driver\.ready"[^\n]*/, 60_000, 'stdout').then(() => true, () => false)
    // Alice's third request comes after both of her messages were queued; the Lead is stalled in its own request.
    const stalled = await h.waitFor(() => s.requests.filter(r => r.route === 'alice').length >= 3 && s.requests.filter(r => r.route === 'alice')[2].chunksSent >= 1, { timeoutMs: 60_000, label: 'alice third request' }).then(() => true, () => false)
    const descendantsBefore = await h.descendantPids(handle.pid)
    const exit = await handle.kill('SIGKILL', { tree: true })
    const settled = await h.waitFor(() => descendantsBefore.every(pid => !h.isProcessAlive(pid)), { timeoutMs: 5_000, label: 'driver processes gone' }).then(() => true, () => false)
    kit.collect('teamKill', s, { ready, stalled, exit: { code: exit.code, signal: exit.signal }, mainAlive: h.isProcessAlive(handle.pid), settled })
  }
  obs.afterKill = await readSessions(h, obs.root, home)
  obs.atKill = teamState(pkgs, obs.afterKill.sessions[obs.sessionId]?.records ?? [])
  {
    const s = await kit.serverFor('teamResume')
    const sdk = kit.sdkFor(s)
    try {
      const { projectId } = await sdk.call('projects.open', { root: obs.root })
      await sdk.openSession({ projectId, sessionId: obs.sessionId })
      log('phase teamResume')
      const { result, error, events } = await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.teamResume })
      obs.phases.teamResume = { reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events) }
    } finally {
      await sdk.dispose()
    }
    kit.collect('teamResume', s)
  }
  await kit.finish()
  obs.teamState = teamState(pkgs, obs.sessions[obs.sessionId]?.records ?? [])
  obs.prompts = { continue: pkgs.team.CONTINUE_PROMPT, wake: pkgs.team.WAKE_PROMPT }
  return obs
}

/**
 * The cancel project (H13): three turns, each cancelled by the caller once its members are
 * all running the slow command (a delegated member, two teammates, two workflow members).
 */
async function runCancel(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'cancel-project'), phases: {}, requests: [] }
  await mkdir(obs.root, { recursive: true })
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, join(work, 'home'))
  let projectId
  for (const phase of ['cancelDelegate', 'cancelTeam', 'cancelWorkflow']) {
    const server = await kit.serverFor(phase)
    const sdk = kit.sdkFor(server)
    try {
      projectId = (await sdk.call('projects.open', { root: obs.root, create: true })).projectId
      if (obs.sessionId === undefined) obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 cancel' })).sessionId
      else await sdk.openSession({ projectId, sessionId: obs.sessionId })
      log(`phase ${phase}`)
      const want = CANCEL_MEMBERS[phase].length
      // Processes the host keeps for its whole life (the OS sandbox's network bridge, ADR 0022) are not the turn's.
      const host = await h.descendantPids(process.pid)
      const turnPids = async () => (await h.descendantPids(process.pid)).filter(pid => !host.includes(pid))
      const turnDone = runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS[phase] })
      // Every member is in its slow command: one shell process tree per member under this process.
      let before = []
      const running = await h.waitFor(async () => {
        const shells = server.requests.filter(r => r.route !== undefined && r.outcome === 'completed').length
        before = await turnPids()
        return shells >= want && before.length >= want
      }, { timeoutMs: 30_000, intervalMs: 100, label: `${phase}: members running` }).then(() => true, () => false)
      await new Promise(resolve => setTimeout(resolve, 300))
      before = await turnPids()
      await sdk.cancelTurn({ projectId, sessionId: obs.sessionId, cause: 'user' })
      const { result, error, events } = await turnDone
      await h.waitFor(() => before.every(pid => !h.isProcessAlive(pid)), { timeoutMs: 5_000, label: 'slow commands gone' }).catch(() => undefined)
      kit.collect(phase, server, { running, reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events), descendantsBefore: before, survivors: before.filter(h.isProcessAlive) })
    } finally {
      await sdk.dispose()
    }
  }
  await kit.finish()
  return obs
}

/** One turn's result as the judges read it. */
const turnObs = ({ result, error, events }) => ({ reason: result?.reason, error: error === undefined ? undefined : String(error), toolResults: toolResultsOf(events) })

/** The budget project (H11): perTask maxRequests 2; the member's request uses the cap up. */
async function runBudget(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'budget-project'), phases: {}, requests: [], cap: BUDGET.perTask }
  await mkdir(obs.root, { recursive: true })
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, join(work, 'home'))
  const server = await kit.serverFor('budget')
  const sdk = kit.sdkFor(server)
  try {
    const { projectId } = await sdk.call('projects.open', { root: obs.root, create: true })
    await sdk.call('settings.update', { projectId, patch: { costCaps: { perTask: BUDGET.perTask } } })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 budget' })).sessionId
    log('phase budget')
    obs.phases.budget = turnObs(await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.budget }))
  } finally {
    await sdk.dispose()
  }
  kit.collect('budget', server)
  await kit.finish()
  return obs
}

/** The member-approval project (H14): a member edits .env; the caller denies through `approvals.respond`. */
async function runMemberApproval(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'member-approval-project'), phases: {}, requests: [], approvals: [] }
  await mkdir(obs.root, { recursive: true })
  await writeFile(join(obs.root, MEMBER_ENV.path), MEMBER_ENV.original)
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, join(work, 'home'))
  const server = await kit.serverFor('memberApproval')
  const sdk = kit.sdkFor(server)
  try {
    const { projectId } = await sdk.call('projects.open', { root: obs.root, create: true })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 member approval' })).sessionId
    log('phase memberApproval')
    const onEvent = (event) => {
      if (event.type !== 'approval.request') return
      const entry = { sessionId: event.sessionId, parentSessionId: event.parentSessionId ?? null, request: event.request }
      obs.approvals.push(entry)
      // Answered inside the listener on purpose: the request must already be pending when the event fires (#73).
      entry.answered = sdk.call('approvals.respond', { projectId, sessionId: event.request.sessionId, decision: { id: event.request.id, decision: 'deny', scope: 'once' } })
        .then(ok => ok, error => `error: ${error instanceof Error ? error.message : String(error)}`)
    }
    obs.phases.memberApproval = turnObs(await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.memberApproval }, { onEvent }))
    for (const entry of obs.approvals) entry.answered = await entry.answered
  } finally {
    await sdk.dispose()
  }
  kit.collect('memberApproval', server)
  obs.envContent = await readFile(join(obs.root, MEMBER_ENV.path), 'utf8').catch(() => null)
  await kit.finish()
  return obs
}

const skillFile = (name, { description, body }) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

/** The skills project (H20): its own home with two user skills; one name also in the project. */
async function runSkills(h, pkgs, work, servers, log) {
  const obs = { root: join(work, 'skills-project'), phases: {}, requests: [] }
  const home = join(work, 'skills-home')
  const userDir = join(home, 'skills')
  const projectDir = join(obs.root, '.nexgent', 'skills')
  for (const [dir, name, skill] of [
    [userDir, SKILLS.user.name, SKILLS.user],
    [userDir, SKILLS.shared.name, SKILLS.shared.user],
    [projectDir, SKILLS.shared.name, SKILLS.shared.project],
  ]) {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'SKILL.md'), skillFile(name, skill))
  }
  const kit = projectKit(h, pkgs, work, servers, buildStep3Script(h), obs, home)
  const server = await kit.serverFor('skills')
  const sdk = kit.sdkFor(server)
  try {
    const { projectId } = await sdk.call('projects.open', { root: obs.root, create: true })
    obs.sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-3 skills' })).sessionId
    log('phase skills')
    obs.phases.skills = turnObs(await runTurn(sdk, { projectId, sessionId: obs.sessionId, text: TASKS.skills }))
  } finally {
    await sdk.dispose()
  }
  kit.collect('skills', server)
  await kit.finish()
  return obs
}

/**
 * H21: after the kills and resumes, a fresh SDK (no model request expected) opens the delegation,
 * workflow and team-kill projects and reads them through the session queries only.
 */
async function runQueries(h, pkgs, work, servers, log, projects) {
  const server = await h.scriptedModelServer({ script: [] })
  servers.push({ phase: 'queries', server })
  const sdk = createStep3Sdk(pkgs, { env: { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: join(work, 'home') }, home: join(work, 'home') })
  const out = {}
  try {
    for (const [key, project] of Object.entries(projects)) {
      log(`queries ${key}`)
      const { projectId } = await sdk.call('projects.open', { root: project.root })
      const input = { projectId, sessionId: project.sessionId }
      const list = await sdk.call('sessions.list', { projectId })
      const children = await sdk.call('sessions.children', input)
      const root = await sdk.call('sessions.view', input)
      const views = {}
      for (const child of children) {
        const view = await sdk.call('sessions.view', { projectId, sessionId: child.sessionId })
        views[child.sessionId] = { summary: view.summary, deliverables: view.items.filter(i => i.kind === 'deliverable').map(i => i.deliverable) }
      }
      out[key] = {
        sessionId: project.sessionId,
        list: list.map(x => ({ sessionId: x.sessionId, parentSessionId: x.parentSessionId, childCount: x.childCount })),
        children: children.map(x => ({ sessionId: x.sessionId, parentSessionId: x.parentSessionId, member: x.member })),
        root: { summary: root.summary, kinds: root.items.map(i => i.kind) },
        views,
        collaboration: await sdk.call('sessions.collaboration', input),
      }
    }
  } finally {
    await sdk.dispose()
  }
  out.requests = server.requests.length
  return out
}

/**
 * Run the headless scenario and return its observations.
 * @param harness - the loaded test-support module; `undefined` collects only the repository inventory.
 * @param work - the layer's work directory.
 * @param options - `log(line)`; `root` is the repository to inventory (H23).
 */
export async function runHeadlessScenario(harness, work, { log = () => {}, root = REPO_ROOT } = {}) {
  const repo = await repoInventory(root)
  log(`repository inventory: ${repo.files.length} files (${repo.source})`)
  if (harness === undefined) return { repo }
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const script = buildStep3Script(harness)
  const servers = []
  try {
    const direct = await runDirect(harness, loaded.pkgs, work, script, servers, log)
    const delegation = await runDelegation(harness, loaded.pkgs, work, servers, log)
    const web = await pageServer()
    servers.push({ server: web })
    const readonly = await runReadonly(harness, loaded.pkgs, work, servers, log, web)
    const tools = await runTools(harness, loaded.pkgs, work, servers, log, web)
    const workflow = await runWorkflowProject(harness, loaded.pkgs, work, servers, log)
    const team = await runTeam(harness, loaded.pkgs, work, servers, log)
    const teamKill = await runTeamKill(harness, loaded.pkgs, work, servers, log)
    const cancel = await runCancel(harness, loaded.pkgs, work, servers, log)
    const budget = await runBudget(harness, loaded.pkgs, work, servers, log)
    const memberApproval = await runMemberApproval(harness, loaded.pkgs, work, servers, log)
    const skills = await runSkills(harness, loaded.pkgs, work, servers, log)
    const queries = await runQueries(harness, loaded.pkgs, work, servers, log, { delegation, workflow, teamKill })
    return { repo, direct, delegation, readonly, tools, workflow, team, teamKill, cancel, budget, memberApproval, skills, queries }
  } finally {
    await Promise.all(servers.map(s => (s.server ?? s).close().catch(() => undefined)))
    await harness.killAllSpawned().catch(() => undefined)
  }
}
