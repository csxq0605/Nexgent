/**
 * Meta jobs (step 6, ADR 0008 decisions 3–4, `data-formats.md` §元改进作业):
 * improve the improver. Three phases, run by the job process like a
 * capability job's:
 *
 * 1. meta-diagnose: a read-only session over the project's past jobs
 *    ({@link metaDiagnosisTools}); `none` ends the job `no-proposal`.
 * 2. meta-propose: a session that proposes exactly one typed change to the
 *    parent ({@link metaProposeTools}); the child is stored, not adopted.
 * 3. compare: the origin ({@link chooseOrigin}, ADR 0009: the latest
 *    feedback job the real job did not solve, on the capability version it
 *    started on; else the latest feedback job, on the version its feedback
 *    task ran on) becomes two project copies (the gate's
 *    `prepareProjectCopy`) with the source job's snapshot tree, feedback
 *    ids and the evaluator epoch; in each, an arm job (a capability job carrying
 *    `arm`) runs diagnose → propose → gate on the parent or the child
 *    improver. The gate adopts only inside its copy; offspring never reach
 *    the real project. `decideImprover` concludes; on `adopt` the child is
 *    adopted in the project's `ImproverStore` (`trigger: meta-job`) and the
 *    next real job runs on it. The copies are removed unless `keepCopies`
 *    (and they are small enough).
 *
 * The epoch is the gate's `projectEpoch` (ADR 0008 decision 5); each arm's
 * gate is started with the origin's epoch and refuses to run in another.
 *
 * ADR 0012: the improver is the user's. A meta job reads the projects of
 * its batch (`metaProjects`); the origin is searched in all of them (jobs
 * merged by when they finished) and records its `projectId`; the arms run
 * in copies of the origin's project, their ledger records go to that
 * project, and the child is stored and adopted in the user's line. Arms
 * never touch the user's improvers or meta queue.
 */
import {
  addUsage,
  BASELINE_VERSION,
  decideImprover,
  IMPROVER_LIMITS,
  isFinalImprovementStatus,
  NexgentError,
  ZERO_USAGE,
  type ArmCost,
  type CapabilityDecision,
  type ComparisonArm,
  type ComparisonArmResult,
  type ComparisonOrigin,
  type ComparisonOriginKind,
  type ImproverBundle,
  type ImproverComparison,
  type ImproverVersion,
  type KeptCopy,
  type LedgerRecord,
  type LLMUsage,
  type MetaDiagnosis,
  type MetaImprovementConfig,
  type MetaJobState,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore, ImproverStore, prepareProjectCopy, projectEpoch, type ProjectCopy } from '@nexgent/capabilities'
import { JsonlLedger, JsonlSessionStore, validateImprovementFile } from '@nexgent/session'
import { sumTurns } from './diagnosis.js'
import { scopeOf, type ImproverSource, type PinnedImprover } from './improver.js'
import { createJob, jobPaths, listJobs, readJob, type JobPatch } from './jobs.js'
import { metaDiagnosisTools, metaProposeTools, writeOnce, type MetaChangeState, type MetaDiagnosisState } from './meta-tools.js'
import { improvementsDir } from './paths.js'
import { findFeedbackTask, newSessionId } from './propose.js'
import type { BudgetStatus } from './budget.js'
import type { ImprovementSessionRunner, ImprovementTurnResult } from './session-runner.js'
import type { TrialStarter } from './trial.js'
import type { ImprovementConfig, ImprovementJob, PhaseCost } from './types.js'
import { metaProjects, userImproversDir, type MetaProject } from './user.js'

