import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ApprovalBrokerService,
  Context,
  type ApprovalDecision,
  type ApprovalGrant,
  type ApprovalRequest,
  type KernelToolContext,
  type LLMUsage,
  RUN_CODE_TOOL,
  type Tool,
  UNKNOWN_USAGE,
} from '../src/index.js'
import { MemoryLedger, MemorySessionStore, sleep, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const writeTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Write a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] },
    effects: ['write'],
    approval: 'ask',
  },
  handler: async input => ({ content: `wrote ${(input as { path: string }).path}` }),
}

const allow = (scope: ApprovalDecision['scope']) => async (request: ApprovalRequest): Promise<ApprovalDecision> =>
  ({ id: request.id, decision: 'allow', scope, decidedBy: 'user' })

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('tool approval in the loop', () => {
  it('asks, records request and decision, and runs on allow once', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), textReply('ok')] })
    const { app, store, ledger } = harness
    app.ctx.tools.register(writeTool)
    const seen: ApprovalRequest[] = []
    app.ctx.approvals.setResponder(async (request, signal) => {
      seen.push(request)
      return allow('once')(request)
    })
    const agent = await app.agents.create()
    await agent.run('write a')
    expect(seen[0]).toMatchObject({ tool: 'write_file', callId: 'c1', summary: 'a.txt', risk: 'low', pattern: 'a.txt', options: ['once', 'session'] })
    expect(store.types(agent.sessionId)).toEqual([
      'session.start', 'turn.start', 'user.message', 'assistant.message',
      'approval.request', 'approval.decision', 'tool.result', 'assistant.message', 'turn.end',
    ])
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: false, content: 'wrote a.txt' })
    expect(ledger.of('tool.call')[0]!.approval).toEqual({ required: true, decision: 'allow', scope: 'once', requestId: seen[0]!.id })
  })

  it('denies with approval/denied when the user says no, and does not ask twice in a turn', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'write_file', { path: 'a.txt' }),
        toolCallReply('c2', 'write_file', { path: 'a.txt' }),
        textReply('gave up'),
      ],
    })
    const { app, store, ledger } = harness
    app.ctx.tools.register(writeTool)
    let asked = 0
    app.ctx.approvals.setResponder(async request => {
      asked += 1
      return { id: request.id, decision: 'deny', scope: 'once', decidedBy: 'user' }
    })
    const agent = await app.agents.create()
    await agent.run('write a')
    expect(asked).toBe(1)
    const results = store.of(agent.sessionId, 'tool.result')
    expect(results.map(result => result.error?.code)).toEqual(['approval/denied', 'approval/denied'])
    expect(ledger.of('tool.call').map(record => record.approval.decision)).toEqual(['deny', 'deny'])
    expect(ledger.of('tool.call')[0]!.durationMs).toBe(0)
  })

  it('denies with decidedBy timeout when no responder is registered', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), textReply('ok')] })
    harness.app.ctx.tools.register(writeTool)
    const agent = await harness.app.agents.create()
    await agent.run('write a')
    expect(harness.store.of(agent.sessionId, 'approval.decision')[0]!.decision).toMatchObject({ decision: 'deny', decidedBy: 'timeout' })
    expect(harness.ledger.of('tool.call')[0]!.approval).toMatchObject({ required: true, decision: 'timeout' })
  })

  it('times out a pending request with the broker deadline and fills expiresAt', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), textReply('ok')],
      patches: [{ id: 'approvals', config: { timeoutMs: 40 } }],
    })
    harness.app.ctx.tools.register(writeTool)
    harness.app.ctx.approvals.setResponder((_request, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ id: 'x', decision: 'allow', scope: 'once', decidedBy: 'user' }))
    }))
    const agent = await harness.app.agents.create()
    await agent.run('write a')
    expect(harness.store.of(agent.sessionId, 'approval.request')[0]!.request.expiresAt).toMatch(/Z$/)
    expect(harness.store.of(agent.sessionId, 'approval.decision')[0]!.decision.decidedBy).toBe('timeout')
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]!.error?.code).toBe('approval/denied')
  })

  it('closes a pending request with decidedBy cancel when the turn is cancelled', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'write_file', { path: 'a.txt' })] })
    harness.app.ctx.tools.register(writeTool)
    harness.app.ctx.approvals.setResponder(() => new Promise(() => {}))
    const agent = await harness.app.agents.create()
    agent.subscribe(event => {
      if (event.type === 'approval.request') agent.cancel()
    })
    const result = await agent.run('write a')
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(harness.store.of(agent.sessionId, 'approval.decision')[0]!.decision.decidedBy).toBe('cancel')
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]!.error?.code).toBe('tool/aborted')
    expect(harness.ledger.of('tool.call')[0]!.approval.decision).toBe('cancel')
  })

  it('reuses a session grant within the session and after resume', async () => {
    const store = new MemorySessionStore()
    const ledger = new MemoryLedger()
    harness = await bootHarness({
      store,
      ledger,
      script: [
        toolCallReply('c1', 'write_file', { path: 'notes.md' }), textReply('one'),
        toolCallReply('c2', 'write_file', { path: 'notes.md' }), textReply('two'),
      ],
    })
    harness.app.ctx.tools.register(writeTool)
    let asked = 0
    const unregister = harness.app.ctx.approvals.setResponder(async request => {
      asked += 1
      return allow('session')(request)
    })
    const agent = await harness.app.agents.create()
    await agent.run('first')
    await agent.run('second')
    expect(asked).toBe(1)
    expect(store.of(agent.sessionId, 'approval.grant')[0]!.grant).toMatchObject({ tool: 'write_file', pattern: 'notes.md' })
    expect(ledger.of('tool.call').map(record => record.approval)).toEqual([
      expect.objectContaining({ decision: 'allow', scope: 'session' }),
      { required: true, decision: 'auto', scope: 'session' },
    ])
    const sessionId = agent.sessionId
    await agent.close()
    unregister()

    // a later process: same store, no responder at all
    harness.llm.push(toolCallReply('c3', 'write_file', { path: 'notes.md' }), textReply('three'))
    const resumed = await harness.app.agents.resume(sessionId)
    expect(resumed.grants()).toHaveLength(1)
    await resumed.run('third')
    expect(asked).toBe(1)
    expect(ledger.of('tool.call').at(-1)!.approval).toEqual({ required: true, decision: 'auto', scope: 'session' })
    expect(store.of(sessionId, 'tool.result').at(-1)).toMatchObject({ isError: false })
  })

  it('writes project grants through the host hook and honours config.json approvals', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), textReply('ok'), toolCallReply('c2', 'write_file', { path: 'a.txt' }), textReply('ok')],
    })
    const { app, ledger, workspace } = harness
    app.ctx.tools.register(writeTool)
    const written: ApprovalGrant[] = []
    app.agents.setProjectGrantWriter(async grant => {
      written.push(grant)
      mkdirSync(workspace.layout.dataDir, { recursive: true })
      writeFileSync(workspace.layout.configFile, JSON.stringify({ approvals: written }))
    })
    let offered: readonly string[] = []
    app.ctx.approvals.setResponder(async request => {
      offered = request.options
      return allow('project')(request)
    })
    const first = await app.agents.create()
    await first.run('write')
    await first.close()
    expect(offered).toEqual(['once', 'session', 'project'])
    expect(written).toEqual([expect.objectContaining({ tool: 'write_file', pattern: 'a.txt' })])

    app.ctx.approvals.setResponder(async () => {
      throw new Error('should not be asked')
    })
    const second = await app.agents.create()
    await second.run('write again')
    expect(ledger.of('tool.call').at(-1)!.approval).toEqual({ required: true, decision: 'auto', scope: 'project' })
  })

  it('denies write tools in read-only mode without asking', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), textReply('ok')] })
    harness.app.ctx.tools.register(writeTool)
    harness.app.ctx.approvals.setResponder(async () => {
      throw new Error('should not be asked')
    })
    const agent = await harness.app.agents.create({ sandboxMode: 'read-only' })
    await agent.run('write')
    expect(harness.store.types(agent.sessionId)).not.toContain('approval.request')
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: true, error: { code: 'sandbox/denied' } })
    expect(harness.ledger.of('tool.call')[0]!.approval).toEqual({ required: false, decision: 'deny' })
    expect(harness.llm.requests[0]!.messages[0]!.content).toContain('read-only')
  })

  it('runs run_code in read-only mode and leaves its writes to the tool\'s own sandbox check', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'run_code', { code: 'return 1' }), textReply('ok')] })
    const modes: string[] = []
    harness.app.ctx.tools.register({
      definition: { ...RUN_CODE_TOOL, description: 'Runs code.' },
      handler: async (_input, context) => {
        modes.push(context.sandboxMode)
        // As @nexgent/ptc's host functions do: reads pass, a write is refused per call.
        return { content: context.sandboxMode === 'read-only' ? 'read ok; write refused: sandbox/denied' : 'read ok; wrote' }
      },
    })
    harness.app.ctx.approvals.setResponder(async () => {
      throw new Error('should not be asked')
    })
    const agent = await harness.app.agents.create({ sandboxMode: 'read-only' })
    await agent.run('compute')
    expect(modes).toEqual(['read-only'])
    expect(harness.store.types(agent.sessionId)).not.toContain('approval.request')
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: false, content: 'read ok; write refused: sandbox/denied' })
    expect(harness.ledger.of('tool.call')[0]!.approval).toEqual({ required: false, decision: 'auto' })
  })

  it('runs ask tools without asking in full-access, but still asks for always tools', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'write_file', { path: 'a.txt' }), toolCallReply('c2', 'sudo', {}), textReply('ok')],
    })
    harness.app.ctx.tools.register(writeTool)
    harness.app.ctx.tools.register({
      definition: { ...writeTool.definition, name: 'sudo', effects: ['execute'], approval: 'always', inputSchema: { type: 'object' } },
      handler: async () => ({ content: 'root' }),
    })
    const requests: ApprovalRequest[] = []
    harness.app.ctx.approvals.setResponder(async request => {
      requests.push(request)
      return allow('session')(request)
    })
    const agent = await harness.app.agents.create({ sandboxMode: 'full-access' })
    await agent.run('go')
    expect(requests.map(request => [request.tool, request.risk, request.options])).toEqual([['sudo', 'high', ['once']]])
    expect(harness.store.of(agent.sessionId, 'approval.decision')[0]!.decision.scope).toBe('once')
  })

  it('lets a tool escalate one call through requestApproval', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'bash', { command: 'pnpm install left-pad' }), textReply('ok')] })
    harness.app.ctx.tools.register({
      definition: {
        name: 'bash',
        description: 'Run a command.',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        effects: ['execute', 'write', 'network'],
        approval: 'never',
      },
      handler: async (input, context) => {
        const command = (input as { command: string }).command
        const ok = await (context as KernelToolContext).requestApproval({
          summary: command,
          subject: { kind: 'command', value: command },
          detail: 'matched: package install',
        })
        return ok ? { content: 'installed' } : { content: 'Error: not approved', isError: true }
      },
    })
    harness.app.ctx.approvals.setResponder(allow('once'))
    const agent = await harness.app.agents.create()
    await agent.run('install')
    expect(harness.store.of(agent.sessionId, 'approval.request')[0]!.request).toMatchObject({
      tool: 'bash', summary: 'pnpm install left-pad', pattern: 'pnpm install', risk: 'medium', detail: 'matched: package install',
    })
    expect(harness.ledger.of('tool.call')[0]!.approval).toMatchObject({ required: true, decision: 'allow', scope: 'once' })
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]!.content).toBe('installed')
  })
})

