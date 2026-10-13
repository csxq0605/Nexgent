/**
 * The real phases of an improvement job (step 5 round 2), built from what
 * the host entry supplies: an {@link ImprovementSessionRunner} for the
 * diagnose and propose sessions, and a {@link TrialStarter} for the gate.
 */
import { IMPROVEMENT_LIMITS, NexgentError, type CapabilityComponentKind, type FeedbackListing } from '@nexgent/kernel'
import { listReplayCases } from '@nexgent/capabilities'
import { JsonlSessionStore } from '@nexgent/session'
import { SessionFeedbackStore } from '@nexgent/tasking'
import { diagnosisNudge, diagnosisPrompt, diagnosisTools, sumTurns, type DiagnosisState } from './diagnosis.js'
import { collectCandidate, contextPolicyCheckText, contextPolicyProposeText, findFeedbackTask, newSessionId, pendingContextPolicies, prepareProposalCopy, proposalBrief, proposeRecords } from './propose.js'
import type { ImprovementStages } from './runner.js'
import type { ImprovementSessionRunner, ImprovementTurnResult } from './session-runner.js'
import { trialSpend, trialStatus, type TrialStarter } from './trial.js'
import type { ImprovementJob } from './types.js'

/** What {@link createImprovementStages} needs. */
export interface ImprovementStagesOptions {
  readonly runner: ImprovementSessionRunner
  readonly startTrial: TrialStarter
  /** Parent directory of the propose copies (default the OS temporary directory). */
  readonly tempRoot?: string
}

function turnFailure(turn: ImprovementTurnResult): string | undefined {
  if (turn.outcome === 'completed') return undefined
  return turn.outcome === 'budget' ? 'a cost cap stopped the session' : `the session ended ${turn.outcome}${turn.detail === undefined ? '' : `: ${turn.detail}`}`
}

/** Sessions and tasks a job looks at: the signals' and the request's. */
async function subjects(layout: Parameters<ImprovementStages['diagnose']>[0]['layout'], job: ImprovementJob): Promise<{ sessions: { sessionId: string; taskId?: string }[]; taskIds: string[] }> {
  const ids = new Set<string>()
  for (const item of job.items) ids.add(item.sessionId)
  if (job.request?.sessionId !== undefined) ids.add(job.request.sessionId)
  const cases = await listReplayCases(layout).catch(() => [])
  const taskIds = new Set<string>()
  for (const item of job.items) if (item.kind === 'check-failure') taskIds.add(item.taskId)
  if (job.request?.taskId !== undefined) taskIds.add(job.request.taskId)
  const sessions = [...ids].map(sessionId => {
    const taskId = cases.find(item => item.sessionId === sessionId)?.caseId
    if (taskId !== undefined) taskIds.add(taskId)
    return { sessionId, ...(taskId === undefined ? {} : { taskId }) }
  })
  return { sessions, taskIds: [...taskIds] }
}

/** Feedback the prompt quotes: the batch's entries and the request's deliverable's. */
async function feedbackOf(layout: Parameters<ImprovementStages['diagnose']>[0]['layout'], job: ImprovementJob): Promise<FeedbackListing[]> {
  const store = new SessionFeedbackStore(layout, new JsonlSessionStore({ sessionsDir: layout.sessions }))
  const wanted = new Set(job.items.flatMap(item => (item.kind === 'feedback' ? [item.feedbackId] : [])))
  const sessions = new Set(job.items.filter(item => item.kind === 'feedback').map(item => item.sessionId))
  if (job.request?.sessionId !== undefined) sessions.add(job.request.sessionId)
  const found: FeedbackListing[] = []
  for (const sessionId of sessions) {
    for (const entry of await store.list({ sessionId }).catch(() => [] as readonly FeedbackListing[])) {
      if (wanted.has(entry.id) || (job.request?.deliverableId !== undefined && entry.deliverableId === job.request.deliverableId)) found.push(entry)
    }
  }
  return found
}

