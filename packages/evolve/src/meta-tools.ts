/**
 * The tools of a meta job's two sessions (step 6, `data-formats.md`
 * §元改进作业, `permissions.md` §元改进会话与元改进预算):
 *
 * - meta-diagnose: `improve_list_jobs`, `improve_read_job`,
 *   `improve_read_session`, `improve_read_ledger` (all read only) and
 *   `improve_report_meta_diagnosis`. The host checks the report's schema,
 *   bounds and that every cited job exists; at most
 *   `IMPROVER_LIMITS.maxMetaDiagnosisAttempts` reports. The accepted one is
 *   written once to `<jobId>/meta-diagnosis.json` with the host's
 *   `statusCounts`.
 * - meta-propose: `improve_read_improver` (the parent), `improve_read_job`
 *   and `improve_propose_change`. The host runs `checkImproverChange`; at
 *   most `IMPROVER_LIMITS.maxChangeAttempts` proposals. The accepted child is
 *   stored with the project's `ImproverStore` (written once) and the change
 *   recorded in `<jobId>/change.json`.
 *
 * Handlers read through the host; nothing writes project files.
 */
import { open, readFile } from 'node:fs/promises'
import {
  checkImproverChange,
  EVALUATOR_FIELDS,
  IMPROVE_LIST_JOBS_TOOL,
  IMPROVE_PROPOSE_CHANGE_TOOL,
  IMPROVE_READ_IMPROVER_TOOL,
  IMPROVE_READ_JOB_TOOL,
  IMPROVE_REPORT_META_DIAGNOSIS_TOOL,
  IMPROVER_CHANGE_OPS,
  IMPROVER_LIMITS,
  IMPROVER_PARAM_BOUNDS,
  isFinalImprovementStatus,
  REPLAY_SELECTIONS,
  type CapabilityDecision,
  type ImproverBundle,
  type ImproverChange,
  type ImproverChangeRecord,
  type ImprovementStatus,
  type MetaDiagnosis,
  type MetaDiagnosisReport,
  type Tool,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore, improversDir, ImproverStore, readCandidate } from '@nexgent/capabilities'
import { validateImprovementFile } from '@nexgent/session'
import { readLedgerTool, readSessionTool, sliceLines, toolDefinition } from './diagnosis.js'
import type { PinnedImprover } from './improver.js'
import { jobPaths, listJobs, readJob } from './jobs.js'
import { improvementsDir } from './paths.js'
import type { ImprovementJob } from './types.js'

const DESCRIPTIONS: Record<string, string> = {
  [IMPROVE_LIST_JOBS_TOOL.name]: 'List the improvement jobs of this project, one JSON line each: id, kind, status, trigger, improver version, diagnosed component kind, candidate, gate decision and tokens spent. Narrow by statuses; limit keeps the newest.',
  [IMPROVE_READ_JOB_TOOL.name]: 'Read one improvement job: its record, its diagnosis, its candidate\'s summary and the gate\'s verdict (meta jobs: their meta diagnosis, change and comparison).',
  [IMPROVE_REPORT_META_DIAGNOSIS_TOOL.name]: `Submit the meta diagnosis: findings (stage diagnose / propose / trial / other, a label, the job ids that show it), one hypothesis sentence about the improver, and proposal "change" or "none". The host checks it; at most ${IMPROVER_LIMITS.maxMetaDiagnosisAttempts} reports in total.`,
  [IMPROVE_READ_IMPROVER_TOOL.name]: 'Read the improver this meta job improves (the parent): its diagnosis policy paragraphs, its proposal kinds and briefs, its comparison parameters, and the change operators with their bounds.',
  [IMPROVE_PROPOSE_CHANGE_TOOL.name]: `Propose exactly one change to the improver and why. The host checks it (one operator, within bounds, no evaluator field, a valid improver that differs from the parent) and says what to fix; at most ${IMPROVER_LIMITS.maxChangeAttempts} proposals in total.`,
}

const definition = (spec: Parameters<typeof toolDefinition>[0]) => toolDefinition(spec, DESCRIPTIONS[spec.name])

