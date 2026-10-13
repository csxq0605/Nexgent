/**
 * The propose phase (`data-formats.md` §改进作业 提议; decision 3 A): redo
 * the feedback task in a copy of its snapshot, in a propose session with the
 * ordinary task tools and `capability_draft / try / propose`, so the one
 * component the job proposes has been used successfully at least once
 * (step 4's rule, enforced by `capability_propose`).
 *
 * - The task: the first feedback signal's session (else a failed check's,
 *   else the explicit request's), found among the project's replayable
 *   tasks (a snapshot with a tree and checks). Its user messages before the
 *   first feedback turn are replayed; the first one is preceded by the
 *   job's brief (the diagnosis' hypothesis and the suggested kind).
 * - The copy: `prepareReplayProject` with the adopted version, the
 *   remaining improvement budget as the per-task cap, automatic trials off.
 * - The candidate: exactly one, proposed by the propose session, with one
 *   component that is not a plugin. It is taken from the real project when
 *   the runner routed it there, else imported from the copy, and carries
 *   `origin: improvement` and the job id either way. No candidate means the
 *   proposal failed (spec: "没有提出候选就结束的提议记为 failed").
 * - A context policy counts as used only after a turn that follows its try
 *   has completed (step 4's rule, unchanged). When the replayed turns end
 *   with a context policy tried but nothing proposed, the session gets two
 *   more turns: one to check the deliverable under the policy, one to
 *   propose it ({@link pendingContextPolicies}).
 */
import { randomUUID } from 'node:crypto'
import {
  BASELINE_VERSION,
  IMPROVER_V0,
  NexgentError,
  renderImproverText,
  type CandidateRecord,
  type CapabilityComponentRef,
  type CapabilityComponentKind,
  type ImproverBundle,
  type ProposableKind,
  type SandboxMode,
  type SessionRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import {
  CANDIDATES_DIR,
  CapabilityStore,
  componentPath,
  listCandidates,
  listReplayCases,
  loadBundle,
  prepareReplayProject,
  readComponentDirectory,
  writeCandidate,
  type ReplayCase,
  type ReplayProject,
} from '@nexgent/capabilities'
import { JsonlSessionStore } from '@nexgent/session'
import { join } from 'node:path'
import type { Diagnosis, ImprovementJob } from './types.js'

/** The task a job redoes. */
export interface FeedbackTask {
  readonly replay: ReplayCase
  /** Turn of the first feedback in that session; replay stops before it (absent: no feedback, replay every user turn). */
  readonly firstFeedbackTurn?: number
  /** User messages to replay, in order. */
  readonly messages: readonly { readonly text: string; readonly materialIds?: readonly string[] }[]
  readonly sandboxMode: SandboxMode
}

/** The session the job redoes: feedback first, then a failed check, then the explicit request. */
export function targetSession(job: ImprovementJob): string | undefined {
  const feedback = job.items.find(item => item.kind === 'feedback')
  if (feedback !== undefined) return feedback.sessionId
  if (job.request?.sessionId !== undefined) return job.request.sessionId
  return job.items.find(item => item.kind === 'check-failure')?.sessionId
}

const NARROW: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }

/**
 * Find the feedback task and what to replay.
 * @throws `improvement/not-found` when the session is not a replayable task (no snapshot with checks, e.g. a task from before step 4).
 */
