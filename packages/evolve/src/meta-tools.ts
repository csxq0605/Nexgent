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
 * ADR 0012: a meta job reads the projects of its batch ({@link MetaProject},
 * `metaProjects`): `improve_list_jobs` lists their jobs (one project with
 * `projectId`), `improve_read_job` finds a job in them, `improve_read_session`
 * and `improve_read_ledger` need the `projectId`; any other project is
 * refused in the tool result. The child improver is stored in the user's
 * line (below the Nexgent home), and a change whose text carries a concrete
 * value of the batch's tasks is refused (`instance-literal`, ADR 0012
 * decision 5).
 *
 * Handlers read through the host; nothing writes project files.
 */
import { open, readFile } from 'node:fs/promises'
import {
  checkImproverChange,
  EVALUATOR_FIELDS,
  findInstanceLiterals,
  IMPROVE_LIST_JOBS_TOOL,
  IMPROVE_PROPOSE_CHANGE_TOOL,
  IMPROVE_READ_IMPROVER_TOOL,
  IMPROVE_READ_JOB_TOOL,
  IMPROVE_REPORT_META_DIAGNOSIS_TOOL,
  IMPROVER_CHANGE_OPS,
  IMPROVER_LIMITS,
  IMPROVER_PARAM_BOUNDS,
  improverChangeTexts,
  isFinalImprovementStatus,
  META_READ_LEDGER_TOOL,
  META_READ_SESSION_TOOL,
  REPLAY_SELECTIONS,
  type CapabilityDecision,
  type ImproverBundle,
  type ImproverChange,
  type ImproverChangeRecord,
  type ImprovementStatus,
  type MetaDiagnosis,
  type MetaDiagnosisReport,
  type Tool,
  type ToolOutput,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore, ImproverStore, readCandidate } from '@nexgent/capabilities'
import { validateImprovementFile } from '@nexgent/session'
import { readLedgerTool, readSessionTool, sliceLines, toolDefinition } from './diagnosis.js'
import type { PinnedImprover } from './improver.js'
import { jobPaths, readJob } from './jobs.js'
import { literalEvidence, type LiteralEvidence } from './literals.js'
import { improvementsDir } from './paths.js'
import type { ImprovementJob } from './types.js'
import { homeOf, metaProjects, projectJobs, userImproversDir, type MetaProject, type ProjectJob } from './user.js'

