/**
 * The diagnose phase (`data-formats.md` §改进作业 诊断): a session with the
 * four read-only tools of `IMPROVEMENT_DIAGNOSIS_TOOLS`, which reports one
 * structured diagnosis through `improve_report_diagnosis`. The host checks
 * every report (schema, counts, evidence records exist) and answers what to
 * fix; at most `IMPROVEMENT_LIMITS.maxDiagnosisAttempts` reports (a turn that
 * ends without one also uses an attempt) before the job fails with
 * `improvement/invalid-diagnosis`. The accepted report is written once to
 * `<jobId>/diagnosis.json` with the host's `memberCosts` from the ledger.
 * Step 6: the prompt's `# Policy` is the job's pinned improver's diagnosis
 * policy (`renderDiagnosisPolicy`; `v0` is step 5's text verbatim).
 *
 * Design references only (no code taken): DSH `session-query` for read-only
 * slices by session, turn and record type with a byte cap; DSH
 * `experimental/auto-review` for the prompt shape (a fixed policy section,
 * then the history, then the item to judge; malformed output is a failure).
 */
import { open } from 'node:fs/promises'
import {
  addUsage,
  IMPROVE_LIST_FEEDBACK_TOOL,
  IMPROVE_READ_LEDGER_TOOL,
  IMPROVE_READ_SESSION_TOOL,
  IMPROVE_REPORT_DIAGNOSIS_TOOL,
  IMPROVEMENT_LIMITS,
  IMPROVER_V0,
  NexgentError,
  renderDiagnosisPolicy,
  ZERO_USAGE,
  type Diagnosis,
  type DiagnosisReport,
  type ExecutionForm,
  type FeedbackListing,
  type ImproverBundle,
  type ImprovementToolSpec,
  type LedgerRecord,
  type LedgerRecordType,
  type LLMUsage,
  type MemberCost,
  type SessionRecord,
  type Tool,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlLedger, JsonlSessionStore, validateImprovementFile } from '@nexgent/session'
import { SessionFeedbackStore } from '@nexgent/tasking'
import { jobPaths } from './jobs.js'
import { improvementsDir } from './paths.js'
import type { ImprovementJob } from './types.js'

// ---------------------------------------------------------------------------
// Read-only slices
// ---------------------------------------------------------------------------

/** Join JSON lines up to `maxBytes`; a longer slice is cut at a line and marked. */
export function sliceLines(items: readonly unknown[], maxBytes: number = IMPROVEMENT_LIMITS.defaultSliceBytes): { readonly text: string; readonly truncated: boolean; readonly count: number } {
  const cap = Math.min(Math.max(1, maxBytes), IMPROVEMENT_LIMITS.maxSliceBytes)
  const lines: string[] = []
  let bytes = 0
  for (const item of items) {
    const line = JSON.stringify(item)
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > cap) {
      return { text: `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}[truncated: ${items.length - lines.length} more of ${items.length} records; narrow the query or raise maxBytes up to ${IMPROVEMENT_LIMITS.maxSliceBytes}]`, truncated: true, count: lines.length }
    }
    lines.push(line)
    bytes += size
  }
  return { text: lines.join('\n'), truncated: false, count: lines.length }
}

