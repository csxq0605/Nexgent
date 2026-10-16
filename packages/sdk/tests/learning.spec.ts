/**
 * Rework E1 through the SDK: with the notice acknowledged, a finished task is
 * self-evaluated (G1) and reflected on in the background (the counting path
 * is off), the entry shows
 * in `handbook.list` / `handbook.show`, and `learning.status` reports the
 * settings and the notice; without the notice nothing is asked of the model.
 */
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProjectLayout, type LLMRequest } from '@nexgent/kernel'
import { testSdk, type TestSdk } from './helpers.js'

const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const TEXT = 'Before editing a configuration file, read it fully and keep its existing comments and ordering.'

/** The background requests, answered by what each asks for: rubric, scores (self-score or calibration), reflection. */
const learner = (request: LLMRequest) => {
  const system = String(request.messages[0]?.content ?? '')
  if (system.includes('grading rubric')) return { content: JSON.stringify({ items: [{ text: 'Verbose logging is enabled in the settings file.', weight: 3 }] }), usage }
  if (system.includes('fixed rubric')) return { content: JSON.stringify({ scores: [{ id: 'r1', score: 1, note: 'Enabled.' }] }), usage }
  return { content: JSON.stringify({ ops: [{ op: 'add', text: TEXT, keywords: ['configuration', 'edit'], scope: 'user' }] }), usage }
}

async function history(t: TestSdk, root: string): Promise<{ items: unknown[]; history: Array<{ status: string; added: string[] }> }> {
  try {
    return JSON.parse(await readFile(nodePath.join(resolveProjectLayout(root, { home: t.home }).dataDir, 'learning', 'queue.json'), 'utf8'))
  } catch {
    return { items: [], history: [] }
  }
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function runOne(t: TestSdk, acknowledge: boolean): Promise<{ projectId: string; root: string }> {
  if (acknowledge) await t.sdk.call('learning.acknowledge', {})
  const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
  const { sessionId } = await t.sdk.call('sessions.create', { projectId: project.projectId })
  await (await t.sdk.startTurn({ projectId: project.projectId, sessionId, text: 'Update the settings file to enable verbose logging' })).done
  return { projectId: project.projectId, root: project.root }
}

describe('layer-1 learning through the SDK', () => {
  it('reflects after a task and lists the entry; learning.status reports settings and notice', async () => {
    const t = await testSdk([{ content: 'done', usage }, learner, learner, learner, learner], { legacyCounting: false })
    const { projectId, root } = await runOne(t, true)
    await until(async () => (await history(t, root)).history.length === 1)
    expect((await history(t, root)).history[0]).toMatchObject({ status: 'done' })
    // Self-evaluation first (rubric, then score), then the reflection.
    const phases = t.providers[0]!.llm.calls.slice(1).map(call => (call.options as { learningPhase?: string } | undefined)?.learningPhase)
    expect(phases.slice(0, 2)).toEqual(['self-eval', 'self-eval'])
    expect(phases.at(-1)).toBe('reflect')
    expect(t.providers[0]!.llm.calls.slice(1).every(call => call.options?.purpose === 'auxiliary')).toBe(true)
    const listing = await t.sdk.call('handbook.list', { projectId })
    expect(listing).toMatchObject({ sharedIncluded: true, entries: [{ text: TEXT, status: 'trial', scope: 'user', retrievable: true }] })
    const detail = await t.sdk.call('handbook.show', { projectId, entryId: listing.entries[0]!.id })
    expect(detail.ops).toEqual([expect.objectContaining({ op: 'add', seq: 1, actor: 'reflection' })])
    await expect(t.sdk.call('handbook.show', { projectId, entryId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'handbook/not-found' })
    expect(await t.sdk.call('learning.status', { projectId })).toMatchObject({
      noticeAcknowledged: true,
      active: true,
      rules: 'adr-0019',
      config: { enabled: true, budget: { maxUsd: 3, windowDays: 30 } },
      budget: { maxUsd: 3, windowDays: 30 },
      selfEvaluations: 1,
      reliability: { status: 'insufficient' },
    })
    expect(t.launched).toEqual([])
  })

  it('asks nothing of the model before the notice is acknowledged', async () => {
    const t = await testSdk([{ content: 'done', usage }], { legacyCounting: false })
    const { projectId, root } = await runOne(t, false)
    await until(async () => (await history(t, root)).items.length === 1)
    expect(t.providers[0]!.llm.calls).toHaveLength(1)
    expect(await t.sdk.call('learning.status', { projectId })).toMatchObject({ noticeAcknowledged: false, active: false })
    expect(await t.sdk.call('handbook.list', { projectId })).toEqual({ entries: [], sharedIncluded: true })
  })
})
