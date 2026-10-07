import { describe, expect, it, vi } from 'vitest'
import { compileArchitecture, prepareArchitecture, prepareOutputTrialArchitecture, resolveWorkflowBody } from '../src/architecture.ts'

const worker = { id: 'worker', role: 'researcher', prompt: 'Find evidence', dependencies: [] }
const reviewer = { id: 'reviewer', role: 'reviewer', prompt: 'Check evidence', dependencies: ['worker'] }
type AgentHook = (prompt: string, options?: Record<string, unknown>) => Promise<unknown>
interface GraphResult { architectureVersion: string; outputs: Record<string, unknown> }
const AsyncFunction = (Object.getPrototypeOf(async () => {}) as {
  constructor: new (...parts: string[]) => (agent: AgentHook, args: unknown) => Promise<GraphResult>
}).constructor

function parsePrompt(prompt: string): { task: string; dependencies: unknown[] } {
  const value: unknown = JSON.parse(prompt)
  if (value === null || typeof value !== 'object'
    || !('task' in value) || typeof value.task !== 'string'
    || !('dependencies' in value) || !Array.isArray(value.dependencies)) throw new Error('Invalid member prompt')
  return { task: value.task, dependencies: value.dependencies }
}

describe('native workflow architecture', () => {
  it('retains the definition identity while a host output trial disables member global tools', async () => {
    const graph = { nodes: [{ ...worker, toolFilter: { allow: ['write'] } }, reviewer] }
    const ordinary = prepareArchitecture(graph)
    const trial = prepareOutputTrialArchitecture(graph)
    expect(trial.version).toBe(ordinary.version)
    expect(trial.architecture).toEqual(ordinary.architecture)
    const masks: unknown[] = []
    await new AsyncFunction('agent', 'args', trial.script)(async (_prompt, options) => {
      masks.push(options?.toolFilter)
      return 'actual output'
    }, {})
    expect(masks).toEqual([{ allow: [] }, { allow: [] }])
    expect(ordinary.script).not.toBe(trial.script)
  })
  it('starts a dependant when its own input is ready while unrelated work remains active', async () => {
    const slow = Promise.withResolvers<string>()
    const calls: string[] = []
    const nodes = [
      { ...worker, id: 'slow', prompt: 'slow' },
      { ...worker, id: 'fast', prompt: 'fast' },
      { ...reviewer, id: 'next', prompt: 'next', dependencies: ['fast'] },
      { ...reviewer, id: 'other', prompt: 'other', dependencies: ['fast'] },
    ]
    const pending = new AsyncFunction('agent', 'args', compileArchitecture({ nodes }))(async (prompt) => {
      const task = parsePrompt(prompt).task
      calls.push(task)
      return task === 'slow' ? slow.promise : task
    }, {})
    try {
      await vi.waitFor(() => { expect(calls).toContain('next'); expect(calls).toContain('other') })
      expect(calls.filter(task => task === 'fast')).toHaveLength(1)
    } finally {
      slow.resolve('slow')
      await pending
    }
  })
  it('passes actual dependency outputs and preserves a content version across input order', async () => {
    const calls: { task: string; dependencies: unknown[] }[] = []
    const script = compileArchitecture({ nodes: [reviewer, worker] })
    expect(script).toBe(compileArchitecture({ nodes: [worker, reviewer] }))
    const result = await new AsyncFunction('agent', 'args', script)(async (prompt: string) => {
      calls.push(parsePrompt(prompt))
      return calls.length === 1 ? 'verified evidence' : 'review complete'
    }, { material: 'source' })
    expect(calls[1]?.dependencies).toEqual([{ id: 'worker', output: 'verified evidence' }])
    expect(result.outputs).toEqual({ worker: 'verified evidence', reviewer: 'review complete' })
    expect(result.architectureVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(compileArchitecture({ nodes: [{ ...worker, prompt: 'Changed task' }, reviewer] })).not.toBe(script)
  })

  it('rejects invalid topology and ambiguous execution before any child starts', () => {
    expect(() => compileArchitecture({ nodes: [worker, worker] })).toThrow('unique')
    expect(() => compileArchitecture({ nodes: [reviewer] })).toThrow('unknown dependency')
    expect(() => compileArchitecture({ nodes: [{ ...worker, dependencies: ['reviewer'] }, reviewer] })).toThrow('cycle')
    expect(() => resolveWorkflowBody('return 1', { nodes: [worker] })).toThrow('exactly one')
    expect(() => resolveWorkflowBody(undefined, undefined)).toThrow('exactly one')
    expect(resolveWorkflowBody('return 1', undefined)).toBe('return 1')
    expect(resolveWorkflowBody(undefined, { nodes: [worker] })).toBe(compileArchitecture({ nodes: [worker] }))
  })

  it.each([
    null, [], {}, { nodes: [] }, { nodes: [null] }, { nodes: [worker], unknown: true },
    { nodes: [{ ...worker, unknown: true }] }, { nodes: [{ ...worker, prompt: ' ' }] },
    { nodes: [{ ...worker, dependencies: null }] }, { nodes: [{ ...reviewer, dependencies: ['worker', 'worker'] }] },
    { nodes: [{ ...worker, provider: '' }] }, { nodes: [{ ...worker, model: 2 }] },
    { nodes: [{ ...worker, schema: { type: 'string' } }] },
    { nodes: [{ ...worker, persona: ' ' }] }, { nodes: [{ ...worker, persona: 7 }] },
    { nodes: [{ ...worker, toolFilter: {} }] }, { nodes: [{ ...worker, toolFilter: { allow: ['read', 7] } }] },
    { nodes: [{ ...worker, schema: { type: 'object', properties: { count: { type: 'number', minimum: 0 } } } }] },
  ])('rejects malformed graph data %j at compilation', (input) => {
    expect(() => compileArchitecture(input)).toThrow()
  })

  it('passes structured outputs, routes and hostile text as data through the existing agent hook', async () => {
    const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] }
    const first = { ...worker, id: '__proto__', prompt: '"; throw new Error("injected"); //', provider: 'mimo', model: 'mimo-v2.6-pro', schema,
      persona: 'You are the independent reviewer in {{cwd}}.', toolFilter: { allow: ['write', 'read', 'read'], deny: ['edit'] } }
    const second = { ...reviewer, dependencies: [first.id] }
    const calls: { prompt: string; options: unknown }[] = []
    const result = await new AsyncFunction('agent', 'args', compileArchitecture({ nodes: [second, first] }))(
      async (prompt: string, options: unknown) => { calls.push({ prompt, options }); return { count: 3 } }, {},
    )
    expect(calls[0]?.options).toMatchObject({ label: first.id, provider: first.provider, model: first.model, schema,
      persona: first.persona, toolFilter: { allow: ['read', 'write'], deny: ['edit'] } })
    expect(compileArchitecture({ nodes: [first] })).toBe(compileArchitecture({ nodes: [{ ...first, toolFilter: { deny: ['edit'], allow: ['read', 'write'] } }] }))
    expect(compileArchitecture({ nodes: [first] })).not.toBe(compileArchitecture({ nodes: [{ ...first, persona: 'Changed persona' }] }))
    expect(compileArchitecture({ nodes: [first] })).not.toBe(compileArchitecture({ nodes: [{ ...first, toolFilter: { allow: [] } }] }))
    expect(parsePrompt(calls[0]!.prompt).task).toBe(first.prompt)
    expect(parsePrompt(calls[1]!.prompt).dependencies).toEqual([{ id: first.id, output: { count: 3 } }])
    expect(Object.hasOwn(result.outputs, '__proto__')).toBe(true)
  })

  it('never starts dependent work after a failed member', async () => {
    let calls = 0
    await expect(new AsyncFunction('agent', 'args', compileArchitecture({ nodes: [worker, reviewer] }))(
      async () => { calls += 1; return null }, {},
    )).rejects.toThrow('dependency failed')
    expect(calls).toBe(1)
  })

  it.each([{ allow: [] }, { deny: ['write'] }])('preserves single-list masks %j', (toolFilter) => {
    expect(compileArchitecture({ nodes: [{ ...worker, toolFilter }] })).toContain(JSON.stringify(toolFilter))
  })

  it('fails delivery when an independent member fails even without dependants', async () => {
    await expect(new AsyncFunction('agent', 'args', compileArchitecture({ nodes: [worker] }))(
      async () => null, {},
    )).rejects.toThrow('architecture member failed')
  })
})