/** What a meta phase spent. */
export interface MetaSpend {
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** What a meta phase gets (the meta job's view of `StageInput`). */
export interface MetaStageInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  /** The hosting project's `improvement` settings (thinking). */
  readonly config: ImprovementConfig
  /** The user config's meta settings (model, budget; ADR 0012). */
  readonly meta: MetaImprovementConfig
  /** The Nexgent home: the user's improver line the child is stored and adopted in. */
  readonly home: string
  /** The meta budget left when the phase starts. */
  readonly budget: BudgetStatus
  /** The improver the meta job pinned: the parent. */
  readonly improver: PinnedImprover
  log(line: string): Promise<void>
  record(patch: JobPatch): Promise<void>
  /** Whether the meta budget is spent now (checked between the comparison arms). */
  budgetSpent(): Promise<boolean>
}

interface MetaResultBase extends MetaSpend {
  readonly patch?: JobPatch
  readonly error?: unknown
}

/** Meta diagnosis: a change is worth proposing, none, or failed. */
export type MetaDiagnoseResult = MetaResultBase & (
  | { readonly outcome: 'change'; readonly diagnosis: MetaDiagnosis; readonly detail?: string }
  | { readonly outcome: 'none' | 'failed'; readonly detail: string }
)

/** Meta proposal: one child improver, or failed. */
export type MetaProposeResult = MetaResultBase & (
  | { readonly outcome: 'change'; readonly childVersion: ImproverVersion; readonly child: ImproverBundle; readonly detail?: string }
  | { readonly outcome: 'failed'; readonly detail: string }
)

/** Comparison: the child adopted, not adopted, the budget ran out between the arms, or failed. */
export type CompareResult = MetaResultBase & { readonly outcome: 'adopted' | 'rejected' | 'budget-exhausted' | 'failed'; readonly detail: string }

/** The three phases of a meta job. */
export interface MetaStages {
  diagnose(input: MetaStageInput): Promise<MetaDiagnoseResult>
  propose(input: MetaStageInput & { readonly diagnosis?: MetaDiagnosis }): Promise<MetaProposeResult>
  compare(input: MetaStageInput & { readonly childVersion: ImproverVersion; readonly child: ImproverBundle }): Promise<CompareResult>
}

/** The arm job's runner (injected so the meta stages can run a whole capability job in a copy). */
export type ArmJobRunner = (layout: WorkspaceLayout, jobId: string, options: {
  readonly improvers: ImproverSource
  readonly runner: ImprovementSessionRunner
  /** The origin's evaluator epoch: the arm's gate refuses to run in another. */
  readonly epoch: string
}) => Promise<unknown>

/** What {@link createMetaStages} needs. */
export interface MetaStagesOptions {
  readonly runner: ImprovementSessionRunner
  readonly startTrial: TrialStarter
  /** Runs one arm's capability job in its copy (the runner's `runImprovementJob` with the real stages). */
  readonly runArm: ArmJobRunner
  /** Parent directory of the comparison copies (default the OS temporary directory). */
  readonly tempRoot?: string
  /** Largest comparison copy kept for `keepCopies` (default the gate's `KEEP_COPY_MAX_BYTES`; tests lower it). */
  readonly keepMaxBytes?: number
  /**
   * Estimated dollars of one model request (the host passes `@nexgent/llm`'s
   * `estimateUsd`). Without it every arm's cost is unknown, so no child is
   * adopted (`unknown-arm`): an unknown result is not a success.
   */
  readonly priceUsd?: (model: string, usage: LLMUsage) => number | 'unknown'
  readonly now?: () => Date
}

function turnFailure(turn: ImprovementTurnResult): string | undefined {
  if (turn.outcome === 'completed') return undefined
  return turn.outcome === 'budget' ? 'a cost cap stopped the session' : `the session ended ${turn.outcome}${turn.detail === undefined ? '' : `: ${turn.detail}`}`
}

/** An improver source that only knows one pinned improver (an arm runs on exactly its own). */
export function fixedImprover(improver: PinnedImprover): ImproverSource {
  return {
    async current() {
      return improver
    },
    async load(_layout, version) {
      if (version === improver.version) return improver.bundle
      throw new NexgentError('improver/not-found', `this comparison arm runs only on improver ${improver.version}`)
    },
  }
}

/** The jobs of one project an origin may come from. */
export interface OriginProject {
  readonly layout: WorkspaceLayout
  /** ADR 0012: the project's id in user-level records (recorded in the origin). */
  readonly projectId?: string
  readonly jobs: readonly ImprovementJob[]
}

interface OriginEntry {
  readonly project: OriginProject
  readonly job: ImprovementJob
}

function isFeedbackJob(job: ImprovementJob, meta: ImprovementJob): boolean {
  return job.kind !== 'meta' && job.arm === undefined && isFinalImprovementStatus(job.status)
    && job.items.some(item => item.kind === 'feedback') && job.createdAt <= meta.createdAt && job.id !== meta.id
}

/** Finished feedback-triggered capability jobs created before the meta job, in every project, latest finished first. */
function feedbackJobs(projects: readonly OriginProject[], meta: ImprovementJob): OriginEntry[] {
  const candidates = projects.flatMap(project => project.jobs.filter(job => isFeedbackJob(job, meta)).map(job => ({ project, job })))
  return candidates.sort((left, right) => (left.job.updatedAt < right.job.updatedAt ? 1 : left.job.updatedAt > right.job.updatedAt ? -1 : 0))
}

/** The last finished feedback-triggered capability job created before the meta job (the `feedback-version` origin's job). */
export function sourceJob(jobs: readonly ImprovementJob[], meta: ImprovementJob): ImprovementJob | undefined {
  return jobs.filter(job => isFeedbackJob(job, meta)).sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0))[0]
}

