/** Run the A3 hard-crash recovery contracts through the official DSH headless profile. */

import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_UPSTREAM = '46a7f68b0922371ce7144b668b90e377d8e799f4'
const TOOL = 'spike.recovery_multiply'
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const scratchParent = resolve(repo, '..')
const upstream = resolve(process.argv[2] ?? join(scratchParent, 'NExgent-upstream-deepseek-46a7f68'))
const patchPath = join(here, 'dsh_recovery.patch.yml')
const pluginPath = join(here, 'dsh_recovery_plugin.mjs')
const cliBinPath = join(upstream, 'apps', 'cli', 'lib', 'bin.js')
const lockfilePath = join(upstream, 'pnpm-lock.yaml')
const runRoot = await mkdtemp(join(scratchParent, '.nexgent-dsh-recovery-'))

type Scenario = 'completed' | 'unknown'
type Phase = 'crash' | 'resume'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Row = { type?: string; id?: string; sessionId?: string; text?: string; data?: Record<string, Json>; [key: string]: Json | undefined }

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function parseJsonl(text: string): Row[] {
  return text.split(/\r?\n/u).filter(line => line.trim() !== '').map(line => JSON.parse(line) as Row)
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  try { await visit(root) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return found
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function captured(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { cwd: scratchParent, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const exit = await waitForExit(child, 30_000)
  expect(exit.code === 0, `${command} exited ${String(exit.code)}: ${stderr.trim()}`)
  return stdout
}

async function gitSnapshot(): Promise<{ head: string; trackedStatus: string }> {
  const safeDirectory = upstream.replaceAll('\\', '/')
  const common = ['-c', `safe.directory=${safeDirectory}`, '-C', upstream]
  const [head, trackedStatus] = await Promise.all([
    captured('git', [...common, 'rev-parse', 'HEAD']),
    captured('git', [...common, 'status', '--porcelain=v1', '--untracked-files=no']),
  ])
  return { head: head.trim(), trackedStatus: trackedStatus.trim() }
}

async function waitForMarker(path: string, expected: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  try {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const value = await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (value === expected) return
      if (value !== undefined && value !== '') throw new Error(`unexpected failpoint ${JSON.stringify(value)}`)
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('headless exited before publishing its failpoint')
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    throw new Error(`timed out waiting for failpoint ${expected}`)
  } catch (error: unknown) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    throw error
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`headless exceeded ${timeoutMs} ms`))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }) })
  })
}

interface Paths {
  root: string
  dshHome: string
  sessionRoot: string
  projectRoot: string
  marker: string
  ledger: string
  receipts: string
  artifacts: string
}

function scenarioPaths(scenario: Scenario): Paths {
  const root = join(runRoot, scenario)
  return {
    root,
    dshHome: join(root, 'dsh-home'),
    sessionRoot: join(root, 'sessions'),
    projectRoot: join(root, 'project'),
    marker: join(root, 'failpoint.txt'),
    ledger: join(root, 'execution-ledger.jsonl'),
    receipts: join(root, 'plugin-receipts.jsonl'),
    artifacts: join(root, 'receipts'),
  }
}

