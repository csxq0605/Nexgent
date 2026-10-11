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
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { REPO_ROOT } from './harness.mjs'
import { SCRIPTED_API_KEY, TASKS, buildStep3Script } from './step3-scenario.mjs'
import { filesContaining } from './step2-headless.mjs'
import { CLI_BIN, createStep2Sdk, loadStep2Packages, runTurn } from './step2-runtime.mjs'

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

/** Session ids that have a session file (data-formats.md: `.nexgent/sessions/<sessionId>/session.jsonl`). */
async function sessionFiles(root) {
  const dir = join(root, '.nexgent', 'sessions')
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
  const sdk = createStep2Sdk(pkgs, { env, home })
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
  obs.sessionFiles = await sessionFiles(root)
  obs.sessions = {}
  for (const id of obs.sessionFiles) {
    const read = await h.readSessionRecords(root, id)
    obs.sessions[id] = { records: read.records, truncated: read.truncated ?? null }
  }
  obs.ledger = (await h.readLedgerRecords(root)).records

  const exportDir = join(work, 'direct-export')
  log('phase direct export')
  const cli = h.spawnNode([CLI_BIN, 'export', obs.sessionId, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
  const cliExit = await cli.exit
  const exported = {}
  for (const name of await readdir(exportDir).catch(() => [])) exported[name] = await readFile(join(exportDir, name), 'utf8')
  obs.export = { code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: exported }
  obs.secretHits = await filesContaining(join(root, '.nexgent'), SCRIPTED_API_KEY, root)
  obs.exportSecretHits = await filesContaining(exportDir, SCRIPTED_API_KEY, work)
  return obs
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
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const script = buildStep3Script(harness)
  const servers = []
  try {
    const direct = await runDirect(harness, loaded.pkgs, work, script, servers, log)
    return { repo, direct }
  } finally {
    await Promise.all(servers.map(s => s.close().catch(() => undefined)))
    await harness.killAllSpawned().catch(() => undefined)
  }
}
