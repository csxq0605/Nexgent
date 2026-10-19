/**
 * The host side of a PTC run (`permissions.md` §代码执行进程): one new Node
 * process per call, started with an empty environment (on Windows only the
 * variables Windows needs to start a process, which the bootstrap deletes
 * before model code runs), the Node permission model on (no file system, no
 * child processes, no worker threads, no native addons), a heap cap, and the
 * project root as cwd. Files and other host capabilities exist in the
 * program only as host functions answered over the stdio protocol
 * (`protocol.ts`); each call is checked by the host function itself.
 *
 * Bounds: a deadline (default 60 s, at most 300 s), a cap on captured output
 * and on the returned value, and a cap on one protocol line. On timeout,
 * cancellation, a protocol violation or an exceeded line cap the whole
 * process tree is killed (POSIX: the process group; Windows: a kill-on-close
 * Job Object through `@nexgent/workspace`'s launcher, then `taskkill /T`),
 * and {@link runProgram} resolves only after the tree is gone.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { NexgentError, type JsonValue } from '@nexgent/kernel'
import { JOB_SPEC_ENV, jobLaunchSpec, jobLauncherArgs, processGroupAlive } from '@nexgent/workspace'
import { BOOTSTRAP_SOURCE } from './bootstrap.js'
import { parseProgramMessage, type CallMessage, type HostMessage } from './protocol.js'

/** Default and largest program deadline (ms), as `run_code`'s `timeoutMs`. */
export const PTC_LIMITS = {
  defaultTimeoutMs: 60_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 300_000,
  /** Captured output kept (UTF-16 code units of text; the head is kept, the rest dropped). */
  maxOutputChars: 64_000,
  /** Characters of the JSON-encoded return value. */
  maxValueChars: 256_000,
  /** One protocol line from the program (a host call's arguments, the return value). */
  maxLineChars: 16 * 1024 * 1024,
  /** V8 old-space cap of the program process (MiB). */
  maxHeapMb: 512,
} as const

/** Variables a Windows process needs to start; passed to the launcher, removed by the bootstrap. */
export const WINDOWS_STARTUP_ENV = ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ComSpec'] as const

/** What a host function receives besides its arguments. */
export interface HostCallContext {
  /** Aborted when the program ends (finished, timed out, cancelled or killed). */
  readonly signal: AbortSignal
}

/**
 * One function the program can call. Arguments and result cross the process
 * boundary as JSON. A throw becomes a `HostError` in the program with the
 * thrown message (a {@link NexgentError} keeps its code in the message).
 */
export interface HostFunction {
  /** A JavaScript identifier, bound as a parameter of the program body. */
  readonly name: string
  call(args: readonly JsonValue[], context: HostCallContext): Promise<JsonValue | undefined>
}

/** How a program ended. */
export type ProgramStatus = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'crashed'

/** The outcome of {@link runProgram}. */
export interface ProgramResult {
  readonly status: ProgramStatus
  /** The JSON value the program returned (`completed` only, when it returned one). */
  readonly value?: JsonValue
  /** Captured output in order, stdout and stderr interleaved, capped at `maxOutputChars`. */
  readonly output: string
  /** Whether output was dropped at the cap. */
  readonly outputTruncated: boolean
  /** What failed (`failed` / `timeout` / `cancelled` / `crashed`). */
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string }
  /** Host function calls answered. */
  readonly calls: number
  readonly durationMs: number
  /** Process id of the program (for tests that check nothing is left). */
  readonly pid?: number
}

/** Options of {@link runProgram}. */
export interface RunProgramOptions {
  /** Async function body; `return` gives the result. */
  readonly code: string
  /** Working directory of the process (the project root). */
  readonly cwd: string
  readonly functions?: readonly HostFunction[]
  /** JSON values bound by name (e.g. `args`). */
  readonly globals?: Readonly<Record<string, JsonValue>>
  /** Trusted helper source, see `BootMessage.prelude`. */
  readonly prelude?: string
  /** Default {@link PTC_LIMITS.defaultTimeoutMs}; clamped to [`minTimeoutMs`, `maxTimeoutMs`] unless `unboundedTimeout`. */
  readonly timeoutMs?: number
  /** Allow `timeoutMs` above `maxTimeoutMs` (workflow scripts wait on members). */
  readonly unboundedTimeout?: boolean
  readonly signal?: AbortSignal
  readonly maxOutputChars?: number
  readonly maxValueChars?: number
  readonly maxLineChars?: number
  /** Streamed output, as it arrives (before the cap). */
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
  /** Node executable; default `process.execPath` (under Electron it runs as Node via `ELECTRON_RUN_AS_NODE`). */
  readonly nodePath?: string
  /** Turn the Node permission model off (only for hosts whose Node lacks it). Default on. */
  readonly permission?: boolean
  /** Windows only: run inside a kill-on-close Job Object (default `true`). */
  readonly windowsJob?: boolean
  /** Windows only: the `pwsh` that launches the job (default `pwsh`). */
  readonly pwshPath?: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The permission flag this Node understands (`--permission` from 22.13 / 23.5, before that `--experimental-permission`). */
export function permissionFlag(version: string = process.versions.node): string {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13)) return '--permission'
  return '--experimental-permission'
}

