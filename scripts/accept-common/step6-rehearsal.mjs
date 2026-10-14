/**
 * Step 6's scripted rehearsal (E02, E03; rewritten 2026-10-14 for the pilot, ADR 0011 and the
 * user's "按推薦" of 08:12): observations made by running
 * `scripts/experiment/step6/pilot/run.mjs --scripted --keep-runs` (the measurement thread's
 * pilot runner, spawned and imported, never edited) and then recomputing the checks from the
 * primary files it leaves behind, not from its own `observations.json` checks:
 *
 *   isolation (E02)  `checkIsolation(pilotCases(), …)` over each family project, each arm copy
 *                    (base, memory, parent: the whole root, so sessions, snapshots, receipts,
 *                    outputs and working files) and each arm's own NEXGENT_HOME, with
 *                    per-directory file counts for sessions and snapshots; a negative control (a
 *                    holdout fingerprint planted in a temp copy of a session file must be found,
 *                    the unplanted copy must be clean)
 *   gate picks (E02) the case ids the gate's trial records name, recomputed from the trial
 *                    files under `.nexgent/capabilities/trials` and the project's session files
 *   holdout runs (E03) every record of raw.json joined to its kept run directory: the run's own
 *                    session is the one whose `session.start` names the run copy as its project
 *                    root and the run id as its title; each arm's NEXGENT_HOME (raw.json `arms`)
 *                    is its own directory
 *
 * A scripted rehearsal, not the real pilot: it shows the runner and the checks work (and would
 * catch a leak, a shared home or a reused copy); the real pilot's isolation and arms are R05's.
 * No model call; the spawned process gets a scripted backend and no key.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, realpath, stat, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const experimentDir = join(repo, 'scripts', 'experiment', 'step6')
const ARMS = ['base', 'memory', 'parent']
const REPEATS = 3

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const exists = async path => stat(path).then(() => true, () => false)
const real = async path => realpath(path).catch(() => resolve(path))

/** The pilot's cases and the shared isolation scan (imported, not edited), as `{ allCases, checkIsolation }`. */
async function loadCases() {
  const pilot = await import(pathToFileURL(join(experimentDir, 'pilot', 'cases.mjs')).href)
  const shared = await import(pathToFileURL(join(experimentDir, 'cases.mjs')).href)
  return { allCases: pilot.pilotCases, checkIsolation: shared.checkIsolation }
}

/** Every file under `dir`, recursively (empty when it does not exist). */
async function filesUnder(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(path)))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** A session's header and first user message, from its `session.jsonl`; undefined when unreadable. */
async function readSession(dir, id) {
  const file = join(dir, id, 'session.jsonl')
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let start
  let firstUser
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'session.start' && start === undefined) start = record
    if (record.type === 'user.message' && firstUser === undefined) firstUser = record
    if (start !== undefined && firstUser !== undefined) break
  }
  return { file, start, firstUserMessage: firstUser?.content }
}

/** Every session directory of a `.nexgent/sessions`. @param {string} sessionsDir */
async function readSessions(sessionsDir) {
  const out = []
  for (const entry of await readdir(sessionsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const session = await readSession(sessionsDir, entry.name)
    out.push({ id: entry.name, ...(session ?? { file: join(sessionsDir, entry.name, 'session.jsonl') }), readable: session !== undefined })
  }
  return out
}

/** Every `sessionId` value anywhere in a parsed JSON value. */
function sessionIdsIn(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) sessionIdsIn(v, out)
  else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'sessionId' && typeof v === 'string') out.add(v)
      else sessionIdsIn(v, out)
    }
  }
  return out
}

/**
 * E02, one root: the whole-root isolation scan plus per-directory counts of what the scan covered.
 * @param {any} cases the runner's cases module
 * @param {string} label
 * @param {string} root a project root (or kept arm copy)
 */