/** Statuses of a job that did not solve its feedback (ADR 0009). */
const UNRESOLVED_STATUSES: ReadonlySet<ImprovementJob['status']> = new Set(['rejected', 'failed', 'no-proposal'])

/** The job's gate found the baseline passing every feedback check: its problem was gone before the job started. */
async function baselineAlreadyPassed(layout: WorkspaceLayout, job: ImprovementJob): Promise<boolean> {
  if (job.decisionId === undefined) return false
  const decision = await new CapabilityStore(layout.capabilities).decision(job.decisionId).catch(() => undefined)
  return decision?.verdict?.feedbackPassRate?.baseline === 1
}

/** The capability version in force at `at` (the adoption history; `baseline` before the first revision). */
async function versionAt(layout: WorkspaceLayout, at: string): Promise<string> {
  const revisions = await new CapabilityStore(layout.capabilities).history().catch(() => [])
  return revisions.filter(revision => revision.committedAt <= at).at(-1)?.version ?? BASELINE_VERSION
}

/** The capability version a job started on: its recorded `baseVersion`, else the version in force when it left `queued`. */
export async function jobStartVersion(layout: WorkspaceLayout, job: ImprovementJob): Promise<string> {
  if (job.baseVersion !== undefined) return job.baseVersion
  return versionAt(layout, job.history.find(entry => entry.status !== 'queued')?.at ?? job.createdAt)
}

/** The capability version a job's feedback task ran on before its first feedback (`session.start`, then the last `capability.version`). */
export async function feedbackTaskVersion(layout: WorkspaceLayout, job: ImprovementJob): Promise<string> {
  const task = await findFeedbackTask(layout, job)
  const { records } = await new JsonlSessionStore({ sessionsDir: layout.sessions }).readAll(task.replay.sessionId)
  let version: string | undefined
  for (const record of records) {
    if (record.type === 'feedback') break
    if (record.type === 'session.start') version = record.capabilityVersion
    else if (record.type === 'capability.version') version = record.version
  }
  return version ?? BASELINE_VERSION
}

/** The chosen origin's job, kind and the capability version both arms start on. */
export interface OriginChoice {
  readonly kind: ComparisonOriginKind
  readonly job: ImprovementJob
  /** The project the job is in (the arms run in its copies). */
  readonly layout: WorkspaceLayout
  readonly projectId?: string
  readonly capabilityVersion: string
  /** For `unresolved`: the version the job started on (differs from `capabilityVersion` when an adoption came between the task and the job). */
  readonly startedOn?: string
}

/**
 * Choose the comparison's origin (ADR 0009, ADR 0010): the latest unresolved
 * feedback job, else the latest feedback job; else none. Both arms start on
 * the version the job's feedback task ran on: for an unresolved job that is
 * the version it started on unless an adoption came in between (ADR 0010
 * decision 2), when the problem may already have been covered.
 * @throws `improvement/not-found` when the latest feedback job's task cannot be replayed.
 */
export async function chooseOrigin(layout: WorkspaceLayout, jobs: readonly ImprovementJob[], meta: ImprovementJob): Promise<OriginChoice | undefined> {
  return chooseOriginIn([{ layout, jobs }], meta)
}

