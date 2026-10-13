/**
 * The job process side: run one improvement job through its phases.
 *
 * The process takes `job.lock` (its pid) exclusively; a job already locked
 * by a live process is left alone. A `queued` job runs diagnose, propose and
 * trial; a `waiting-history` job (its slot taken again by the host) runs
 * only the trial. Before each phase the job is re-read (a `cancelled` job
 * stops) and the budget is checked; when it is spent the job ends
 * `budget-exhausted`. Each phase's spend goes into `job.json` before the
 * next phase starts. On a final status the process writes `improvement.end`
 * to the ledger. When the job is done (final or parked) the process releases
 * the project's job slot and, if the next batch filled up meanwhile, runs
 * that job too, in the same process.
 *
 * The phases are {@link ImprovementStages}: {@link createImprovementStages}
 * builds the real ones from the host entry's session runner and gate;
 * {@link PENDING_STAGES} (no runner configured) ends every job `failed`
 * saying so — an unknown result is not a success.
 *
 * Step 6: when a `queued` job starts, the process reads the improver in
 * force ({@link ImproverSource}) and writes its version into `job.json`
 * with the move to `diagnosing`; every phase gets that bundle, and a
 * resumed trial loads the same version again. An improver that cannot be
 * loaded fails the job.
 */
import { appendFile, rm } from 'node:fs/promises'
import {
  addUsage,
  readProjectConfig,
  toErrorInfo,
  ZERO_USAGE,
  type Diagnosis,
  type ImprovementConfig,
  type ImprovementCostPhase,
  type LLMUsage,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlLedger } from '@nexgent/session'
import { budgetStatus, type BudgetStatus } from './budget.js'
import type { MetaStageInput, MetaStages } from './meta.js'
import { jobImproverVersion, PROJECT_IMPROVERS, type ImproverSource, type PinnedImprover } from './improver.js'
import { jobPaths, listJobs, readJob, transitionJob, updateJob, type JobPatch } from './jobs.js'
import { breakStaleLock, readLockPid, tryCreateLock } from './lock.js'
import { improvementsDir } from './paths.js'
import { releaseSlot } from './queue.js'
import { TERMINAL_STATUSES, type ImprovementJob, type ImprovementJobStatus, type PhaseCost } from './types.js'

/** What a phase spent. */
export interface PhaseSpend {
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** What a phase gets. */
export interface StageInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  /** The project's `improvement` settings (model, thinking, budget). */
  readonly config: ImprovementConfig
  /** Budget left when the phase starts. */
  readonly budget: BudgetStatus
  /** The improver the job pinned when it started. */
  readonly improver: PinnedImprover
  /** Append a line to the job log. */
  log(line: string): Promise<void>
  /** Write references into `job.json` now (session ids, base version), keeping the status. */
  record(patch: JobPatch): Promise<void>
}

/** Fields every phase result may carry. */
interface ResultBase extends PhaseSpend {
  /** Written with the status change that follows the phase. */
  readonly patch?: JobPatch
  /** The error of a `failed` result. */
  readonly error?: unknown
}

/** Diagnosis result: propose a component, or none (not a capability problem), or failed. */
export type DiagnoseResult = ResultBase & (
  | { readonly outcome: 'propose'; readonly proposalKind: string; readonly diagnosis?: Diagnosis; readonly detail?: string }
  | { readonly outcome: 'none' | 'failed'; readonly detail: string }
)

/** Proposal result: one candidate, none, or failed. */
export type ProposeResult = ResultBase & (
  | { readonly outcome: 'candidate'; readonly candidateId: string; readonly detail?: string }
  | { readonly outcome: 'none' | 'failed'; readonly detail: string }
)

/** Trial result: the gate's conclusion. */
export type TrialResult = ResultBase & {
  readonly outcome: 'adopted' | 'rejected' | 'awaiting-approval' | 'waiting-history' | 'failed'
  readonly trialId?: string
  readonly decisionId?: string
  readonly detail?: string
}