async function scanRoot(cases, label, root) {
  const all = cases.allCases()
  const whole = await cases.checkIsolation(all, [root])
  const part = async name => {
    const dir = join(root, '.nexgent', name)
    return { dir, exists: await exists(dir), scanned: (await cases.checkIsolation(all, [dir])).scanned }
  }
  const directories = {}
  // A NEXGENT_HOME is scanned whole; it has no .nexgent/ of its own.
  if (label.includes(' home:')) return { label, root, exists: await exists(root), scanned: whole.scanned, skipped: whole.skipped, leaks: whole.leaks, directories }
  for (const name of ['sessions', 'snapshots', 'ledgers', 'capabilities', 'outputs', 'materials', 'improvements']) directories[name] = await part(name)
  return { label, root, exists: await exists(root), scanned: whole.scanned, skipped: whole.skipped, leaks: whole.leaks, directories }
}

/**
 * The gate's picks, recomputed: every session id the project's trial records name
 * (`trial.start` plans: selection and guard), mapped to a case by the first user message of
 * that session in the project's own session files.
 * @param {any} cases
 * @param {string} root
 */
async function recomputePicks(cases, root) {
  const all = cases.allCases()
  const byMessage = new Map(all.map(task => [task.message, task.id]))
  const sessions = await readSessions(join(root, '.nexgent', 'sessions'))
  const sessionToCase = {}
  for (const s of sessions) {
    const caseId = typeof s.firstUserMessage === 'string' ? byMessage.get(s.firstUserMessage) : undefined
    if (caseId !== undefined) sessionToCase[s.id] = caseId
  }
  const trialsDir = join(root, '.nexgent', 'capabilities', 'trials')
  const trialFiles = (await filesUnder(trialsDir)).filter(path => path.endsWith('.jsonl'))
  const referenced = new Set()
  let trialText = ''
  for (const file of trialFiles) {
    const text = await readFile(file, 'utf8')
    trialText += text
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        sessionIdsIn(JSON.parse(line), referenced)
      } catch {
        // a damaged line: the text search below still sees it
      }
    }
  }
  // Also any known session id appearing anywhere in the trial text (the runner's own method).
  for (const s of sessions) if (trialText.includes(s.id)) referenced.add(s.id)
  const picked = [...new Set([...referenced].flatMap(id => (sessionToCase[id] === undefined ? [] : [sessionToCase[id]])))].sort()
  const unmapped = [...referenced].filter(id => sessionToCase[id] === undefined).sort()
  return { root, trialFiles: trialFiles.length, sessions: sessions.length, mappedSessions: Object.keys(sessionToCase).length, mappedCases: [...new Set(Object.values(sessionToCase))].sort(), referencedSessions: [...referenced].sort(), picked, unmapped }
}

/**
 * The negative control: a holdout fingerprint planted (as a JSON line, the way a session
 * stores it) in a temp copy of one of the project's session files must be found; the same
 * copy without it must be clean. A scan that finds nothing by construction fails this.
 * @param {any} cases
 * @param {string} root a project root with at least one session
 */
