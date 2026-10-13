/**
 * Meta jobs (step 6, ADR 0008 decisions 3–4, `data-formats.md` §元改进作业):
 * improve the improver. Three phases, run by the job process like a
 * capability job's:
 *
 * 1. meta-diagnose: a read-only session over the project's past jobs
 *    ({@link metaDiagnosisTools}); `none` ends the job `no-proposal`.
 * 2. meta-propose: a session that proposes exactly one typed change to the
 *    parent ({@link metaProposeTools}); the child is stored, not adopted.
 * 3. compare: the origin (the last finished feedback-triggered job before
 *    the meta job: its feedback task's snapshot tree, feedback ids, the
 *    capability version it started on, the evaluator epoch) is copied into
 *    two project copies; in each, an arm job (a capability job carrying
 *    `arm`) runs diagnose → propose → gate on the parent or the child
 *    improver. The gate adopts only inside its copy; offspring never reach
 *    the real project. `decideImprover` concludes; on `adopt` the child is
 *    adopted in the project's `ImproverStore` (`trigger: meta-job`) and the
 *    next real job runs on it. The copies are removed unless `keepCopies`.
 *
 * The epoch is the SHA-256 of `canonicalEvaluatorText(evaluatorSettings())`
 * of the project's capabilities settings (ADR 0008 decision 5); the gate
 * writes the same into `TrialPlan.epoch` (W4).
 */
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import {
  addUsage,
  BASELINE_VERSION,
  canonicalEvaluatorText,
  decideImprover,
  evaluatorSettings,
  IMPROVER_LIMITS,
  isFinalImprovementStatus,
  NexgentError,
  readProjectConfig,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type ArmCost,
  type CapabilityDecision,
  type ComparisonArm,
  type ComparisonArmResult,
  type ComparisonOrigin,
  type ImproverBundle,
  type ImproverComparison,
  type ImproverVersion,
  type KeptCopy,
  type LedgerRecord,
  type LLMUsage,
  type MetaDiagnosis,
  type MetaJobState,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore, improversDir, ImproverStore } from '@nexgent/capabilities'
import { JsonlLedger, validateImprovementFile } from '@nexgent/session'
import { sumTurns } from './diagnosis.js'
import type { ImproverSource, PinnedImprover } from './improver.js'
import { createJob, jobPaths, listJobs, readJob, type JobPatch } from './jobs.js'
import { metaDiagnosisTools, metaProposeTools, writeOnce, type MetaChangeState, type MetaDiagnosisState } from './meta-tools.js'
import { improvementsDir } from './paths.js'
import { findFeedbackTask, newSessionId } from './propose.js'
import type { BudgetStatus } from './budget.js'
import type { ImprovementSessionRunner, ImprovementTurnResult } from './session-runner.js'
import type { TrialStarter } from './trial.js'
import type { ImprovementConfig, ImprovementJob, PhaseCost } from './types.js'