/** The three phases of a job. */
export interface ImprovementStages {
  diagnose(input: StageInput): Promise<DiagnoseResult>
  propose(input: StageInput & { readonly proposalKind: string; readonly diagnosis?: Diagnosis }): Promise<ProposeResult>
  trial(input: StageInput & { readonly candidateId: string }): Promise<TrialResult>
  /** Step 6: the phases of a meta job (absent: a meta job fails saying so). */
  readonly meta?: MetaStages
}

const NOTHING: PhaseSpend = { usage: ZERO_USAGE, requestCount: 0 }

/** Stages of a host without a session runner: every job ends `failed` with that reason. */
export const PENDING_STAGES: ImprovementStages = {
  async diagnose() {
    return { ...NOTHING, outcome: 'failed', detail: 'No improvement session runner is configured in this host; nothing was diagnosed or proposed.' }
  },
  async propose() {
    return { ...NOTHING, outcome: 'failed', detail: 'No improvement session runner is configured in this host.' }
  },
  async trial() {
    return { ...NOTHING, outcome: 'failed', detail: 'No gate is configured in this host.' }
  },
}

/** Options of {@link runImprovementJob}. */
export interface RunJobOptions {
  readonly stages?: ImprovementStages
  /** Where the job reads its improver (default {@link PROJECT_IMPROVERS}: the project's improver store). */
  readonly improvers?: ImproverSource
  /** Run the next batch's job in this process when it fills up meanwhile (default true). */
  readonly chain?: boolean
  readonly now?: () => Date
}

/** How a run ended. */
export interface RunJobResult {
  /** Jobs this process ran, in order (the first is the one asked for). */
  readonly jobs: readonly ImprovementJob[]
  /** Set when the asked-for job was not run (locked by a live process, or not runnable). */
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
  const now = options.now ?? (() => new Date())
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
    const loaded = await readProjectConfig(layout.configFile).catch(() => undefined)
    const threshold = loaded?.config.improvement.feedbackThreshold
    const metaConfig = loaded?.config.improvement.meta
    const parentVersion = metaConfig?.enabled === true ? (await (options.improvers ?? PROJECT_IMPROVERS).current(layout).catch(() => undefined))?.version : undefined
    const started = await releaseSlot(directory, id, {
      autoStart: loaded?.config.autoImprove === true,
      ...(threshold === undefined ? {} : { threshold }),
      ...(metaConfig === undefined || parentVersion === undefined ? {} : { meta: { enabled: true, everyJobs: metaConfig.everyJobs, parentVersion } }),
      now: now(),
    })
    if (started !== undefined && options.chain !== false) next = started.id
  }
  return { jobs: ran, ...(skipped === undefined ? {} : { skipped }) }
}

/** Write `improvement.end` for a job that reached a final status (best effort: accounting never changes the outcome). */
async function writeEnd(layout: WorkspaceLayout, job: ImprovementJob): Promise<void> {
  if (!TERMINAL_STATUSES.has(job.status)) return
  await new JsonlLedger({ ledgersDir: layout.ledgers }).append({
    type: 'improvement.end',
    jobId: job.id,
    ...(job.kind === 'meta' ? { kind: 'meta' as const } : {}),
    trigger: job.trigger,
    status: job.status,
    phases: job.phases,
    improvementId: job.id,
    ...(job.improverVersion === undefined ? {} : { improverVersion: job.improverVersion }),
    ...(job.meta?.childVersion === undefined ? {} : { childVersion: job.meta.childVersion }),
    ...(job.arm === undefined ? {} : { metaJobId: job.arm.metaJobId, comparisonArm: job.arm.arm }),
    ...(job.candidateId === undefined ? {} : { candidateId: job.candidateId }),
    ...(job.decisionId === undefined ? {} : { decisionId: job.decisionId }),
  }).catch(() => undefined)
}

