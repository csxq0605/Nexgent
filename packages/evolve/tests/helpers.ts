import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach } from 'vitest'
import { resolveWorkspaceLayout, ZERO_USAGE, type FeedbackListing, type WorkspaceLayout } from '@nexgent/kernel'
import type { ImprovementStages } from '../src/index.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

// ADR 0012: the user's improvers, meta queue and config live in the Nexgent home; every test gets its own.
beforeEach(async () => {
  process.env.NEXGENT_HOME = await tempDir()
})

/** The test's Nexgent home. */
export function home(): string {
  return process.env.NEXGENT_HOME!
}

/** Write the test home's user config (`<home>/config.json`). */
export async function userConfig(meta: Record<string, unknown>): Promise<void> {
  await writeFile(join(home(), 'config.json'), `${JSON.stringify({ version: 1, improvement: { meta } })}\n`)
}

/** A fresh directory removed after the test. */
export async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexgent-evolve-'))
  created.push(path)
  return path
}

/** A project with `.nexgent/config.json` (autoImprove and `improvement` as given). */
export async function project(autoImprove: boolean | undefined = true, improvement?: Record<string, unknown>): Promise<WorkspaceLayout> {
  const layout = resolveWorkspaceLayout(await tempDir())
  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(layout.configFile, `${JSON.stringify({ version: 1, ...(autoImprove === undefined ? {} : { autoImprove }), ...(improvement === undefined ? {} : { improvement }) })}\n`)
  return layout
}

/** A feedback listing as `ctx.tasking.feedback.list` returns it. */
export function feedback(input: Partial<FeedbackListing> = {}): FeedbackListing {
  return {
    id: randomUUID(),
    deliverableId: randomUUID(),
    version: 1,
    comment: 'the summary is missing the region column',
    sessionId: randomUUID(),
    turn: 2,
    submittedAt: new Date(Date.now() + 1_000).toISOString(),
    ...input,
  }
}

/** Stages that always reach the given end (spending `tokens` per phase). */
export function stagesTo(end: 'none' | 'diagnose-failed' | 'propose-failed' | 'adopted' | 'rejected' | 'waiting-history', tokens = 100): ImprovementStages {
  const usage = { ...ZERO_USAGE, inputTokens: tokens, totalTokens: tokens }
  return {
    async diagnose() {
      if (end === 'none') return { usage, requestCount: 1, outcome: 'none', detail: 'a change of requirements, not a missing capability' }
      if (end === 'diagnose-failed') return { usage, requestCount: 1, outcome: 'failed', detail: 'the diagnosis broke the schema 3 times' }
      return { usage, requestCount: 1, outcome: 'propose', proposalKind: 'skill' }
    },
    async propose() {
      if (end === 'propose-failed') return { usage, requestCount: 2, outcome: 'failed', detail: 'the component never ran successfully' }
      return { usage, requestCount: 2, outcome: 'candidate', candidateId: '11111111-1111-4111-8111-111111111111' }
    },
    async trial() {
      return { usage, requestCount: 3, outcome: end as 'adopted' | 'rejected' | 'waiting-history', trialId: '22222222-2222-4222-8222-222222222222', ...(end === 'adopted' ? { decisionId: '33333333-3333-4333-8333-333333333333' } : {}) }
    },
  }
}
