import { describe, expect, it } from 'vitest'
import { IMPROVER_V0, renderDiagnosisPolicy, renderImproverText, type Diagnosis, type FailureCategory, type ImprovementJob } from '@nexgent/kernel'
import { diagnosisPrompt, proposalBrief } from '../src/index.js'

/**
 * Step 6 (ADR 0008 decision 1): the built-in improver `v0` is the step-5
 * diagnosis policy and proposal brief as data. These tests pin it to the
 * text `@nexgent/evolve` sends today, so moving evolve onto the improver
 * changes no prompt of a project that never adopted another improver.
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

describe('improver v0 reproduces the step-5 prompts', () => {
  it('diagnosis policy', () => {
    const prompt = diagnosisPrompt({ job, feedback: [], sessions: [] })
    expect(prompt.startsWith(`# Policy\n${renderDiagnosisPolicy(IMPROVER_V0)}\n\n# Why this job started\n`)).toBe(true)
  })

  it('proposal brief, with 0, 2 and 5 failure types, for every kind', () => {
    for (const count of [0, 2, 5]) {
      const failureTypes: Diagnosis['failureTypes'] = Array.from({ length: count }, (_, index) => ({
        category: CATEGORIES[index % CATEGORIES.length] as FailureCategory,
        label: `failure ${index}`,
        evidence: [{ sessionId: 's1', seq: index + 1 }],
      }))
      for (const kind of IMPROVER_V0.proposal.kinds) {
        const diagnosis = { hypothesis: 'No step checks the columns.', proposalKind: kind, failureTypes }
        const failures = failureTypes.slice(0, 4).map(failure => `- ${failure.category}: ${failure.label}`).join('\n')
        const template = IMPROVER_V0.proposal.briefs[kind]
        expect(template, kind).toBeDefined()
        expect(renderImproverText(template ?? '', { jobId: job.id, hypothesis: diagnosis.hypothesis, failures, kind }), `${kind} ${count}`).toBe(proposalBrief(diagnosis, job))
      }
    }
  })
})
