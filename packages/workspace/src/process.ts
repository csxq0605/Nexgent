// Adapted from deepseek-harness@46a7f68b packages/subprocess/subprocess-local/src/spawn.ts (MIT)
/**
 * The `ctx.processes` implementation. One rule from the contract: when `run`
 * resolves, no process it started is still alive. POSIX children start in
 * their own process group (`detached`) and the whole group is signalled
 * (`SIGTERM`, then `SIGKILL` after `graceMs`). On Windows each command runs
 * inside a kill-on-close Job Object (see `windows-job.ts`), so terminating the
 * launcher with `taskkill /PID <pid> /T /F` ends every process of the job,
 * descendants whose parent already exited included. Leftover background
 * members are also reaped after a normal exit (the process group on POSIX,
 * the job on Windows).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { NexgentError, type ProcessResult, type ProcessRunner, type ProcessSpec } from '@nexgent/kernel'
import { scrubEnv } from './env.js'
import { DEFAULT_MAX_OUTPUT_BYTES, FileSink, HeadTailBuffer, MODEL_OUTPUT_CHARS, omittedMarker } from './output.js'
import { Redactor } from './redact.js'
import { currentPowerShell, PWSH_MISSING_MESSAGE } from './shell-check.js'
import { JOB_SPEC_ENV, JOB_START_FAILED_EXIT, JOB_START_FAILED_MARKER, jobLaunchSpec, jobLauncherArgs } from './windows-job.js'

/** Default wait between the polite and the forced kill (ms). */
export const DEFAULT_GRACE_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647
const POLL_MS = 20

/** Options for {@link LocalProcessRunner}. */
export interface ProcessRunnerOptions {
  /** Per-stream output cap in bytes (head and tail kept, the middle dropped); default 64 KiB. */
  readonly maxOutputBytes?: number
  /** `SIGTERM` → `SIGKILL` delay; default 5000 ms. */
  readonly graceMs?: number
  /** Redactor applied to captured output; scrubbed env values are added per run. */
  readonly redactor?: Redactor
  /** Remove secrets from the inherited environment (default `true`). */
  readonly scrubEnv?: boolean
  /** Host environment to inherit; default `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  /** Windows only: run commands inside a kill-on-close Job Object (default `true`); `false` leaves only `taskkill /T`. */
  readonly windowsJob?: boolean
  /** Windows only: the PowerShell executable that launches the job (default: `pwsh`, else Windows PowerShell 5.1). */
  readonly pwshPath?: string
}

/**
 * What {@link LocalProcessRunner.run} accepts beyond the kernel's `ProcessSpec`:
 * paths that receive the complete (redacted) stdout / stderr while the result
 * keeps only the capped head and tail.
 */
export interface LocalProcessSpec extends ProcessSpec {
  readonly outputFiles?: { readonly stdout: string; readonly stderr: string }
}

/** Whether a POSIX process group still has a live (non-zombie) member. */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (process.platform !== 'linux') return true
  // Zombies keep `kill(-pgid, 0)` succeeding until reaped; on Linux check /proc for live members.
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      let stat: string
      try {
        stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      } catch {
        continue
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true
    }
    return false
  } catch {
    return true
  }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

function treeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  return processGroupAlive(child.pid)
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await sleep(POLL_MS)
  }
  return true
}

/**
 * Why a command could not start. When the Windows job launcher (`pwsh`) is
 * itself missing, say so instead of blaming the command.
 */
export function startFailureMessage(command: string, error: NodeJS.ErrnoException, viaJobLauncher: boolean): string {
  if (viaJobLauncher && error.code === 'ENOENT') return `failed to start ${command}: ${PWSH_MISSING_MESSAGE}`
  return `failed to start ${command}: ${error.message}`
}