function launch(scenario: Scenario, phase: Phase, paths: Paths, sessionId?: string): {
  child: ChildProcessWithoutNullStreams
  output: Promise<{ stdout: string; stderr: string }>
  command: string[]
} {
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  Object.assign(env, {
    DSH_HOME: paths.dshHome,
    DSH_RECOVERY_SESSION_ROOT: paths.sessionRoot,
    DSH_RECOVERY_SCENARIO: scenario,
    DSH_RECOVERY_PHASE: phase,
    DSH_RECOVERY_MARKER_PATH: paths.marker,
    DSH_RECOVERY_LEDGER_PATH: paths.ledger,
    DSH_RECOVERY_RECEIPT_PATH: paths.receipts,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
  })
  const task = phase === 'crash'
    ? '计算 6 × 7；工具结果后等待恢复。'
    : scenario === 'completed'
      ? '从持久历史恢复并交付 JSON {"answer":42}，不要重放已完成工具。'
      : '从未知工具结果恢复；不要重试，交付安全状态 JSON。'
  const args = [cliBinPath, '--profile', 'headless', '--patch', patchPath, '--json']
  if (sessionId !== undefined) args.push('--session-id', sessionId)
  args.push(task)
  const child = spawn(process.execPath, args, { cwd: paths.projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return { child, output: new Promise(resolveOutput => child.once('close', () => resolveOutput({ stdout, stderr }))), command: [process.execPath, ...args] }
}

async function sessionLog(paths: Paths): Promise<{ path: string; text: string; rows: Row[] }> {
  const logs = (await filesBelow(paths.sessionRoot)).filter(path => path.endsWith('.jsonl'))
  expect(logs.length === 1, `expected one Session JSONL, found ${logs.length}`)
  const text = await readFile(logs[0]!, 'utf8')
  return { path: logs[0]!, text, rows: parseJsonl(text) }
}

function resultCallId(row: Row): string | undefined {
  const message = row.data?.message
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const source = message.source
  if (source !== null && typeof source === 'object' && !Array.isArray(source) && typeof source.callId === 'string') return source.callId
  return typeof message.toolCallId === 'string' ? message.toolCallId : undefined
}

function errorCode(row: Row): string | undefined {
  const error = row.data?.error
  return error !== null && typeof error === 'object' && !Array.isArray(error) && typeof error.code === 'string'
    ? error.code
    : undefined
}

function turnEndReasonKind(row: Row): string | undefined {
  if (row.type !== 'turn/end') return undefined
  const reason = row.data?.reason
  return reason !== null && typeof reason === 'object' && !Array.isArray(reason) && typeof reason.kind === 'string'
    ? reason.kind
    : undefined
}

function hasMultiplyArguments(row: Row): boolean {
  const args = row.arguments
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    && args.left === 6 && args.right === 7
}

async function runScenario(
  scenario: Scenario,
  upstreamCommit: string,
  executedInputs: Record<string, Json>,
): Promise<Record<string, Json>> {
  const paths = scenarioPaths(scenario)
  await Promise.all([mkdir(paths.projectRoot, { recursive: true }), mkdir(paths.artifacts, { recursive: true })])
  const marker = scenario === 'completed' ? 'completed-result-durable' : 'unknown-tool-entered'

  const first = launch(scenario, 'crash', paths)
  await waitForMarker(paths.marker, marker, first.child)
  const killed = first.child.kill('SIGKILL')
  expect(killed, 'failed to request hard termination at the failpoint')
  const firstExit = await waitForExit(first.child, 10_000)
  expect(firstExit.code === null && firstExit.signal === 'SIGKILL',
    `${scenario}: phase 1 did not exit by SIGKILL (${String(firstExit.code)}/${String(firstExit.signal)})`)
  const firstOutput = await first.output
  await writeFile(join(paths.artifacts, 'phase1-stdout.jsonl'), firstOutput.stdout)
  await writeFile(join(paths.artifacts, 'phase1-stderr.txt'), firstOutput.stderr)
  const crashed = await sessionLog(paths)
  await writeFile(join(paths.artifacts, 'session-after-crash.jsonl'), crashed.text)
  const header = crashed.rows[0]
  expect(header?.type === 'session' && typeof header.id === 'string', 'crashed Session has no identity header')
  const sessionId = header.id
  const callId = scenario === 'completed' ? 'a3-completed-call' : 'a3-unknown-call'
  const crashCalls = crashed.rows.filter(row => row.type === 'tool/call' && row.data?.callId === callId)
  const crashResults = crashed.rows.filter(row => row.type === 'tool/result' && resultCallId(row) === callId)
  expect(crashCalls.length === 1, `${scenario}: crash prefix does not contain exactly one tool/call`)
  expect(crashed.rows.every(row => row.type !== 'turn/end'), `${scenario}: phase 1 exited after its turn was already closed`)
  if (scenario === 'completed') {
    expect(crashResults.length === 1 && errorCode(crashResults[0]!) === undefined,
      'completed: crash prefix does not contain its completed result')
  } else {
    expect(crashResults.length === 0, 'unknown: crash prefix already contains a tool result')
  }

  const second = launch(scenario, 'resume', paths, sessionId)
  const secondExit = await waitForExit(second.child, 90_000)
  const secondOutput = await second.output
  await writeFile(join(paths.artifacts, 'phase2-stdout.jsonl'), secondOutput.stdout)
  await writeFile(join(paths.artifacts, 'phase2-stderr.txt'), secondOutput.stderr)
  expect(secondExit.code === 0, `resume exited ${String(secondExit.code)} (${String(secondExit.signal)})`)

  const resumed = await sessionLog(paths)
  await writeFile(join(paths.artifacts, 'session-after-resume.jsonl'), resumed.text)
  const ledgerText = await readFile(paths.ledger, 'utf8')
  const receiptText = await readFile(paths.receipts, 'utf8')
  await writeFile(join(paths.artifacts, 'execution-ledger.jsonl'), ledgerText)
  await writeFile(join(paths.artifacts, 'plugin-receipts.jsonl'), receiptText)
  const ledger = parseJsonl(ledgerText)
  const adapterRequests = parseJsonl(receiptText).filter(row => row.type === 'model_request')
  const calls = resumed.rows.filter(row => row.type === 'tool/call' && row.data?.callId === callId)
  const results = resumed.rows.filter(row => row.type === 'tool/result' && resultCallId(row) === callId)
  const unknown = results.filter(row => errorCode(row) === 'TOOL_OUTCOME_UNKNOWN')
  const successful = results.filter(row => {
    const message = row.data?.message
    return message !== null && typeof message === 'object' && !Array.isArray(message) && message.isError === false
  })
  const interruptedEnds = resumed.rows.filter(row => turnEndReasonKind(row) === 'interrupted')
  const outputRows = parseJsonl(secondOutput.stdout)
  const final = outputRows.at(-1)

  expect(calls.length === 1, `${scenario}: expected one durable tool/call, got ${calls.length}`)
  expect(ledger.length === 1 && ledger[0]?.callId === callId, `${scenario}: expected one handler-entry ledger row`)
  expect(ledger[0]?.scenario === scenario && ledger[0]?.phase === 'crash' && ledger[0]?.tool === TOOL
    && hasMultiplyArguments(ledger[0]!), `${scenario}: handler-entry ledger fields do not match the dispatched call`)
  expect(adapterRequests.length === (scenario === 'completed' ? 3 : 2),
    `${scenario}: fixed adapter request receipt count was ${adapterRequests.length}`)
  expect(interruptedEnds.length >= 1, `${scenario}: recovery did not durably close the interrupted turn`)
  if (scenario === 'completed') {
    expect(successful.length === 1, `completed: expected one successful result, got ${successful.length}`)
    expect(unknown.length === 0, `completed: successful call was repaired as unknown ${unknown.length} time(s)`)
    expect(final?.type === 'final' && final.text === '{"answer":42}', 'completed: final answer mismatch')
  } else {
    expect(successful.length === 0, `unknown: unexpected successful result count ${successful.length}`)
    expect(unknown.length === 1, `unknown: expected one unknown-outcome result, got ${unknown.length}`)
    expect(final?.type === 'final' && final.text === '{"status":"unknown","action":"verify_external_state"}',
      'unknown: safe final answer mismatch')
  }

  await writeFile(join(paths.artifacts, 'failpoint.txt'), await readFile(paths.marker))
  const rawReceiptNames = [
    'phase1-stdout.jsonl',
    'phase1-stderr.txt',
    'phase2-stdout.jsonl',
    'phase2-stderr.txt',
    'session-after-crash.jsonl',
    'session-after-resume.jsonl',
    'execution-ledger.jsonl',
    'plugin-receipts.jsonl',
    'failpoint.txt',
  ]
  const receiptFiles: Record<string, Json> = {}
  for (const name of rawReceiptNames) {
    const path = join(paths.artifacts, name)
    receiptFiles[name] = { sha256: await sha256(path) }
  }
  const manifestPath = join(paths.artifacts, 'receipts.sha256.json')
  await writeFile(manifestPath, JSON.stringify({ algorithm: 'sha256', files: receiptFiles }, undefined, 2) + '\n')

  const summary: Record<string, Json> = {
    passed: true,
    scenario,
    backend: 'deepseek-harness',
    upstreamCommit,
    profile: 'headless',
    model: `${'spike-recovery-mock'}/${'fixed'}`,
    executedInputs,
    sessionId,
    marker,
    phase1Exit: { code: firstExit.code, signal: firstExit.signal },
    phase2Exit: { code: secondExit.code, signal: secondExit.signal },
    counts: {
      toolCalls: calls.length,
      successfulResults: successful.length,
      unknownOutcomeResults: unknown.length,
      handlerEntriesObserved: ledger.length,
      interruptedTurnEnds: interruptedEnds.length,
      fixedAdapterRequestReceipts: adapterRequests.length,
      handlerEntryReceipts: ledger.length,
    },
    fixedAdapterRequests: {
      provider: 'spike-recovery-mock',
      model: 'fixed',
      receiptType: 'model_request',
      source: 'plugin-receipts.jsonl',
      count: adapterRequests.length,
    },
    receiptManifest: {
      path: manifestPath,
      sha256: await sha256(manifestPath),
      rawReceiptCount: rawReceiptNames.length,
    },
    final: final?.text ?? null,
    assertions: {
      officialNamedHeadlessProfile: true,
      publicSessionIdResume: true,
      processKilledAfterCheckpointReturned: true,
      exactlyOneHandlerEntryObserved: true,
      crashPrefixPreserved: true,
      interruptedTurnReasonObserved: true,
      ...(scenario === 'completed'
        ? { fixedAdapterDidNotReissueCompletedCallAfterRestart: true }
        : { fixedAdapterDidNotReissueUnknownCallAfterRestart: true }),
      fixedAdapterRequestsRecorded: true,
    },
    evidenceScope: scenario === 'completed'
      ? 'The process-kill experiment shows that restored history let this fixed adapter avoid reissuing the completed call. It does not establish runtime exactly-once deduplication or power-loss durability.'
      : 'The ledger proves handler entry, not business-effect commit. Recovery recorded the missing durable result as unknown, and this fixed adapter chose not to reissue the call.',
    artifacts: paths.artifacts,
    persistedSession: resumed.path,
    commands: {
      phase1: first.command.join(' '),
      phase2: second.command.join(' '),
    },
  }
  await writeFile(join(paths.artifacts, 'summary.json'), JSON.stringify(summary, undefined, 2) + '\n')
  return summary
}

expect(resolve(runRoot).startsWith(`${scratchParent}\\`) && basename(runRoot).startsWith('.nexgent-dsh-recovery-'),
  `scratch escaped the approved parent: ${runRoot}`)
const gitBefore = await gitSnapshot()
expect(gitBefore.head === EXPECTED_UPSTREAM, `upstream drift: expected ${EXPECTED_UPSTREAM}, got ${gitBefore.head}`)
expect(gitBefore.trackedStatus === '', `upstream tracked tree is dirty before the run:\n${gitBefore.trackedStatus}`)
const executedInputs: Record<string, Json> = {
  cliBin: { path: cliBinPath, sha256: await sha256(cliBinPath) },
  patch: { path: patchPath, sha256: await sha256(patchPath) },
  plugin: { path: pluginPath, sha256: await sha256(pluginPath) },
  lockfile: { path: lockfilePath, sha256: await sha256(lockfilePath) },
}
const outcomes: Record<string, Json> = {}
let failed = false
for (const scenario of ['completed', 'unknown'] as const) {
  try {
    outcomes[scenario] = await runScenario(scenario, gitBefore.head, executedInputs) as Json
  } catch (error: unknown) {
    failed = true
    const paths = scenarioPaths(scenario)
    await mkdir(paths.artifacts, { recursive: true })
    const failure: Record<string, Json> = {
      passed: false,
      scenario,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      artifacts: paths.artifacts,
    }
    await writeFile(join(paths.artifacts, 'failure.json'), JSON.stringify(failure, undefined, 2) + '\n')
    outcomes[scenario] = failure
  }
}
const gitAfter = await gitSnapshot()
expect(gitAfter.head === EXPECTED_UPSTREAM, `upstream HEAD changed during the run: ${gitAfter.head}`)
expect(gitAfter.trackedStatus === '', `upstream tracked tree became dirty during the run:\n${gitAfter.trackedStatus}`)
const summary = {
  passed: !failed,
  backend: 'deepseek-harness',
  upstreamCommit: gitBefore.head,
  upstreamTrackedTree: {
    cleanBefore: gitBefore.trackedStatus === '',
    cleanAfter: gitAfter.trackedStatus === '',
    statusMode: 'git status --porcelain=v1 --untracked-files=no',
    safeDirectoryScope: 'per-command',
  },
  profile: 'headless',
  executedInputs,
  scratchRoot: runRoot,
  outcomes,
  evidenceScope: 'This is process-kill recovery with a deterministic fixed adapter. It does not establish runtime exactly-once deduplication or power-loss durability; an unknown-outcome ledger row records handler entry, not business-effect commit.',
  isolation: 'The fixture plugin and tool execute in the host process; this is Agent scope plus process-crash recovery, not an OS sandbox.',
}
await writeFile(join(runRoot, 'summary.json'), JSON.stringify(summary, undefined, 2) + '\n')
process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
if (failed) process.exitCode = 1