/**
 * {@link chooseOrigin} over several projects (ADR 0012 decision 4): the
 * feedback jobs of all of them, latest finished first, by the same rules.
 */
export async function chooseOriginIn(projects: readonly OriginProject[], meta: ImprovementJob): Promise<OriginChoice | undefined> {
  const finished = feedbackJobs(projects, meta)
  const where = (project: OriginProject) => ({ layout: project.layout, ...(project.projectId === undefined ? {} : { projectId: project.projectId }) })
  for (const { project, job } of finished) {
    const layout = project.layout
    if (!UNRESOLVED_STATUSES.has(job.status) || (await baselineAlreadyPassed(layout, job))) continue
    // A job that failed because its task cannot be replayed cannot be an origin either.
    if ((await findFeedbackTask(layout, job).catch(() => undefined)) === undefined) continue
    const startedOn = await jobStartVersion(layout, job)
    const ranOn = await feedbackTaskVersion(layout, job)
    return { kind: 'unresolved', job, ...where(project), capabilityVersion: ranOn === startedOn ? startedOn : ranOn, startedOn }
  }
  const latest = finished[0]
  if (latest === undefined) return undefined
  return { kind: 'feedback-version', job: latest.job, ...where(latest.project), capabilityVersion: await feedbackTaskVersion(latest.project.layout, latest.job) }
}

function feedbackIdsOf(job: ImprovementJob): string[] {
  return job.items.flatMap(item => (item.kind === 'feedback' ? [item.feedbackId] : [])).sort()
}

async function activeVersion(layout: WorkspaceLayout): Promise<string> {
  return (await new CapabilityStore(layout.capabilities).activation()).version ?? BASELINE_VERSION
}

/**
 * The origin a job's feedback task gives in a project: how it was chosen,
 * its snapshot tree, its feedback ids, `capabilityVersion` and the epoch.
 * @throws `improvement/not-found` when the feedback task has no snapshot with checks.
 */
export async function originOf(layout: WorkspaceLayout, kind: ComparisonOriginKind, job: ImprovementJob, sourceJobId: string, capabilityVersion: string, projectId?: string): Promise<ComparisonOrigin> {
  return (await originCase(layout, kind, job, sourceJobId, capabilityVersion, projectId)).origin
}

async function originCase(layout: WorkspaceLayout, kind: ComparisonOriginKind, job: ImprovementJob, sourceJobId: string, capabilityVersion: string, projectId?: string) {
  const task = await findFeedbackTask(layout, job)
  const origin: ComparisonOrigin = {
    kind, sourceJobId, tree: task.replay.tree, feedbackIds: feedbackIdsOf(job), capabilityVersion, epoch: await projectEpoch(layout),
    ...(projectId === undefined ? {} : { projectId }),
  }
  return { origin, replay: task.replay }
}

/** Total spend of a job's phases. */
function phaseTotal(job: ImprovementJob): PhaseCost {
  const phases = Object.values(job.phases).filter((phase): phase is PhaseCost => phase !== undefined)
  return { usage: addUsage(ZERO_USAGE, ...phases.map(phase => phase.usage)), requestCount: phases.reduce((sum, phase) => sum + phase.requestCount, 0) }
}

/** Estimated dollars of an arm job's model requests (its records in the real and the copy's ledger); `unknown` when any is, or some are missing. */
async function armUsd(layouts: readonly WorkspaceLayout[], job: ImprovementJob, requestCount: number, price: MetaStagesOptions['priceUsd']): Promise<number | 'unknown'> {
  if (price === undefined) return 'unknown'
  const seen = new Map<string, { model: string; usage: LLMUsage }>()
  for (const layout of layouts) {
    try {
      for await (const record of new JsonlLedger({ ledgersDir: layout.ledgers }).read({ types: ['llm.request.end'] }) as AsyncIterable<LedgerRecord>) {
        if (record.type !== 'llm.request.end' || record.improvementId !== job.id) continue
        seen.set(record.requestId, { model: record.model, usage: record.usage })
      }
    } catch {
      return 'unknown'
    }
  }
  if (seen.size < requestCount) return 'unknown'
  let total = 0
  for (const item of seen.values()) {
    const usd = price(item.model, item.usage)
    if (usd === 'unknown') return 'unknown'
    total += usd
  }
  return total
}

