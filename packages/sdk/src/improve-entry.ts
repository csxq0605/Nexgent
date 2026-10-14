/**
 * The improvement job's process entry (step 5, W4). `@nexgent/evolve`
 * starts it for each job (`node improve-entry.js improve <projectRoot>
 * <jobId>`, detached, so a job outlives the CLI run or the desktop window
 * that triggered it); it runs the job's phases with what only the product
 * can supply:
 *
 * - the session runner: each improvement session runs in an SDK of its own
 *   that starts no background processes (no gate, no jobs). Diagnose runs
 *   on the real project with exactly the job's four read-only tools;
 *   propose runs on the job's snapshot copy (file tools work there, sandbox
 *   as the job says) while its session file and ledger records go to the
 *   real project. Approvals are answered `deny` (`headless`): a job asks
 *   nobody anything. The kernel stamps `improvementId` and
 *   `improvementPhase` on every ledger record.
 * - the gate: `runGateProcess` (the step-4 gate with its replay runner and
 *   reviewer) for the job's candidate.
 *
 * The API key comes from the environment or the Nexgent home's credentials
 * file, as for any task; it is never passed on a command line or written.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createImprovementStages,
  runImprovementJob,
  type ImprovementSession,
  type ImprovementSessionRequest,
  type ImprovementSessionRunner,
  type ImprovementTurnResult,
  type TrialStarter,
} from '@nexgent/evolve'
import { addUsage, nexgentHome, resolveWorkspaceLayout, UNKNOWN_USAGE, ZERO_USAGE, type LedgerRecord, type LLMUsage, type TurnEndReason } from '@nexgent/kernel'
import { estimateUsd } from '@nexgent/llm'
import { JsonlLedger } from '@nexgent/session'
import { createSdk } from './sdk.js'
import { runGateProcess } from './trial-entry.js'

/** Absolute path of this entry (the `@nexgent/evolve` row's `entry`). */
export const IMPROVE_ENTRY: string = fileURLToPath(import.meta.url)

type Env = Readonly<Record<string, string | undefined>>

function outcomeOf(reason: TurnEndReason): Pick<ImprovementTurnResult, 'outcome' | 'detail'> {
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
      return { outcome: 'completed' }
    case 'cancelled':
      return reason.cause === 'cost-cap' ? { outcome: 'budget' } : { outcome: 'cancelled', detail: reason.cause }
    case 'error':
      return reason.error.code === 'budget/exhausted'
        ? { outcome: 'budget' }
        : { outcome: 'error', detail: `${reason.error.code}: ${reason.error.message}`.slice(0, 500) }
    case 'interrupted':
      return { outcome: 'error', detail: 'interrupted' }
  }
}

/** Usage and request count of a session's settled model requests so far (the real project's ledger). */
async function sessionSpend(ledgersDir: string, sessionId: string): Promise<{ usage: LLMUsage; requests: number }> {
  let usage: LLMUsage = ZERO_USAGE
  let requests = 0
  for await (const record of new JsonlLedger({ ledgersDir }).read({ types: ['llm.request.end'] }) as AsyncIterable<LedgerRecord>) {
    if (record.type !== 'llm.request.end' || record.sessionId !== sessionId) continue
    usage = addUsage(usage, record.usage)
    requests += 1
  }
  return { usage, requests }
}

/** Subtract `before` from `after` field by field (`unknown` stays unknown). */
function usageSince(after: LLMUsage, before: LLMUsage): LLMUsage {
  const out: Record<string, number | 'unknown'> = {}
  for (const key of Object.keys(after) as (keyof LLMUsage)[]) {
    const a = after[key]
    const b = before[key]
    out[key] = a === 'unknown' || b === 'unknown' ? 'unknown' : a - b
  }
  return out as unknown as LLMUsage
}

/**
 * Improvement sessions over the SDK (`ImprovementSessionRunner`): one SDK
 * per session, without background processes, its approvals denied.
 */
