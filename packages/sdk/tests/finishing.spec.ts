// Rework D3: turn cost, cost warnings, the data location and waiting for learning.
import * as nodePath from 'node:path'
import { resolveProjectLayout } from '@nexgent/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { SdkEvent } from '../src/index.js'
import { testSdk, waitForEvent } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

async function oneTurn(t: Awaited<ReturnType<typeof testSdk>>, projectId: string, sessionId: string, text = 'hi'): Promise<void> {
  await t.sdk.call('turns.send', { projectId, sessionId, text })
  await vi.waitFor(() => expect(t.sdk.isRunning(projectId, sessionId)).toBe(false))
}

describe('turn cost', () => {
  it('turn.end carries the dollars the provider priced, and the history prices each turn', async () => {
    const t = await testSdk([{ content: 'ok', usage }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    t.providers[0]!.llm.estimateUsd = () => 0.5
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await oneTurn(t, project.projectId, session.sessionId)
    const end = t.eventsOf(session.sessionId).find(event => event.type === 'turn.end') as Extract<SdkEvent, { type: 'turn.end' }>
    expect(end.cost).toEqual({ usd: 0.5, estimated: false })
    const view = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: session.sessionId })
    const item = view.items.find(i => i.kind === 'turn.end') as Extract<(typeof view.items)[number], { kind: 'turn.end' }>
    // Priced from the session's model with the price table (claude-sonnet-5-5: 100 in, 10 out).
    expect(item.cost?.estimated).toBe(false)
    expect(item.cost?.usd).toBeGreaterThan(0)
    expect(item.cost?.usd).toBeLessThan(0.01)
  })
})

describe('cost warnings', () => {
  it('maps the kernel warning to a project-level cost.warning event', async () => {
    const t = await testSdk([{ content: 'ok', usage }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    await t.sdk.call('settings.update', { projectId: project.projectId, patch: { costCaps: { perTask: { maxTokens: 120 } } } })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await oneTurn(t, project.projectId, session.sessionId)
    const event = (await waitForEvent(t, e => e.type === 'cost.warning')) as Extract<SdkEvent, { type: 'cost.warning' }>
    expect(event.projectId).toBe(project.projectId)
    expect(event.warning).toMatchObject({ scope: 'perTask', level: 'warning', limit: 'maxTokens', used: 110, cap: 120, estimated: false, triggerSessionId: session.sessionId })
    expect(typeof event.warning.ts).toBe('string')
  })
})

describe('data location', () => {
  it('settings name the project data folder, which the host can reveal', async () => {
    const revealed: string[] = []
    const t = await testSdk([], { reveal: async path => void revealed.push(path) })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const settings = await t.sdk.call('settings.get', { projectId: project.projectId })
    const layout = resolveProjectLayout(project.root, { home: t.home })
    expect(settings.dataDir).toBe(layout.dataDir)
    expect((await t.sdk.call('settings.update', { projectId: project.projectId, patch: { thinking: 'off' } })).dataDir).toBe(layout.dataDir)
    await t.sdk.call('projects.revealData', { projectId: project.projectId })
    expect(revealed).toEqual([layout.dataDir])
  })

  it('revealing needs the host hook', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    await expect(t.sdk.call('projects.revealData', { projectId: project.projectId })).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('waiting for learning', () => {
  it('is idle at once when nothing is learning, even with a stopped signal', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    expect(t.sdk.learningBusy(project.projectId)).toBe(false)
    expect(await t.sdk.waitForLearning(project.projectId)).toBe('idle')
    const controller = new AbortController()
    controller.abort()
    expect(await t.sdk.waitForLearning(project.projectId, controller.signal)).toBe('idle')
  })
})
