/**
 * The `workflow` tool with a fake member runner: records, `parallel` /
 * `pipeline` / `phase` / `log`, the concurrency and member bounds, member
 * failure, cancellation, graphs, and recovery planning.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COLLABORATION_LIMITS, WORKFLOW_TOOL, type SessionRecord } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { planWorkflowRecovery, workflowTool } from '../src/index.js'
import { FakeRunner, ofType, workflowContext } from './helpers.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('workflow tool', () => {
  it('uses the contract name, schema, effects and approval', () => {
    const tool = workflowTool({ runner: new FakeRunner().run })
    expect(tool.definition).toMatchObject({ name: 'workflow', inputSchema: WORKFLOW_TOOL.inputSchema, effects: ['read'], approval: 'never' })
  })

  it('runs parallel members then a pipeline summary member, and records the run in order', async () => {
    const runner = new FakeRunner(request => ({ delayMs: 60, files: [`out/${request.name}/part.md`] }))
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({
      title: 'two parts',
      script: `
        phase('research')
        const parts = await parallel([
          () => agent('Research part A', { name: 'part-a', files: ['data/a.csv'] }),
          () => agent('Research part B', { name: 'part-b', preset: 'read-only-analyst' }),
        ])
        phase('summary')
        const [summary] = await pipeline([parts], async results => agent('Summarize: ' + results.map(r => r.text).join('; '), { name: 'summary' }))
        log('parts', parts.length)
        return { summary: summary.text, files: summary.deliverables[0].files.map(f => f.path), args }`,
      args: { year: 2026 },
    }, context)
    expect(output.isError).toBe(false)
    expect(output.content).toMatch(/^Workflow "two parts" completed: 3 members \(3 completed\)\./)
    expect(output.content).toContain('"summary": "summary done"')
    expect(output.content).toContain('"year": 2026')
    expect(output.content).toContain('Log:\nparts 2')
    expect(output.content).toContain('Files: out/part-a/part.md')
    // Concurrent: both parallel members were running at once.
    expect(runner.peak).toBe(2)
    expect(runner.requests.map(request => request.name)).toEqual(['part-a', 'part-b', 'summary'])
    expect(runner.requests[0]).toMatchObject({ parentSessionId: 'parent-session', files: ['data/a.csv'], turn: 3, toolCallId: 'call-1' })
    expect(runner.requests[1]?.preset).toBe('read-only-analyst')
    expect(runner.requests[2]?.task).toBe('Summarize: part-a done; part-b done')

    const start = ofType(records, 'workflow.start')
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ turn: 3, toolCallId: 'call-1', kind: 'script', title: 'two parts' })
    const workflowId = start[0]!.workflowId
    expect(workflowId).toMatch(UUID_V4)
    expect(ofType(records, 'workflow.phase').map(record => record.phase)).toEqual(['research', 'summary'])
    expect(ofType(records, 'subagent.start').every(record => record.workflowId === workflowId && record.executionForm === 'workflow')).toBe(true)
    expect(ofType(records, 'subagent.end').map(record => record.result.status)).toEqual(['completed', 'completed', 'completed'])
    expect(ofType(records, 'workflow.end')).toEqual([expect.objectContaining({ turn: 3, workflowId, status: 'completed', members: 3 })])
    expect(records[0]?.type).toBe('workflow.start')
    expect(records.at(-1)?.type).toBe('workflow.end')
    expect(output.meta).toMatchObject({ workflowId, status: 'completed', members: [{ name: 'part-a' }, { name: 'part-b' }, { name: 'summary' }] })
  })

  it('runs members truly in parallel but never more than the concurrency bound', async () => {
    const runner = new FakeRunner(() => ({ delayMs: 80 }))
    const { context, records } = await workflowContext()
    const started = Date.now()
    const output = await workflowTool({ runner: runner.run }).handler({
      script: `return (await parallel(Array.from({ length: 6 }, (_, i) => () => agent('task ' + i, { name: 'w' })))).map(r => r.name)`,
    }, context)
    expect(output.isError).toBe(false)
    expect(runner.peak).toBe(COLLABORATION_LIMITS.maxConcurrentMembers)
    // Six 80 ms members in waves of four take two waves, not six.
    expect(Date.now() - started).toBeLessThan(6 * 80)
    // Repeated names get a suffix.
    expect(runner.requests.map(request => request.name)).toEqual(['w', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6'])
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'completed', members: 6 })
  })

  it('refuses the member after the bound and ends failed, keeping the started members', async () => {
    const runner = new FakeRunner()
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run, maxMembers: 3 }).handler({
      script: `for (let i = 0; i < 4; i++) await agent('task ' + i)`,
    }, context)
    expect(output.isError).toBe(true)
    expect(output.content).toContain('failed')
    expect(output.content).toContain('a workflow starts at most 3 members; this is agent() call 4')
    expect(runner.requests).toHaveLength(3)
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'failed', members: 3 })
    expect(COLLABORATION_LIMITS.maxMembersPerTask).toBe(16)
  })

  it('ends failed with a readable error when a member fails, and keeps what the others completed', async () => {
    const runner = new FakeRunner(request => request.name === 'bad' ? { status: 'failed', delayMs: 10 } : { delayMs: 50, files: [`out/${request.name}.md`] })
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({
      script: `
        const results = await parallel([() => agent('good work', { name: 'good' }), () => agent('bad work', { name: 'bad' })])
        await agent('never reached', { name: 'after' })`,
    }, context)
    expect(output.isError).toBe(true)
    expect(output.content).toContain('Error: member bad failed: bad could not finish')
    expect(output.content).toContain('## good (completed')
    expect(output.content).toContain('Files: out/good.md')
    expect(runner.requests.map(request => request.name)).toEqual(['good', 'bad'])
    const ends = ofType(records, 'subagent.end')
    expect(ends.map(record => record.result.status).sort()).toEqual(['completed', 'failed'])
    expect(ends.find(record => record.result.status === 'completed')?.result.deliverables[0]?.files[0]?.path).toBe('out/good.md')
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'failed', error: { message: 'member bad failed: bad could not finish' } })
  })

  it('a member failure the script catches leaves the workflow to the script: it completes, and the member shows as failed', async () => {
    const runner = new FakeRunner(request => request.name === 'poor' ? { status: 'budget' } : { delayMs: 10, files: [`out/${request.name}.md`] })
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({
      script: `
        const done = []
        for (const name of ['good', 'poor', 'fine']) {
          try { done.push((await agent('work', { name })).name) } catch (error) { done.push('skipped ' + name) }
        }
        return done`,
    }, context)
    expect(output.isError).toBe(false)
    expect(output.content).toContain('## poor (budget')
    expect(output.content).toContain('skipped poor')
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'completed', members: 3 })
    expect(ofType(records, 'workflow.end')[0]).not.toHaveProperty('error')
    expect(ofType(records, 'subagent.end').map(record => record.result.status)).toEqual(['completed', 'budget', 'completed'])
  })

  it('reports a member that cannot start without recording it', async () => {
    const runner = new FakeRunner(() => ({ startError: 'unknown preset "nope"; presets: general-executor' }))
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({ script: `await agent('x', { preset: 'nope' })` }, context)
    expect(output.isError).toBe(true)
    expect(output.content).toContain('member member-1 could not start: unknown preset "nope"')
    expect(ofType(records, 'subagent.start')).toHaveLength(0)
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'failed', members: 0 })
  })

  it('reports script errors and bad hook arguments', async () => {
    const { context } = await workflowContext()
    const tool = workflowTool({ runner: new FakeRunner().run })
    const thrown = await tool.handler({ script: 'throw new Error("plan changed")' }, context)
    expect(thrown.content).toContain('Error: the workflow script failed: plan changed')
    const syntax = await tool.handler({ script: 'return (' }, context)
    expect(syntax.content).toContain('the workflow script failed')
    const badOption = await tool.handler({ script: `await agent('x', { effort: 'max' })` }, context)
    expect(badOption.content).toContain('agent() does not take effort')
    const badName = await tool.handler({ script: `await agent('x', { name: 'Bad Name' })` }, context)
    expect(badName.content).toContain('agent() name "Bad Name" must be lowercase')
    const badPhase = await tool.handler({ script: `phase('')` }, context)
    expect(badPhase.content).toContain('phase() takes a title')
    const badParallel = await tool.handler({ script: `await parallel([1])` }, context)
    expect(badParallel.content).toContain('parallel() item 0 is not a function')
    await expect(tool.handler({ script: 'return 1', graph: { nodes: [] } }, context)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tool.handler({}, context)).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('is refused to members and to hosts without tool records', async () => {
    const tool = workflowTool({ runner: new FakeRunner().run })
    const member = await workflowContext({ member: true })
    await expect(tool.handler({ script: 'return 1' }, member.context)).rejects.toMatchObject({ code: 'tool/denied' })
    const plain = await workflowContext()
    const { appendRecord: _drop, ...noRecords } = plain.context
    await expect(tool.handler({ script: 'return 1' }, noRecords)).rejects.toMatchObject({ code: 'tool/failed' })
  })

  it('cancels the script and its running members, then ends cancelled', async () => {
    const runner = new FakeRunner(request => request.name === 'quick' ? { delayMs: 5 } : { hang: true })
    const controller = new AbortController()
    const { context, records } = await workflowContext({ signal: controller.signal })
    const pending = workflowTool({ runner: runner.run }).handler({
      script: `await agent('q', { name: 'quick' }); await parallel([() => agent('a', { name: 'slow-a' }), () => agent('b', { name: 'slow-b' })])`,
    }, context)
    while (runner.active < 2) await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    const output = await pending
    expect(output.isError).toBe(true)
    expect(output.meta).toMatchObject({ status: 'cancelled' })
    expect(runner.cancelled.sort()).toEqual(['slow-a', 'slow-b'])
    expect(ofType(records, 'subagent.end').map(record => record.result.status)).toEqual(['completed', 'cancelled', 'cancelled'])
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'cancelled', members: 3 })
  })

  it('cancels members a script left running when it returned', async () => {
    const runner = new FakeRunner(() => ({ hang: true }))
    const { context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({ script: `agent('forgotten', { name: 'orphan' }); await new Promise(r => setTimeout(r, 50)); return 'early'` }, context)
    expect(output.isError).toBe(true)
    expect(runner.cancelled).toEqual(['orphan'])
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'failed', members: 1 })
  })

  it('saves a graph, runs it in dependency order and records its version', async () => {
    const runner = new FakeRunner()
    const { root, context, records } = await workflowContext()
    const output = await workflowTool({ runner: runner.run }).handler({
      title: 'three nodes',
      graph: { nodes: [
        { id: 'report', prompt: 'Write the report', dependencies: ['north', 'south'] },
        { id: 'north', prompt: 'Analyze north', dependencies: [] },
        { id: 'south', prompt: 'Analyze south', dependencies: [], preset: 'read-only-analyst' },
      ] },
    }, context)
    expect(output.isError).toBe(false)
    const start = ofType(records, 'workflow.start')[0]!
    expect(start).toMatchObject({ kind: 'graph', title: 'three nodes' })
    expect(start.architecture).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(join(root, '.nexgent', 'architectures', `${start.architecture!}.json`))).toBe(true)
    expect(output.content).toContain(`Graph saved as .nexgent/architectures/${start.architecture!}.json`)
    expect(runner.requests.map(request => request.name).slice(0, 2).sort()).toEqual(['north', 'south'])
    expect(runner.requests[2]?.name).toBe('report')
    expect(runner.requests[2]?.task).toContain('Result of north:\nnorth done')
    expect(runner.requests.find(request => request.name === 'south')?.preset).toBe('read-only-analyst')
    // Rework K4 (audit D10): the graph's result repeats its nodes' replies, so it is not shown a second time.
    expect(output.content).not.toContain('Result:')
    expect(output.content).toContain('## north (completed, member id ')
  })

  it('refuses a cyclic graph before anything is saved, run or recorded', async () => {
    const runner = new FakeRunner()
    const { root, context, records } = await workflowContext()
    await expect(workflowTool({ runner: runner.run }).handler({
      graph: { nodes: [{ id: 'a', prompt: 'a', dependencies: ['b'] }, { id: 'b', prompt: 'b', dependencies: ['a'] }] },
    }, context)).rejects.toThrow('graph: dependency cycle among a, b')
    expect(runner.requests).toHaveLength(0)
    expect(records).toHaveLength(0)
    expect(existsSync(join(root, '.nexgent', 'architectures'))).toBe(false)
  })
})

describe('workflow recovery planning', () => {
  const base = { sessionId: 'p', ts: '2026-10-11T00:00:00.000Z' }
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 'unknown', cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } as const
  const records = [
    { ...base, seq: 10, type: 'workflow.start', turn: 2, toolCallId: 'c', workflowId: 'w1', kind: 'script' },
    { ...base, seq: 11, type: 'subagent.start', turn: 2, childSessionId: 'a', childTurn: 1, name: 'a', executionForm: 'workflow', workflowId: 'w1', task: 'a' },
    { ...base, seq: 12, type: 'subagent.start', turn: 2, childSessionId: 'b', childTurn: 1, name: 'b', executionForm: 'workflow', workflowId: 'w1', task: 'b' },
    { ...base, seq: 13, type: 'subagent.end', turn: 2, childSessionId: 'a', childTurn: 1, result: { status: 'completed', text: 'a', deliverables: [], usage, requestCount: 1 } },
    { ...base, seq: 14, type: 'workflow.start', turn: 1, toolCallId: 'd', workflowId: 'w0', kind: 'graph', architecture: 'f'.repeat(64) },
    { ...base, seq: 15, type: 'workflow.end', turn: 1, workflowId: 'w0', status: 'completed', members: 0 },
  ] as unknown as SessionRecord[]

  it('closes only the open workflow, counting its started members', () => {
    expect(planWorkflowRecovery(records)).toEqual([
      { type: 'workflow.end', turn: 2, workflowId: 'w1', status: 'interrupted', members: 2, error: { name: 'NexgentError', code: 'internal', message: expect.stringContaining('not resumed') } },
    ])
    expect(planWorkflowRecovery(records.slice(4))).toEqual([])
  })
})