/** Build the phases. */
export function createImprovementStages(options: ImprovementStagesOptions): ImprovementStages {
  return {
    async diagnose(input) {
      const { layout, job, config } = input
      const sessionId = newSessionId()
      const subject = await subjects(layout, job)
      const state: DiagnosisState = { attempts: 0 }
      const tools = diagnosisTools({ layout, job, sessionId, taskIds: subject.taskIds, state })
      await input.record({ sessions: { ...job.sessions, diagnose: sessionId } })
      const session = await options.runner.open({
        jobId: job.id, phase: 'diagnose', sessionId, projectRoot: layout.root, model: config.model, thinking: config.thinking,
        title: `improvement ${job.id} diagnose`, tools,
      })
      const turns: ImprovementTurnResult[] = []
      try {
        let text = diagnosisPrompt({ job, feedback: await feedbackOf(layout, job), sessions: subject.sessions })
        let nudges = 0
        for (;;) {
          const before = state.attempts
          const turn = await session.send(text)
          turns.push(turn)
          await input.log(`diagnose turn: ${turn.outcome}, ${turn.requestCount} requests, reports ${state.attempts}`)
          if (state.accepted !== undefined) break
          const failure = turnFailure(turn)
          if (failure !== undefined) return { ...sumTurns(turns), outcome: 'failed', detail: `The diagnosis stopped: ${failure}.` }
          // A turn that ends without reporting at all uses an attempt too.
          if (state.attempts === before) nudges += 1
          if (state.attempts + nudges >= IMPROVEMENT_LIMITS.maxDiagnosisAttempts) break
          text = diagnosisNudge(state)
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
          error: new NexgentError('improvement/invalid-diagnosis', `no acceptable diagnosis after ${IMPROVEMENT_LIMITS.maxDiagnosisAttempts} attempts`),
          detail: `No acceptable diagnosis after ${IMPROVEMENT_LIMITS.maxDiagnosisAttempts} attempts${state.lastProblems === undefined ? ' (the session did not report one)' : `; last problems: ${state.lastProblems.slice(0, 5).join('; ')}`}.`,
        }
      }
      const diagnosed = { at: accepted.createdAt, proposalKind: accepted.proposalKind, attempts: accepted.attempts }
      if (accepted.proposalKind === 'none') return { ...spend, outcome: 'none', detail: `Not a capability problem: ${accepted.hypothesis}`, patch: { diagnosed } }
      if (accepted.proposalKind === 'plugin') {
        return { ...spend, outcome: 'failed', detail: 'The diagnosis suggests a plugin; an improvement job cannot propose plugins (their approval cannot be asked headless).', patch: { diagnosed } }
      }
      return { ...spend, outcome: 'propose', proposalKind: accepted.proposalKind, diagnosis: accepted, patch: { diagnosed } }
    },

    async propose(input) {
      const { layout, job, config } = input
      const diagnosis = input.diagnosis
      if (diagnosis === undefined) return { usage: sumTurns([]).usage, requestCount: 0, outcome: 'failed', detail: 'The propose phase has no diagnosis.' }
      let task
      try {
        task = await findFeedbackTask(layout, job)
      } catch (error) {
        return { usage: sumTurns([]).usage, requestCount: 0, outcome: 'failed', detail: (error as Error).message }
      }
      const { copy, baseVersion } = await prepareProposalCopy(layout, task, input.budget.remaining, options.tempRoot)
      const sessionId = newSessionId()
      await input.record({ baseVersion, sessions: { ...job.sessions, propose: sessionId } })
      const turns: ImprovementTurnResult[] = []
      try {
        const session = await options.runner.open({
          jobId: job.id, phase: 'propose', sessionId, projectRoot: layout.root, workspaceRoot: copy.root, sandboxMode: task.sandboxMode,
          model: config.model, thinking: config.thinking, title: `improvement ${job.id} propose`,
        })
        try {
          for (const [index, message] of task.messages.entries()) {
            const text = index === 0 ? `${proposalBrief(diagnosis, job)}\n${message.text}` : message.text
            const turn = await session.send(text)
            turns.push(turn)
            await input.log(`propose turn ${index + 1}/${task.messages.length}: ${turn.outcome}, ${turn.requestCount} requests`)
            const failure = turnFailure(turn)
            if (failure !== undefined) return { ...sumTurns(turns), outcome: 'failed', detail: `The propose session stopped: ${failure}.` }
          }
          // A context policy counts as used only after a later turn completed: one turn to check under it, one to propose it.
          const policies = pendingContextPolicies(await proposeRecords(layout, copy, sessionId))
          if (policies.length > 0) {
            for (const [label, text] of [['check', contextPolicyCheckText(policies)], ['propose', contextPolicyProposeText(policies)]] as const) {
              const turn = await session.send(text)
              turns.push(turn)
              await input.log(`propose turn (context policy ${label}): ${turn.outcome}, ${turn.requestCount} requests`)
              const failure = turnFailure(turn)
              if (failure !== undefined) return { ...sumTurns(turns), outcome: 'failed', detail: `The propose session stopped: ${failure}.` }
            }
          }
        } finally {
          await session.close().catch(() => undefined)
        }
        const outcome = await collectCandidate(layout, copy, sessionId, job)
        if (outcome.status === 'failed') return { ...sumTurns(turns), outcome: 'failed', detail: outcome.detail }
        const component = outcome.candidate.components[0]!
        return {
          ...sumTurns(turns),
          outcome: 'candidate',
          candidateId: outcome.candidate.id,
          detail: `Proposed ${component.kind as CapabilityComponentKind} ${component.name}${outcome.imported ? ' (imported from the copy)' : ''}.`,
        }
      } finally {
        await copy.dispose().catch(() => undefined)
      }
    },

    async trial(input) {
      const outcome = await options.startTrial({ layout: input.layout, candidateId: input.candidateId, job: input.job })
      const spend = outcome.status === 'decided' ? await trialSpend(input.layout, outcome.trialId) : sumTurns([])
      const mapped = trialStatus(outcome)
      return {
        ...spend,
        outcome: mapped.status,
        detail: mapped.detail,
        ...(outcome.status === 'decided' ? { trialId: outcome.trialId, decisionId: outcome.decision.id } : {}),
      }
    },
  }
}