async function runOne(layout: WorkspaceLayout, directory: string, jobId: string, options: RunJobOptions): Promise<{ job: ImprovementJob; skipped?: undefined } | { skipped: string }> {
  const paths = jobPaths(directory, jobId)
  const now = options.now ?? (() => new Date())
  const stages = options.stages ?? PENDING_STAGES
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
    const resume = job.status === 'waiting-history'
    if (job.status !== 'queued' && !resume) return { skipped: `job ${jobId} is ${job.status}, not queued or waiting for history` }
    await log(`start pid=${process.pid} trigger=${job.trigger} items=${job.items.length}${resume ? ' (resuming the trial)' : ''}`)
    const config = (await readProjectConfig(layout.configFile)).config.improvement

    const move = async (to: ImprovementJobStatus, detail?: string, patch?: JobPatch, error?: unknown): Promise<ImprovementJob> => {
      const full: JobPatch = { ...patch, ...(error === undefined ? {} : { error: toErrorInfo(error) }) }
      const written = await transitionJob(directory, jobId, to, { now: now(), ...(detail === undefined ? {} : { detail }), patch: full, expect: [job.status] })
      if (written === undefined) {
        // Someone else moved it (a cancel): keep what is on disk.
        job = await readJob(directory, jobId)
        return job
      }
      job = written
      await log(`status ${to}${detail === undefined ? '' : `: ${detail}`}`)
      await writeEnd(layout, job)
      return job
    }
    const spend = async (phase: ImprovementCostPhase, cost: PhaseSpend) => {
      job = await updateJob(directory, jobId, current => ({ phases: { ...current.phases, [phase]: mergeCost(current.phases[phase], cost) } }), now())
    }
    // Meta jobs spend the meta budget; capability jobs the improvement budget (ADR 0008 decision 3).
    const isMeta = job.kind === 'meta'
    const status = async (): Promise<BudgetStatus> => budgetStatus((await listJobs(directory)).filter(item => (item.kind === 'meta') === isMeta), isMeta ? config.meta.budget : config.budget, now())
    const source = options.improvers ?? PROJECT_IMPROVERS
    let improver: PinnedImprover | undefined
    const input = async (): Promise<StageInput> => ({
      layout, job, config, budget: await status(), log, improver: improver!,
      record: async patch => { job = await updateJob(directory, jobId, patch, now()) },
    })
    /** Re-read the job (a cancel lands on disk) and check the budget; `true` = stop here. */
    const halt = async (phase: ImprovementCostPhase): Promise<boolean> => {
      job = await readJob(directory, jobId)
      if (TERMINAL_STATUSES.has(job.status)) return true
      const current = await status()
      if (!current.exhausted) return false
      await move('budget-exhausted', `The ${isMeta ? 'meta improvement' : 'improvement'} budget is spent (${current.used} of ${current.limit} tokens since ${current.windowStart}); stopped before the ${phase} phase.`)
      return true
    }
    if (isMeta) {
      return { job: await runMeta({ layout, config, log, move, spend, halt, status, now, source, stages: stages.meta, get: () => job, set: next => { job = next }, directory }) }
    }

    try {
      let candidateId = job.candidateId
      // A job pins the improver in force when it starts; a resumed trial keeps the version it pinned.
      try {
        improver = resume ? { version: jobImproverVersion(job), bundle: await source.load(layout, jobImproverVersion(job)) } : await source.current(layout)
      } catch (error) {
        if (resume || !(await halt('diagnose'))) await move('failed', `The improver ${resume ? jobImproverVersion(job) : 'in force'} cannot be loaded: ${(error as Error).message}`, undefined, error)
        return { job }
      }
      const version = improver.version
      if (!resume) {
        if (await halt('diagnose')) return { job }
        await move('diagnosing', undefined, { improverVersion: version })
        await log(`improver ${version}`)
        const diagnosis = await stages.diagnose(await input())
        await spend('diagnose', diagnosis)
        if (diagnosis.outcome !== 'propose') return { job: await move(diagnosis.outcome === 'none' ? 'no-proposal' : 'failed', diagnosis.detail, diagnosis.patch, diagnosis.error) }

        if (await halt('propose')) return { job }
        await move('proposing', undefined, diagnosis.patch)
        const proposal = await stages.propose({
          ...(await input()),
          proposalKind: diagnosis.proposalKind,
          ...(diagnosis.diagnosis === undefined ? {} : { diagnosis: diagnosis.diagnosis }),
        })
        await spend('propose', proposal)
        if (proposal.outcome !== 'candidate') return { job: await move(proposal.outcome === 'none' ? 'no-proposal' : 'failed', proposal.detail, proposal.patch, proposal.error) }
        candidateId = proposal.candidateId
        if (await halt('trial')) return { job }
        await move('trialing', proposal.detail, { ...proposal.patch, candidateId })
      } else {
        if (candidateId === undefined) return { job: await move('failed', 'The job waited for history but has no candidate.') }
        if (await halt('trial')) return { job }
        await move('trialing', 'Enough past tasks now; running the trial.')
      }
      const trial = await stages.trial({ ...(await input()), candidateId })
      await spend('trial', trial)
      const refs: JobPatch = { ...trial.patch, ...(trial.trialId === undefined ? {} : { trialId: trial.trialId }), ...(trial.decisionId === undefined ? {} : { decisionId: trial.decisionId }) }
      return { job: await move(trial.outcome, trial.detail, refs, trial.error) }
    } catch (error) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        await move('failed', `The job stopped on an error: ${(error as Error).message}`, undefined, error).catch(() => undefined)
      }
      return { job }
    }
  } finally {
    await rm(paths.lock, { force: true })
  }
}