async function negativeControl(cases, root) {
  const holdout = cases.allCases().find(task => task.set === 'holdout' && task.fingerprints.length > 0)
  const sessionsDir = join(root, '.nexgent', 'sessions')
  const first = (await readdir(sessionsDir).catch(() => [])).sort()[0]
  if (holdout === undefined || first === undefined) return { planted: false, reason: holdout === undefined ? 'no holdout case with a fingerprint' : `no session under ${sessionsDir}` }
  const tmp = await mkdtemp(join(tmpdir(), 'nexgent-rehearsal-control-'))
  try {
    const clean = join(tmp, 'clean')
    const dirty = join(tmp, 'dirty')
    await cp(join(sessionsDir, first), clean, { recursive: true })
    await cp(join(sessionsDir, first), dirty, { recursive: true })
    const sample = await readFile(join(dirty, 'session.jsonl'), 'utf8')
    const print = holdout.fingerprints[0]
    const planted = JSON.stringify({ type: 'user.message', seq: 9999, sessionId: first, turn: 1, content: `${holdout.message}\n(${print})` })
    await writeFile(join(dirty, 'session.jsonl'), `${sample.endsWith('\n') ? sample : `${sample}\n`}${planted}\n`)
    const before = await cases.checkIsolation(cases.allCases(), [clean])
    const after = await cases.checkIsolation(cases.allCases(), [dirty])
    return {
      planted: true,
      caseId: holdout.id,
      fingerprint: print.slice(0, 60),
      cleanScanned: before.scanned,
      cleanLeaks: before.leaks.length,
      plantedScanned: after.scanned,
      plantedLeaks: after.leaks.length,
      foundPlantedCase: after.leaks.some(leak => leak.caseId === holdout.id),
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * E03, one family: raw.json's runs joined to the kept run directories.
 * @param {string} familyDir `<out>/<family>`
 * @param {any[]} runs raw.json records of the family
 * @param {Record<string, string[]>} armSessionIds arm → session ids of the arm's source copy (history)
 */
async function inspectRuns(familyDir, runs, armSessionIds, messageOf) {
  const runsDir = join(familyDir, 'runs')
  const dirs = (await readdir(runsDir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => join(runsDir, e.name)).sort()
  // runId → the copy directories and sessions that claim it (session.start title + projectRoot)
  const claims = new Map()
  for (const dir of dirs) {
    const own = await real(dir)
    for (const s of await readSessions(join(dir, '.nexgent', 'sessions'))) {
      if (s.start === undefined || typeof s.start.projectRoot !== 'string') continue
      if ((await real(s.start.projectRoot)) !== own) continue
      const title = String(s.start.title ?? '')
      if (!claims.has(title)) claims.set(title, [])
      claims.get(title).push({ dir, sessionId: s.id, sessionFile: s.file, firstUserMessage: s.firstUserMessage })
    }
  }
  const records = []
  for (const run of runs) {
    const mine = claims.get(run.runId) ?? []
    const claim = mine[0]
    records.push({
      runId: run.runId,
      family: run.family,
      caseId: run.caseId,
      arm: run.arm,
      repeat: run.repeat,
      pass: run.pass,
      claims: mine.length,
      copyDir: claim?.dir,
      copyExists: claim === undefined ? false : await exists(claim.dir),
      sessionId: claim?.sessionId,
      sessionFile: claim?.sessionFile,
      sessionFileExists: claim === undefined ? false : await exists(claim.sessionFile),
      sessionMatchesCase: claim !== undefined && claim.firstUserMessage === messageOf.get(run.caseId),
      sessionInArmSource: claim === undefined ? undefined : (armSessionIds[run.arm] ?? []).includes(claim.sessionId),
    })
  }
  return { runsDir, directories: dirs, records }
}

/**
 * Run the scripted pilot (both families, 3 repeats per case and arm) and make the E02 / E03 observations.
 * @param {string} work a scratch directory (created); the run's output goes to `<work>/out`
 * @param {{ log?: (line: string) => void, timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, unknown>>} observations, or `{ error }` when the run crashed
 */
export async function runRehearsal(work, { log = () => {}, timeoutMs = 20 * 60_000 } = {}) {
  const out = resolve(work, 'out')
  await mkdir(out, { recursive: true })
  const startedAt = Date.now()
  // The comparison copies the runner keeps (nexgent-arm-*) land under the work dir, not the OS temp dir.
  const temp = resolve(work, 'tmp')
  await mkdir(temp, { recursive: true })
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp }
  delete env.NEXGENT_API_KEY
  delete env.ANTHROPIC_API_KEY
  const args = [join(experimentDir, 'pilot', 'run.mjs'), '--scripted', '--keep-runs', '--out', out]
  const child = await new Promise(resolveChild => {
    const proc = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const tail = chunk => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-4000)
      for (const line of text.split('\n')) if (line.trim() !== '') log(`pilot/run.mjs: ${line}`)
    }
    proc.stdout.on('data', tail)
    proc.stderr.on('data', tail)
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.on('error', error => resolveChild({ code: null, stderr: String(error) }))
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveChild({ code, signal, stderr })
    })
  })
  const durationMs = Date.now() - startedAt
  if (child.code !== 0) return { error: `pilot/run.mjs exited ${child.code ?? child.signal}: ${child.stderr.slice(-400)}`, durationMs }
  return observeOutput(out, durationMs)
}

