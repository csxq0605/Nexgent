/**
 * The offline run's process entry (ADR 0026, ADR 0027): `node
 * offline-entry.js run <runId>` runs (or resumes) an approved layer-3 run of
 * the Nexgent home in `NEXGENT_HOME`, detached from the window that started
 * it, with what only the product can supply:
 *
 * - the evaluator: `practiceReplayEvaluator` with the gate's replay runner
 *   (each case in its own `trial-entry.js replay` process, on a copy of the
 *   case's input snapshot with the candidate as its execution profile) and
 *   the external reviewer (`CALIBRATION_MODEL`, reasoning on) scoring each
 *   run on the case's frozen rubric;
 * - the proposer: `llmOfflineProposer` with the product's default execution
 *   model, reasoning on.
 *
 * Every model request of the run is recorded in the run's own ledger
 * (`<run>/ledgers/`, `purpose: auxiliary`, `taskId: offline:<runId>`), never
 * in a project's. The process holds `<run>/lock` (its pid) while it works;
 * SIGTERM / SIGINT stop it at the next stage boundary (`aborted`).
 *
 * The API key comes from the environment or the Nexgent home's credentials
 * file, as for any task; it is never passed on a command line or written.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CALIBRATION_MODEL, processReplayRunner } from '@nexgent/capabilities'
import { llmOfflineProposer, offlineRunDirectory, practiceReplayEvaluator, runOfflineEvolution, type OfflineScorer } from '@nexgent/evolve'
import { DEFAULT_PROJECT_CONFIG, LocalCredentials, nexgentHome, UNKNOWN_USAGE, type LLMUsage, type ThinkingMode } from '@nexgent/kernel'
import { AnthropicProvider, estimateUsd } from '@nexgent/llm'
import { JsonlLedger } from '@nexgent/session'
import { documentText, TRIAL_ENTRY } from './trial-entry.js'

/** Absolute path of this entry. */
export const OFFLINE_ENTRY: string = fileURLToPath(import.meta.url)

/** A run's lock file (the pid of the process working on it). */
export const OFFLINE_LOCK_FILE = 'lock'

type Env = Readonly<Record<string, string | undefined>>

/** The external reviewer over the Claude Platform route (reasoning on, low effort, as calibration). */
function reviewer(provider: AnthropicProvider, runId: string, model: string): OfflineScorer {
  return {
    async score(request) {
      let text = ''
      let usage: LLMUsage = UNKNOWN_USAGE
      let failure: string | undefined
      const send = async (thinking: ThinkingMode) => {
        text = ''
        failure = undefined
        for await (const event of provider.complete({
          requestId: randomUUID(),
          model,
          thinking,
          effort: 'low',
          maxTokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          signal: request.signal,
        }, { purpose: 'auxiliary', taskId: `offline:${runId}` })) {
          if (event.type === 'text.delta') text += event.text
          else if (event.type === 'usage') usage = event.usage
          else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
        }
      }
      await send('on')
      return { text, usd: estimateUsd(model, usage), ...(failure === undefined ? {} : { failure }) }
    },
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Run (or resume) one approved run in this process. */
export async function runOfflineProcess(runId: string, env: Env = process.env, signal?: AbortSignal): Promise<string> {
  const home = nexgentHome(env as NodeJS.ProcessEnv)
  const directory = offlineRunDirectory(home, runId)
  const lock = join(directory, OFFLINE_LOCK_FILE)
  await mkdir(join(directory, 'ledgers'), { recursive: true })
  // One process per run: another live holder of the lock keeps it.
  const holder = Number.parseInt((await readFile(lock, 'utf8').catch(() => '')).trim(), 10)
  if (Number.isSafeInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) return 'running'
  await writeFile(lock, `${process.pid}\n`)
  try {
    const ledger = new JsonlLedger({ ledgersDir: join(directory, 'ledgers') })
    const provider = new AnthropicProvider({ credentials: new LocalCredentials({ env: env as NodeJS.ProcessEnv, home }), ledger, env, defaultModel: DEFAULT_PROJECT_CONFIG.model })
    const model = DEFAULT_PROJECT_CONFIG.model
    const state = await runOfflineEvolution(home, runId, {
      evaluator: practiceReplayEvaluator({
        home,
        runId,
        runner: processReplayRunner({ args: [TRIAL_ENTRY, 'replay'], env: env as NodeJS.ProcessEnv }),
        scorer: reviewer(provider, runId, CALIBRATION_MODEL),
        documentText,
      }),
      proposer: llmOfflineProposer({ llm: provider, model, thinking: 'on', estimateUsd }),
      ...(signal === undefined ? {} : { signal }),
    })
    return state.status
  } finally {
    await rm(lock, { force: true })
  }
}

/** Command-line entry. */
export async function main(argv: readonly string[]): Promise<number> {
  const [mode, runId] = argv
  if (mode === 'run' && runId !== undefined) {
    const controller = new AbortController()
    for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => controller.abort())
    const status = await runOfflineProcess(runId, process.env, controller.signal)
    process.stdout.write(`offline-entry ${runId} ${status}\n`)
    return 0
  }
  process.stderr.write('usage: offline-entry run <runId>\n')
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