/** Node arguments of a program process. */
export function programArgs(options: { readonly permission?: boolean; readonly version?: string } = {}): string[] {
  return [
    ...(options.permission === false ? [] : [permissionFlag(options.version)]),
    `--max-old-space-size=${PTC_LIMITS.maxHeapMb}`,
    '--input-type=module',
    '--eval',
    BOOTSTRAP_SOURCE,
  ]
}

/** The program's environment: empty on POSIX; on Windows the startup variables only. */
export function programEnv(host: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {}
  if (platform === 'win32') {
    for (const name of WINDOWS_STARTUP_ENV) {
      const key = Object.keys(host).find(candidate => candidate.toLowerCase() === name.toLowerCase())
      const value = key === undefined ? undefined : host[key]
      if (value !== undefined) env[name] = value
    }
  }
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
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
    await sleep(20)
  }
  return true
}

function errorText(error: unknown): string {
  if (error instanceof NexgentError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Run one program in a new process and wait until it and every process it
 * started are gone.
 * @throws `tool/invalid-input` for a host function name that is not an identifier or is bound twice.
 * @throws `process/failed` when the process cannot be started.
 */
export async function runProgram(options: RunProgramOptions): Promise<ProgramResult> {
  const started = Date.now()
  const functions = options.functions ?? []
  const globals = options.globals ?? {}
  const names = [...functions.map(fn => fn.name), ...Object.keys(globals)]
  for (const name of names) {
    if (!IDENTIFIER.test(name)) throw new NexgentError('tool/invalid-input', `host binding ${JSON.stringify(name)} is not an identifier`)
  }
  if (new Set(names).size !== names.length) throw new NexgentError('tool/invalid-input', 'host bindings must have distinct names')
  const byName = new Map(functions.map(fn => [fn.name, fn]))
  const timeoutMs = options.unboundedTimeout === true
    ? Math.max(PTC_LIMITS.minTimeoutMs, options.timeoutMs ?? PTC_LIMITS.defaultTimeoutMs)
    : Math.min(PTC_LIMITS.maxTimeoutMs, Math.max(PTC_LIMITS.minTimeoutMs, options.timeoutMs ?? PTC_LIMITS.defaultTimeoutMs))
  const maxOutput = options.maxOutputChars ?? PTC_LIMITS.maxOutputChars
  const maxValue = options.maxValueChars ?? PTC_LIMITS.maxValueChars
  const maxLine = options.maxLineChars ?? PTC_LIMITS.maxLineChars

  if (options.signal?.aborted === true) {
    return { status: 'cancelled', output: '', outputTruncated: false, error: { name: 'AbortError', message: 'cancelled before start' }, calls: 0, durationMs: 0 }
  }

  const node = options.nodePath ?? process.execPath
  const args = programArgs({ ...(options.permission === undefined ? {} : { permission: options.permission }) })
  const env = programEnv()
  const useJob = process.platform === 'win32' && options.windowsJob !== false
  let child: ChildProcess
  try {
    child = spawn(useJob ? (options.pwshPath ?? 'pwsh') : node, useJob ? jobLauncherArgs() : args, {
      cwd: options.cwd,
      env: useJob ? { ...env, [JOB_SPEC_ENV]: JSON.stringify(jobLaunchSpec(node, args, env)) } : env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new NexgentError('process/failed', `cannot start the program process: ${(error as Error).message}`, { cause: error })
  }

  const life = new AbortController()
  let output = ''
  let outputTruncated = false
  let calls = 0
  let ended: { status: ProgramStatus; value?: JsonValue; error?: ProgramResult['error'] } | undefined
  const settle = (outcome: NonNullable<typeof ended>): void => {
    ended ??= outcome
  }
  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    options.onOutput?.(stream, text)
    if (outputTruncated) return
    const room = maxOutput - output.length
    if (text.length <= room) {
      output += text
      return
    }
    output += text.slice(0, Math.max(0, room))
    outputTruncated = true
  }
  const send = (message: HostMessage): void => {
    if (child.stdin?.writable !== true) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const answer = async (message: CallMessage): Promise<void> => {
    const fn = byName.get(message.fn)
    if (fn === undefined) {
      send({ t: 'reply', id: message.id, ok: false, error: `no host function ${message.fn}` })
      return
    }
    try {
      const value = await fn.call(message.args, { signal: life.signal })
      calls += 1
      if (life.signal.aborted) return
      send(value === undefined ? { t: 'reply', id: message.id, ok: true } : { t: 'reply', id: message.id, ok: true, value })
    } catch (error) {
      calls += 1
      if (life.signal.aborted) return
      send({ t: 'reply', id: message.id, ok: false, error: errorText(error) })
    }
  }

  let killing: Promise<void> | undefined
  const kill = (): Promise<void> => {
    killing ??= (async () => {
      killTree(child)
      await waitUntil(() => !treeAlive(child), 5_000)
    })()
    return killing
  }

  child.stdin?.on('error', () => {})
  const stdoutDecoder = new StringDecoder('utf8')
  let lineBuffer = ''
  const onLine = (line: string): void => {
    if (line.trim() === '') return
    const message = parseProgramMessage(line)
    if (message === undefined) {
      append('stdout', `${line}\n`)
      return
    }
    switch (message.t) {
      case 'log':
        append(message.stream, message.text)
        return
      case 'call':
        void answer(message)
        return
      case 'done':
        if (!message.ok) {
          settle({ status: 'failed', error: message.error })
          return
        }
        if (message.value !== undefined && JSON.stringify(message.value).length > maxValue) {
          settle({ status: 'failed', error: { name: 'RangeError', message: `the return value is larger than ${maxValue} characters of JSON; return less or write it to a file` } })
          return
        }
        settle(message.value === undefined ? { status: 'completed' } : { status: 'completed', value: message.value })
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuffer += stdoutDecoder.write(chunk)
    const overflow = (): void => {
      lineBuffer = ''
      settle({ status: 'failed', error: { name: 'RangeError', message: `a message from the program exceeded ${maxLine} characters (a host call argument or the return value is too large)` } })
      void kill()
    }
    let index: number
    while ((index = lineBuffer.indexOf('\n')) >= 0) {
      if (index > maxLine) return overflow()
      const line = lineBuffer.slice(0, index)
      lineBuffer = lineBuffer.slice(index + 1)
      onLine(line)
    }
    if (lineBuffer.length > maxLine) overflow()
  })
  const stderrDecoder = new StringDecoder('utf8')
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', stderrDecoder.write(chunk)))

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const timer = setTimeout(() => {
    settle({ status: 'timeout', error: { name: 'TimeoutError', message: `the program did not finish within ${timeoutMs} ms and was stopped` } })
    void kill()
  }, timeoutMs)
  const onAbort = (): void => {
    settle({ status: 'cancelled', error: { name: 'AbortError', message: 'the program was cancelled' } })
    void kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  send({
    t: 'boot',
    code: options.code,
    functions: functions.map(fn => fn.name),
    globals,
    ...(options.prelude === undefined ? {} : { prelude: options.prelude }),
  })

  let exit: { code: number | null; signal: NodeJS.Signals | null }
  try {
    exit = await exited
  } catch (error) {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    life.abort()
    throw new NexgentError('process/failed', `cannot start the program process: ${(error as Error).message}`, { cause: error })
  }
  clearTimeout(timer)
  options.signal?.removeEventListener('abort', onAbort)
  life.abort()
  if (lineBuffer.trim() !== '') onLine(lineBuffer)
  // The program never starts children (no permission), but reap the group anyway.
  if (killing !== undefined) await killing
  if (treeAlive(child)) await kill()
  child.stdin?.destroy()

  if (ended === undefined) {
    const how = exit.signal === null ? `exit code ${String(exit.code)}` : `signal ${exit.signal}`
    settle({ status: 'crashed', error: { name: 'Error', message: `the program process ended (${how}) without a result` } })
  }
  const outcome = ended!
  return {
    status: outcome.status,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    output,
    outputTruncated,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    calls,
    durationMs: Date.now() - started,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  }
}
