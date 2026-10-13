/**
 * The job process side: run one improvement job through its phases.
 *
 * The process takes `job.lock` (its pid) exclusively; a job already locked
 * by a live process, or no longer `queued`, is left alone. Before each
 * phase the budget is checked; when it is spent the job ends
 * `budget-exhausted`. Each phase reports what it spent, which goes into
 * `job.json` before the next phase starts. When the job is done (finished
 * or parked) the process releases the project's job slot and, if the next
 * batch filled up meanwhile, runs that job too, in the same process.
 *
 * Diagnosis, proposal and trial are {@link ImprovementStages}. Step 5 round
 * 1 ships {@link PENDING_STAGES}: the diagnosis is not written yet, so a
 * job ends `failed` saying so (an unknown result is not a success). Round 2
 * supplies the real diagnosis and proposal; the trial hands the candidate
 * to the step-4 gate.
 */
import { appendFile, rm } from 'node:fs/promises'
import { addUsage, readProjectConfig, ZERO_USAGE, type LLMUsage, type WorkspaceLayout } from '@nexgent/kernel'
import { budgetStatus, type BudgetStatus } from './budget.js'
import { jobPaths, listJobs, readJob, transitionJob, updateJob, type JobPatch } from './jobs.js'
import { breakStaleLock, readLockPid, tryCreateLock } from './lock.js'
import { improvementsDir } from './paths.js'
import { releaseSlot } from './queue.js'
import { DEFAULT_BUDGET, DEFAULT_THRESHOLD, TERMINAL_STATUSES, type ImprovementBudget, type ImprovementJob, type ImprovementPhase, type PhaseCost } from './types.js'

/** What a phase spent. */
export interface PhaseSpend {
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** What a phase gets. */
export interface StageInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  /** Budget left when the phase starts. */
  readonly budget: BudgetStatus
  /** Append a line to the job log. */
  log(line: string): Promise<void>
}

/** Diagnosis result: propose a component, or none (not a capability problem), or failed. */
export type DiagnoseResult = PhaseSpend & (
  | { readonly outcome: 'propose'; readonly proposalKind: string; readonly detail?: string }
  | { readonly outcome: 'none' | 'failed'; readonly detail: string }
)

/** Proposal result: one candidate, none, or failed. */
export type ProposeResult = PhaseSpend & (
  | { readonly outcome: 'candidate'; readonly candidateId: string; readonly detail?: string }
  | { readonly outcome: 'none' | 'failed'; readonly detail: string }
)

/** Trial result: the gate's conclusion. */
export type TrialResult = PhaseSpend & {
  readonly outcome: 'adopted' | 'rejected' | 'awaiting-approval' | 'waiting-history' | 'failed'
  readonly trialId?: string
  readonly decisionId?: string
  readonly detail?: string
}

/** The three phases of a job. */
export interface ImprovementStages {
  diagnose(input: StageInput): Promise<DiagnoseResult>
  propose(input: StageInput & { readonly proposalKind: string }): Promise<ProposeResult>
  trial(input: StageInput & { readonly candidateId: string }): Promise<TrialResult>
}

const NOTHING: PhaseSpend = { usage: ZERO_USAGE, requestCount: 0 }

/** Round-1 stages: the diagnosis is not implemented yet, so every job ends `failed` with that reason. */
export const PENDING_STAGES: ImprovementStages = {
  async diagnose() {
    return { ...NOTHING, outcome: 'failed', detail: 'The diagnosis is not implemented yet (step 5, round 2); nothing was diagnosed or proposed.' }
  },
  async propose() {
    return { ...NOTHING, outcome: 'failed', detail: 'The proposal is not implemented yet (step 5, round 2).' }
  },
  async trial() {
    return { ...NOTHING, outcome: 'failed', detail: 'Handing candidates to the gate is not implemented yet (step 5, round 2).' }
  },
}

/** Options of {@link runImprovementJob}. */
export interface RunJobOptions {
  readonly stages?: ImprovementStages
  readonly budget?: ImprovementBudget
  readonly threshold?: number
  /** Run the next batch's job in this process when it fills up meanwhile (default true). */
  readonly chain?: boolean
  readonly now?: () => Date
}

/** How a run ended. */
export interface RunJobResult {
  /** Jobs this process ran, in order (the first is the one asked for). */
  readonly jobs: readonly ImprovementJob[]
  /** Set when the asked-for job was not run (locked by a live process, or not queued). */
  readonly skipped?: string
}

function mergeCost(previous: PhaseCost | undefined, spend: PhaseSpend): PhaseCost {
  return previous === undefined
    ? { usage: spend.usage, requestCount: spend.requestCount }
    : { usage: addUsage(previous.usage, spend.usage), requestCount: previous.requestCount + spend.requestCount }
}

/**
 * Run job `jobId` of the project (the body of the host's `improve` entry).
 * Never throws for a job problem: those end the job `failed`.
 */
