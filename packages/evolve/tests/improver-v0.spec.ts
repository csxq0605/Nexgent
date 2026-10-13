import { describe, expect, it } from 'vitest'
import { IMPROVER_V0, renderDiagnosisPolicy, renderImproverText, type Diagnosis, type FailureCategory, type ImprovementJob } from '@nexgent/kernel'
import { diagnosisPrompt, proposalBrief } from '../src/index.js'

/**
 * Step 6 (ADR 0008 decision 1): `@nexgent/evolve` renders its diagnosis
 * policy and proposal brief from the job's improver, and the built-in `v0`
 * is the step-5 text as data (kept only in the kernel contract). The
 * step-5 prompts are frozen here as they were sent before step 6, so a
 * project that never adopted another improver gets the same prompts word
 * for word.
 */
const TS = '2026-10-13T00:00:00.000Z'
const job: ImprovementJob = {
  formatVersion: 1,
  id: '00000000-0000-4000-8000-000000000001',
  createdAt: TS,
  updatedAt: TS,
  trigger: 'explicit',
  items: [],
  status: 'proposing',
  history: [{ status: 'queued', at: TS }],
  phases: {},
}

const CATEGORIES: readonly FailureCategory[] = ['system-design', 'inter-agent-misalignment', 'task-verification']

// The step-5 text (evolve diagnosis.ts `POLICY` and propose.ts `proposalBrief` before step 6), verbatim.
const STEP5_POLICY = [
  'You are the diagnosis step of Nexgent\'s improvement job. A user worked on tasks in this project and was not satisfied (feedback, failed checks, or an explicit request to improve).',
  'Find out why, using only the read-only tools: read the sessions, the ledger and the feedback. You cannot change files or run anything.',
  'Classify each failure with one category: system-design (the specification or the way the work was set up was wrong or incomplete), inter-agent-misalignment (members of the task worked against or past each other), task-verification (the work was not checked, or ended before it was right).',
  'Cite evidence as {sessionId, seq} of real records (seq is the record\'s position in its session; add turn when you know it).',
  'Then decide whether a reusable capability component would have prevented the problem in future tasks of this kind: a skill (written practice the model loads), a function-module (tools as code), a context-policy (standing instructions), a preset, a team-template or an architecture. A plugin cannot be proposed by an improvement job.',
  'Answer proposalKind "none" when it is not a capability problem: the user changed or added a requirement only for this one deliverable, or the feedback is about taste, not about something future tasks should do.',
  'Report once with improve_report_diagnosis; if the host refuses it, fix exactly what it names and report again.',
].join('\n')

function step5Brief(diagnosis: Pick<Diagnosis, 'hypothesis' | 'proposalKind' | 'failureTypes'>, id: string): string {
  return [
    '# Improvement job',
    `You are redoing a past task in a copy of the project, for improvement job ${id}. The user was not satisfied with how it was done before.`,
    `Diagnosis: ${diagnosis.hypothesis}`,
    ...diagnosis.failureTypes.slice(0, 4).map(failure => `- ${failure.category}: ${failure.label}`),
    '',
    `While you do the task, build one reusable ${diagnosis.proposalKind} component that makes tasks like this come out right without the user having to ask again:`,
    '1. capability_draft it, 2. capability_try it, 3. actually use it in this task (call its tool, load the skill, …) and finish the task with it,',
    '4. then capability_propose exactly that one component. Propose nothing else and nothing more than one component.',
    'A context-policy takes effect from the turn after you try it, and counts as used only once such a turn has completed: try it, finish the task, and do not propose it in the same turn; the host then gives you one turn to check the result under the policy and one more to propose it.',
    'Do not mention the improvement job in the deliverable itself.',
    '',
    '# The task',
  ].join('\n')
}

describe('improver v0 reproduces the step-5 prompts', () => {
  it('diagnosis policy: the kernel rendering and the prompt evolve sends', () => {
    expect(renderDiagnosisPolicy(IMPROVER_V0)).toBe(STEP5_POLICY)
    const prompt = diagnosisPrompt({ job, feedback: [], sessions: [] })
    expect(prompt.startsWith(`# Policy\n${STEP5_POLICY}\n\n# Why this job started\n`)).toBe(true)
    expect(diagnosisPrompt({ job, feedback: [], sessions: [], improver: IMPROVER_V0 })).toBe(prompt)
  })

  it('proposal brief, with 0, 2 and 5 failure types, for every kind', () => {
    expect(IMPROVER_V0.proposal.kinds).toEqual(['skill', 'function-module', 'context-policy', 'preset', 'team-template', 'architecture'])
    for (const count of [0, 2, 5]) {
      const failureTypes: Diagnosis['failureTypes'] = Array.from({ length: count }, (_, index) => ({
        category: CATEGORIES[index % CATEGORIES.length] as FailureCategory,
        label: `failure ${index}`,
        evidence: [{ sessionId: 's1', seq: index + 1 }],
      }))
      for (const kind of IMPROVER_V0.proposal.kinds) {
        const diagnosis = { hypothesis: 'No step checks the columns {{kind}}.', proposalKind: kind, failureTypes }
        const failures = failureTypes.slice(0, 4).map(failure => `- ${failure.category}: ${failure.label}`).join('\n')
        const expected = step5Brief(diagnosis, job.id)
        expect(renderImproverText(IMPROVER_V0.proposal.briefs[kind] ?? '', { jobId: job.id, hypothesis: diagnosis.hypothesis, failures, kind }), `${kind} ${count}`).toBe(expected)
        expect(proposalBrief(diagnosis, job), `${kind} ${count}`).toBe(expected)
        expect(proposalBrief(diagnosis, job, IMPROVER_V0)).toBe(expected)
      }
    }
  })
})
