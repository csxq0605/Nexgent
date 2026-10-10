// Adapted from deepseek-harness@46a7f68b packages/subprocess/subprocess-local/src/spawn.ts (MIT)
/**
 * The `ctx.processes` implementation. One rule from the contract: when `run`
 * resolves, no process it started is still alive. POSIX children start in
 * their own process group (`detached`) and the whole group is signalled
 * (`SIGTERM`, then `SIGKILL` after `graceMs`); on Windows the tree is
 * terminated with `taskkill /PID <pid> /T /F`. Leftover background members of
 * the group are also reaped after a normal exit.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'
import { NexgentError, type ProcessResult, type ProcessRunner, type ProcessSpec } from '@nexgent/kernel'
import { scrubEnv } from './env.js'
import { DEFAULT_MAX_OUTPUT_BYTES, TailBuffer } from './output.js'
import { Redactor } from './redact.js'

/** Default wait between the polite and the forced kill (ms). */
export const DEFAULT_GRACE_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647
const POLL_MS = 20

/** Options for {@link LocalProcessRunner}. */
export interface ProcessRunnerOptions {
  /** Per-stream output cap in bytes (tail kept); default 64 KiB. */
  readonly maxOutputBytes?: number
  /** `SIGTERM` → `SIGKILL` delay; default 5000 ms. */
  readonly graceMs?: number
  /** Redactor applied to captured output; scrubbed env values are added per run. */
  readonly redactor?: Redactor
  /** Remove secrets from the inherited environment (default `true`). */
  readonly scrubEnv?: boolean
  /** Host environment to inherit; default `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
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

  async run(spec: ProcessSpec): Promise<ProcessResult> {
    const started = Date.now()
    if (spec.signal?.aborted === true) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 }
    }
    const host = this.options.hostEnv ?? process.env
    const scrubbed = this.options.scrubEnv === false
      ? { env: { ...Object.fromEntries(Object.entries(host).filter(([, v]) => v !== undefined)), ...spec.env } as Record<string, string>, removedValues: [] }
      : scrubEnv(host, spec.env)
    const redactor = this.redactor.with(scrubbed.removedValues)

    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: scrubbed.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })

    const buffers = { stdout: new TailBuffer(this.maxOutputBytes), stderr: new TailBuffer(this.maxOutputBytes) }
    const closed: Promise<void>[] = []
    for (const stream of ['stdout', 'stderr'] as const) {
      const readable = child[stream]!
      const decoder = new StringDecoder('utf8')
      readable.on('data', (chunk: Buffer) => {
        buffers[stream].push(chunk)
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
      throw new NexgentError('process/failed', `failed to start ${spec.command}: ${(error as Error).message}`, { cause: error })
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