export async function runImprovementJob(layout: WorkspaceLayout, jobId: string, options: RunJobOptions = {}): Promise<RunJobResult> {
  const directory = improvementsDir(layout)
  const ran: ImprovementJob[] = []
  let next: string | undefined = jobId
  let skipped: string | undefined
  while (next !== undefined) {
    const id: string = next
    next = undefined
    const outcome = await runOne(layout, directory, id, options)
    if (outcome.skipped !== undefined) {
      if (ran.length === 0) skipped = outcome.skipped
      break
    }
    ran.push(outcome.job)
    const autoStart = (await readProjectConfig(layout.configFile).catch(() => undefined))?.config.autoImprove === true
    const started = await releaseSlot(directory, id, { autoStart, threshold: options.threshold ?? DEFAULT_THRESHOLD, now: (options.now ?? (() => new Date()))() })
    if (started !== undefined && options.chain !== false) next = started.id
  }
  return { jobs: ran, ...(skipped === undefined ? {} : { skipped }) }
}

async function runOne(layout: WorkspaceLayout, directory: string, jobId: string, options: RunJobOptions): Promise<{ job: ImprovementJob; skipped?: undefined } | { skipped: string }> {
  const paths = jobPaths(directory, jobId)
  const now = options.now ?? (() => new Date())
  const stages = options.stages ?? PENDING_STAGES
  const budget = options.budget ?? DEFAULT_BUDGET
  // The host may have written the lock with this process's pid already.
  if (!(await tryCreateLock(paths.lock))) {
    const holder = await readLockPid(paths.lock)
    if (holder !== process.pid) {
      if (!(await breakStaleLock(paths.lock)) || !(await tryCreateLock(paths.lock))) return { skipped: `job ${jobId} is locked by another process` }
    }
  }
  const log = (line: string) => appendFile(paths.log, `${now().toISOString()} ${line}\n`).catch(() => undefined)
  try {
    let job = await readJob(directory, jobId)
    if (job.status !== 'queued') return { skipped: `job ${jobId} is ${job.status}, not queued` }
    await log(`start pid=${process.pid} trigger=${job.trigger} items=${job.items.length}`)

    const move = async (to: ImprovementJob['status'], detail?: string, patch?: JobPatch) => {
      const written = await transitionJob(directory, jobId, to, { now: now(), ...(detail === undefined ? {} : { detail }), ...(patch === undefined ? {} : { patch }) })
      if (written !== undefined) job = written
      await log(`status ${to}${detail === undefined ? '' : `: ${detail}`}`)
      return job
    }
    const spend = async (phase: ImprovementPhase, cost: PhaseSpend) => {
      job = await updateJob(directory, jobId, current => ({ phases: { ...current.phases, [phase]: mergeCost(current.phases[phase], cost) } }), now())
    }
    const status = async (): Promise<BudgetStatus> => budgetStatus(await listJobs(directory), budget, now())
    const input = async (): Promise<StageInput> => ({ layout, job, budget: await status(), log })
    const exhausted = async (phase: ImprovementPhase): Promise<boolean> => {
      const current = await status()
      if (!current.exhausted) return false
      await move('budget-exhausted', `The improvement budget is spent (${current.used} of ${current.limit} tokens since ${current.windowStart}); stopped before the ${phase} phase.`)
      return true
    }

    try {
      if (await exhausted('diagnose')) return { job }
      await move('diagnosing')
      const diagnosis = await stages.diagnose(await input())
      await spend('diagnose', diagnosis)
      if (diagnosis.outcome !== 'propose') return { job: await move(diagnosis.outcome === 'none' ? 'no-proposal' : 'failed', diagnosis.detail) }

      if (await exhausted('propose')) return { job }
      await move('proposing')
      const proposal = await stages.propose({ ...(await input()), proposalKind: diagnosis.proposalKind })
      await spend('propose', proposal)
      if (proposal.outcome !== 'candidate') return { job: await move(proposal.outcome === 'none' ? 'no-proposal' : 'failed', proposal.detail) }

      if (await exhausted('trial')) return { job }
      await move('trialing', undefined, { candidateId: proposal.candidateId })
      const trial = await stages.trial({ ...(await input()), candidateId: proposal.candidateId })
      await spend('trial', trial)
      const refs = { ...(trial.trialId === undefined ? {} : { trialId: trial.trialId }), ...(trial.decisionId === undefined ? {} : { decisionId: trial.decisionId }) }
      return { job: await move(trial.outcome, trial.detail, refs) }
    } catch (error) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        const detail = `The job stopped on an error: ${(error as Error).message}`
        await transitionJob(directory, jobId, 'failed', { now: now(), detail, expect: [job.status] }).then(written => { if (written !== undefined) job = written }, () => undefined)
        await log(`status failed: ${detail}`)
      }
      return { job }
    }
  } finally {
    await rm(paths.lock, { force: true })
  }
}
