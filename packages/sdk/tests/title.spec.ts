/**
 * Rework D2: the interface language in the user settings, and the title a
 * conversation gets after its first turn (`autoTitle`), announced with a
 * `session.title` event like a rename.
 */
import * as nodePath from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SESSION_TITLE_PROMPT, type LLMRequest } from '@nexgent/kernel'
import type { SdkEvent } from '../src/index.js'
import { cleanTitle } from '../src/title.js'
import { testSdk } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('the interface language', () => {
  it('is stored in the user config, read back, and removed with null', async () => {
    const t = await testSdk([])
    expect((await t.sdk.call('userSettings.get', {})).language).toBeUndefined()
    expect(await t.sdk.call('userSettings.update', { patch: { language: 'en' } })).toMatchObject({ language: 'en' })
    expect(JSON.parse(await readFile(nodePath.join(t.home, 'config.json'), 'utf8'))).toMatchObject({ version: 1, language: 'en' })
    await expect(t.sdk.call('userSettings.update', { patch: { language: 'english please' } })).rejects.toMatchObject({ code: 'config/invalid' })
    const cleared = await t.sdk.call('userSettings.update', { patch: { language: null } })
    expect(cleared.language).toBeUndefined()
    expect(JSON.parse(await readFile(nodePath.join(t.home, 'config.json'), 'utf8')).language).toBeUndefined()
  })
})

describe('the title after the first turn', () => {
  const titler = (request: LLMRequest) => {
    expect(request.messages[0]).toEqual({ role: 'system', content: SESSION_TITLE_PROMPT })
    expect(request.thinking).toBe('off')
    return { content: '“9 月订单按地区汇总”。', usage }
  }

  it('names an untitled conversation once, in the ledger, and announces it', async () => {
    const t = await testSdk([{ content: 'done', usage }, titler, { content: 'again', usage }], { autoTitle: true, legacyCounting: false })
    const events: SdkEvent[] = []
    t.sdk.subscribe(event => events.push(event))
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const { sessionId } = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await (await t.sdk.startTurn({ projectId: project.projectId, sessionId, text: '把 9 月的订单按地区汇总成一张表' })).done
    await until(() => events.some(event => event.type === 'session.title'))
    expect(events.find(event => event.type === 'session.title')).toMatchObject({ sessionId, title: '9 月订单按地区汇总' })
    expect((await t.sdk.call('sessions.list', { projectId: project.projectId }))[0]).toMatchObject({ title: '9 月订单按地区汇总' })
    const titleCall = t.providers[0]!.llm.calls[1]!
    expect(titleCall.options).toMatchObject({ sessionId, purpose: 'auxiliary' })
    // The second turn asks for no other title.
    await (await t.sdk.startTurn({ projectId: project.projectId, sessionId, text: '再按客户分一次' })).done
    expect(t.providers[0]!.llm.calls).toHaveLength(3)
    await t.sdk.dispose()
  })

  it('keeps a title the conversation already has, and is off unless asked for', async () => {
    const titled = await testSdk([{ content: 'done', usage }], { autoTitle: true, legacyCounting: false })
    const project = await titled.sdk.call('projects.open', { root: nodePath.join(titled.base, 'p'), create: true })
    const { sessionId } = await titled.sdk.call('sessions.create', { projectId: project.projectId, title: '我的标题' })
    await (await titled.sdk.startTurn({ projectId: project.projectId, sessionId, text: '整理 README' })).done
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(titled.providers[0]!.llm.calls).toHaveLength(1)
    await titled.sdk.dispose()

    const off = await testSdk([{ content: 'done', usage }], { legacyCounting: false })
    const other = await off.sdk.call('projects.open', { root: nodePath.join(off.base, 'p'), create: true })
    const created = await off.sdk.call('sessions.create', { projectId: other.projectId })
    await (await off.sdk.startTurn({ projectId: other.projectId, sessionId: created.sessionId, text: '整理 README' })).done
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(off.providers[0]!.llm.calls).toHaveLength(1)
    await off.sdk.dispose()
  })

  it('announces a rename with the same event', async () => {
    const t = await testSdk([])
    const events: SdkEvent[] = []
    t.sdk.subscribe(event => events.push(event))
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const { sessionId } = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('sessions.rename', { projectId: project.projectId, sessionId, title: '六月订单' })
    expect(events.filter(event => event.type === 'session.title')).toEqual([expect.objectContaining({ sessionId, title: '六月订单' })])
  })

  it('cleans what the model replies into one short line', () => {
    expect(cleanTitle('Title: "Monthly sales summary".\nExtra')).toBe('Monthly sales summary')
    expect(cleanTitle('标题：《订单汇总》')).toBe('订单汇总')
    expect(cleanTitle('  \n ')).toBeUndefined()
    expect([...cleanTitle('长'.repeat(80))!]).toHaveLength(40)
  })
})
