/**
 * The headless scenario of accept-step4 (round 2): drives `@nexgent/sdk`
 * through the phases of step4-scenario.mjs against the scripted model server
 * and collects raw observations — request tool lists and member lines,
 * session records of every session, ledger lines, the draft area, candidate
 * records, the adopted bundle and the activation chain. It judges nothing:
 * step4-judges.mjs decides each item from these observations.
 *
 * Never calls a real model: every SDK is created against a loopback server.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDirSync, registerHome, scanSecrets } from './data-dir.mjs'
import { filesContaining } from './step2-headless.mjs'
import { CLI_BIN, runTurn } from './step2-runtime.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'
import { SCRIPTED_API_KEY, TASK_A, TASK_B, writeReplayProject } from './step4-fixtures.mjs'
import { canonicalManifestText, componentDir } from './step4-kernel.mjs'
import { ASKS, BASELINE_TASK, CANDIDATE, buildStep4Script, routeOf } from './step4-scenario.mjs'

/** One SDK turn in a child process (step 3's driver; it loads whatever the SDK profile loads). */
const DRIVER = fileURLToPath(new URL('./step3-driver.mjs', import.meta.url))

const sha256 = data => createHash('sha256').update(data).digest('hex')
const errorText = error => (error instanceof Error ? error.message : String(error))
const toolsOf = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)

export async function jsonl(path) {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Every session file of the project: `{ <sessionId>: records[] }`. */
export async function sessionsOf(root) {
  const dir = join(dataDirSync(root), 'sessions')
  const out = {}
  for (const id of await readdir(dir).catch(() => [])) out[id] = await jsonl(join(dir, id, 'session.jsonl'))
  return out
}

/** Every ledger record of the project, in file order per month. */
export async function ledgerOf(root) {
  const dir = join(dataDirSync(root), 'ledgers')
  const out = []
  for (const month of (await readdir(dir).catch(() => [])).sort()) out.push(...await jsonl(join(dir, month, 'requests.jsonl')))
  return out
}

/** `activation/<n>.json` revisions in order (an unreadable one is recorded as `{ error }`). */
export async function activationOf(root) {
  const dir = join(dataDirSync(root), 'capabilities', 'activation')
  const names = (await readdir(dir).catch(() => [])).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  const out = []
  for (const name of names) out.push(await readFile(join(dir, name), 'utf8').then(JSON.parse, error => ({ file: name, error: errorText(error) })))
  return out
}

/** Files under a directory, relative with `/`. */
export async function filesUnder(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(path, base))
    else out.push(path.slice(base.length + 1).split('\\').join('/'))
  }
  return out.sort()
}

/** `candidates/<id>/candidate.json` of every candidate. */
export async function candidatesOf(root) {
  const dir = join(dataDirSync(root), 'capabilities', 'candidates')
  const out = []
  for (const id of await readdir(dir).catch(() => [])) {
    out.push({ id, record: await readFile(join(dir, id, 'candidate.json'), 'utf8').then(JSON.parse, error => ({ error: errorText(error) })), files: await filesUnder(join(dir, id)) })
  }
  return out
}

/**
 * A bundle as stored: its manifest text, the version recomputed from it with the
 * contract's canonical form, and each listed file's actual hash.
 */
export async function bundleFacts(root, version) {
  const dir = join(dataDirSync(root), 'capabilities', version)
  const facts = { version, files: [] }
  try {
    facts.manifestText = await readFile(join(dir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(facts.manifestText)
    facts.manifest = manifest
    facts.recomputedVersion = sha256(canonicalManifestText(manifest))
    for (const component of manifest.components ?? []) {
      for (const file of component.files ?? []) {
        const bytes = await readFile(join(dir, componentDir(component.kind, component.name), file.path)).catch(() => null)
        facts.files.push({ kind: component.kind, name: component.name, path: file.path, listed: file.sha256, actual: bytes === null ? null : sha256(bytes) })
      }
    }
    const listed = new Set(facts.files.map(file => `${componentDir(file.kind, file.name)}/${file.path}`))
    facts.unlisted = (await filesUnder(dir)).filter(path => path !== 'manifest.json' && !listed.has(path))
  } catch (error) {
    facts.error = errorText(error)
  }
  return facts
}

/**
 * Adopt the good components through `@nexgent/capabilities` (midterm checkpoint 2:
 * "用存储接口手动写一条采用修订"; the gate does this from round 3).
 * SEAM: the store's write / adopt calls.
 */
async function adoptManually(cap, root) {
  const store = new cap.CapabilityStore(join(dataDirSync(root), 'capabilities'))
  const components = [CANDIDATE.functionModule, CANDIDATE.skill].map(c => ({ kind: c.kind, name: c.name, files: c.files }))
  const bundle = await store.write(components)
  const tail = await store.adopt(bundle.version, { trigger: 'manual' })
  return { version: bundle.version, published: tail !== null }
}

/** One turn in a child `node` process; resolves with its exit code and last line. */
function turnInChild(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
      resolve({ pid: child.pid, exitCode: code, done: lines.find(line => line.type === 'driver.done'), stderr: stderr.slice(-2000) })
    })
  })
}

