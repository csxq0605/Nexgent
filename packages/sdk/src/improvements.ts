/**
 * Step 5 (W4): the SDK's `improvements.*` methods over one project's
 * `@nexgent/evolve` host (`ctx.improve`). Jobs are read from
 * `.nexgent/improvements/`; the diagnosis from the job's `diagnosis.json`;
 * the candidate as `capabilities.show` shows it; the display-only dollar
 * estimate from the ledger's model requests of the job (its `improvementId`
 * and its trial's `trialId`) and the `@nexgent/llm` price table.
 *
 * Step 6 (W5): meta jobs travel the same methods. Their detail adds
 * `meta-diagnosis.json`, `change.json` and `comparison.json`; their dollar
 * estimate adds both comparison arms (from `comparison.json` once written,
 * which also covers the arms' gate trials kept in the copies' ledgers; from
 * the real ledger's `metaJobId` records while the arms still run).
 *
 * API 7 (ADR 0012): the listing's `meta` is the user's (user config, user
 * meta queue, user meta budget), the same in every project.
 */
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { billedTokens, jobPaths, readUserConfig, readUserQueue, type ImprovementHost } from '@nexgent/evolve'
import { jobFeedbackIds, jobPhaseTimes, NexgentError, type Diagnosis, type ImprovementCostPhase, type ImprovementJob, type ImproverChangeRecord, type ImproverComparison, type ImproverDecisionReason, type MetaDiagnosis, type LedgerRecord, type LLMUsage, type PhaseCost } from '@nexgent/kernel'
import { estimateUsdTotal } from '@nexgent/llm'
import { JsonlLedger } from '@nexgent/session'
import type { CapabilityService } from '@nexgent/capabilities'
import type { ImprovementDetail, ImprovementJobView, ImprovementListing } from './api.js'
import * as capabilities from './capabilities.js'

type Requests = { model: string; usage: LLMUsage }[]

/** The model requests of each job, from the ledger (`improvementId`, or its trial's `trialId`), and of each meta job's comparison arms (`metaJobId`). */
interface JobRequests {
  readonly own: Map<string, Requests>
  readonly arms: Map<string, Requests>
}

async function jobRequests(host: ImprovementHost, jobs: readonly ImprovementJob[]): Promise<JobRequests> {
  const byTrial = new Map<string, string>()
  for (const job of jobs) if (job.trialId !== undefined) byTrial.set(job.trialId, job.id)
  const ids = new Set(jobs.map(job => job.id))
  const out: JobRequests = { own: new Map(), arms: new Map() }
  const add = (map: Map<string, Requests>, id: string, record: { model: string; usage: LLMUsage }) => {
    const list = map.get(id) ?? []
    list.push({ model: record.model, usage: record.usage })
    map.set(id, list)
  }
  const ledger = new JsonlLedger({ ledgersDir: host.layout.ledgers })
  try {
    for await (const record of ledger.read({ types: ['llm.request.end'] }) as AsyncIterable<LedgerRecord>) {
      if (record.type !== 'llm.request.end') continue
      const jobId = record.improvementId !== undefined && ids.has(record.improvementId)
        ? record.improvementId
        : record.trialId === undefined ? undefined : byTrial.get(record.trialId)
      if (jobId !== undefined) add(out.own, jobId, record)
      else if (record.metaJobId !== undefined && ids.has(record.metaJobId)) add(out.arms, record.metaJobId, record)
    }
  } catch {
    // An unreadable ledger leaves the estimates unknown.
  }
  return out
}

/** What a meta job's arms cost in dollars: both arms of `comparison.json` once written, else their records in the real ledger. */
function armUsd(comparison: ImproverComparison | undefined, armRequests: Requests | undefined): number | 'unknown' {
  if (comparison !== undefined) {
    const { parent, child } = comparison
    return parent.cost.estimatedUsd === 'unknown' || child.cost.estimatedUsd === 'unknown' ? 'unknown' : parent.cost.estimatedUsd + child.cost.estimatedUsd
  }
  return armRequests === undefined || armRequests.length === 0 ? 0 : estimateUsdTotal(armRequests)
}