describe('ApprovalBrokerService', () => {
  const request: ApprovalRequest = {
    id: 'r1', sessionId: 's', callId: 'c', tool: 't', summary: 'x', risk: 'low', options: ['once', 'session'],
  }

  async function broker(config: { timeoutMs?: number } = {}) {
    const ctx = new Context()
    await ctx.plugin(ApprovalBrokerService, config)
    return { ctx, approvals: ctx.approvals }
  }

  it('drops late answers and aborts the responder signal once settled', async () => {
    const { ctx, approvals } = await broker({ timeoutMs: 20 })
    let responderSignal: AbortSignal | undefined
    let answer: ((decision: ApprovalDecision) => void) | undefined
    approvals.setResponder((_r, signal) => {
      responderSignal = signal
      return new Promise(resolve => { answer = resolve })
    })
    const decision = await approvals.request(request, new AbortController().signal)
    expect(decision).toMatchObject({ decision: 'deny', decidedBy: 'timeout', scope: 'once' })
    expect(responderSignal?.aborted).toBe(true)
    answer?.({ id: 'r1', decision: 'allow', scope: 'once', decidedBy: 'user' })
    await sleep(5)
    await ctx.fiber.dispose()
  })

  it('keeps a single responder; a replaced responder cannot unregister the new one', async () => {
    const { approvals } = await broker()
    const offFirst = approvals.setResponder(async r => ({ id: r.id, decision: 'deny', scope: 'once', decidedBy: 'user' }))
    approvals.setResponder(async r => ({ id: r.id, decision: 'allow', scope: 'session', decidedBy: 'user' }))
    offFirst()
    expect(await approvals.request(request, new AbortController().signal)).toMatchObject({ decision: 'allow', scope: 'session' })
  })

  it('normalizes answers: id, deny scope and unoffered scopes', async () => {
    const { approvals } = await broker()
    approvals.setResponder(async () => ({ id: 'other', decision: 'allow', scope: 'project', decidedBy: 'user' }))
    expect(await approvals.request(request, new AbortController().signal)).toEqual({ id: 'r1', decision: 'allow', scope: 'once', decidedBy: 'user' })
    approvals.setResponder(async () => ({ id: 'r1', decision: 'deny', scope: 'session', decidedBy: 'headless' }))
    expect(await approvals.request(request, new AbortController().signal)).toEqual({ id: 'r1', decision: 'deny', scope: 'once', decidedBy: 'headless' })
  })

  it('cancels on abort and denies immediately for an aborted signal or a throwing responder', async () => {
    const { approvals } = await broker()
    const aborted = AbortSignal.abort()
    approvals.setResponder(() => new Promise(() => {}))
    expect((await approvals.request(request, aborted)).decidedBy).toBe('cancel')
    const controller = new AbortController()
    const pending = approvals.request(request, controller.signal)
    controller.abort()
    expect((await pending).decidedBy).toBe('cancel')
    approvals.setResponder(async () => {
      throw new Error('tty closed')
    })
    expect(await approvals.request(request, new AbortController().signal)).toMatchObject({ decision: 'deny', decidedBy: 'timeout' })
  })
})