/** Write a JSON file once (exclusive create). */
export async function writeOnce(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function tokensOf(job: ImprovementJob): number {
  let total = 0
  for (const phase of Object.values(job.phases)) {
    const value = phase?.usage.totalTokens
    if (typeof value === 'number') total += value
  }
  return total
}

/** One line of `improve_list_jobs`. */
function summary(job: ImprovementJob): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind ?? 'capability',
    status: job.status,
    trigger: job.trigger,
    createdAt: job.createdAt,
    improverVersion: job.improverVersion ?? 'v0',
    signals: job.items.length,
    ...(job.diagnosed === undefined ? {} : { diagnosedKind: job.diagnosed.proposalKind, diagnosisAttempts: job.diagnosed.attempts }),
    ...(job.candidateId === undefined ? {} : { candidateId: job.candidateId }),
    ...(job.decisionId === undefined ? {} : { decisionId: job.decisionId }),
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    ...(job.firstUse === undefined ? {} : { firstUse: true }),
    ...(job.rolledBack === undefined ? {} : { rolledBack: true }),
    ...(job.meta === undefined ? {} : { childVersion: job.meta.childVersion, compared: job.meta.compared }),
    tokens: tokensOf(job),
  }
}

/** `improve_read_job`: the record and its side files, or `undefined` when there is no such job. */
async function jobDetail(layout: WorkspaceLayout, jobId: string): Promise<Record<string, unknown> | undefined> {
  const directory = improvementsDir(layout)
  let job: ImprovementJob
  try {
    job = await readJob(directory, jobId)
  } catch {
    return undefined
  }
  const paths = jobPaths(directory, jobId)
  const out: Record<string, unknown> = { job }
  const diagnosis = await readOptionalJson(paths.diagnosis)
  if (diagnosis !== undefined) out.diagnosis = diagnosis
  for (const [key, path] of [['metaDiagnosis', paths.metaDiagnosis], ['change', paths.change], ['comparison', paths.comparison]] as const) {
    const value = await readOptionalJson(path)
    if (value !== undefined) out[key] = value
  }
  if (job.candidateId !== undefined) {
    const candidate = await readCandidate(layout.capabilities, job.candidateId).catch(() => undefined)
    if (candidate !== undefined) out.candidate = { id: candidate.id, summary: candidate.summary, components: candidate.components.map(component => ({ kind: component.kind, name: component.name })) }
  }
  if (job.decisionId !== undefined) {
    const decision: CapabilityDecision | undefined = (await new CapabilityStore(layout.capabilities).decisions().catch(() => [] as CapabilityDecision[])).find(item => item.id === job.decisionId)
    if (decision !== undefined) out.decision = { outcome: decision.outcome, reason: decision.reason, detail: decision.detail, ...(decision.verdict === undefined ? {} : { verdict: decision.verdict }) }
  }
  return out
}

function readJobTool(layout: WorkspaceLayout): Tool {
  return {
    definition: definition(IMPROVE_READ_JOB_TOOL),
    async handler(raw) {
      const { jobId } = raw as { jobId: string }
      const detail = await jobDetail(layout, jobId)
      if (detail === undefined) return { content: `No improvement job ${jobId} in this project.`, isError: true }
      const slice = sliceLines([detail])
      return { content: slice.text, meta: { truncated: slice.truncated } }
    },
  }
}

/** Final-status counts of the project's finished capability jobs (the host's, never the model's). */
export function finishedStatusCounts(jobs: readonly ImprovementJob[]): Partial<Record<ImprovementStatus, number>> {
  const counts: Partial<Record<ImprovementStatus, number>> = {}
  for (const job of jobs) {
    if (job.kind === 'meta' || job.arm !== undefined || !isFinalImprovementStatus(job.status)) continue
    counts[job.status] = (counts[job.status] ?? 0) + 1
  }
  return counts
}

/** State of one meta-diagnose session's reports. */
export interface MetaDiagnosisState {
  attempts: number
  accepted?: MetaDiagnosis
  lastProblems?: readonly string[]
}

/** What {@link metaDiagnosisTools} needs. */
export interface MetaDiagnosisToolsInput {
  readonly layout: WorkspaceLayout
  /** The meta job. */
  readonly job: ImprovementJob
  readonly sessionId: string
  readonly improver: PinnedImprover
  readonly state: MetaDiagnosisState
  readonly now?: () => Date
}