/** One job as lists show it. */
export function jobView(job: ImprovementJob, requests: readonly { model: string; usage: LLMUsage }[] | undefined, arms: number | 'unknown' = 0): ImprovementJobView {
  const tokens: Partial<Record<ImprovementCostPhase, number | 'unknown'>> = {}
  for (const [phase, cost] of Object.entries(job.phases) as [ImprovementCostPhase, PhaseCost][]) {
    const billed = billedTokens(cost.usage)
    tokens[phase] = billed.complete ? billed.tokens : 'unknown'
  }
  const ranRequests = Object.values(job.phases).reduce((sum, cost) => sum + (cost?.requestCount ?? 0), 0)
  // A job whose phases made requests the ledger does not show cannot be priced.
  const ownUsd = requests === undefined || requests.length === 0
    ? (ranRequests === 0 ? 0 : 'unknown')
    : estimateUsdTotal(requests)
  const estimatedUsd = ownUsd === 'unknown' || arms === 'unknown' ? 'unknown' : ownUsd + arms
  return {
    id: job.id,
    ...(job.kind === undefined ? {} : { kind: job.kind }),
    ...(job.improverVersion === undefined ? {} : { improverVersion: job.improverVersion }),
    ...(job.improverScope === undefined ? {} : { improverScope: job.improverScope }),
    trigger: job.trigger,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    itemCount: job.items.length,
    feedbackIds: jobFeedbackIds(job),
    phaseTimes: jobPhaseTimes(job),
    ...(job.diagnosed === undefined ? {} : { proposalKind: job.diagnosed.proposalKind }),
    ...(job.candidateId === undefined ? {} : { candidateId: job.candidateId }),
    ...(job.trialId === undefined ? {} : { trialId: job.trialId }),
    ...(job.decisionId === undefined ? {} : { decisionId: job.decisionId }),
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    ...(job.meta === undefined ? {} : {
      meta: {
        ...(job.meta.childVersion === undefined ? {} : { childVersion: job.meta.childVersion }),
        ...(job.meta.compared === undefined ? {} : { outcome: job.meta.compared.outcome, reason: job.meta.compared.reason as ImproverDecisionReason }),
      },
    }),
    tokens,
    estimatedUsd,
  }
}

/** A job side file, or `undefined` when not written (or unreadable). */
async function sideFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function comparisonOf(host: ImprovementHost, job: ImprovementJob): Promise<ImproverComparison | undefined> {
  return job.kind === 'meta' ? sideFile<ImproverComparison>(jobPaths(host.directory, job.id).comparison) : undefined
}

function viewWith(job: ImprovementJob, requests: JobRequests, comparison: ImproverComparison | undefined): ImprovementJobView {
  return jobView(job, requests.own.get(job.id), job.kind === 'meta' ? armUsd(comparison, requests.arms.get(job.id)) : 0)
}

/** One job's view with its own ledger requests. */
export async function viewOf(host: ImprovementHost, job: ImprovementJob): Promise<ImprovementJobView> {
  const [requests, comparison] = await Promise.all([jobRequests(host, [job]), comparisonOf(host, job)])
  return viewWith(job, requests, comparison)
}

/** `improvements.list`: jobs newest first, the batch waiting for the next job, the budget windows (capability jobs; meta jobs). */
export async function listing(host: ImprovementHost, now: Date = new Date()): Promise<ImprovementListing> {
  const [jobs, queue, settings, budget, metaBudget, user, userQueue] = await Promise.all([
    host.list(), host.queue(), host.settings(), host.budgetStatus(now), host.metaBudgetStatus(now),
    // API 7 (ADR 0012): meta settings and counting are the user's, the same in every project.
    readUserConfig(host.home), readUserQueue(host.home).catch(() => undefined),
  ])
  const [requests, comparisons] = await Promise.all([jobRequests(host, jobs), Promise.all(jobs.map(job => comparisonOf(host, job)))])
  const meta = user.improvement.meta
  return {
    jobs: jobs.map((job, index) => viewWith(job, requests, comparisons[index])).reverse(),
    ...(queue?.activeJobId === undefined ? {} : { activeJobId: queue.activeJobId }),
    pending: queue?.pending.length ?? 0,
    threshold: settings.improvement.feedbackThreshold,
    budget: { usedTokens: budget.used, maxTokens: budget.limit, windowDays: settings.improvement.budget.windowDays },
    autoImprove: settings.autoImprove,
    meta: {
      enabled: meta.enabled,
      pending: userQueue?.pending.length ?? 0,
      everyJobs: meta.everyJobs,
      budget: { usedTokens: metaBudget.used, maxTokens: metaBudget.limit, windowDays: meta.budget.windowDays },
    },
  }
}

async function diagnosisOf(host: ImprovementHost, job: ImprovementJob): Promise<Diagnosis | undefined> {
  if (job.diagnosed === undefined) return undefined
  return sideFile<Diagnosis>(jobPaths(host.directory, job.id).diagnosis)
}

function jobId(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new NexgentError('tool/invalid-input', 'jobId must be a string')
  return value
}