describe('cost caps', () => {
  function writeConfig(root: string, value: unknown) {
    mkdirSync(join(root, '.nexgent'), { recursive: true })
    writeFileSync(join(root, '.nexgent', 'config.json'), JSON.stringify(value))
  }

  it('stops before the request that would exceed perTask.maxRequests', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'echo', {}), toolCallReply('c2', 'echo', {}), textReply('never sent')],
    })
    writeConfig(harness.root, { costCaps: { perTask: { maxRequests: 2 } } })
    harness.app.ctx.tools.register({
      definition: { name: 'echo', description: 'e', inputSchema: { type: 'object' }, effects: ['read'], approval: 'never' },
      handler: async () => ({ content: 'ok' }),
    })
    const agent = await harness.app.agents.create()
    const result = await agent.run('loop')
    expect(harness.llm.requests).toHaveLength(2)
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    const [error] = harness.store.of(agent.sessionId, 'error')
    expect(error).toMatchObject({
      turn: 1,
      fatal: false,
      error: { code: 'budget/exhausted', details: { scope: 'task', metric: 'requests', used: 2, limit: 2 } },
    })
    expect(harness.store.types(agent.sessionId).slice(-2)).toEqual(['error', 'turn.end'])
    const outcomes = harness.ledger.of('task.outcome')
    expect(outcomes).toEqual([expect.objectContaining({ status: 'cancelled', requestCount: 2, error: expect.objectContaining({ code: 'budget/exhausted' }) })])
    await agent.close()
    expect(harness.ledger.of('task.outcome')).toHaveLength(1)
  })

  it('counts input + output tokens against perTask.maxTokens', async () => {
    harness = await bootHarness({ script: [textReply('a'), textReply('b')] })
    writeConfig(harness.root, { costCaps: { perTask: { maxTokens: 15 } } })
    const agent = await harness.app.agents.create()
    expect((await agent.run('one')).reason).toEqual({ kind: 'completed' })
    expect((await agent.run('two')).reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(harness.llm.requests).toHaveLength(1)
    expect(harness.store.of(agent.sessionId, 'error')[0]!.error.details).toEqual({ scope: 'task', metric: 'tokens', used: 15, limit: 15 })
  })

  /** Ledger records of one model request by another task, `daysAgo` days back. */
  function seedRequest(ledger: MemoryLedger, daysAgo: number, used: LLMUsage | 'unknown' = usage(10, 5)): void {
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
    const common = { ts, sessionId: 'other', requestId: `r-${ledger.records.length}`, provider: 'anthropic', endpoint: 'https://example.invalid', model: 'm' }
    ledger.records.push(
      { ...common, type: 'llm.request.start', purpose: 'task', thinking: 'on' },
      { ...common, type: 'llm.request.end', status: 'ok', usage: used === 'unknown' ? UNKNOWN_USAGE : used, latencyMs: 1 },
    )
  }

  it('stops before the request that would exceed perProject.maxRequests, counting the ledger window', async () => {
    const ledger = new MemoryLedger()
    seedRequest(ledger, 1)
    seedRequest(ledger, 29, 'unknown')
    seedRequest(ledger, 31) // outside the default 30-day window
    harness = await bootHarness({ ledger, script: [toolCallReply('c1', 'echo', {}), textReply('never sent')] })
    writeConfig(harness.root, { costCaps: { perProject: { maxRequests: 3 } } })
    harness.app.ctx.tools.register({
      definition: { name: 'echo', description: 'e', inputSchema: { type: 'object' }, effects: ['read'], approval: 'never' },
      handler: async () => ({ content: 'ok' }),
    })
    const agent = await harness.app.agents.create()
    const result = await agent.run('loop')
    expect(harness.llm.requests).toHaveLength(1)
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(harness.store.of(agent.sessionId, 'error')[0]).toMatchObject({
      turn: 1,
      fatal: false,
      error: { code: 'budget/exhausted', details: { scope: 'project', metric: 'requests', used: 3, limit: 3 } },
    })
    expect(harness.store.types(agent.sessionId).slice(-2)).toEqual(['error', 'turn.end'])
    expect(ledger.of('task.outcome')).toEqual([expect.objectContaining({
      status: 'cancelled',
      requestCount: 1,
      error: expect.objectContaining({ code: 'budget/exhausted', details: { scope: 'project', metric: 'requests', used: 3, limit: 3 } }),
    })])
  })

  it('counts known ledger tokens against perProject.maxTokens within windowDays', async () => {
    const ledger = new MemoryLedger()
    seedRequest(ledger, 2, usage(10, 5))
    seedRequest(ledger, 2, 'unknown')
    seedRequest(ledger, 6, usage(100, 100)) // outside windowDays: 5
    harness = await bootHarness({ ledger, script: [textReply('never sent')] })
    writeConfig(harness.root, { costCaps: { perProject: { maxTokens: 15, windowDays: 5 } } })
    const agent = await harness.app.agents.create()
    expect((await agent.run('one')).reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(harness.llm.requests).toHaveLength(0)
    expect(harness.store.of(agent.sessionId, 'error')[0]!.error.details).toEqual({ scope: 'project', metric: 'tokens', used: 15, limit: 15 })
  })

  it('re-reads the ledger each turn, so other sessions\' requests count', async () => {
    const ledger = new MemoryLedger()
    harness = await bootHarness({ ledger, script: [textReply('a'), textReply('never sent')] })
    writeConfig(harness.root, { costCaps: { perProject: { maxRequests: 2 } } })
    const agent = await harness.app.agents.create()
    expect((await agent.run('one')).reason).toEqual({ kind: 'completed' })
    seedRequest(ledger, 0)
    seedRequest(ledger, 0)
    expect((await agent.run('two')).reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(harness.llm.requests).toHaveLength(1)
    expect(harness.store.of(agent.sessionId, 'error')[0]!.error.details).toEqual({ scope: 'project', metric: 'requests', used: 2, limit: 2 })
  })

  it('sends no request and ends the turn with a readable error when the ledger cannot be read', async () => {
    const ledger = new MemoryLedger()
    ledger.read = async function* () {
      throw new Error('disk gone')
    }
    harness = await bootHarness({ ledger, script: [textReply('never sent')] })
    writeConfig(harness.root, { costCaps: { perProject: { maxRequests: 1 } } })
    const agent = await harness.app.agents.create()
    const result = await agent.run('one')
    expect(harness.llm.requests).toHaveLength(0)
    expect(result.reason).toMatchObject({
      kind: 'error',
      error: { message: expect.stringMatching(/per-project cost cap cannot be checked.*disk gone.*no model request was sent/) },
    })
    await agent.close()
    expect(ledger.records.filter(record => record.type === 'task.outcome')).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('rejects an invalid config.json at agent creation', async () => {
    harness = await bootHarness()
    writeConfig(harness.root, { sandboxMode: 'yolo' })
    await expect(harness.app.agents.create()).rejects.toMatchObject({ code: 'config/invalid' })
  })
})