/** What a meta phase spent. */
export interface MetaSpend {
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** What a meta phase gets (the meta job's view of `StageInput`). */
export interface MetaStageInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  readonly config: ImprovementConfig
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
export type ArmJobRunner = (layout: WorkspaceLayout, jobId: string, options: { readonly improvers: ImproverSource; readonly runner: ImprovementSessionRunner }) => Promise<unknown>

/** What {@link createMetaStages} needs. */
export interface MetaStagesOptions {
  readonly runner: ImprovementSessionRunner
  readonly startTrial: TrialStarter
  /** Runs one arm's capability job in its copy (the runner's `runImprovementJob` with the real stages). */
  readonly runArm: ArmJobRunner
  /** Parent directory of the comparison copies (default the OS temporary directory). */
  readonly tempRoot?: string
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

/** The evaluator epoch of a project (ADR 0008 decision 5). */
export async function evaluatorEpoch(layout: WorkspaceLayout): Promise<string> {
  const { config } = await readProjectConfig(layout.configFile)
  return createHash('sha256').update(canonicalEvaluatorText(evaluatorSettings(config.capabilities))).digest('hex')
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

/** The source job of a comparison: the last finished feedback-triggered capability job created before the meta job. */
export function sourceJob(jobs: readonly ImprovementJob[], meta: ImprovementJob): ImprovementJob | undefined {
  const candidates = jobs.filter(job => job.kind !== 'meta' && job.arm === undefined && isFinalImprovementStatus(job.status)
    && job.items.some(item => item.kind === 'feedback') && job.createdAt <= meta.createdAt && job.id !== meta.id)
  return candidates.sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0)).at(-1)
}

function feedbackIdsOf(job: ImprovementJob): string[] {
  return job.items.flatMap(item => (item.kind === 'feedback' ? [item.feedbackId] : [])).sort()
}

async function activeVersion(layout: WorkspaceLayout): Promise<string> {
  return (await new CapabilityStore(layout.capabilities).activation()).version ?? BASELINE_VERSION
}

/**
 * The origin a job's feedback task gives in a project: its snapshot tree, its
 * feedback ids, `capabilityVersion` and the epoch.
 * @throws `improvement/not-found` when the feedback task has no snapshot with checks.
 */
export async function originOf(layout: WorkspaceLayout, job: ImprovementJob, sourceJobId: string, capabilityVersion: string): Promise<ComparisonOrigin> {
  const task = await findFeedbackTask(layout, job)
  return { sourceJobId, tree: task.replay.tree, feedbackIds: feedbackIdsOf(job), capabilityVersion, epoch: await evaluatorEpoch(layout) }
}

/** Paths a comparison copy leaves out: VCS and dependency folders, and the real project's improvement jobs. */
function copyFilter(root: string, dataDir: string): (source: string) => boolean {
  const jobs = join(dataDir, 'improvements')
  return source => {
    if (source === jobs || source.startsWith(`${jobs}${sep}`)) return false
    const top = relative(root, source).split(sep)[0]
    return top !== '.git' && top !== 'node_modules'
  }
}

async function bytesOf(path: string): Promise<number> {
  const info = await stat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const name of await readdir(path)) total += await bytesOf(join(path, name))
  return total
}

/**
 * Copy the project for one arm and put the copy on the origin's capability
 * version (a manual adoption inside the copy when the real project has moved on).
 */
async function prepareCopy(layout: WorkspaceLayout, arm: ComparisonArm, capabilityVersion: string, tempRoot?: string): Promise<WorkspaceLayout> {
  const root = await mkdtemp(join(tempRoot ?? tmpdir(), `nexgent-meta-${arm}-`))
  await cp(layout.root, root, { recursive: true, filter: copyFilter(layout.root, layout.dataDir) })
  const copy = resolveWorkspaceLayout(root)
  const store = new CapabilityStore(copy.capabilities)
  if ((await activeVersion(copy)) !== capabilityVersion) {
    await store.adopt(capabilityVersion, { trigger: 'manual', detail: 'A comparison copy starts on the capability version the origin job started on.' }).catch(() => undefined)
  }
  return copy
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
      const tools = metaDiagnosisTools({ layout, job, sessionId, improver: input.improver, state, now })
      await input.record({ sessions: { ...job.sessions, 'meta-diagnose': sessionId } })
      const session = await options.runner.open({
        jobId: job.id, phase: 'meta-diagnose', sessionId, projectRoot: layout.root, improverVersion: input.improver.version,
        model: config.meta.model, thinking: config.thinking, title: `meta improvement ${job.id} diagnose`, tools,
      })
      const turns: ImprovementTurnResult[] = []
      const max = IMPROVER_LIMITS.maxMetaDiagnosisAttempts
      try {
        let text = metaDiagnosisPrompt(job, input.improver)
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
      const tools = metaProposeTools({ layout, job, sessionId, improver: input.improver, state, now })
      await input.record({ sessions: { ...job.sessions, 'meta-propose': sessionId } })
      const session = await options.runner.open({
        jobId: job.id, phase: 'meta-propose', sessionId, projectRoot: layout.root, improverVersion: input.improver.version,
        model: config.meta.model, thinking: config.thinking, title: `meta improvement ${job.id} propose`, tools,
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
      const source = sourceJob(await listJobs(improvementsDir(layout)), job)
      if (source === undefined) return { ...nothing, outcome: 'failed', detail: 'There is no finished feedback-triggered improvement job to compare the two improvers on.' }
      let origin: ComparisonOrigin
      try {
        origin = await originOf(layout, source, source.id, source.baseVersion ?? await activeVersion(layout))
      } catch (error) {
        return { ...nothing, outcome: 'failed', detail: `The comparison origin cannot be prepared: ${(error as Error).message}`, error }
      }
      await input.log(`compare: origin job ${source.id}, tree ${origin.tree}, capabilities ${origin.capabilityVersion}, epoch ${origin.epoch}`)
      const arms: { arm: ComparisonArm; improver: PinnedImprover }[] = [
        { arm: 'parent', improver: input.improver },
        { arm: 'child', improver: { version: input.childVersion, bundle: input.child } },
      ]
      const results: Partial<Record<ComparisonArm, ComparisonArmResult>> = {}
      const copies: Partial<Record<ComparisonArm, WorkspaceLayout>> = {}
      let spent: PhaseCost = { usage: ZERO_USAGE, requestCount: 0 }
      const keep = job.meta?.keepCopies === true
      let kept: { parent?: KeptCopy; child?: KeptCopy } | undefined
      try {
        for (const { arm, improver } of arms) {
          if (await input.budgetSpent()) {
            return { ...spent, outcome: 'budget-exhausted', detail: `The meta budget ran out before the ${arm} arm; no improver was compared.` }
          }
          const copy = await prepareCopy(layout, arm, origin.capabilityVersion, options.tempRoot)
          copies[arm] = copy
          const armJob = await createJob(improvementsDir(copy), {
            trigger: 'explicit',
            items: source.items,
            ...(source.request === undefined ? {} : { request: source.request }),
            arm: { metaJobId: job.id, arm },
            now: now(),
          })
          const found = await originOf(copy, armJob, source.id, await activeVersion(copy)).catch(() => undefined)
          if (found === undefined) return { ...spent, outcome: 'failed', detail: `The origin cannot be read in the ${arm} arm's copy; nothing was compared.` }
          const runner: ImprovementSessionRunner = { open: request => options.runner.open({ ...request, metaJobId: job.id, comparisonArm: arm, ledgerRoot: layout.root }) }
          await input.log(`compare: ${arm} arm job ${armJob.id} on improver ${improver.version} in ${copy.root}`)
          await options.runArm(copy, armJob.id, { improvers: fixedImprover(improver), runner })
          const done = await readJob(improvementsDir(copy), armJob.id)
          const total = phaseTotal(done)
          spent = { usage: addUsage(spent.usage, total.usage), requestCount: spent.requestCount + total.requestCount }
          const decision: CapabilityDecision | undefined = done.decisionId === undefined
            ? undefined
            : (await new CapabilityStore(copy.capabilities).decisions().catch(() => [] as CapabilityDecision[])).find(item => item.id === done.decisionId)
          const cost: ArmCost = { ...total, estimatedUsd: await armUsd([layout, copy], done, total.requestCount, options.priceUsd) }
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
        if (keep) {
          kept = {}
          for (const arm of ['parent', 'child'] as const) {
            const copy = copies[arm]
            if (copy !== undefined) kept[arm] = { root: copy.root, bytes: await bytesOf(copy.root).catch(() => 0) }
          }
        } else {
          for (const copy of Object.values(copies)) if (copy !== undefined) await rm(copy.root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
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
      const store = new ImproverStore(improversDir(layout))
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

/** The meta-diagnose session's first message. Pure. */
export function metaDiagnosisPrompt(job: ImprovementJob, improver: PinnedImprover): string {
  const basis = job.meta?.basis ?? []
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
    basis.length === 0 ? 'No batch of jobs was named; use improve_list_jobs to find the recent ones.' : `Jobs that finished since the last meta job (oldest first): ${basis.join(', ')}.`,
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