/** Spawn `spec` the way every command is started: scrubbed environment, own process group, Job Object launcher on Windows. */
function startChild(
  spec: Pick<ProcessSpec, 'command' | 'args' | 'cwd' | 'env' | 'stdin'>,
  options: ProcessRunnerOptions,
  baseRedactor: Redactor,
): { child: ChildProcess; redactor: Redactor; useJob: boolean } {
  const host = options.hostEnv ?? process.env
  const scrubbed = options.scrubEnv === false
    ? { env: { ...Object.fromEntries(Object.entries(host).filter(([, v]) => v !== undefined)), ...spec.env } as Record<string, string>, removedValues: [] }
    : scrubEnv(host, spec.env)
  const redactor = baseRedactor.with(scrubbed.removedValues)

  const useJob = process.platform === 'win32' && options.windowsJob !== false
  const env = useJob
    ? { ...scrubbed.env, [JOB_SPEC_ENV]: JSON.stringify(jobLaunchSpec(spec.command, spec.args, scrubbed.env)) }
    : scrubbed.env
  const child = spawn(useJob ? (options.pwshPath ?? currentPowerShell().program) : spec.command, useJob ? jobLauncherArgs() : [...spec.args], {
    cwd: spec.cwd,
    env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  return { child, redactor, useJob }
}

/** Spawns one-shot processes with deadline, cancellation, tree kill, env scrub, output cap and redaction. */
export class LocalProcessRunner implements ProcessRunner {
  private readonly maxOutputBytes: number
  private readonly graceMs: number
  private readonly redactor: Redactor

  constructor(private readonly options: ProcessRunnerOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.redactor = options.redactor ?? new Redactor()
  }

  async run(spec: LocalProcessSpec): Promise<ProcessResult> {
    const started = Date.now()
    if (spec.signal?.aborted === true) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 }
    }
    const { child, redactor, useJob } = startChild(spec, this.options, this.redactor)

    const buffers = { stdout: new HeadTailBuffer(this.maxOutputBytes), stderr: new HeadTailBuffer(this.maxOutputBytes) }
    const sinks = spec.outputFiles === undefined
      ? undefined
      : { stdout: new FileSink(spec.outputFiles.stdout, redactor), stderr: new FileSink(spec.outputFiles.stderr, redactor) }
    const closed: Promise<void>[] = []
    for (const stream of ['stdout', 'stderr'] as const) {
      const readable = child[stream]!
      const decoder = new StringDecoder('utf8')
      readable.on('data', (chunk: Buffer) => {
        buffers[stream].push(chunk)
        sinks?.[stream].write(chunk)
        if (spec.onOutput !== undefined) {
          const text = decoder.write(chunk)
          if (text !== '') spec.onOutput(stream, redactor.redact(text))
        }
      })
      closed.push(new Promise(resolve => {
        readable.once('close', () => resolve())
      }))
    }
    if (spec.stdin !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(spec.stdin)
    }

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    let timedOut = false
    let aborted = false
    let killing: Promise<void> | undefined
    const kill = (): Promise<void> => {
      killing ??= (async () => {
        signalTree(child, 'SIGTERM')
        if (!(await waitUntil(() => !treeAlive(child), this.graceMs))) signalTree(child, 'SIGKILL')
      })()
      return killing
    }
    const timer = setTimeout(() => {
      timedOut = true
      void kill()
    }, Math.max(1, Math.min(spec.timeoutMs, MAX_TIMER_MS)))
    const onAbort = (): void => {
      aborted = true
      void kill()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    let outcome: { code: number | null; signal: NodeJS.Signals | null }
    try {
      outcome = await exited
    } catch (error) {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      throw new NexgentError('process/failed', startFailureMessage(spec.command, error as NodeJS.ErrnoException, useJob), { cause: error })
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }

    // The root exited; reap the rest of its group (background jobs, or the tree mid-kill).
    if (killing !== undefined) await killing
    if (treeAlive(child)) await kill()
    if (!(await waitUntil(() => !treeAlive(child), this.graceMs + 5_000))) {
      signalTree(child, 'SIGKILL')
      await waitUntil(() => !treeAlive(child), 5_000)
    }
    // Pipes may be held by an escaped descendant; do not wait forever.
    const drained = await Promise.race([Promise.all(closed).then(() => true), sleep(1_000).then(() => false)])
    if (!drained) {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }

    if (sinks !== undefined) await Promise.all([sinks.stdout.close(), sinks.stderr.close()])

    if (useJob && outcome.code === JOB_START_FAILED_EXIT) {
      const line = buffers.stderr.text().split(/\r?\n/).find(text => text.startsWith(JOB_START_FAILED_MARKER))
      if (line !== undefined) {
        throw new NexgentError('process/failed', `failed to start ${spec.command}: ${line.slice(JOB_START_FAILED_MARKER.length)}`)
      }
    }

    return {
      exitCode: outcome.code,
      ...(outcome.signal === null ? {} : { signal: outcome.signal }),
      stdout: redactor.redact(buffers.stdout.text()),
      stderr: redactor.redact(buffers.stderr.text()),
      timedOut,
      aborted,
      durationMs: Date.now() - started,
    }
  }
}

/** What {@link BackgroundShells.start} needs. */
export interface BackgroundStart {
  readonly sessionId: string
  /** Executable and arguments of the real process (already wrapped by the OS sandbox when it applies). */
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** What the model asked to run, for listings. */
  readonly label: string
  /** File that receives the complete (redacted) stdout and stderr, in arrival order. */
  readonly logPath: string
  /** Optional deadline; background processes have none by default. */
  readonly timeoutMs?: number
  /** Called once when the process (and its tree) has ended. */
  readonly onExit?: () => void
}

/** A background process as the model sees it. */
export interface BackgroundStatus {
  readonly id: string
  readonly label: string
  readonly running: boolean
  /** Exit code once it ended; `null` while running or when killed by a signal. */
  readonly exitCode: number | null
  readonly signal?: string
  /** Whether {@link BackgroundShells.kill} (or the deadline) ended it. */
  readonly killed: boolean
  readonly durationMs: number
  readonly logPath: string
}

/** The answer of {@link BackgroundShells.read}. */
export interface BackgroundRead extends BackgroundStatus {
  /** Output produced since the previous read (complete lines, redacted); the middle is dropped when it exceeds the cap. */
  readonly output: string
}

interface BackgroundEntry {
  readonly id: string
  readonly sessionId: string
  readonly label: string
  readonly logPath: string
  readonly child: ChildProcess
  readonly startedAt: number
  readonly exited: Promise<void>
  unread: string
  droppedUnread: number
  running: boolean
  exitCode: number | null
  signal: string | undefined
  killed: boolean
  endedAt: number | undefined
  kill: () => Promise<void>
  readonly onExit: (() => void) | undefined
}

const liveRegistries = new Set<BackgroundShells>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Synchronous last resort: signal every still-running tree when the host exits.
  process.once('exit', () => {
    for (const registry of liveRegistries) registry.killAllNow()
  })
}