export async function findFeedbackTask(layout: WorkspaceLayout, job: ImprovementJob): Promise<FeedbackTask> {
  const sessionId = targetSession(job)
  const taskId = job.request?.taskId ?? job.items.find(item => item.kind === 'check-failure')?.taskId
  const cases = await listReplayCases(layout)
  const replay = cases.find(item => (sessionId !== undefined && item.sessionId === sessionId) || (taskId !== undefined && item.caseId === taskId))
  if (replay === undefined) {
    throw new NexgentError('improvement/not-found', `the task to redo (session ${sessionId ?? '?'}) has no snapshot with checks; tasks from before step 4, or without checks, cannot be redone`)
  }
  const records: readonly SessionRecord[] = (await new JsonlSessionStore({ sessionsDir: layout.sessions }).readAll(replay.sessionId)).records
  const firstFeedback = records.find(record => record.type === 'feedback')
  const firstFeedbackTurn = firstFeedback === undefined ? undefined : (firstFeedback as { readonly turn: number }).turn
  const messages: { text: string; materialIds?: readonly string[] }[] = []
  for (const record of records) {
    if (record.type !== 'user.message' || record.source !== 'user') continue
    if (firstFeedbackTurn !== undefined && record.turn >= firstFeedbackTurn) continue
    messages.push({ text: record.content, ...(record.materials === undefined || record.materials.length === 0 ? {} : { materialIds: [...record.materials] }) })
  }
  if (messages.length === 0) throw new NexgentError('improvement/not-found', `session ${replay.sessionId} has no user message before its first feedback`)
  const start = records[0]
  const original: SandboxMode = start?.type === 'session.start' ? start.sandboxMode : 'workspace-write'
  const sandboxMode: SandboxMode = NARROW[original] <= NARROW['workspace-write'] ? original : 'workspace-write'
  return { replay, ...(firstFeedbackTurn === undefined ? {} : { firstFeedbackTurn }), messages, sandboxMode }
}

/**
 * The brief that precedes the redone task's first message: the pinned
 * improver's brief template for the diagnosed kind (default `v0`, step 5's
 * text verbatim). Pure.
 * @throws `improver/invalid` when the improver has no brief for the kind.
 */
export function proposalBrief(diagnosis: Pick<Diagnosis, 'hypothesis' | 'proposalKind' | 'failureTypes'>, job: ImprovementJob, improver: ImproverBundle = IMPROVER_V0): string {
  const kind = diagnosis.proposalKind as CapabilityComponentKind
  const template = improver.proposal.briefs[kind as ProposableKind]
  if (template === undefined) throw new NexgentError('improver/invalid', `the improver has no proposal brief for ${kind}`)
  return renderImproverText(template, {
    jobId: job.id,
    hypothesis: diagnosis.hypothesis,
    failures: diagnosis.failureTypes.slice(0, 4).map(failure => `- ${failure.category}: ${failure.label}`).join('\n'),
    kind,
  })
}

/**
 * Context policies the propose session tried while it proposed nothing yet:
 * they need a further completed turn before `capability_propose` accepts
 * them. Pure over the session's records.
 */
export function pendingContextPolicies(records: readonly SessionRecord[]): CapabilityComponentRef[] {
  if (records.some(record => record.type === 'capability.propose')) return []
  const tried = new Map<string, CapabilityComponentRef>()
  for (const record of records) {
    if (record.type === 'capability.try' && record.component.kind === 'context-policy') tried.set(record.component.name, record.component)
  }
  return [...tried.values()]
}

/** The propose session's records, from the real project or else the copy (empty when neither has them). */
export async function proposeRecords(layout: WorkspaceLayout, copy: ReplayProject | undefined, sessionId: string): Promise<readonly SessionRecord[]> {
  for (const sessionsDir of [layout.sessions, ...(copy === undefined ? [] : [join(copy.root, '.nexgent', 'sessions')])]) {
    try {
      return (await new JsonlSessionStore({ sessionsDir }).readAll(sessionId)).records
    } catch {
      // not here
    }
  }
  return []
}

/** The turn that checks the deliverable under a tried context policy (it must complete before the policy counts as used). */
export function contextPolicyCheckText(policies: readonly CapabilityComponentRef[]): string {
  const names = policies.map(policy => policy.name).join(', ')
  return `The context policy ${names} is in effect now. Check the deliverable of the task against what the task asked, under this policy, and fix anything that is off. Do not call capability_try or capability_propose in this turn (trying it again would restart the wait).`
}

