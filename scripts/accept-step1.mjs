#!/usr/bin/env node
/**
 * Step 1 acceptance (plan 4.7: "`accept-step1` 两平台通过"), scripted provider:
 *
 *   A. `nexgent run` on a fresh temp project performs a write-file task
 *      → the file, the session JSONL and the ledger are checked;
 *   B. `nexgent resume` starts a second, long turn; the process is killed
 *      hard mid-stream (crash simulation);
 *   C. a new process `nexgent resume` closes the interrupted turn, continues
 *      the conversation with its history, writes another file → checked.
 *
 * Usage: node scripts/accept-step1.mjs [--out <summary.json>] [--work-dir <empty dir>]
 * Writes a summary JSON (test-support schema, fields of
 * docs/validation/TEMPLATE.md); default location: summary.json in a fresh nexgent-accept-step1-XXXX temp dir.
 *
 * Exit codes: 0 pass; 1 fail; 2 not runnable yet (build missing, scripted
 * provider or `nexgent` runtime not wired) — never a fake pass.
 * Linux, macOS and Windows; no shell, no Python.
 */
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CLI_BIN, loadHarness, REPO_ROOT, startScriptedServer } from './accept-common/harness.mjs'
import {
  buildScript,
  FILES,
  isRuntimeNotWired,
  openTurns,
  parseJsonLines,
  requestMentions,
  SCRIPTED_API_KEY,
  seqContiguous,
  sessionIdFrom,
  TASKS,
  taskOutcomes,
  turnEndKinds,
  unpairedRequests,
} from './accept-common/scenario.mjs'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_NOT_READY = 2
/** Per-process deadline. */
const PROCESS_TIMEOUT_MS = 60_000

