/**
 * A {@link TrialRunner} that runs each replay in its own OS process: the
 * host's replay entry gets the {@link ReplayRunRequest} as JSON on stdin and
 * prints one line `NEXGENT_REPLAY_RESULT <json>` (a {@link ReplayRunResult})
 * before exiting. A process that exits without that line, or outlives the
 * run's deadline (it is killed), is an `error` / `timeout` run, i.e.
 * `unknown` — never a failure.
 */
import { spawn } from 'node:child_process'
import { UNKNOWN_USAGE } from '@nexgent/kernel'
import type { ReplayRunRequest, ReplayRunResult, TrialRunner } from './gate.js'

/** Prefix of the result line a replay entry prints. */
export const REPLAY_RESULT_PREFIX = 'NEXGENT_REPLAY_RESULT '

/** How to start a replay process. */
export interface ProcessRunnerOptions {
  /** Executable (default `process.execPath`). */
  readonly command?: string
  /** Arguments before nothing else: the entry script and its mode. */
  readonly args: readonly string[]
  /** Environment of the process (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv
}

const OUTCOMES = new Set(['completed', 'cancelled', 'budget', 'error', 'timeout'])

function parseResult(line: string): ReplayRunResult | undefined {
  try {
    const value = JSON.parse(line.slice(REPLAY_RESULT_PREFIX.length)) as Partial<ReplayRunResult>
    if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome) || typeof value.requestCount !== 'number' || value.usage === undefined) return undefined
    return value as ReplayRunResult
  } catch {
    return undefined
  }
}

/** Build the runner. */
export function processReplayRunner(options: ProcessRunnerOptions): TrialRunner {
  return {
    run(request: ReplayRunRequest, signal: AbortSignal): Promise<ReplayRunResult> {
      return new Promise(resolve => {
        const child = spawn(options.command ?? process.execPath, [...options.args], {
          env: options.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        let killedFor: 'timeout' | 'cancelled' | undefined
        const finish = (result: ReplayRunResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        }
        const timer = setTimeout(() => {
          killedFor = 'timeout'
          child.kill('SIGKILL')
        }, request.timeoutMs)
        const onAbort = () => {
          killedFor = 'cancelled'
          child.kill('SIGKILL')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000) })
        child.on('error', error => finish({ outcome: 'error', detail: `could not start the replay process: ${error.message}`, usage: UNKNOWN_USAGE, requestCount: 0 }))
        child.on('close', code => {
          if (killedFor !== undefined) {
            finish({ outcome: killedFor, detail: killedFor === 'timeout' ? 'the replay process ran past its deadline and was killed' : 'the trial was cancelled', usage: UNKNOWN_USAGE, requestCount: 0 })
            return
          }
          const line = stdout.split('\n').reverse().find(entry => entry.startsWith(REPLAY_RESULT_PREFIX))
          const result = line === undefined ? undefined : parseResult(line)
          finish(result ?? { outcome: 'error', detail: `the replay process exited with code ${code ?? 'unknown'} and no result${stderr === '' ? '' : `: ${stderr.trim().slice(-500)}`}`, usage: UNKNOWN_USAGE, requestCount: 0 })
        })
        child.stdin.on('error', () => undefined)
        child.stdin.end(JSON.stringify(request))
      })
    },
  }
}