export function sdkSessionRunner(env: Env = process.env): ImprovementSessionRunner {
  return {
    async open(request: ImprovementSessionRequest): Promise<ImprovementSession> {
      const real = resolveWorkspaceLayout(request.projectRoot)
      // A comparison arm's records go to the real project's ledger (its sessions stay in the arm's copy).
      const ledgers = request.ledgerRoot === undefined ? real.ledgers : resolveWorkspaceLayout(request.ledgerRoot).ledgers
      const propose = request.phase === 'propose'
      if (propose && request.workspaceRoot === undefined) throw new Error('a propose session needs the snapshot copy (workspaceRoot)')
      const sdk = createSdk({
        appVersion: 'improvement',
        env,
        background: false,
        approvalResponder: async approval => ({ id: approval.id, decision: 'deny', scope: 'once', decidedBy: 'headless', reason: 'improvement jobs run without anyone to ask' }),
        // Propose works in the copy; its session and ledger belong to the real project.
        ...(propose || request.ledgerRoot !== undefined ? { patches: [{ id: 'session', config: { sessionsDir: real.sessions, ledgersDir: ledgers } }] } : {}),
      })
      try {
        const project = await sdk.call('projects.open', { root: propose ? request.workspaceRoot! : request.projectRoot })
        await sdk.createImprovementSession({
          projectId: project.projectId,
          sessionId: request.sessionId,
          title: request.title,
          improvement: {
            jobId: request.jobId,
            phase: request.phase,
            improverVersion: request.improverVersion,
            ...(request.metaJobId === undefined || request.comparisonArm === undefined ? {} : { metaJobId: request.metaJobId, comparisonArm: request.comparisonArm }),
          },
          model: request.model,
          thinking: request.thinking,
          ...(request.sandboxMode === undefined ? {} : { sandboxMode: request.sandboxMode }),
          ...(request.tools === undefined ? {} : { tools: request.tools }),
        })
        let spent = { usage: ZERO_USAGE as LLMUsage, requests: 0 }
        const abort = () => void sdk.cancelTurn({ projectId: project.projectId, sessionId: request.sessionId }).catch(() => undefined)
        request.signal?.addEventListener('abort', abort, { once: true })
        return {
          sessionId: request.sessionId,
          async send(text: string): Promise<ImprovementTurnResult> {
            let reason: TurnEndReason
            try {
              const started = await sdk.startTurn({ projectId: project.projectId, sessionId: request.sessionId, text })
              reason = (await started.done).reason
            } catch (error) {
              return { outcome: 'error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 500), usage: UNKNOWN_USAGE, requestCount: 0 }
            }
            const now = await sessionSpend(ledgers, request.sessionId).catch(() => undefined)
            const turn = now === undefined
              ? { usage: UNKNOWN_USAGE, requests: 0 }
              : { usage: usageSince(now.usage, spent.usage), requests: now.requests - spent.requests }
            if (now !== undefined) spent = now
            return { ...outcomeOf(reason), usage: turn.usage, requestCount: turn.requests }
          },
          async close(): Promise<void> {
            request.signal?.removeEventListener('abort', abort)
            await sdk.dispose()
          },
        }
      } catch (error) {
        await sdk.dispose().catch(() => undefined)
        throw error
      }
    },
  }
}

/** The gate for a job's candidate: the step-4 gate process's work, in this process. */
export function gateTrialStarter(env: Env = process.env): TrialStarter {
  return ({ layout, candidateId, comparison, epoch }) => runGateProcess(layout.root, candidateId, env, { comparison, ...(epoch === undefined ? {} : { epoch }) })
}

/** Run one job (the `improve` mode); returns the jobs this process ran. */
export async function runImprovementProcess(root: string, jobId: string, env: Env = process.env) {
  return runImprovementJob(resolveWorkspaceLayout(root), jobId, {
    // ADR 0012: the user's improvers, meta queue and config, in the Nexgent home this process was given.
    home: nexgentHome(env as NodeJS.ProcessEnv),
    stages: createImprovementStages({ runner: sdkSessionRunner(env), startTrial: gateTrialStarter(env), priceUsd: estimateUsd }),
  })
}

/** Command-line entry. */
export async function main(argv: readonly string[]): Promise<number> {
  const [mode, root, jobId, ...rest] = argv
  if (mode === 'improve' && root !== undefined && jobId !== undefined && rest.length === 0) {
    process.stdout.write(`improve-entry start ${jobId} ${process.pid}\n`)
    const result = await runImprovementProcess(root, jobId)
    process.stdout.write(`improve-entry done ${result.jobs.map(job => `${job.id}:${job.status}`).join(' ')}${result.skipped === undefined ? '' : ` skipped ${result.skipped}`}\n`)
    return 0
  }
  process.stderr.write('usage: improve-entry improve <projectRoot> <jobId>\n')
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
