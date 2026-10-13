/**
 * The tasking package inside the real kernel loop (scripted model, real
 * session and workspace plugins): material → turn with write_file + present
 * (v1) → feedback turn with str_replace + present (v2) → restart → resume,
 * with every record in the order docs/spec/agent-hooks.md fixes.
 */
import { readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  createApp,
  renderFeedbackPrompt,
  type Context,
  type ContextProvider,
  type ContextService,
  type LLMRequest,
  type NexgentApp,
  type SessionRecord,
} from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { createFeedbackEntry, materialAddedRecord, TaskingPlugin, type LocalTaskingService } from '../src/index.js'
import { sha256Of, tempDir } from './helpers.js'

const apps: NexgentApp[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
})

/** A minimal `ctx.context` so the goal provider has somewhere to register. */
function contextPlugin(): { name: string; apply(ctx: Context): void } {
  const providers: ContextProvider[] = []
  const service: ContextService = {
    providers,
    register(provider) {
      providers.push(provider)
      return () => {
        const index = providers.indexOf(provider)
        if (index !== -1) providers.splice(index, 1)
      }
    },
  }
  return { name: 'test-context', apply: ctx => void ctx.provide('context', service) }
}

async function boot(root: string, script: ScriptEntry<LLMRequest>[]): Promise<{ app: NexgentApp; llm: ScriptedProvider; tasking: LocalTaskingService }> {
  const llm = scriptedProvider(script)
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
  apps.push(app)
  await app.ctx.plugin(contextPlugin())
  await app.ctx.plugin(TaskingPlugin)
  return { app, llm, tasking: app.ctx.get('tasking') as LocalTaskingService }
}

/** The deliverable id the latest `present` result in the request names. */
function presentedId(request: LLMRequest): string {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== 'tool' || message.name !== 'present') continue
    const match = /Presented deliverable ([0-9a-f-]{36})/.exec(String(message.content))
    if (match !== null) return match[1]!
  }
  throw new Error('no present result in the request')
}

function types(records: readonly SessionRecord[], turn: number): string[] {
  return records.filter(record => 'turn' in record && record.turn === turn).map(record => record.type)
}