/** Load `@nexgent/capabilities` from its build, or report why not. */
async function loadCapabilities() {
  try {
    return { ok: true, cap: await import(new URL('../../packages/capabilities/dist/index.js', import.meta.url).href) }
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  }
}

/**
 * Run the step-4 headless scenario.
 * @param h - the loaded test-support harness.
 * @returns observations: `{ root, key, features, phases, sessions, ledger, requests, activation, candidates, drafts, bundle, tampered }`.
 */
export async function runStep4Headless(h, work, { log = () => {} } = {}) {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await writeReplayProject(root)
  const state = { pluginMarker: join(work, 'plugin-ran.txt') }
  const script = await buildStep4Script(h, state)
  const server = await h.scriptedModelServer({ script: script.lead, routes: script.routes, routeKey: routeOf(h) })
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  registerHome(root, home)
  const obs = { root, key: SCRIPTED_API_KEY, features: {}, phases: {} }
  const turnObs = ({ result, error }) => ({ reason: result?.reason, ...(error === undefined ? {} : { error: errorText(error) }) })
  try {
    let projectId
    const sdk = createStep3Sdk(pkgs, { env, home })
    try {
      projectId = (await sdk.call('projects.open', { root, create: true })).projectId
      // Whether the gate is there: the SDK's capabilities.trial answers "not implemented yet" until W3/W4 land.
      obs.features.gate = await sdk.call('capabilities.trial', { projectId, candidateId: '00000000-0000-4000-8000-000000000000' })
        .then(() => true, error => !/not implemented yet/.test(errorText(error)))
      log('phase baseline')
      const baseline = (await sdk.call('sessions.create', { projectId, title: 'step-4 baseline' })).sessionId
      obs.phases.baseline = { sessionId: baseline, ...turnObs(await runTurn(sdk, { projectId, sessionId: baseline, text: BASELINE_TASK.ask })) }
      log('phase taskA')
      state.sessionA = (await sdk.call('sessions.create', { projectId, title: 'step-4 task A' })).sessionId
      obs.phases.taskA = { sessionId: state.sessionA, ...turnObs(await runTurn(sdk, { projectId, sessionId: state.sessionA, text: TASK_A.ask })) }
      obs.features.capabilityTools = state.capabilityTools === true
      if (obs.features.capabilityTools) {
        log('phase peer (task A still open)')
        const peer = (await sdk.call('sessions.create', { projectId, title: 'step-4 peer' })).sessionId
        obs.phases.peer = { sessionId: peer, ...turnObs(await runTurn(sdk, { projectId, sessionId: peer, text: ASKS.peer })) }
        log('phase extras (context policies, plugin approval denied)')
        const extras = (await sdk.call('sessions.create', { projectId, title: 'step-4 extras' })).sessionId
        const approvals = []
        const onEvent = (event) => {
          if (event.type !== 'approval.request') return
          const entry = { sessionId: event.sessionId, request: event.request }
          approvals.push(entry)
          // Answered inside the listener: the request is pending when the event fires.
          entry.answered = sdk.call('approvals.respond', { projectId, sessionId: event.request.sessionId, decision: { id: event.request.id, decision: 'deny', scope: 'once' } })
            .then(ok => ok, error => `error: ${errorText(error)}`)
        }
        obs.phases.extras = { sessionId: extras, ...turnObs(await runTurn(sdk, { projectId, sessionId: extras, text: ASKS.extras }, { onEvent })) }
        for (const entry of approvals) entry.answered = await entry.answered
        obs.phases.extras.approvals = approvals
      }
    } finally {
      await sdk.dispose()
    }

    if (obs.features.capabilityTools) {
      log('phase adopt (store interface)')
      const cap = await loadCapabilities()
      try {
        if (!cap.ok) throw new Error(`@nexgent/capabilities did not load: ${cap.reason}`)
        obs.phases.adopt = await adoptManually(cap.cap, root)
        state.adoptedVersion = obs.phases.adopt.version
      } catch (error) {
        obs.phases.adopt = { error: errorText(error) }
      }
    }

    if (state.adoptedVersion !== undefined) {
      obs.bundle = await bundleFacts(root, state.adoptedVersion)
      log('phase taskB (child process)')
      const opener = createStep3Sdk(pkgs, { env, home })
      let sessionB
      try {
        sessionB = (await opener.call('sessions.create', { projectId: (await opener.call('projects.open', { root })).projectId, title: 'step-4 task B' })).sessionId
      } finally {
        await opener.dispose()
      }
      obs.phases.taskB = { sessionId: sessionB, parentPid: process.pid, child: await turnInChild({ root, home, env, sessionId: sessionB, text: TASK_B.ask }) }
      obs.bundleAfterB = await bundleFacts(root, state.adoptedVersion)
      log('phase export (task B)')
      const exportDir = join(work, 'export-b')
      const cli = h.spawnNode([CLI_BIN, 'export', sessionB, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
      const cliExit = await cli.exit
      obs.export = { code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: (await readdir(exportDir).catch(() => [])).sort() }
      obs.exportSecretHits = await filesContaining(exportDir, SCRIPTED_API_KEY, work)

      log('phase tamper')
      const target = join(dataDirSync(root), 'capabilities', state.adoptedVersion, componentDir(CANDIDATE.functionModule.kind, CANDIDATE.functionModule.name), 'index.mjs')
      obs.activationBeforeTamper = await activationOf(root)
      await appendFile(target, '// tampered\n')
      obs.tampered = { version: state.adoptedVersion, path: 'index.mjs' }
      const fresh = createStep3Sdk(pkgs, { env, home })
      try {
        const pid = (await fresh.call('projects.open', { root })).projectId
        const tamper = (await fresh.call('sessions.create', { projectId: pid, title: 'step-4 tamper' })).sessionId
        obs.phases.tamper = { sessionId: tamper, ...turnObs(await runTurn(fresh, { projectId: pid, sessionId: tamper, text: ASKS.tamper })) }
      } finally {
        await fresh.dispose()
      }
    }
  } finally {
    const route = routeOf(h)
    obs.requests = server.requests.map(request => ({ route: route(request.body) ?? 'baseline', tools: toolsOf(request.body), system: h.requestText({ system: request.body?.system, messages: ((body) => (body?.messages ?? []).filter(message => message?.role === 'user').flatMap(message => (typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text))).filter(text => typeof text === 'string' && text.startsWith('# Skills')))(request.body).map(content => ({ role: 'user', content })) }) }))
    await server.close()
  }
  obs.sessions = await sessionsOf(root)
  obs.ledger = await ledgerOf(root)
  obs.activation = await activationOf(root)
  obs.candidates = await candidatesOf(root)
  obs.drafts = await filesUnder(join(dataDirSync(root), 'capabilities', 'drafts'))
  obs.snapshots = await filesUnder(join(dataDirSync(root), 'snapshots'))
  obs.pluginRan = await stat(state.pluginMarker).then(() => true, () => false)
  obs.secretHits = await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY)
  // Schema of every record (H18), with the session package's own validators.
  const { validateSessionRecord, validateLedgerRecord } = pkgs.session
  const issuesOf = (records, validate, where) => records.flatMap((record, index) => validate(record).map(issue => `${where}#${index + 1} ${record.type}: ${issue.path ?? ''} ${issue.message ?? JSON.stringify(issue)}`))
  obs.schemaIssues = [
    ...Object.entries(obs.sessions).flatMap(([id, records]) => issuesOf(records, validateSessionRecord, `session ${id.slice(0, 8)}`)),
    ...issuesOf(obs.ledger, validateLedgerRecord, 'ledger'),
  ]
  obs.outputs = {}
  for (const task of [BASELINE_TASK, TASK_A, TASK_B]) obs.outputs[task.id] = await readFile(join(root, task.output), 'utf8').catch(() => null)
  return obs
}
