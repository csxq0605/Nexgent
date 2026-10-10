/**
 * Cross-process harness: start a Node child, watch its output, wait for
 * files, kill its process tree, and await its exit. Used by package tests
 * and by `scripts/accept-step1.mjs`.
 *
 * Design follows deepseek-harness `test-support/session-snapshot`
 * (`launcher.ts`: spawn, capture, wait-for-state, kill); rewritten.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { killProcessTree, TimeoutError } from './faults.js'

/** Options for {@link spawnNode}. */
export interface SpawnNodeOptions {
  /** Working directory (default `process.cwd()`). */
  readonly cwd?: string
  /** Extra environment, merged over `process.env`; `undefined` values delete a key. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Do not inherit `process.env` (only `env` plus `PATH`/`SystemRoot` are passed). */
  readonly cleanEnv?: boolean
  /** Text written to stdin, which is then closed. Default: stdin ignored. */
  readonly stdin?: string
  /** Flags for node itself, placed before `args` (e.g. `['--import', 'tsx']`). */
  readonly nodeArgs?: readonly string[]
}

/** How a child ended. */
export interface ProcessExit {
  /** Exit code, or `null` when killed by a signal. */
  readonly code: number | null
  /** Terminating signal, or `null`. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Wall time from spawn to exit. */
  readonly durationMs: number
}

/** Which output stream(s) a matcher looks at. */
export type OutputStream = 'stdout' | 'stderr' | 'both'

/** A matcher over accumulated output. */
export type OutputMatcher = RegExp | ((text: string) => boolean)

/** Result of {@link NodeProcessHandle.waitForOutput}. */
export interface OutputMatch {
  /** The accumulated text of the watched stream(s) when the matcher passed. */
  readonly text: string
  /** The regex match, when the matcher was a RegExp. */
  readonly match: RegExpExecArray | undefined
}

/** A running Node child. */
export interface NodeProcessHandle {
  readonly pid: number
  readonly child: ChildProcess
  /** stdout so far. */
  readonly stdout: string
  /** stderr so far. */
  readonly stderr: string
  /** Resolves when the child exits (never rejects). */
  readonly exit: Promise<ProcessExit>
  /** Whether the child has exited. */
  readonly exited: boolean
  /**
   * Resolve when the accumulated output matches. Rejects with
   * {@link TimeoutError} after `timeoutMs` (default 10000), or with an
   * error carrying the output if the child exits first.
   */
  waitForOutput(matcher: OutputMatcher, timeoutMs?: number, stream?: OutputStream): Promise<OutputMatch>
  /** {@link waitForFile} with a default 10000 ms timeout; also rejects if the child exits first. */
  waitForFile(path: string, timeoutMs?: number, predicate?: (content: string) => boolean): Promise<string>
  /**
   * Kill the child. `tree` (default true) kills descendants too: Windows
   * uses `taskkill /T /F`; POSIX signals every descendant. Resolves with the exit.
   */
  kill(signal?: NodeJS.Signals, options?: { readonly tree?: boolean }): Promise<ProcessExit>
}

const live = new Set<NodeProcessHandle>()

/**
 * Spawn `node <nodeArgs> <args>` with piped stdout/stderr (UTF-8).
 * @param args - script path and its arguments.
 * @param options - cwd, env, stdin.
 */
export function spawnNode(args: readonly string[], options: SpawnNodeOptions = {}): NodeProcessHandle {
  const base: Record<string, string | undefined> = options.cleanEnv === true
    ? { PATH: process.env['PATH'], Path: process.env['Path'], SystemRoot: process.env['SystemRoot'] }
    : { ...process.env }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...base, ...options.env })) {
    if (value !== undefined) env[key] = value
  }
  const started = Date.now()
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), ...args], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const l of [...listeners]) l()
  }
  child.stdout?.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
    notify()
  })
  child.stderr?.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
    notify()
  })
  if (options.stdin !== undefined && child.stdin !== null) {
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin)
  }

  const exit = new Promise<ProcessExit>((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      exited = true
      live.delete(handle)
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started })
      notify()
    }
    child.on('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`
      finish(null, null)
    })
    child.on('close', finish)
  })

  const text = (stream: OutputStream): string =>
    stream === 'stdout' ? stdout : stream === 'stderr' ? stderr : `${stdout}${stderr}`

  const handle: NodeProcessHandle = {
    get pid() { return child.pid ?? -1 },
    child,
    get stdout() { return stdout },
    get stderr() { return stderr },
    exit,
    get exited() { return exited },
    waitForOutput(matcher, timeoutMs = 10_000, stream = 'both') {
      return new Promise<OutputMatch>((resolve, reject) => {
        const test = (): OutputMatch | undefined => {
          const current = text(stream)
          if (typeof matcher === 'function') return matcher(current) ? { text: current, match: undefined } : undefined
          matcher.lastIndex = 0
          const match = matcher.exec(current)
          return match === null ? undefined : { text: current, match }
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          listeners.delete(check)
        }
        function check(): void {
          const result = test()
          if (result !== undefined) {
            cleanup()
            resolve(result)
          } else if (exited) {
            cleanup()
            reject(new Error(`process exited before output matched ${String(matcher)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
          }
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new TimeoutError(`output did not match ${String(matcher)} within ${timeoutMs}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`))
        }, timeoutMs)
        listeners.add(check)
        check()
      })
    },
    async waitForFile(path, timeoutMs = 10_000, predicate) {
      const exitedEarly = exit.then(() => {
        throw new Error(`process exited before ${path} appeared\n--- stderr ---\n${stderr}`)
      })
      const controller = new AbortController()
      try {
        return await Promise.race([waitForFile(path, { timeoutMs, signal: controller.signal, ...(predicate ? { predicate } : {}) }), exitedEarly])
      } finally {
        controller.abort()
        exitedEarly.catch(() => {})
      }
    },
    async kill(signal = 'SIGKILL', killOptions = {}) {
      if (!exited && child.pid !== undefined) {
        if (killOptions.tree ?? true) await killProcessTree(child.pid, signal)
        else child.kill(signal)
      }
      return exit
    },
  }
  live.add(handle)
  return handle
}

/** Kill every {@link spawnNode} child still running (for `afterEach`). */
export async function killAllSpawned(): Promise<void> {
  await Promise.all([...live].map((h) => h.kill('SIGKILL')))
}

/** Options for {@link waitForFile}. */
export interface WaitForFileOptions {
  /** Default 10000. */
  readonly timeoutMs?: number
  /** Poll interval, default 25. */
  readonly intervalMs?: number
  /** Extra condition on the file's UTF-8 content. */
  readonly predicate?: (content: string) => boolean
  /** Stops polling (rejects with the signal's reason). */
  readonly signal?: AbortSignal
}

/**
 * Poll until `path` exists (and `predicate` accepts its content); resolves
 * with the content.
 * @param path - file to wait for.
 * @param options - timeout, interval, predicate.
 */
export async function waitForFile(path: string, options: WaitForFileOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const end = Date.now() + timeoutMs
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason
    try {
      if ((await stat(path)).isFile()) {
        const content = await readFile(path, 'utf8')
        if (options.predicate === undefined || options.predicate(content)) return content
      }
    } catch {
      // not there yet
    }
    if (Date.now() >= end) throw new TimeoutError(`file ${path} did not appear within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25))
  }
}