const STEP = {
  step: 1,
  name: '主应用（kernel / llm / session / workspace 重写）',
  exitCriteria: ['`accept-step1` 两平台通过', '真实 MiMo 一次（手动，另行记录）'],
  script: 'scripts/accept-step1.mjs',
  simulated: 'scripted OpenAI-compatible model server; run → write-file task; resume → long turn killed mid-stream; resume in a new process → continue and write another file',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step1: ${line}\n`)
}

function tail(text, max = 600) {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `...${trimmed.slice(-max)}`
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Await a child's exit, killing it when it overruns. */
async function exitWithin(handle, ms = PROCESS_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  const result = await Promise.race([handle.exit, timeout])
  clearTimeout(timer)
  if (result !== undefined) return { ...result, timedOut: false }
  return { ...(await handle.kill('SIGKILL')), timedOut: true }
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'work-dir': { type: 'string' } }, strict: true })

  const loaded = await loadHarness()
  if (!loaded.ok) {
    log(`not runnable yet: ${loaded.reason}`)
    return EXIT_NOT_READY
  }
  const h = loaded.harness

  const work = values['work-dir'] === undefined
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step1-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const project = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(project)
  await mkdir(home)
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`work dir ${work}`)

  const s = h.acceptanceSummary(STEP)
  s.fault('kill')
  s.untested('real MiMo run (manual, recorded separately under docs/validation/step-1/)')
  s.untested('approval prompts (stdin is not a TTY here, so approvals resolve as headless denies)')
  s.doesNotProve('anything about real-model behaviour, cost or latency')

  const finish = async (code) => {
    // Raw records: every session file plus every ledger month file.
    const files = []
    const sessionIds = typeof h.listSessionIds === 'function' ? await h.listSessionIds(project).catch(() => []) : []
    for (const id of sessionIds) files.push(join(project, '.nexgent', 'sessions', id, 'session.jsonl'))
    const ledger = await h.readLedgerRecords(project).catch(() => ({ files: [] }))
    for (const file of ledger.files) if (typeof file.path === 'string') files.push(file.path)
    const manifest = []
    for (const file of files) {
      if (await exists(file)) manifest.push({ sha256: await sha256(file), file: relative(work, file).split('\\').join('/') })
    }
    s.set({ raw: { location: work, sha256: null, summaryDir: null, manifest } })
    const summary = await s.write(out)
    log(`summary ${out} (result ${summary.result})`)
    if (code === EXIT_NOT_READY) return code
    return summary.result === 'pass' ? EXIT_PASS : EXIT_FAIL
  }

  const started = await startScriptedServer(h, buildScript())
  if (!started.ok) {
    s.check('scripted model server available', false, started.reason)
    s.knownIssue(started.reason)
    log(`not runnable yet: ${started.reason}`)
    return finish(EXIT_NOT_READY)
  }
  const server = started.server
  const env = {
    NEXGENT_API_KEY: SCRIPTED_API_KEY,
    NEXGENT_API_BASE_URL: server.baseUrl,
    NEXGENT_HOME: home,
    NEXGENT_DEBUG: '1',
  }
  const cli = args => h.spawnNode([CLI_BIN, ...args], { cwd: work, env })

  try {
    // A. run: write-file task ------------------------------------------------
    log('A: nexgent run (write-file task)')
    const exitA = await exitWithin(cli(['run', '--project', project, '--task', TASKS.write, '--json']))
    const eventsA = parseJsonLines(exitA.stdout)
    if (isRuntimeNotWired(exitA, eventsA)) {
      const reason = 'nexgent runtime not wired yet (apps/cli/src/runtime.ts loadRuntime returns undefined)'
      s.check('nexgent runtime wired', false, reason)
      s.knownIssue(reason)
      log(`not runnable yet: ${reason}`)
      return await finish(EXIT_NOT_READY)
    }
    s.check('A: run exits 0', exitA.code === 0 && !exitA.timedOut, `code ${exitA.code}${exitA.timedOut ? ' (timed out)' : ''}; stderr: ${tail(exitA.stderr)}`)
    const sessionId = sessionIdFrom(eventsA)
    s.check('A: run announces a session id', sessionId !== undefined, `events: ${eventsA.map(e => e.type).join(',')}`)
    if (sessionId === undefined) return await finish(EXIT_FAIL)
    s.check('A: task file written', (await readText(join(project, FILES.first.path))) === FILES.first.content)
    const sessionA = await h.readSessionRecords(project, sessionId)
    const kindsA = turnEndKinds(sessionA.records)
    s.check('A: session file starts with session.start', sessionA.records[0]?.type === 'session.start')
    s.check('A: turn 1 completed', kindsA.get(1) === 'completed', JSON.stringify([...kindsA]))
    s.check('A: tool result recorded', sessionA.records.some(r => r.type === 'tool.result' && r.isError === false))
    s.check('A: session lock released', !(await exists(join(project, '.nexgent', 'sessions', sessionId, '.lock'))))
    const ledgerA = (await h.readLedgerRecords(project)).records
    const pairsA = unpairedRequests(ledgerA)
    s.check('A: ledger has paired request records', ledgerA.some(r => r.type === 'llm.request.start') && pairsA.withoutEnd.length === 0 && pairsA.withoutStart.length === 0, JSON.stringify(pairsA))
    s.check('A: ledger task.outcome completed', taskOutcomes(ledgerA, sessionId)[0]?.status === 'completed')

    // B. resume: long turn, killed mid-stream --------------------------------
    log('B: nexgent resume (long turn), then kill')
    const runB = cli(['resume', sessionId, '--project', project, '--task', TASKS.long, '--json'])
    let streamed = true
    try {
      await runB.waitForOutput(/"type":"text\.delta"/, PROCESS_TIMEOUT_MS, 'stdout')
    } catch (error) {
      streamed = false
      s.check('B: long turn started streaming', false, `${error instanceof Error ? error.message : String(error)}; stderr: ${tail(runB.stderr)}`)
    }
    if (streamed) s.check('B: long turn started streaming', true)
    const exitB = await runB.kill('SIGKILL')
    s.check('B: process killed before finishing', exitB.code !== 0, `code ${exitB.code} signal ${exitB.signal}`)
    const sessionB = await h.readSessionRecords(project, sessionId)
    s.check('B: turn 2 left open by the crash', openTurns(sessionB.records).includes(2), JSON.stringify(openTurns(sessionB.records)))

    // C. resume in a new process -----------------------------------------------
    log('C: nexgent resume in a new process')
    const exitC = await exitWithin(cli(['resume', sessionId, '--project', project, '--task', TASKS.resume, '--json']))
    const eventsC = parseJsonLines(exitC.stdout)
    s.check('C: resume exits 0', exitC.code === 0 && !exitC.timedOut, `code ${exitC.code}; stderr: ${tail(exitC.stderr)}`)
    s.check('C: same session resumed', sessionIdFrom(eventsC) === sessionId)
    s.check('C: second file written', (await readText(join(project, FILES.resumed.path))) === FILES.resumed.content)
    const sessionC = await h.readSessionRecords(project, sessionId)
    const kindsC = turnEndKinds(sessionC.records)
    s.check('C: interrupted turn 2 closed as interrupted', kindsC.get(2) === 'interrupted', JSON.stringify([...kindsC]))
    s.check('C: turn 3 completed', kindsC.get(3) === 'completed', JSON.stringify([...kindsC]))
    s.check('C: no turn left open', openTurns(sessionC.records).length === 0)
    s.check('C: seq contiguous', seqContiguous(sessionC.records))
    s.check('C: session lock released', !(await exists(join(project, '.nexgent', 'sessions', sessionId, '.lock'))))
    const continued = server.requests[3]?.body
    s.check('C: resumed request carries the turn-1 history', requestMentions(continued, TASKS.write) && requestMentions(continued, TASKS.resume))
    s.check('scripted server consumed every entry', server.remaining === 0, `remaining ${server.remaining}`)
    const ledgerC = (await h.readLedgerRecords(project)).records
    const outcomes = taskOutcomes(ledgerC, sessionId).map(r => r.status)
    s.check('C: ledger task.outcome per finished process', outcomes.length === 2 && outcomes.every(status => status === 'completed'), JSON.stringify(outcomes))
    const pairsC = unpairedRequests(ledgerC)
    s.check('C: only the killed request lacks an end record', pairsC.withoutEnd.length === 1 && pairsC.withoutStart.length === 0, JSON.stringify(pairsC))
    s.ledger(ledgerC, 'unknown')

    s.proves('nexgent run completes a write-file task and persists session + ledger')
    s.proves('a hard-killed process leaves a session that a new process resumes with its history')
  } catch (error) {
    s.check('acceptance script ran to the end', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
  } finally {
    await h.killAllSpawned()
    await server.close()
  }
  return finish(EXIT_FAIL)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`accept-step1: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
