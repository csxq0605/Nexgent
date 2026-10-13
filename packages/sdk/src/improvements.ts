/**
 * Step 5 (W4): the SDK's `improvements.*` methods over one project's
 * `@nexgent/evolve` host (`ctx.improve`). Jobs are read from
 * `.nexgent/improvements/`; the diagnosis from the job's `diagnosis.json`;
 * the candidate as `capabilities.show` shows it; the display-only dollar
 * estimate from the ledger's model requests of the job (its `improvementId`
 * and its trial's `trialId`) and the `@nexgent/llm` price table.
 */
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { billedTokens, budgetStatus, jobPaths, type ImprovementHost } from '@nexgent/evolve'
import { jobFeedbackIds, jobPhaseTimes, NexgentError, type Diagnosis, type ImprovementCostPhase, type ImprovementJob, type ImproverDecisionReason, type LedgerRecord, type LLMUsage, type PhaseCost } from '@nexgent/kernel'
import { estimateUsdTotal } from '@nexgent/llm'
import { JsonlLedger } from '@nexgent/session'
import type { CapabilityService } from '@nexgent/capabilities'
import type { ImprovementDetail, ImprovementJobView, ImprovementListing } from './api.js'
import * as capabilities from './capabilities.js'

/** The model requests of each job, from the ledger (`improvementId`, or its trial's `trialId`). */
type JobRequests = Map<string, { model: string; usage: LLMUsage }[]>

async function jobRequests(host: ImprovementHost, jobs: readonly ImprovementJob[]): Promise<JobRequests> {
  const byTrial = new Map<string, string>()
  for (const job of jobs) if (job.trialId !== undefined) byTrial.set(job.trialId, job.id)
  const ids = new Set(jobs.map(job => job.id))
  const out: JobRequests = new Map()
  const ledger = new JsonlLedger({ ledgersDir: host.layout.ledgers })
  try {
    for await (const record of ledger.read({ types: ['llm.request.end'] }) as AsyncIterable<LedgerRecord>) {
      if (record.type !== 'llm.request.end') continue
      const jobId = record.improvementId !== undefined && ids.has(record.improvementId)
        ? record.improvementId
        : record.trialId === undefined ? undefined : byTrial.get(record.trialId)
      if (jobId === undefined) continue
      const list = out.get(jobId) ?? []
      list.push({ model: record.model, usage: record.usage })
      out.set(jobId, list)
    }
  } catch {
    // An unreadable ledger leaves the estimates unknown.
  }
  return out
}

/** One job as lists show it. */
export function jobView(job: ImprovementJob, requests: readonly { model: string; usage: LLMUsage }[] | undefined): ImprovementJobView {
  const tokens: Partial<Record<ImprovementCostPhase, number | 'unknown'>> = {}
  for (const [phase, cost] of Object.entries(job.phases) as [ImprovementCostPhase, PhaseCost][]) {
    const billed = billedTokens(cost.usage)
    tokens[phase] = billed.complete ? billed.tokens : 'unknown'
  }
  const ranRequests = Object.values(job.phases).reduce((sum, cost) => sum + (cost?.requestCount ?? 0), 0)
  // A job whose phases made requests the ledger does not show cannot be priced.
  const estimatedUsd = requests === undefined || requests.length === 0
    ? (ranRequests === 0 ? 0 : 'unknown')
    : estimateUsdTotal(requests)
  return {
    id: job.id,
    ...(job.kind === undefined ? {} : { kind: job.kind }),
    ...(job.improverVersion === undefined ? {} : { improverVersion: job.improverVersion }),
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

/** One job's view with its own ledger requests. */
export async function viewOf(host: ImprovementHost, job: ImprovementJob): Promise<ImprovementJobView> {
  return jobView(job, (await jobRequests(host, [job])).get(job.id))
}

/** `improvements.list`: jobs newest first, the batch waiting for the next job, the budget window. */
export async function listing(host: ImprovementHost, now: Date = new Date()): Promise<ImprovementListing> {
  const [jobs, queue, settings] = await Promise.all([host.list(), host.queue(), host.settings()])
  const requests = await jobRequests(host, jobs)
  const budget = budgetStatus(jobs, settings.improvement.budget, now)
  return {
    jobs: jobs.map(job => jobView(job, requests.get(job.id))).reverse(),
    ...(queue?.activeJobId === undefined ? {} : { activeJobId: queue.activeJobId }),
    pending: queue?.pending.length ?? 0,
    threshold: settings.improvement.feedbackThreshold,
    budget: { usedTokens: budget.used, maxTokens: budget.limit, windowDays: settings.improvement.budget.windowDays },
    autoImprove: settings.autoImprove,
  }
}

const DIAGNOSIS_FILE = 'diagnosis.json'

async function diagnosisOf(host: ImprovementHost, job: ImprovementJob): Promise<Diagnosis | undefined> {
  if (job.diagnosed === undefined) return undefined
  try {
    return JSON.parse(await readFile(join(jobPaths(host.directory, job.id).directory, DIAGNOSIS_FILE), 'utf8')) as Diagnosis
  } catch {
    return undefined
  }
}

function jobId(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new NexgentError('tool/invalid-input', 'jobId must be a string')
  return value
}

/** `improvements.show`: the job, its diagnosis and its candidate. */
export async function show(host: ImprovementHost, service: CapabilityService | undefined, id: unknown): Promise<ImprovementDetail> {
  const job = await host.show(jobId(id))
  const [view, diagnosis] = await Promise.all([viewOf(host, job), diagnosisOf(host, job)])
  const candidate = job.candidateId === undefined || service === undefined
    ? undefined
    : await capabilities.show(service, job.candidateId).catch(() => undefined)
  return {
    view,
    job,
    ...(diagnosis === undefined ? {} : { diagnosis }),
    ...(candidate === undefined ? {} : { candidate }),
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