const DESCRIPTIONS: Record<string, string> = {
  [IMPROVE_LIST_JOBS_TOOL.name]: 'List the improvement jobs of this meta job\'s projects (one project with projectId), one JSON line each: project id, id, kind, status, trigger, improver version, diagnosed component kind, candidate, gate decision and tokens spent. Narrow by statuses; limit keeps the newest.',
  [IMPROVE_READ_JOB_TOOL.name]: 'Read one improvement job: its record, its diagnosis, its candidate\'s summary and the gate\'s verdict (meta jobs: their meta diagnosis, change and comparison). projectId may be left out; the job is then looked up in every project of this meta job.',
  [META_READ_SESSION_TOOL.name]: 'Read a slice of one session of a project of this meta job (projectId as improve_list_jobs shows it): its records by turn range and record type.',
  [META_READ_LEDGER_TOOL.name]: 'Read a slice of the ledger of a project of this meta job (projectId as improve_list_jobs shows it), narrowed by task, session, member, capability version or record types.',
  [IMPROVE_REPORT_META_DIAGNOSIS_TOOL.name]: `Submit the meta diagnosis: findings (stage diagnose / propose / trial / other, a label, the job ids that show it), one hypothesis sentence about the improver, and proposal "change" or "none". The host checks it; at most ${IMPROVER_LIMITS.maxMetaDiagnosisAttempts} reports in total.`,
  [IMPROVE_READ_IMPROVER_TOOL.name]: 'Read the improver this meta job improves (the parent): its diagnosis policy paragraphs, its proposal kinds and briefs, its comparison parameters, and the change operators with their bounds.',
  [IMPROVE_PROPOSE_CHANGE_TOOL.name]: `Propose exactly one change to the improver and why. The host checks it (one operator, within bounds, no evaluator field, a valid improver that differs from the parent, no concrete value of the tasks it was learned from) and says what to fix; at most ${IMPROVER_LIMITS.maxChangeAttempts} proposals in total.`,
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
function summary(projectId: string, job: ImprovementJob): Record<string, unknown> {
  return {
    projectId,
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

/** The projects a meta session may read, resolved once. */
type Projects = () => Promise<readonly MetaProject[]>

function projectsOf(layout: WorkspaceLayout, job: ImprovementJob, given: readonly MetaProject[] | undefined, home?: string): Projects {
  let resolved: Promise<readonly MetaProject[]> | undefined
  return () => (resolved ??= given === undefined ? metaProjects(layout, job, home) : Promise.resolve(given))
}

/** The project a tool call names, or the refusal to return. */
async function projectNamed(projects: Projects, projectId: string): Promise<MetaProject | ToolOutput> {
  const all = await projects()
  const found = all.find(project => project.projectId === projectId)
  if (found !== undefined) return found
  return { content: `Project ${projectId} is not one of this meta job's projects (${all.map(project => project.projectId).join(', ') || 'none'}).`, isError: true }
}

function isProject(value: MetaProject | ToolOutput): value is MetaProject {
  return 'layout' in value
}

function readJobTool(projects: Projects): Tool {
  return {
    definition: definition(IMPROVE_READ_JOB_TOOL),
    async handler(raw) {
      const { jobId, projectId } = raw as { jobId: string; projectId?: string }
      let searched: readonly MetaProject[]
      if (projectId === undefined) searched = await projects()
      else {
        const named = await projectNamed(projects, projectId)
        if (!isProject(named)) return named
        searched = [named]
      }
      for (const project of searched) {
        const detail = await jobDetail(project.layout, jobId)
        if (detail === undefined) continue
        const slice = sliceLines([{ projectId: project.projectId, ...detail }])
        return { content: slice.text, meta: { truncated: slice.truncated } }
      }
      return { content: `No improvement job ${jobId} in ${projectId === undefined ? 'this meta job\'s projects' : `project ${projectId}`}.`, isError: true }
    },
  }
}

/** A project-scoped copy of a single-project read tool (`projectId` required). */
function scopedReadTool(spec: typeof META_READ_SESSION_TOOL, projects: Projects, inner: (layout: WorkspaceLayout) => Tool): Tool {
  return {
    definition: definition(spec),
    async handler(raw, context) {
      const { projectId, ...rest } = raw as { projectId: string }
      const named = await projectNamed(projects, projectId)
      if (!isProject(named)) return named
      return inner(named.layout).handler(rest, context)
    },
  }
}

/** The finished capability jobs of the batch (every finished capability job of the projects when the batch is empty). */
function batchJobs(job: ImprovementJob, jobs: readonly ProjectJob[]): ProjectJob[] {
  const batch = job.meta?.batch ?? []
  if (batch.length > 0) return jobs.filter(item => batch.some(entry => entry.projectId === item.project.projectId && entry.jobId === item.job.id))
  return jobs.filter(item => item.job.kind !== 'meta' && item.job.arm === undefined && isFinalImprovementStatus(item.job.status))
}

/** Final-status counts of the finished capability jobs given (the host's, never the model's). */
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
  /** The project hosting the meta job. */
  readonly layout: WorkspaceLayout
  /** The projects it may read (default `metaProjects`: its batch's, or its own). */
  readonly projects?: readonly MetaProject[]
  /** The Nexgent home the projects' data is located under (default `NEXGENT_HOME` / `~/.nexgent`). */
  readonly home?: string
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
    for (const jobId of finding.jobIds) if (!known.has(jobId)) problems.push(`findings[${index}].jobIds: no improvement job ${jobId} in this meta job's projects`)
  })
  if (report.hypothesis.length > IMPROVER_LIMITS.maxHypothesisChars) problems.push(`hypothesis: at most ${IMPROVER_LIMITS.maxHypothesisChars} characters`)
  return problems
}