function turnOf(record: SessionRecord): number | undefined {
  const turn = (record as { readonly turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/** Records of one session narrowed by turn range and type. */
export function selectRecords(records: readonly SessionRecord[], query: { readonly fromTurn?: number; readonly toTurn?: number; readonly types?: readonly string[] }): SessionRecord[] {
  return records.filter(record => {
    if (query.types !== undefined && query.types.length > 0 && !query.types.includes(record.type)) return false
    const turn = turnOf(record)
    if (query.fromTurn !== undefined && (turn === undefined || turn < query.fromTurn)) return false
    if (query.toTurn !== undefined && (turn === undefined || turn > query.toTurn)) return false
    return true
  })
}

/** Ledger records narrowed by attribution. */
export async function selectLedger(layout: WorkspaceLayout, query: { readonly taskId?: string; readonly sessionId?: string; readonly memberId?: string; readonly capabilityVersion?: string; readonly types?: readonly string[] }): Promise<LedgerRecord[]> {
  const ledger = new JsonlLedger({ ledgersDir: layout.ledgers })
  const out: LedgerRecord[] = []
  const range = {
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.types === undefined || query.types.length === 0 ? {} : { types: query.types as LedgerRecordType[] }),
  }
  for await (const record of ledger.read(range)) {
    if (query.taskId !== undefined && record.taskId !== query.taskId) continue
    if (query.memberId !== undefined && record.memberId !== query.memberId) continue
    if (query.capabilityVersion !== undefined && record.capabilityVersion !== query.capabilityVersion) continue
    out.push(record)
  }
  return out
}

// ---------------------------------------------------------------------------
// Member costs (host-computed; the model can only cite them)
// ---------------------------------------------------------------------------

/**
 * Per-member usage of the given tasks from the ledger (`llm.request.end` and
 * `tool.call`), the root as `main`. Trial runs and improvement sessions are
 * left out (they are not the user's task).
 */
export async function memberCostsFor(layout: WorkspaceLayout, taskIds: readonly string[]): Promise<MemberCost[]> {
  if (taskIds.length === 0) return []
  const wanted = new Set(taskIds)
  const totals = new Map<string, { usage: LLMUsage; requestCount: number; toolCallCount: number; executionForm: ExecutionForm }>()
  const ledger = new JsonlLedger({ ledgersDir: layout.ledgers })
  for await (const record of ledger.read({ types: ['llm.request.end', 'tool.call'] })) {
    if (record.taskId === undefined || !wanted.has(record.taskId) || record.trialId !== undefined || record.improvementId !== undefined) continue
    const member = record.memberId ?? 'main'
    const entry = totals.get(member) ?? { usage: ZERO_USAGE, requestCount: 0, toolCallCount: 0, executionForm: record.executionForm ?? 'direct' }
    if (record.type === 'llm.request.end') {
      entry.usage = addUsage(entry.usage, record.usage)
      entry.requestCount += 1
    } else {
      entry.toolCallCount += 1
    }
    totals.set(member, entry)
  }
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const costs: MemberCost[] = []
  for (const [memberId, entry] of totals) {
    let name = memberId
    if (memberId !== 'main') {
      const start = (await store.readAll(memberId).catch(() => undefined))?.records[0]
      if (start?.type === 'session.start' && start.member !== undefined) name = start.member.name
    }
    costs.push({ memberId, name, executionForm: entry.executionForm, usage: entry.usage, requestCount: entry.requestCount, toolCallCount: entry.toolCallCount })
  }
  return costs.sort((left, right) => (left.memberId === 'main' ? -1 : right.memberId === 'main' ? 1 : left.memberId < right.memberId ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Report checking
// ---------------------------------------------------------------------------

/**
 * Problems of a report (empty when it is acceptable): the contract schema of
 * the resulting `diagnosis.json`, the count bounds, and every evidence
 * record existing (with the cited turn, when given).
 */
export async function checkReport(report: unknown, diagnosis: Omit<Diagnosis, keyof DiagnosisReport>, readRecords: (sessionId: string) => Promise<readonly SessionRecord[] | undefined>): Promise<string[]> {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return ['the report must be an object']
  const value = report as DiagnosisReport
  const full = { ...diagnosis, ...value }
  const problems = validateImprovementFile('diagnosis', full).map(issue => `${issue.path || '(report)'}: ${issue.message}`)
  if (problems.length > 0) return problems
  if (value.failureTypes.length > IMPROVEMENT_LIMITS.maxFailureTypes) problems.push(`failureTypes: at most ${IMPROVEMENT_LIMITS.maxFailureTypes} entries`)
  if (value.hypothesis.length > IMPROVEMENT_LIMITS.maxHypothesisChars) problems.push(`hypothesis: at most ${IMPROVEMENT_LIMITS.maxHypothesisChars} characters`)
  if (value.proposalKind !== 'none' && value.failureTypes.length === 0) problems.push('failureTypes: name at least one failure when proposing a component')
  const cache = new Map<string, readonly SessionRecord[] | undefined>()
  for (const [index, failure] of value.failureTypes.entries()) {
    if (failure.label.length > IMPROVEMENT_LIMITS.maxLabelChars) problems.push(`failureTypes[${index}].label: at most ${IMPROVEMENT_LIMITS.maxLabelChars} characters`)
    if (failure.evidence.length > IMPROVEMENT_LIMITS.maxEvidence) problems.push(`failureTypes[${index}].evidence: at most ${IMPROVEMENT_LIMITS.maxEvidence} entries`)
    for (const [at, ref] of failure.evidence.entries()) {
      if (!cache.has(ref.sessionId)) cache.set(ref.sessionId, await readRecords(ref.sessionId).catch(() => undefined))
      const records = cache.get(ref.sessionId)
      const record = records?.find(item => item.seq === ref.seq)
      if (records === undefined) problems.push(`failureTypes[${index}].evidence[${at}]: no session ${ref.sessionId}`)
      else if (record === undefined) problems.push(`failureTypes[${index}].evidence[${at}]: session ${ref.sessionId} has no record seq ${ref.seq}`)
      else if (ref.turn !== undefined && turnOf(record) !== ref.turn) problems.push(`failureTypes[${index}].evidence[${at}]: record seq ${ref.seq} is not in turn ${ref.turn}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const DESCRIPTIONS: Record<string, string> = {
  [IMPROVE_READ_SESSION_TOOL.name]: 'Read records of one session of this project as JSON lines (read only), narrowed by turn range and record type (e.g. user.message, assistant.message, tool.result, feedback, deliverable.presented). The result is cut at maxBytes and marked truncated.',
  [IMPROVE_READ_LEDGER_TOOL.name]: 'Read the project ledger as JSON lines (read only): model requests, tool calls and task outcomes with their usage, narrowed by taskId, sessionId, memberId (main for the root conversation), capabilityVersion and record type. Cut at maxBytes.',
  [IMPROVE_LIST_FEEDBACK_TOOL.name]: 'List the user\'s feedback entries on deliverables (rating 1-5 when given, comment, session, turn), optionally for one session or deliverable.',
  [IMPROVE_REPORT_DIAGNOSIS_TOOL.name]: `Submit the diagnosis (once). Cite evidence by session id and record seq. proposalKind is the kind of reusable component that would have prevented the problem, or "none" when it is not a capability problem (e.g. the user changed the requirement). The host checks it and says what to fix; at most ${IMPROVEMENT_LIMITS.maxDiagnosisAttempts} reports in total.`,
}

/** A tool definition from its contract spec (description from this package, or `description`). */
export function toolDefinition(spec: ImprovementToolSpec, description?: string): Tool['definition'] {
  return { name: spec.name, description: description ?? DESCRIPTIONS[spec.name] ?? spec.name, inputSchema: spec.inputSchema, effects: [...spec.effects], approval: spec.approval }
}

const definition = (spec: ImprovementToolSpec) => toolDefinition(spec)

/** Read a session's records, or `undefined` when there is no such session. */
export function sessionReader(layout: WorkspaceLayout): (sessionId: string) => Promise<readonly SessionRecord[] | undefined> {
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  return async sessionId => {
    try {
      return (await store.readAll(sessionId)).records
    } catch (error) {
      if (error instanceof NexgentError && (error.code === 'session/not-found' || error.code === 'tool/invalid-input')) return undefined
      throw error
    }
  }
}

/** `improve_read_session` over a project (shared by the diagnose and meta-diagnose sessions). */
export function readSessionTool(layout: WorkspaceLayout): Tool {
  const readRecords = sessionReader(layout)
  return {
    definition: definition(IMPROVE_READ_SESSION_TOOL),
    async handler(raw) {
      const args = raw as { sessionId: string; fromTurn?: number; toTurn?: number; types?: string[]; maxBytes?: number }
      const records = await readRecords(args.sessionId).catch(() => undefined)
      if (records === undefined) return { content: `No session ${args.sessionId} in this project.`, isError: true }
      const slice = sliceLines(selectRecords(records, args), args.maxBytes)
      return { content: slice.text === '' ? '(no records match)' : slice.text, meta: { records: slice.count, truncated: slice.truncated } }
    },
  }
}

/** `improve_read_ledger` over a project (shared by the diagnose and meta-diagnose sessions). */
export function readLedgerTool(layout: WorkspaceLayout): Tool {
  return {
    definition: definition(IMPROVE_READ_LEDGER_TOOL),
    async handler(raw) {
      const args = raw as { taskId?: string; sessionId?: string; memberId?: string; capabilityVersion?: string; types?: string[]; maxBytes?: number }
      const slice = sliceLines(await selectLedger(layout, args), args.maxBytes)
      return { content: slice.text === '' ? '(no ledger records match)' : slice.text, meta: { records: slice.count, truncated: slice.truncated } }
    },
  }
}

/** State of one diagnose session's reports. */
export interface DiagnosisState {
  attempts: number
  accepted?: Diagnosis
  lastProblems?: readonly string[]
}

/** What {@link diagnosisTools} needs. */
export interface DiagnosisToolsInput {
  readonly layout: WorkspaceLayout
  readonly job: ImprovementJob
  /** The diagnose session. */
  readonly sessionId: string
  /** Tasks whose ledger costs go into `memberCosts`. */
  readonly taskIds: readonly string[]
  readonly state: DiagnosisState
  readonly now?: () => Date
}

/** Write `diagnosis.json` once (exclusive create). */
async function writeDiagnosis(path: string, diagnosis: Diagnosis): Promise<void> {
  const handle = await open(path, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(diagnosis, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * The four tools of a diagnose session. Handlers read through the host
 * (`.nexgent/` is closed to the model's file tools) and never write
 * anything but `diagnosis.json`.
 */
export function diagnosisTools(input: DiagnosisToolsInput): Tool[] {
  const feedback = new SessionFeedbackStore(input.layout, new JsonlSessionStore({ sessionsDir: input.layout.sessions }))
  const readRecords = sessionReader(input.layout)
  const now = input.now ?? (() => new Date())
  const max = IMPROVEMENT_LIMITS.maxDiagnosisAttempts
  return [
    readSessionTool(input.layout),
    readLedgerTool(input.layout),
    {
      definition: definition(IMPROVE_LIST_FEEDBACK_TOOL),
      async handler(raw) {
        const args = raw as { sessionId?: string; deliverableId?: string }
        const entries: readonly FeedbackListing[] = await feedback.list(args)
        const slice = sliceLines(entries)
        return { content: slice.text === '' ? '(no feedback)' : slice.text, meta: { entries: entries.length, truncated: slice.truncated } }
      },
    },
    {
      definition: definition(IMPROVE_REPORT_DIAGNOSIS_TOOL),
      async handler(raw) {
        const state = input.state
        if (state.accepted !== undefined) return { content: 'The diagnosis was already accepted; nothing more to do. End your turn.' }
        if (state.attempts >= max) return { content: `No reports are left (${max} used); the job ends without a diagnosis.`, isError: true }
        state.attempts += 1
        const base = {
          formatVersion: 1 as const,
          jobId: input.job.id,
          createdAt: now().toISOString(),
          sessionId: input.sessionId,
          attempts: state.attempts,
          memberCosts: await memberCostsFor(input.layout, input.taskIds),
        }
        const problems = await checkReport(raw, base, readRecords)
        if (problems.length > 0) {
          state.lastProblems = problems
          const left = max - state.attempts
          return {
            content: `The diagnosis was not accepted (${state.attempts} of ${max} reports used${left === 0 ? '; none left' : `, ${left} left`}). Fix:\n${problems.slice(0, 20).map(problem => `- ${problem}`).join('\n')}`,
            isError: true,
          }
        }
        const diagnosis: Diagnosis = { ...base, ...(raw as DiagnosisReport) }
        await writeDiagnosis(jobPaths(improvementsDir(input.layout), input.job.id).diagnosis, diagnosis)
        state.accepted = diagnosis
        return { content: `Diagnosis accepted (proposalKind ${diagnosis.proposalKind}). End your turn.`, meta: { proposalKind: diagnosis.proposalKind } }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** What the diagnose prompt is about. */
export interface DiagnosisSubject {
  readonly job: ImprovementJob
  /** Feedback entries of the batch (and of the request's deliverable), with their text. */
  readonly feedback: readonly FeedbackListing[]
  /** Sessions to examine, with their task ids when known. */
  readonly sessions: readonly { readonly sessionId: string; readonly taskId?: string }[]
  /** The job's pinned improver, whose diagnosis policy opens the prompt (default `v0`). */
  readonly improver?: ImproverBundle
}

function describeSignal(job: ImprovementJob, feedback: readonly FeedbackListing[]): string[] {
  const lines: string[] = []
  for (const item of job.items) {
    if (item.kind === 'feedback') {
      const entry = feedback.find(listing => listing.id === item.feedbackId)
      const rating = item.rating === undefined ? 'no rating' : `rating ${item.rating}/5`
      lines.push(`- feedback ${item.feedbackId} on deliverable ${item.deliverableId}${item.version === undefined ? '' : ` v${item.version}`} in session ${item.sessionId}${entry === undefined ? '' : ` turn ${entry.turn}`} (${rating}): ${JSON.stringify(entry?.comment ?? '(text not found)')}`)
    } else {
      lines.push(`- failed checks of task ${item.taskId} (session ${item.sessionId}, turn ${item.turn})${item.failedChecks === undefined ? '' : `: ${item.failedChecks.join(', ')}`}`)
    }
  }
  return lines
}

/** The diagnose session's first message. Pure. */
export function diagnosisPrompt(subject: DiagnosisSubject): string {
  const { job } = subject
  const parts = ['# Policy', renderDiagnosisPolicy(subject.improver ?? IMPROVER_V0), '', '# Why this job started', `Trigger: ${job.trigger}.`]
  const signals = describeSignal(job, subject.feedback)
  if (signals.length > 0) parts.push(...signals)
  if (job.request !== undefined) {
    const request = job.request
    parts.push(`The user asked to improve${request.deliverableId === undefined ? '' : ` deliverable ${request.deliverableId}${request.version === undefined ? '' : ` v${request.version}`}`}${request.sessionId === undefined ? '' : ` from session ${request.sessionId}`}${request.taskId === undefined ? '' : ` (task ${request.taskId})`}.`)
    if (request.note !== undefined) parts.push(`Their words: ${JSON.stringify(request.note)}`)
    const extra = subject.feedback.filter(entry => !job.items.some(item => item.kind === 'feedback' && item.feedbackId === entry.id))
    for (const entry of extra) parts.push(`- feedback ${entry.id} on deliverable ${entry.deliverableId} v${entry.version} in session ${entry.sessionId} turn ${entry.turn} (${entry.rating === undefined ? 'no rating' : `rating ${entry.rating}/5`}): ${JSON.stringify(entry.comment)}`)
  }
  parts.push('', '# Sessions to examine')
  if (subject.sessions.length === 0) parts.push('(none named; use improve_list_feedback and the ledger to find them)')
  for (const session of subject.sessions) parts.push(`- session ${session.sessionId}${session.taskId === undefined ? '' : ` (task ${session.taskId})`}`)
  parts.push('', '# Your report', 'Read what you need, then call improve_report_diagnosis with failureTypes, involved (members: "main" for the root conversation), hypothesis (one sentence: which missing capability led to this) and proposalKind.')
  return parts.join('\n')
}

/** The message after a turn that ended without an accepted report. Pure. */
export function diagnosisNudge(state: DiagnosisState): string {
  const left = IMPROVEMENT_LIMITS.maxDiagnosisAttempts - state.attempts
  const problems = state.lastProblems === undefined ? '' : ` The last report was refused for: ${state.lastProblems.slice(0, 10).join('; ')}.`
  return `You ended the turn without an accepted diagnosis.${problems} Call improve_report_diagnosis now (${left} report${left === 1 ? '' : 's'} left).`
}

/** Usage of a sequence of turns. */
export function sumTurns(turns: readonly { readonly usage: LLMUsage; readonly requestCount: number }[]): { readonly usage: LLMUsage; readonly requestCount: number } {
  return { usage: addUsage(...turns.map(turn => turn.usage)), requestCount: turns.reduce((sum, turn) => sum + turn.requestCount, 0) }
}