/** Build the meta phases. */
export function createMetaStages(options: MetaStagesOptions): MetaStages {
  const now = options.now ?? (() => new Date())
  return {
    async diagnose(input) {
      const { layout, job, config } = input
      const sessionId = newSessionId()
      const state: MetaDiagnosisState = { attempts: 0 }
      const projects = await metaProjects(layout, job)
      const tools = metaDiagnosisTools({ layout, projects, job, sessionId, improver: input.improver, state, now })
      await input.record({ sessions: { ...job.sessions, 'meta-diagnose': sessionId } })
      const session = await options.runner.open({
        jobId: job.id, phase: 'meta-diagnose', sessionId, projectRoot: layout.root, improverVersion: input.improver.version, ...scopeOf(job),
        model: input.meta.model, thinking: config.thinking, title: `meta improvement ${job.id} diagnose`, tools,
      })
      const turns: ImprovementTurnResult[] = []
      const max = IMPROVER_LIMITS.maxMetaDiagnosisAttempts
      try {
        let text = metaDiagnosisPrompt(job, input.improver, projects)
        let nudges = 0
        for (;;) {
          const before = state.attempts
          const turn = await session.send(text)
          turns.push(turn)
          await input.log(`meta-diagnose turn: ${turn.outcome}, ${turn.requestCount} requests, reports ${state.attempts}`)
          if (state.accepted !== undefined) break
          const failure = turnFailure(turn)
          if (failure !== undefined) return { ...sumTurns(turns), outcome: 'failed', detail: `The meta diagnosis stopped: ${failure}.` }
          if (state.attempts === before) nudges += 1
          if (state.attempts + nudges >= max) break
          text = `You ended the turn without an accepted meta diagnosis.${state.lastProblems === undefined ? '' : ` The last report was refused for: ${state.lastProblems.slice(0, 10).join('; ')}.`} Call improve_report_meta_diagnosis now (${max - state.attempts} left).`
        }
      } finally {
        await session.close().catch(() => undefined)
      }
      const spend = sumTurns(turns)
      const accepted = state.accepted
      if (accepted === undefined) {
        return {
          ...spend,
          outcome: 'failed',
          error: new NexgentError('improvement/invalid-diagnosis', `no acceptable meta diagnosis after ${max} attempts`),
          detail: `No acceptable meta diagnosis after ${max} attempts${state.lastProblems === undefined ? ' (the session did not report one)' : `; last problems: ${state.lastProblems.slice(0, 5).join('; ')}`}.`,
        }
      }
      const meta: MetaJobState = { ...(job.meta as MetaJobState), diagnosed: { at: accepted.createdAt, attempts: accepted.attempts, proposal: accepted.proposal } }
      if (accepted.proposal === 'none') return { ...spend, outcome: 'none', detail: `The improver needs no change: ${accepted.hypothesis}`, patch: { meta } }
      return { ...spend, outcome: 'change', diagnosis: accepted, patch: { meta } }
    },

    async propose(input) {
      const { layout, job, config } = input
      const sessionId = newSessionId()
      const state: MetaChangeState = { attempts: 0 }
      const tools = metaProposeTools({ layout, projects: await metaProjects(layout, job), home: input.home, job, sessionId, improver: input.improver, state, now })
      await input.record({ sessions: { ...job.sessions, 'meta-propose': sessionId } })
      const session = await options.runner.open({
        jobId: job.id, phase: 'meta-propose', sessionId, projectRoot: layout.root, improverVersion: input.improver.version, ...scopeOf(job),
        model: input.meta.model, thinking: config.thinking, title: `meta improvement ${job.id} propose`, tools,
      })
      const turns: ImprovementTurnResult[] = []
      const max = IMPROVER_LIMITS.maxChangeAttempts
      try {
        let text = metaProposePrompt(input.diagnosis)
        let nudges = 0
        for (;;) {
          const before = state.attempts
          const turn = await session.send(text)
          turns.push(turn)
          await input.log(`meta-propose turn: ${turn.outcome}, ${turn.requestCount} requests, proposals ${state.attempts}`)
          if (state.accepted !== undefined) break
          const failure = turnFailure(turn)
          if (failure !== undefined) return { ...sumTurns(turns), outcome: 'failed', detail: `The meta proposal stopped: ${failure}.` }
          if (state.attempts === before) nudges += 1
          if (state.attempts + nudges >= max) break
          text = `You ended the turn without an accepted change.${state.lastProblems === undefined ? '' : ` The last proposal was refused for: ${state.lastProblems.slice(0, 10).join('; ')}.`} Call improve_propose_change now (${max - state.attempts} left).`
        }
      } finally {
        await session.close().catch(() => undefined)
      }
      const spend = sumTurns(turns)
      if (state.accepted === undefined || state.child === undefined) {
        return {
          ...spend,
          outcome: 'failed',
          error: new NexgentError('improver/invalid-change', `no acceptable improver change after ${max} attempts`),
          detail: `No acceptable improver change after ${max} attempts${state.lastProblems === undefined ? ' (the session did not propose one)' : `; last problems: ${state.lastProblems.slice(0, 5).join('; ')}`}.`,
        }
      }
      const childVersion = state.accepted.childVersion
      return {
        ...spend,
        outcome: 'change',
        childVersion,
        child: state.child,
        detail: `Proposed ${state.accepted.change.op} (child improver ${childVersion}).`,
        patch: { meta: { ...(job.meta as MetaJobState), childVersion } },
      }
    },

    async compare(input) {
      const { layout, job } = input
      const paths = jobPaths(improvementsDir(layout), job.id)
      const nothing = { usage: ZERO_USAGE, requestCount: 0 }
      let origin: ComparisonOrigin
      let replay: Awaited<ReturnType<typeof originCase>>['replay']
      let source: ImprovementJob
      // The project the origin comes from: the arms run in its copies and write its ledger.
      let at: WorkspaceLayout
      let projectId: string | undefined
      try {
        const projects = await metaProjects(layout, job)
        const choice = await chooseOriginIn(await Promise.all(projects.map(async (project: MetaProject) => ({ layout: project.layout, projectId: project.projectId, jobs: await listJobs(improvementsDir(project.layout)) }))), job)
        if (choice === undefined) return { ...nothing, outcome: 'failed', detail: 'There is no finished feedback-triggered improvement job in this meta job\'s projects to compare the two improvers on.' }
        source = choice.job
        at = choice.layout
        projectId = choice.projectId
        ;({ origin, replay } = await originCase(at, choice.kind, source, source.id, choice.capabilityVersion, projectId))
        if (choice.startedOn !== undefined && choice.startedOn !== choice.capabilityVersion) {
          await input.log(`compare: job ${source.id} started on ${choice.startedOn}, after its feedback task ran on ${choice.capabilityVersion}; the arms start on the latter`)
        }
      } catch (error) {
        return { ...nothing, outcome: 'failed', detail: `The comparison origin cannot be prepared: ${(error as Error).message}`, error }
      }
      await input.log(`compare: ${origin.kind} origin, job ${source.id} (${source.status}), project ${at.root}, tree ${origin.tree}, capabilities ${origin.capabilityVersion}, epoch ${origin.epoch}`)
      const arms: { arm: ComparisonArm; improver: PinnedImprover }[] = [
        { arm: 'parent', improver: input.improver },
        { arm: 'child', improver: { version: input.childVersion, bundle: input.child } },
      ]
      const results: Partial<Record<ComparisonArm, ComparisonArmResult>> = {}
      const copies: Partial<Record<ComparisonArm, ProjectCopy>> = {}
      let spent: PhaseCost = { usage: ZERO_USAGE, requestCount: 0 }
      const keep = job.meta?.keepCopies === true
      let kept: { parent?: KeptCopy; child?: KeptCopy } | undefined
      try {
        for (const { arm, improver } of arms) {
          if (await input.budgetSpent()) {
            return { ...spent, outcome: 'budget-exhausted', detail: `The meta budget ran out before the ${arm} arm; no improver was compared.` }
          }
          // The gate's copy: the origin's snapshot tree, the history, the origin's capability version, the same epoch.
          let prepared: ProjectCopy
          try {
            prepared = await prepareProjectCopy({
              layout: at,
              origin: replay,
              version: origin.capabilityVersion,
              ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
              ...(options.keepMaxBytes === undefined ? {} : { keepMaxBytes: options.keepMaxBytes }),
            })
          } catch (error) {
            return { ...spent, outcome: 'failed', detail: `The ${arm} arm's project copy cannot be prepared: ${(error as Error).message}`, error }
          }
          copies[arm] = prepared
          const copy = prepared.layout
          const armJob = await createJob(improvementsDir(copy), {
            trigger: 'explicit',
            items: source.items,
            ...(source.request === undefined ? {} : { request: source.request }),
            arm: { metaJobId: job.id, arm },
            now: now(),
          })
          const found = await originOf(copy, origin.kind, armJob, source.id, await activeVersion(copy), projectId).catch(() => undefined)
          if (found === undefined) return { ...spent, outcome: 'failed', detail: `The origin cannot be read in the ${arm} arm's copy; nothing was compared.` }
          const runner: ImprovementSessionRunner = { open: request => options.runner.open({ ...request, metaJobId: job.id, comparisonArm: arm, ledgerRoot: at.root }) }
          await input.log(`compare: ${arm} arm job ${armJob.id} on improver ${improver.version} in ${copy.root}`)
          await options.runArm(copy, armJob.id, { improvers: fixedImprover(improver), runner, epoch: origin.epoch })
          const done = await readJob(improvementsDir(copy), armJob.id)
          const total = phaseTotal(done)
          spent = { usage: addUsage(spent.usage, total.usage), requestCount: spent.requestCount + total.requestCount }
          const decision: CapabilityDecision | undefined = done.decisionId === undefined
            ? undefined
            : (await new CapabilityStore(copy.capabilities).decisions().catch(() => [] as CapabilityDecision[])).find(item => item.id === done.decisionId)
          const cost: ArmCost = { ...total, estimatedUsd: await armUsd([at, copy], done, total.requestCount, options.priceUsd) }
          results[arm] = {
            arm,
            improverVersion: improver.version,
            origin: found,
            jobId: done.id,
            status: done.status,
            ...(done.error === undefined ? {} : { error: done.error }),
            ...(done.candidateId === undefined ? {} : { candidateId: done.candidateId }),
            ...(decision?.verdict === undefined ? {} : { verdict: decision.verdict }),
            cost,
          }
          await input.log(`compare: ${arm} arm ended ${done.status}${done.candidateId === undefined ? '' : ` with candidate ${done.candidateId}`}, ${typeof cost.estimatedUsd === 'number' ? `$${cost.estimatedUsd.toFixed(4)}` : 'cost unknown'}`)
        }
      } finally {
        for (const arm of ['parent', 'child'] as const) {
          const released = await copies[arm]?.release({ keep }).catch(() => undefined)
          if (released?.status === 'kept') kept = { ...kept, [arm]: released.copy }
          if (released?.status === 'too-large') await input.log(`compare: the ${arm} arm's copy (${released.bytes} bytes) is too large to keep; removed`)
        }
      }
      const parent = results.parent!
      const child = results.child!
      const verdict = decideImprover(origin, parent, child)
      const comparison: ImproverComparison = {
        formatVersion: 1,
        jobId: job.id,
        createdAt: now().toISOString(),
        origin,
        parent,
        child,
        verdict,
        ...(kept === undefined ? {} : { kept }),
      }
      const issues = validateImprovementFile('comparison', comparison)
      if (issues.length > 0) return { ...spent, outcome: 'failed', detail: `The comparison record is invalid: ${issues[0]!.path} ${issues[0]!.message}`, error: new NexgentError('internal', 'invalid comparison record') }
      await writeOnce(paths.comparison, comparison)
      const compared = { at: comparison.createdAt, outcome: verdict.outcome, reason: verdict.reason }
      const meta = { ...(job.meta as MetaJobState), compared }
      if (verdict.outcome === 'reject') {
        return { ...spent, outcome: 'rejected', detail: `The child improver was not adopted (${verdict.reason}).`, patch: { meta } }
      }
      const store = new ImproverStore(userImproversDir(input.home))
      let commit
      try {
        commit = await store.adopt(input.childVersion, { jobId: job.id })
      } catch (error) {
        return { ...spent, outcome: 'rejected', detail: `The comparison favours the child (${verdict.reason}), but it could not be adopted: ${(error as Error).message}`, patch: { meta } }
      }
      if (commit === null) return { ...spent, outcome: 'rejected', detail: `The comparison favours the child (${verdict.reason}), but another improver was adopted meanwhile.`, patch: { meta } }
      return {
        ...spent,
        outcome: 'adopted',
        detail: `Adopted the child improver ${input.childVersion} (${verdict.reason}); the next improvement job runs on it.`,
        patch: { meta: { ...meta, revision: commit.revision.revision } },
      }
    },
  }
}