/** `improvements.show`: the job, its diagnosis and its candidate. */
export async function show(host: ImprovementHost, service: CapabilityService | undefined, id: unknown): Promise<ImprovementDetail> {
  const job = await host.show(jobId(id))
  const paths = jobPaths(host.directory, job.id)
  const meta = job.kind === 'meta'
  const [requests, diagnosis, metaDiagnosis, change, comparison] = await Promise.all([
    jobRequests(host, [job]),
    diagnosisOf(host, job),
    meta ? sideFile<MetaDiagnosis>(paths.metaDiagnosis) : undefined,
    meta ? sideFile<ImproverChangeRecord>(paths.change) : undefined,
    comparisonOf(host, job),
  ])
  const candidate = job.candidateId === undefined || service === undefined
    ? undefined
    : await capabilities.show(service, job.candidateId).catch(() => undefined)
  return {
    view: viewWith(job, requests, comparison),
    job,
    ...(diagnosis === undefined ? {} : { diagnosis }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(metaDiagnosis === undefined ? {} : { metaDiagnosis }),
    ...(change === undefined ? {} : { change }),
    ...(comparison === undefined ? {} : { comparison }),
  }
}

/** `improvements.run`: the explicit "improve" (a session or a deliverable when given). */
export async function run(host: ImprovementHost, input: { readonly sessionId?: unknown; readonly deliverableId?: unknown }): Promise<ImprovementJobView> {
  for (const key of ['sessionId', 'deliverableId'] as const) {
    const value = input[key]
    if (value !== undefined && (typeof value !== 'string' || value === '')) throw new NexgentError('tool/invalid-input', `${key} must be a non-empty string`)
  }
  const job = await host.run({
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId as string }),
    ...(input.deliverableId === undefined ? {} : { deliverableId: input.deliverableId as string }),
  })
  return viewOf(host, job)
}

/** `improvements.runMeta`: a meta job now (trigger `explicit`). */
export async function runMeta(host: ImprovementHost, input: { readonly keepCopies?: unknown }): Promise<ImprovementJobView> {
  if (input.keepCopies !== undefined && typeof input.keepCopies !== 'boolean') throw new NexgentError('tool/invalid-input', 'keepCopies must be a boolean')
  return viewOf(host, await host.runMeta(input.keepCopies === undefined ? {} : { keepCopies: input.keepCopies }))
}

/** `improvements.cancel`. */
export async function cancel(host: ImprovementHost, id: unknown): Promise<ImprovementJobView> {
  return viewOf(host, await host.cancel(jobId(id)))
}

const POLL_MS = 3_000
const SETTLE_MS = 100

/**
 * Follows a project's jobs for `improvement.job` events: jobs change in
 * their own processes, so the SDK watches `.nexgent/improvements/` (and
 * re-reads every few seconds where file events are not delivered) and
 * reports each job that appeared or changed status since the last look.
 */
export class JobWatch {
  readonly #host: ImprovementHost
  readonly #onChange: (job: ImprovementJob) => void
  readonly #seen = new Map<string, string>()
  #watcher: FSWatcher | undefined
  #timer: NodeJS.Timeout | undefined
  #settle: NodeJS.Timeout | undefined
  #checking: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(host: ImprovementHost, onChange: (job: ImprovementJob) => void) {
    this.#host = host
    this.#onChange = onChange
  }

  /** Remember the jobs as they are now (no events for them), then follow changes. */
  async start(): Promise<void> {
    for (const job of await this.#host.list().catch(() => [] as ImprovementJob[])) this.#seen.set(job.id, job.status)
    if (this.#stopped) return
    try {
      await mkdir(this.#host.directory, { recursive: true })
      this.#watcher = watch(this.#host.directory, { recursive: true }, () => this.#schedule())
      this.#watcher.on('error', () => undefined)
    } catch {
      // No file events here: the poll below still notices changes.
    }
    this.#timer = setInterval(() => this.#schedule(), POLL_MS)
    this.#timer.unref()
  }

  /** Look now (after this SDK changed a job itself); resolves once the changes were reported. */
  check(): Promise<void> {
    this.#checking = this.#checking.then(async () => {
      if (this.#stopped) return
      for (const job of await this.#host.list().catch(() => [] as ImprovementJob[])) {
        if (this.#seen.get(job.id) === job.status) continue
        this.#seen.set(job.id, job.status)
        try {
          this.#onChange(job)
        } catch {
          // a listener failure must not stop the watch
        }
      }
    })
    return this.#checking
  }

  stop(): void {
    this.#stopped = true
    this.#watcher?.close()
    if (this.#timer !== undefined) clearInterval(this.#timer)
    if (this.#settle !== undefined) clearTimeout(this.#settle)
  }

  #schedule(): void {
    if (this.#stopped || this.#settle !== undefined) return
    this.#settle = setTimeout(() => {
      this.#settle = undefined
      void this.check()
    }, SETTLE_MS)
    this.#settle.unref()
  }
}