/** Problems of a meta-diagnosis report besides the schema: bounds and cited jobs. */
function reportProblems(report: MetaDiagnosisReport, known: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (report.findings.length > IMPROVER_LIMITS.maxFindings) problems.push(`findings: at most ${IMPROVER_LIMITS.maxFindings}`)
  if (report.proposal === 'change' && report.findings.length === 0) problems.push('findings: name at least one finding when proposing a change')
  report.findings.forEach((finding, index) => {
    if (finding.label.length > IMPROVER_LIMITS.maxLabelChars) problems.push(`findings[${index}].label: at most ${IMPROVER_LIMITS.maxLabelChars} characters`)
    if (finding.jobIds.length === 0 || finding.jobIds.length > IMPROVER_LIMITS.maxFindingJobs) problems.push(`findings[${index}].jobIds: 1 to ${IMPROVER_LIMITS.maxFindingJobs} job ids`)
    for (const jobId of finding.jobIds) if (!known.has(jobId)) problems.push(`findings[${index}].jobIds: no improvement job ${jobId} in this project`)
  })
  if (report.hypothesis.length > IMPROVER_LIMITS.maxHypothesisChars) problems.push(`hypothesis: at most ${IMPROVER_LIMITS.maxHypothesisChars} characters`)
  return problems
}

/** The five tools of a meta-diagnose session. */
export function metaDiagnosisTools(input: MetaDiagnosisToolsInput): Tool[] {
  const now = input.now ?? (() => new Date())
  const max = IMPROVER_LIMITS.maxMetaDiagnosisAttempts
  const directory = improvementsDir(input.layout)
  return [
    {
      definition: definition(IMPROVE_LIST_JOBS_TOOL),
      async handler(raw) {
        const args = raw as { statuses?: string[]; limit?: number }
        let jobs = (await listJobs(directory)).filter(job => job.id !== input.job.id)
        if (args.statuses !== undefined) jobs = jobs.filter(job => args.statuses!.includes(job.status))
        jobs = jobs.slice(-(args.limit ?? 50))
        const slice = sliceLines(jobs.map(summary))
        return { content: slice.text === '' ? '(no jobs)' : slice.text, meta: { jobs: slice.count, truncated: slice.truncated } }
      },
    },
    readJobTool(input.layout),
    readSessionTool(input.layout),
    readLedgerTool(input.layout),
    {
      definition: definition(IMPROVE_REPORT_META_DIAGNOSIS_TOOL),
      async handler(raw) {
        const state = input.state
        if (state.accepted !== undefined) return { content: 'The meta diagnosis was already accepted; nothing more to do. End your turn.' }
        if (state.attempts >= max) return { content: `No reports are left (${max} used); the meta job ends without a diagnosis.`, isError: true }
        state.attempts += 1
        const jobs = await listJobs(directory)
        const record = {
          formatVersion: 1 as const,
          jobId: input.job.id,
          createdAt: now().toISOString(),
          sessionId: input.sessionId,
          attempts: state.attempts,
          improverVersion: input.improver.version,
          basis: [...(input.job.meta?.basis ?? [])],
          statusCounts: finishedStatusCounts(jobs),
          ...(raw as MetaDiagnosisReport),
        } as MetaDiagnosis
        const schema = validateImprovementFile('metaDiagnosis', record).map(issue => `${issue.path} ${issue.message}`)
        const problems = schema.length > 0 ? schema : reportProblems(raw as MetaDiagnosisReport, new Set(jobs.filter(job => job.id !== input.job.id).map(job => job.id)))
        if (problems.length > 0) {
          state.lastProblems = problems
          const left = max - state.attempts
          return {
            content: `The meta diagnosis was not accepted (${state.attempts} of ${max} reports used${left === 0 ? '; none left' : `, ${left} left`}). Fix:\n${problems.slice(0, 20).map(problem => `- ${problem}`).join('\n')}`,
            isError: true,
          }
        }
        await writeOnce(jobPaths(directory, input.job.id).metaDiagnosis, record)
        state.accepted = record
        return { content: `Meta diagnosis accepted (proposal ${record.proposal}). End your turn.`, meta: { proposal: record.proposal } }
      },
    },
  ]
}

/** State of one meta-propose session's proposals. */
export interface MetaChangeState {
  attempts: number
  accepted?: ImproverChangeRecord
  /** The accepted child improver. */
  child?: ImproverBundle
  lastProblems?: readonly string[]
}