/** The meta-diagnose session's first message (ADR 0012: with the projects it may read, when given). Pure. */
export function metaDiagnosisPrompt(job: ImprovementJob, improver: PinnedImprover, projects?: readonly Pick<MetaProject, 'projectId' | 'name'>[]): string {
  const basis = job.meta?.basis ?? []
  const batch = job.meta?.batch ?? []
  const nameOf = (projectId: string) => projects?.find(project => project.projectId === projectId)?.name ?? projectId
  return [
    '# Policy',
    'You are the meta diagnosis step of Nexgent\'s improvement flow. The improver is the data that tells improvement jobs how to diagnose user feedback, which component kinds to propose with which brief, and how many past tasks the gate compares. You look at how its jobs went and decide whether one change to the improver would make future jobs better.',
    'Use only the read-only tools: list and read the improvement jobs, their sessions and the ledger. You cannot change anything here.',
    'Classify each finding by the stage it concerns: diagnose (diagnoses that were refused, missed the cause or chose the wrong kind), propose (no candidate, or candidates that did not solve the problem), trial (the gate could not decide or compared too little) or other. Cite the jobs that show it.',
    'The gate\'s adoption rules, the reviewer, the budgets and the switches belong to the evaluator: they are not yours to judge or change.',
    'Answer proposal "none" when the jobs went as well as an improver can make them (e.g. the feedback was about taste, or the jobs failed for reasons outside the improver).',
    'Report once with improve_report_meta_diagnosis; if the host refuses it, fix exactly what it names and report again.',
    '',
    '# This meta job',
    `Trigger: ${job.trigger}. Improver in force: ${improver.version}.`,
    basis.length === 0
      ? 'No batch of jobs was named; use improve_list_jobs to find the recent ones.'
      : batch.length === 0
        ? `Jobs that finished since the last meta job (oldest first): ${basis.join(', ')}.`
        : `Jobs that finished since the last meta job (oldest first): ${batch.map(entry => `${entry.jobId} (project ${nameOf(entry.projectId)})`).join(', ')}.`,
    ...(projects === undefined ? [] : [
      '',
      '# Projects',
      'The improver is shared by every project of the user, so judge it by what holds for any task, not for one project. You may read only these projects (pass projectId to improve_read_session and improve_read_ledger):',
      ...projects.map(project => `- ${project.projectId} (${project.name})`),
    ]),
  ].join('\n')
}

/** The meta-propose session's first message. Pure. */
export function metaProposePrompt(diagnosis: MetaDiagnosis | undefined): string {
  return [
    '# Policy',
    'You are the meta proposal step of Nexgent\'s improvement flow. Propose exactly one change to the improver (read it with improve_read_improver) that addresses the meta diagnosis below. The child improver will run one improvement job against the parent from the same start, and is adopted only if its job does better.',
    'Change only what the operators allow; evaluator settings cannot be changed. Submit with improve_propose_change; if the host refuses it, fix exactly what it names and propose again.',
    '',
    '# Meta diagnosis',
    diagnosis === undefined ? '(none)' : `Hypothesis: ${diagnosis.hypothesis}`,
    ...(diagnosis?.findings ?? []).map(finding => `- ${finding.stage}: ${finding.label} (jobs ${finding.jobIds.join(', ')})`),
  ].join('\n')
}