/**
 * Processes started with `run_in_background`. Each one runs in its own tree
 * (same rules as {@link LocalProcessRunner}), writes its complete output to a
 * log file and keeps the unread part in memory for `shell_output`. Everything
 * of a session is killed by {@link disposeSession}; everything at all by
 * {@link disposeAll} and when the host process exits.
 */
export class BackgroundShells {
  private readonly entries = new Map<string, BackgroundEntry>()
  private counter = 0
  private readonly graceMs: number
  private readonly redactor: Redactor
  private readonly maxUnread: number

  constructor(private readonly options: ProcessRunnerOptions & { readonly maxUnreadChars?: number } = {}) {
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.redactor = options.redactor ?? new Redactor()
    this.maxUnread = options.maxUnreadChars ?? MODEL_OUTPUT_CHARS
    liveRegistries.add(this)
    installExitHook()
  }

  /** Start a process and return at once. Throws `process/failed` when it cannot start. */
  start(spec: BackgroundStart): BackgroundStatus {
    const { child, redactor, useJob } = startChild(
      { command: spec.command, args: spec.args, cwd: spec.cwd, ...(spec.env === undefined ? {} : { env: spec.env }) },
      this.options,
      this.redactor,
    )
    const id = `bg-${++this.counter}`
    const entry: BackgroundEntry = {
      id, sessionId: spec.sessionId, label: spec.label, logPath: spec.logPath, child, startedAt: Date.now(),
      exited: undefined as unknown as Promise<void>,
      unread: '', droppedUnread: 0, running: true, exitCode: null, signal: undefined, killed: false, endedAt: undefined,
      kill: undefined as unknown as () => Promise<void>,
      onExit: spec.onExit,
    }
    const onText = (text: string): void => {
      entry.unread += text
      if (entry.unread.length > this.maxUnread * 2) {
        const drop = entry.unread.length - this.maxUnread * 2
        entry.unread = entry.unread.slice(drop)
        entry.droppedUnread += drop
      }
    }
    const sinks = [new FileSink(spec.logPath, redactor, onText), new FileSink(spec.logPath, redactor, onText)]
    const closed: Promise<void>[] = []
    for (const [index, stream] of (['stdout', 'stderr'] as const).entries()) {
      const readable = child[stream]!
      readable.on('data', (chunk: Buffer) => sinks[index]!.write(chunk))
      closed.push(new Promise(resolve => readable.once('close', () => resolve())))
    }

    let killing: Promise<void> | undefined
    const kill = (): Promise<void> => {
      killing ??= (async () => {
        signalTree(child, 'SIGTERM')
        if (!(await waitUntil(() => !treeAlive(child), this.graceMs))) signalTree(child, 'SIGKILL')
      })()
      return killing
    }
    entry.kill = kill
    let timer: NodeJS.Timeout | undefined
    if (spec.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        entry.killed = true
        void kill()
      }, Math.max(1, Math.min(spec.timeoutMs, MAX_TIMER_MS)))
    }

    const exited = new Promise<void>(resolve => {
      const finish = async (code: number | null, signal: NodeJS.Signals | null, failure?: Error): Promise<void> => {
        if (timer !== undefined) clearTimeout(timer)
        if (killing !== undefined) await killing
        if (treeAlive(child)) await kill()
        await waitUntil(() => !treeAlive(child), this.graceMs + 5_000)
        const drained = await Promise.race([Promise.all(closed).then(() => true), sleep(1_000).then(() => false)])
        if (!drained) {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        if (failure !== undefined) onText(`${startFailureMessage(spec.command, failure as NodeJS.ErrnoException, useJob)}\n`)
        await Promise.all(sinks.map(sink => sink.close()))
        entry.exitCode = code
        entry.signal = signal ?? undefined
        entry.running = false
        entry.endedAt = Date.now()
        try {
          entry.onExit?.()
        } catch {
          // a failing callback must not strand the process record
        }
        resolve()
      }
      child.once('error', error => { void finish(null, null, error) })
      child.once('exit', (code, signal) => { void finish(code, signal) })
    })
    ;(entry as { exited: Promise<void> }).exited = exited
    this.entries.set(id, entry)
    return this.status(entry)
  }

  private status(entry: BackgroundEntry): BackgroundStatus {
    return {
      id: entry.id,
      label: entry.label,
      running: entry.running,
      exitCode: entry.exitCode,
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      killed: entry.killed,
      durationMs: (entry.endedAt ?? Date.now()) - entry.startedAt,
      logPath: entry.logPath,
    }
  }

  private find(sessionId: string, id: string): BackgroundEntry | undefined {
    const entry = this.entries.get(id)
    return entry !== undefined && entry.sessionId === sessionId ? entry : undefined
  }

  /** The processes of a session. */
  list(sessionId: string): BackgroundStatus[] {
    return [...this.entries.values()].filter(entry => entry.sessionId === sessionId).map(entry => this.status(entry))
  }

  /** New output since the last read, or `undefined` for an unknown id (or another session's). */
  read(sessionId: string, id: string): BackgroundRead | undefined {
    const entry = this.find(sessionId, id)
    if (entry === undefined) return undefined
    let output = entry.unread
    let dropped = entry.droppedUnread
    entry.unread = ''
    entry.droppedUnread = 0
    if (output.length > this.maxUnread) {
      const head = Math.floor(this.maxUnread / 2)
      const tail = this.maxUnread - head
      dropped += output.length - head - tail
      output = `${output.slice(0, head)}\n${omittedMarker(dropped, 'chars')}\n${output.slice(output.length - tail)}`
    } else if (dropped > 0) {
      output = `${omittedMarker(dropped, 'chars')}\n${output}`
    }
    return { ...this.status(entry), output }
  }

  /** Kill the tree and wait until it is gone. `undefined` for an unknown id. */
  async kill(sessionId: string, id: string): Promise<BackgroundStatus | undefined> {
    const entry = this.find(sessionId, id)
    if (entry === undefined) return undefined
    if (entry.running) {
      entry.killed = true
      await entry.kill()
      await entry.exited
    }
    return this.status(entry)
  }

  /** Kill every process of a session and forget them. Call when the session closes. */
  async disposeSession(sessionId: string): Promise<void> {
    const mine = [...this.entries.values()].filter(entry => entry.sessionId === sessionId)
    await Promise.all(mine.map(async entry => {
      if (entry.running) {
        entry.killed = true
        await entry.kill()
        await entry.exited
      }
      this.entries.delete(entry.id)
    }))
  }

  /** Kill everything. */
  async disposeAll(): Promise<void> {
    const sessions = new Set([...this.entries.values()].map(entry => entry.sessionId))
    await Promise.all([...sessions].map(sessionId => this.disposeSession(sessionId)))
    liveRegistries.delete(this)
  }

  /** Synchronous SIGKILL of every running tree (host exit). */
  killAllNow(): void {
    for (const entry of this.entries.values()) if (entry.running) signalTree(entry.child, 'SIGKILL')
  }
}