/**
 * The E02 / E03 observations over a finished run's output directory (what `runRehearsal`
 * does after the spawn; exported so a kept output can be re-judged).
 * @param {string} out the runner's `--out` directory
 * @param {number} [durationMs]
 */
export async function observeOutput(out, durationMs) {
  try {
    const cases = await loadCases()
    const raw = await readJson(join(out, 'raw.json'))
    const families = await readJson(join(out, 'observations.json'))
    const all = cases.allCases()
    const holdoutCaseIds = all.filter(task => task.set === 'holdout').map(task => task.id)

    const isolationRoots = []
    const gate = []
    const holdoutRuns = []
    let controlRoot
    for (const family of families) {
      const roots = [
        ['project', family.root],
        ...ARMS.filter(arm => family.arms?.[arm]?.root !== undefined).map(arm => [`arm:${arm}`, family.arms[arm].root]),
        ...ARMS.filter(arm => family.arms?.[arm]?.home !== undefined).map(arm => [`home:${arm}`, family.arms[arm].home]),
      ]
      for (const [label, root] of roots) isolationRoots.push({ family: family.family, ...(await scanRoot(cases, `${family.family} ${label}`, root)) })
      controlRoot ??= family.root
      gate.push({ family: family.family, ...(await recomputePicks(cases, family.root)) })
      const armSessions = {}
      for (const arm of ARMS) {
        const root = family.arms?.[arm]?.root
        armSessions[arm] = root === undefined ? [] : (await readSessions(join(root, '.nexgent', 'sessions'))).map(s => s.id)
      }
      const familyRuns = raw.runs.filter(run => run.family === family.family)
      holdoutRuns.push({ family: family.family, ...(await inspectRuns(join(out, family.family), familyRuns, armSessions, new Map(all.map(task => [task.id, task.message])))), runnerRuns: family.runs.length, stopped: family.stopped, error: family.error?.message?.split('\n')[0] })
    }
    // Each arm's own NEXGENT_HOME, as raw.json names it (relative to the output) and as it is on disk.
    const homes = []
    for (const [family, arms] of Object.entries(raw.arms ?? {})) {
      for (const [arm, facts] of Object.entries(arms ?? {})) {
        const path = typeof facts?.home === 'string' ? resolve(out, facts.home) : undefined
        homes.push({ family, arm, home: facts?.home, exists: path === undefined ? false : await exists(path), real: path === undefined ? undefined : await real(path) })
      }
    }
    return {
      scripted: true,
      note: 'scripted rehearsal (pilot/run.mjs --scripted): the real pilot is R05\'s',
      out,
      durationMs,
      command: 'node scripts/experiment/step6/pilot/run.mjs --scripted --keep-runs --out <work>/out',
      holdoutCaseIds,
      arms: ARMS,
      repeatsRequired: REPEATS,
      raw: { runs: raw.runs },
      homes,
      familyHomes: families.map(family => ({ family: family.family, home: family.home })),
      isolation: { roots: isolationRoots, negativeControl: controlRoot === undefined ? { planted: false, reason: 'no family project' } : await negativeControl(cases, controlRoot) },
      gate: { families: gate },
      holdout: { families: holdoutRuns },
    }
  } catch (error) {
    return { error: error instanceof Error ? (error.stack ?? error.message) : String(error), durationMs }
  }
}