describe('tasking in the kernel loop', () => {
  it('runs material → present v1 → feedback → present v2 → restart, recording everything in order', async () => {
    const base = await tempDir()
    const root = nodePath.join(base, 'proj')
    const source = nodePath.join(base, 'orders.csv')
    await writeFile(source, 'order,region,amount\n1,north,100\n2,south,80\n')

    let feedbackPrompt = ''
    const { app, llm, tasking } = await boot(root, [
      { content: 'Writing the summary.', toolCalls: [{ name: 'write_file', arguments: { path: 'report/summary.csv', content: 'region,total\nnorth,100\nsouth,80\n' } }] },
      { toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: 'Sales by region.' } }] },
      { content: 'Here is the summary.' },
      request => {
        feedbackPrompt = String(request.messages.findLast(message => message.role === 'user')?.content)
        return { toolCalls: [{ name: 'str_replace', arguments: { path: 'report/summary.csv', old_str: 'north,100', new_str: '华北,100' } }] }
      },
      request => ({ toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: 'Chinese region names.', deliverableId: presentedId(request) } }] }),
      { content: 'Updated.' },
    ])

    const agent = await app.agents.create({ title: 'sales' })
    const sessionId = agent.sessionId
    const material = await tasking.materials.add({ sourcePath: source, sessionId })
    await agent.appendHostRecord(materialAddedRecord(material))
    const goal = await tasking.goals.set(agent.appendHostRecord, 'Summarize sales by region')

    const first = await agent.run({ text: 'Summarize the orders by region and give me the result.', materialIds: [material.id] })
    expect(first.reason).toEqual({ kind: 'completed' })
    const system = llm.requests[0]!.messages[0]!
    expect(system.role).toBe('system')
    expect(String(system.content)).toContain('# Current goal\nSummarize sales by region')

    const [deliverable] = await tasking.deliverables.list()
    expect(deliverable!.versions.map(version => version.version)).toEqual([1])
    const v1 = deliverable!.versions[0]!
    const v1Snapshot = tasking.deliverables.snapshotPath(v1.deliverableId, 1, 'report/summary.csv')
    const v1Hash = sha256Of(v1Snapshot)
    expect(v1Hash).toBe(v1.files[0]!.sha256)

    const feedback = await createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, rating: 3, comment: '地区要用中文名' }, tasking.deliverables)
    const second = await agent.run({ source: 'feedback', feedback })
    expect(second.reason).toEqual({ kind: 'completed' })
    expect(feedbackPrompt).toBe(renderFeedbackPrompt(feedback))

    const after = await tasking.deliverables.list()
    expect(after).toHaveLength(1)
    expect(after[0]!.versions.map(version => [version.version, version.turn])).toEqual([[1, 1], [2, 2]])
    expect(sha256Of(v1Snapshot)).toBe(v1Hash)
    const diff = await tasking.deliverables.diff(v1.deliverableId, 1, 2)
    expect(diff.files.map(file => [file.path, file.change])).toEqual([['report/summary.csv', 'modified']])
    expect(diff.files[0]!.hunks![0]!.lines.filter(line => line.op !== 'context')).toEqual([
      { op: 'remove', text: 'north,100' },
      { op: 'add', text: '华北,100' },
    ])

    const { records } = await app.ctx.session.readAll(sessionId)
    // Turn 1 wrote the file before presenting it, so the present request carried the hidden reminder.
    expect(types(records, 1)).toEqual([
      'turn.start', 'user.message', 'assistant.message', 'tool.result', 'user.message',
      'assistant.message', 'deliverable.presented', 'tool.result', 'assistant.message',
      'turn.files', 'turn.end',
    ])
    expect(types(records, 2)).toEqual([
      'turn.start', 'feedback', 'user.message', 'assistant.message', 'tool.result', 'user.message',
      'assistant.message', 'deliverable.presented', 'tool.result', 'assistant.message',
      'turn.files', 'turn.end',
    ])
    const filesRecords = records.filter(record => record.type === 'turn.files')
    expect(filesRecords.map(record => record.type === 'turn.files' && record.changes)).toEqual([
      [{ path: 'report/summary.csv', change: 'added' }],
      [{ path: 'report/summary.csv', change: 'modified' }],
    ])
    const presented = records.filter(record => record.type === 'deliverable.presented')
    expect(presented.map(record => record.type === 'deliverable.presented' && [record.turn, record.step, record.deliverable.version])).toEqual([[1, 2, 1], [2, 2, 2]])
    expect(records.find(record => record.type === 'material.added')).toMatchObject({ material: { id: material.id } })
    expect(records.find(record => record.type === 'user.message' && record.turn === 1)).toMatchObject({ materials: [material.id], source: 'user' })

    await agent.close()
    await app.dispose()
    apps.splice(apps.indexOf(app), 1)

    // Restart: a new process sees everything and can continue the session.
    const restarted = await boot(root, [{ content: 'Still here.' }])
    const resumed = await restarted.app.agents.resume(sessionId)
    expect((await restarted.tasking.materials.list()).map(m => m.id)).toEqual([material.id])
    expect((await restarted.tasking.deliverables.list())[0]!.versions).toHaveLength(2)
    expect(await restarted.tasking.feedback.list({ sessionId })).toEqual([expect.objectContaining({ id: feedback.id, turn: 2, rating: 3 })])
    expect(await restarted.tasking.goals.get(sessionId)).toEqual(goal)
    const third = await resumed.run('Anything left?')
    expect(third.reason).toEqual({ kind: 'completed' })
    expect(String(restarted.llm.requests[0]!.messages[0]!.content)).toContain('# Current goal')
    await resumed.close()
    expect(await readFile(nodePath.join(root, 'report', 'summary.csv'), 'utf8')).toBe('region,total\n华北,100\nsouth,80\n')
  }, 60_000)

  it('rejects present of a missing file with a tool error the model sees', async () => {
    const base = await tempDir()
    const { app, llm } = await boot(nodePath.join(base, 'proj'), [
      { toolCalls: [{ name: 'present', arguments: { paths: ['nope.csv'], summary: 'x' } }] },
      { content: 'ok' },
    ])
    const agent = await app.agents.create({})
    await agent.run('present something')
    const result = llm.requests[1]!.messages.find(message => message.role === 'tool')
    expect(result).toMatchObject({ role: 'tool', name: 'present', isError: true })
    expect(String(result!.content)).toContain('does not exist in the project')
    const { records } = await app.ctx.session.readAll(agent.sessionId)
    expect(records.some(record => record.type === 'deliverable.presented')).toBe(false)
    await agent.close()
  }, 60_000)
})