/** What {@link metaProposeTools} needs. */
export interface MetaProposeToolsInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  readonly sessionId: string
  /** The parent: the improver the meta job pinned. */
  readonly improver: PinnedImprover
  readonly state: MetaChangeState
  readonly now?: () => Date
}

/** What `improve_read_improver` returns. */
function improverText(improver: PinnedImprover): string {
  return JSON.stringify({
    version: improver.version,
    improver: improver.bundle,
    operators: {
      'set-diagnosis-paragraph': `{op, index, text}: rewrite paragraph index (0-based), or append with index = ${improver.bundle.diagnosis.paragraphs.length}; at most ${IMPROVER_LIMITS.maxParagraphs} paragraphs of ${IMPROVER_LIMITS.maxParagraphChars} characters; placeholder {{allowedKinds}}`,
      'set-proposal-kinds': '{op, kinds}: the component kinds a diagnosis may propose, in order of preference (never plugin); every kind needs a brief',
      'set-proposal-brief': `{op, kind, template}: the propose session's brief for one kind, at most ${IMPROVER_LIMITS.maxBriefChars} characters; placeholders {{jobId}}, {{hypothesis}}, {{failures}}, {{kind}}`,
      'set-comparison-param': `{op, param, value}: selectionCases ${IMPROVER_PARAM_BOUNDS.selectionCases.min}-${IMPROVER_PARAM_BOUNDS.selectionCases.max}, repeats ${IMPROVER_PARAM_BOUNDS.repeats.min}-${IMPROVER_PARAM_BOUNDS.repeats.max}, selection ${REPLAY_SELECTIONS.join(' | ')}`,
    } satisfies Record<(typeof IMPROVER_CHANGE_OPS)[number], string>,
    notChangeable: [...EVALUATOR_FIELDS],
  }, null, 2)
}

/** The three tools of a meta-propose session. */
export function metaProposeTools(input: MetaProposeToolsInput): Tool[] {
  const now = input.now ?? (() => new Date())
  const max = IMPROVER_LIMITS.maxChangeAttempts
  return [
    {
      definition: definition(IMPROVE_READ_IMPROVER_TOOL),
      async handler() {
        return { content: improverText(input.improver) }
      },
    },
    readJobTool(input.layout),
    {
      definition: definition(IMPROVE_PROPOSE_CHANGE_TOOL),
      async handler(raw) {
        const state = input.state
        if (state.accepted !== undefined) return { content: 'The change was already accepted; nothing more to do. End your turn.' }
        if (state.attempts >= max) return { content: `No proposals are left (${max} used); the meta job ends without a change.`, isError: true }
        state.attempts += 1
        const args = raw as { change?: unknown; rationale?: unknown }
        const refuse = (problems: readonly string[]) => {
          state.lastProblems = problems
          const left = max - state.attempts
          return {
            content: `The change was not accepted (${state.attempts} of ${max} proposals used${left === 0 ? '; none left' : `, ${left} left`}). Fix:\n${problems.slice(0, 20).map(problem => `- ${problem}`).join('\n')}`,
            isError: true,
          }
        }
        if (typeof args.rationale !== 'string' || args.rationale.length === 0 || args.rationale.length > IMPROVER_LIMITS.maxRationaleChars) {
          return refuse([`rationale: one to ${IMPROVER_LIMITS.maxRationaleChars} characters`])
        }
        const check = checkImproverChange(input.improver.bundle, args.change)
        if (!check.ok) return refuse([`${check.refusal}: ${check.problems.join('; ')}`])
        const { version: childVersion } = await new ImproverStore(improversDir(input.layout)).write(check.child)
        const record: ImproverChangeRecord = {
          formatVersion: 1,
          jobId: input.job.id,
          createdAt: now().toISOString(),
          sessionId: input.sessionId,
          attempts: state.attempts,
          parentVersion: input.improver.version,
          childVersion,
          change: check.change as ImproverChange,
          rationale: args.rationale,
        }
        const issues = validateImprovementFile('change', record)
        if (issues.length > 0) return refuse(issues.map(issue => `${issue.path} ${issue.message}`))
        await writeOnce(jobPaths(improvementsDir(input.layout), input.job.id).change, record)
        state.accepted = record
        state.child = check.child
        return { content: `Change accepted: the child improver is ${childVersion}. End your turn.`, meta: { childVersion } }
      },
    },
  ]
}