/** What {@link runMeta} gets from {@link runOne}. */
interface MetaRun {
  readonly layout: WorkspaceLayout
  readonly directory: string
  readonly config: ImprovementConfig
  readonly stages: MetaStages | undefined
  readonly source: ImproverSource
  log(line: string): Promise<void>
  move(to: ImprovementJobStatus, detail?: string, patch?: JobPatch, error?: unknown): Promise<ImprovementJob>
  spend(phase: ImprovementCostPhase, cost: PhaseSpend): Promise<void>
  halt(phase: ImprovementCostPhase): Promise<boolean>
  status(): Promise<BudgetStatus>
  now(): Date
  get(): ImprovementJob
  set(job: ImprovementJob): void
}

/**
 * A meta job's phases (`queued → meta-diagnosing → meta-proposing →
 * comparing → adopted | rejected`): it pins the improver in force as the
 * parent, then runs the meta stages; before each phase the job is re-read
 * and the meta budget checked.
 */
async function runMeta(run: MetaRun): Promise<ImprovementJob> {
  const { layout, directory, config, log, move, spend, halt } = run
  try {
    if (await halt('meta-diagnose')) return run.get()
    const stages = run.stages
    if (stages === undefined) return await move('failed', 'No meta improvement stages are configured in this host; nothing was diagnosed.')
    let parent: PinnedImprover
    try {
      parent = await run.source.current(layout)
    } catch (error) {
      return await move('failed', `The improver in force cannot be loaded: ${(error as Error).message}`, undefined, error)
    }
    const meta = { ...(run.get().meta ?? { basis: [] }), parentVersion: parent.version }
    await move('meta-diagnosing', undefined, { improverVersion: parent.version, meta })
    await log(`parent improver ${parent.version}`)
    const input = async (): Promise<MetaStageInput> => ({
      layout, job: run.get(), config, budget: await run.status(), improver: parent, log,
      record: async patch => { run.set(await updateJob(directory, run.get().id, patch, run.now())) },
      budgetSpent: async () => (await run.status()).exhausted,
    })
    const diagnosis = await stages.diagnose(await input())
    await spend('meta-diagnose', diagnosis)
    if (diagnosis.outcome !== 'change') return await move(diagnosis.outcome === 'none' ? 'no-proposal' : 'failed', diagnosis.detail, diagnosis.patch, diagnosis.error)

    if (await halt('meta-propose')) return run.get()
    await move('meta-proposing', undefined, diagnosis.patch)
    const proposal = await stages.propose({ ...(await input()), diagnosis: diagnosis.diagnosis })
    await spend('meta-propose', proposal)
    if (proposal.outcome !== 'change') return await move('failed', proposal.detail, proposal.patch, proposal.error)

    if (await halt('compare')) return run.get()
    await move('comparing', proposal.detail, proposal.patch)
    const compared = await stages.compare({ ...(await input()), childVersion: proposal.childVersion, child: proposal.child })
    await spend('compare', compared)
    return await move(compared.outcome, compared.detail, compared.patch, compared.error)
  } catch (error) {
    if (!TERMINAL_STATUSES.has(run.get().status)) {
      await move('failed', `The meta job stopped on an error: ${(error as Error).message}`, undefined, error).catch(() => undefined)
    }
    return run.get()
  }
}