/** The five tools of a meta-diagnose session. */
export function metaDiagnosisTools(input: MetaDiagnosisToolsInput): Tool[] {
  const now = input.now ?? (() => new Date())
  const max = IMPROVER_LIMITS.maxMetaDiagnosisAttempts
  const directory = improvementsDir(input.layout)
  const projects = projectsOf(input.layout, input.job, input.projects, input.home)
  const others = async () => (await projectJobs(await projects())).filter(item => item.job.id !== input.job.id)
  return [
    {
      definition: definition(IMPROVE_LIST_JOBS_TOOL),
      async handler(raw) {
        const args = raw as { projectId?: string; statuses?: string[]; limit?: number }
        let jobs = await others()
        if (args.projectId !== undefined) {
          const named = await projectNamed(projects, args.projectId)
          if (!isProject(named)) return named
          jobs = jobs.filter(item => item.project.projectId === named.projectId)
        }
        if (args.statuses !== undefined) jobs = jobs.filter(item => args.statuses!.includes(item.job.status))
        jobs = jobs.slice(-(args.limit ?? 50))
        const slice = sliceLines(jobs.map(item => summary(item.project.projectId, item.job)))
        return { content: slice.text === '' ? '(no jobs)' : slice.text, meta: { jobs: slice.count, truncated: slice.truncated } }
      },
    },
    readJobTool(projects),
    scopedReadTool(META_READ_SESSION_TOOL, projects, readSessionTool),
    scopedReadTool(META_READ_LEDGER_TOOL, projects, readLedgerTool),
    {
      definition: definition(IMPROVE_REPORT_META_DIAGNOSIS_TOOL),
      async handler(raw) {
        const state = input.state
        if (state.accepted !== undefined) return { content: 'The meta diagnosis was already accepted; nothing more to do. End your turn.' }
        if (state.attempts >= max) return { content: `No reports are left (${max} used); the meta job ends without a diagnosis.`, isError: true }
        state.attempts += 1
        const jobs = (await others()).map(item => item.job)
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
        const problems = schema.length > 0 ? schema : reportProblems(raw as MetaDiagnosisReport, new Set(jobs.map(job => job.id)))
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
  /** The project hosting the meta job. */
  readonly layout: WorkspaceLayout
  /** The projects it may read (default `metaProjects`). */
  readonly projects?: readonly MetaProject[]
  /** The Nexgent home whose improver line receives the child (default `NEXGENT_HOME` / `~/.nexgent`). */
  readonly home?: string
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
  const projects = projectsOf(input.layout, input.job, input.projects, input.home)
  let evidence: Promise<LiteralEvidence> | undefined
  const batchEvidence = () => (evidence ??= projects().then(async all => literalEvidence(batchJobs(input.job, await projectJobs(all)), all)))
  return [
    {
      definition: definition(IMPROVE_READ_IMPROVER_TOOL),
      async handler() {
        return { content: improverText(input.improver) }
      },
    },
    readJobTool(projects),
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
        const texts = improverChangeTexts(check.change)
        if (texts.length > 0) {
          const { sources, messages } = await batchEvidence()
          const hits = findInstanceLiterals(texts, sources, messages)
          if (hits.length > 0) {
            return refuse([`instance-literal: the change carries concrete values of the tasks it was learned from (${hits.map(hit => `${hit.value} in ${hit.path}, from ${hit.source}`).join('; ')}); an improver says how to diagnose and propose for any task`])
          }
        }
        const { version: childVersion } = await new ImproverStore(userImproversDir(homeOf(input.home))).write(check.child)
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