/** The turn that proposes the tried context policy. */
export function contextPolicyProposeText(policies: readonly CapabilityComponentRef[]): string {
  const names = policies.map(policy => policy.name).join(', ')
  return `A turn under the context policy ${names} has completed, so it counts as used. Now call capability_propose with exactly that one component (kind context-policy) and nothing else.`
}

/** The candidate a propose session produced, after the job's checks. */
export type ProposalOutcome =
  | { readonly status: 'candidate'; readonly candidate: CandidateRecord; readonly imported: boolean }
  | { readonly status: 'failed'; readonly detail: string }

/** Candidates of one session in a capabilities directory. */
async function candidatesOf(capabilitiesDir: string, sessionId: string): Promise<CandidateRecord[]> {
  return (await listCandidates(capabilitiesDir)).filter(candidate => candidate.sessionId === sessionId)
}

/**
 * Pick and check the propose session's candidate: from the real project, or
 * imported from the copy (rewritten with `origin: improvement` and the job id
 * over the same base version).
 */
export async function collectCandidate(layout: WorkspaceLayout, copy: ReplayProject | undefined, sessionId: string, job: ImprovementJob): Promise<ProposalOutcome> {
  const real = await candidatesOf(layout.capabilities, sessionId)
  const copied = copy === undefined ? [] : await candidatesOf(join(copy.root, '.nexgent', 'capabilities'), sessionId)
  const found = real.length > 0 ? real : copied
  if (found.length === 0) return { status: 'failed', detail: 'The propose session ended without a candidate: no component was used successfully after it was tried, so nothing could be proposed.' }
  if (found.length > 1) return { status: 'failed', detail: `The propose session proposed ${found.length} candidates; an improvement job proposes exactly one.` }
  const candidate = found[0]!
  if (candidate.components.length !== 1) return { status: 'failed', detail: `The candidate has ${candidate.components.length} components; an improvement job proposes exactly one.` }
  if (candidate.components[0]!.kind === 'plugin' || candidate.requiresApproval) return { status: 'failed', detail: 'The candidate is a plugin; an improvement job cannot propose plugins (their approval cannot be asked headless).' }
  if (real.length > 0) {
    if (candidate.origin !== 'improvement' || candidate.jobId !== job.id) return { status: 'failed', detail: `Candidate ${candidate.id} is not marked as this job's (origin ${candidate.origin ?? 'session'}).` }
    return { status: 'candidate', candidate, imported: false }
  }
  // Import from the copy: same components and proofs, base bundle from the real project.
  const copyCapabilities = join(copy!.root, '.nexgent', 'capabilities')
  const component = candidate.components[0]!
  const files = await readComponentDirectory(componentPath(join(copyCapabilities, CANDIDATES_DIR, candidate.id), component))
  const base = await loadBundle(layout.capabilities, candidate.base)
  const { record } = await writeCandidate(layout.capabilities, {
    sessionId: candidate.sessionId,
    taskId: candidate.taskId,
    turn: candidate.turn,
    base,
    components: [{ kind: component.kind, name: component.name, files }],
    proofs: candidate.proofs,
    ...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
    origin: 'improvement',
    jobId: job.id,
  })
  return { status: 'candidate', candidate: record, imported: true }
}

/** Prepare the copy the propose session works in (adopted version, remaining budget as the per-task cap). */
export async function prepareProposalCopy(layout: WorkspaceLayout, task: FeedbackTask, remainingTokens: number, tempRoot?: string): Promise<{ readonly copy: ReplayProject; readonly baseVersion: string }> {
  const baseVersion = (await new CapabilityStore(layout.capabilities).activation()).version ?? BASELINE_VERSION
  const copy = await prepareReplayProject({
    layout,
    replay: task.replay,
    version: baseVersion,
    budget: { maxTokens: Math.max(1, remainingTokens) },
    ...(tempRoot === undefined ? {} : { tempRoot }),
  })
  return { copy, baseVersion }
}

/** A fresh session id. */
export function newSessionId(): string {
  return randomUUID()
}
