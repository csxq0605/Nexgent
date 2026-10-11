/**
 * Step 3 members against the real JSONL store and ledger: a hard kill while
 * a forked member runs, and the attribution the ledger stamps on records
 * written outside an agent's loop.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createApp,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type Context,
  type LLMProvider,
  type LLMStreamEvent,
  type ApprovalRequest,
  type NexgentApp,
  type Plugin,
  type Workspace,
} from '@nexgent/kernel'
import { JsonlLedger, JsonlSessionStore, SessionPlugin } from '../src/index.js'
import { KNOWN_USAGE, tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/member-crash-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

function workspace(root: string): Workspace {
  const layout = resolveWorkspaceLayout(root)
  return {
    root,
    layout,
    resolve: input => (input.startsWith('/') ? input : `${root}/${input}`),
    relative: absolute => absolute.slice(root.length + 1),
    sessionDir: id => `${layout.sessions}/${id}`,
    ensureLayout: async () => {
      mkdirSync(layout.sessions, { recursive: true })
    },
  }
}

const llm: LLMProvider = {
  info: { id: 'anthropic', endpoint: 'https://example.invalid', defaultModel: 'scripted-model' },
  complete: () => (async function* (): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'text.delta', text: 'ok' }
    yield { type: 'usage', usage: KNOWN_USAGE }
    yield { type: 'done', finishReason: 'stop' }
  })(),
}

function boot(root: string, provider: LLMProvider = llm): Promise<NexgentApp> {
  const registry: Record<string, Plugin> = {
    '@nexgent/llm': { name: 'test-llm', apply: (ctx: Context) => { ctx.provide('llm', provider) } },
    '@nexgent/session': SessionPlugin as unknown as Plugin,
    '@nexgent/workspace': { name: 'test-workspace', apply: (ctx: Context) => { ctx.provide('workspace', workspace(root)) } },
  }
  return createApp({ registry })
}

function runChild(root: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, root], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', reject)
    child.on('exit', code => resolve({ stdout, code }))
  })
}

describe('members with JsonlSessionStore', () => {
  it('recovers the parent and a forked member after a hard kill mid-run', async () => {
    const root = await tempDir()
    const result = await runChild(root)
    const match = /^ids (\S+) (\S+)$/m.exec(result.stdout)
    expect(match, result.stdout).not.toBeNull()
    expect(result.code === 0).toBe(false)
    const [, parentId, memberId] = match!

    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const { records: parentRecords } = await store.readAll(parentId!)
    const parentEnd = parentRecords.find(record => record.type === 'turn.end')!
    const { records: before } = await store.readAll(memberId!)
    expect(before.map(record => record.type)).toEqual(['session.start', 'fork.seed', 'turn.start', 'user.message'])
    expect(before[0]).toMatchObject({ parentSessionId: parentId, member: { name: 'helper', executionForm: 'delegated' } })
    expect(before[1]).toMatchObject({ seq: 2, fromSessionId: parentId, throughSeq: parentEnd.seq })

    const app = await boot(root)
    try {
      const parent = await app.agents.resume(parentId!)
      const parentState = await store.resume(parentId!)
      const member = await app.agents.resume(memberId!, { child: { parentSessionId: parentId! } })
      expect(member.parentSessionId).toBe(parentId)
      expect(member.attribution).toEqual({ taskId: parent.attribution.taskId, memberId, executionForm: 'delegated' })
      // The fork history is the parent's projection; the interrupted turn's user message follows it.
      expect(member.history()).toEqual([...parentState.messages, { role: 'user', content: 'member task' }])
      expect(parentState.messages.map(message => message.content)).toEqual(['turn one', 'first answer'])
      await member.close()
      await parent.close()
    } finally {
      await app.dispose()
    }
    const { records: after } = await store.readAll(memberId!)
    const ends = after.filter(record => record.type === 'turn.end')
    expect(ends.map(record => record.type === 'turn.end' && record.reason)).toEqual([{ kind: 'interrupted' }])
    const state = await store.resume(memberId!)
    expect(state.metadata).toMatchObject({ parentSessionId: parentId, member: { name: 'helper', executionForm: 'delegated' } })
  })

  it('writes a member approval request through the validating store', async () => {
    const root = await tempDir()
    // First request: a write_env call; after its result: a text answer.
    const writer: LLMProvider = {
      info: llm.info,
      complete: request => (async function* (): AsyncGenerator<LLMStreamEvent> {
        if (request.messages.at(-1)?.role === 'tool') {
          yield { type: 'text.delta', text: 'done' }
          yield { type: 'usage', usage: KNOWN_USAGE }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        yield { type: 'tool-call.start', index: 0, id: 'w1', name: 'write_env' }
        yield { type: 'tool-call.delta', index: 0, argumentsDelta: '{"path":".env"}' }
        yield { type: 'tool-call.end', index: 0, call: { id: 'w1', name: 'write_env', arguments: '{"path":".env"}' } }
        yield { type: 'usage', usage: KNOWN_USAGE }
        yield { type: 'done', finishReason: 'tool-calls' }
      })(),
    }
    const app = await boot(root, writer)
    const seen: ApprovalRequest[] = []
    let parentId = ''
    let memberId = ''
    try {
      app.ctx.tools.register({
        definition: { name: 'write_env', description: 'Writes .env.', inputSchema: { type: 'object', properties: {} }, effects: ['write'], approval: 'ask' },
        handler: async () => ({ content: 'written' }),
      })
      app.ctx.approvals.setResponder(async request => {
        seen.push(request)
        return { id: request.id, decision: 'deny', scope: 'once', decidedBy: 'user' }
      })
      const parent = await app.agents.create()
      const member = await app.agents.create({ child: { parentSessionId: parent.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
      parentId = parent.sessionId
      memberId = member.sessionId
      const result = await member.run('write the env file')
      expect(result.reason).toEqual({ kind: 'completed' })
      await member.close()
      await parent.close()
    } finally {
      await app.dispose()
    }
    expect(seen.map(request => request.member)).toEqual([{ name: 'helper', executionForm: 'delegated', parentSessionId: parentId }])
    const { records } = await new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) }).readAll(memberId)
    const request = records.find(record => record.type === 'approval.request')
    expect(request?.type === 'approval.request' && request.request).toMatchObject({ sessionId: memberId, tool: 'write_env', member: seen[0]!.member })
    const result = records.find(record => record.type === 'tool.result')
    expect(result).toMatchObject({ name: 'write_env', isError: true })
  })

  it('stamps the open agent attribution on ledger records written outside its loop', async () => {
    const root = await tempDir()
    const app = await boot(root)
    try {
      const parent = await app.agents.create()
      const member = await app.agents.create({ child: { parentSessionId: parent.sessionId, member: { name: 'mate', executionForm: 'team' } } })
      await parent.run('go')
      // A host's own outcome (as the SDK writes it) and an auxiliary request (as a compactor's provider writes it).
      await app.ctx.ledger.append({ type: 'task.outcome', sessionId: parent.sessionId, status: 'completed', totalUsage: ZERO_USAGE, requestCount: 1, toolCallCount: 0, turns: 1, toolsUsed: [] })
      await app.ctx.ledger.append({ type: 'llm.request.start', sessionId: member.sessionId, requestId: 'r1', provider: 'anthropic', endpoint: 'x', model: 'm', purpose: 'auxiliary', thinking: 'on' })
      await app.ctx.ledger.append({ type: 'llm.request.start', requestId: 'r2', provider: 'anthropic', endpoint: 'x', model: 'm', purpose: 'auxiliary', thinking: 'on' })
      await member.close()
      await parent.close({ skipOutcome: true })
    } finally {
      await app.dispose()
    }
    const records = []
    for await (const record of new JsonlLedger({ layout: resolveWorkspaceLayout(root) }).read()) records.push(record)
    const outcome = records.find(record => record.type === 'task.outcome' && record.memberId === 'main')
    expect(outcome).toMatchObject({ executionForm: 'direct', formsUsed: ['direct', 'team'] })
    const aux = records.filter(record => record.type === 'llm.request.start' && record.purpose === 'auxiliary')
    expect(aux.map(record => [record.memberId, record.executionForm])).toEqual([[expect.any(String), 'team'], [undefined, undefined]])
    expect(new Set(records.filter(record => record.taskId !== undefined).map(record => record.taskId)).size).toBe(1)
  })
})
