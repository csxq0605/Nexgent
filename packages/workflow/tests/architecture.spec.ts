/**
 * The declarative graph compiler and the content-addressed store, adapted
 * from PR #4's `architecture.spec.ts` / `architecture-store.spec.ts`
 * (refactor/dsh-application fd0b2f42) to the contract's node fields.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonValue } from '@nexgent/kernel'
import { describe, expect, it, vi } from 'vitest'
import { architectureVersion, compileArchitecture, loadArchitecture, normalizeArchitecture, prepareArchitecture, saveArchitecture } from '../src/index.js'
import { tempDir } from './helpers.js'

const worker = { id: 'worker', prompt: 'Find evidence', dependencies: [] as string[] }
const reviewer = { id: 'reviewer', prompt: 'Check evidence', dependencies: ['worker'] }

interface MemberReply { text: string; deliverables: { files: { path: string }[] }[] }
type AgentHook = (prompt: string, options: Record<string, unknown>) => Promise<MemberReply>
const AsyncFunction = (async () => {}).constructor as new (...parts: string[]) => (agent: AgentHook, args: JsonValue) => Promise<{ architecture: string; outputs: Record<string, string> }>

const reply = (text: string, files: string[] = []): MemberReply => ({ text, deliverables: files.length === 0 ? [] : [{ files: files.map(path => ({ path })) }] })

function run(script: string, agent: AgentHook, args: JsonValue = null) {
  return new AsyncFunction('agent', 'args', script)(agent, args)
}

describe('graph compiler', () => {
  it('normalizes order, dependencies and tool lists, and versions the content', () => {
    const a = prepareArchitecture({ nodes: [reviewer, { ...worker, tools: { allow: ['read_file', 'bash', 'bash'], deny: ['web_fetch'] } }] })
    const b = prepareArchitecture({ nodes: [{ ...worker, tools: { deny: ['web_fetch'], allow: ['bash', 'read_file'] } }, { ...reviewer, dependencies: ['worker', 'worker'] }] })
    expect(a.architecture.nodes.map(node => node.id)).toEqual(['reviewer', 'worker'])
    expect(a.architecture.nodes[1]?.tools).toEqual({ allow: ['bash', 'read_file'], deny: ['web_fetch'] })
    expect(a.version).toMatch(/^[a-f0-9]{64}$/)
    expect(b.version).toBe(a.version)
    expect(b.script).toBe(a.script)
    expect(a.version).toBe(architectureVersion(a.architecture))
    expect(prepareArchitecture({ nodes: [{ ...worker, prompt: 'Changed task' }, reviewer] }).version).not.toBe(a.version)
    expect(prepareArchitecture({ nodes: [{ ...worker, model: 'claude-opus-5-5' }, reviewer] }).version).not.toBe(prepareArchitecture({ nodes: [worker, reviewer] }).version)
  })

  it('rejects a cycle, an unknown dependency, a duplicate id and a self-dependency with a readable error', () => {
    expect(() => prepareArchitecture({ nodes: [{ ...worker, dependencies: ['reviewer'] }, reviewer] })).toThrow('graph: dependency cycle among reviewer, worker')
    expect(() => prepareArchitecture({ nodes: [{ id: 'a', prompt: 'a', dependencies: ['c'] }, { id: 'b', prompt: 'b', dependencies: ['a'] }, { id: 'c', prompt: 'c', dependencies: ['b'] }, worker] }))
      .toThrow('dependency cycle among a, b, c')
    expect(() => prepareArchitecture({ nodes: [reviewer] })).toThrow('node reviewer depends on unknown node worker')
    expect(() => prepareArchitecture({ nodes: [worker, worker] })).toThrow('node id worker appears twice')
    expect(() => prepareArchitecture({ nodes: [{ ...worker, dependencies: ['worker'] }] })).toThrow('node worker depends on itself')
    try {
      prepareArchitecture({ nodes: [reviewer] })
    } catch (error) {
      expect(error).toMatchObject({ code: 'tool/invalid-input' })
    }
  })

  it.each([
    null, [], {}, { nodes: [] }, { nodes: [null] }, { nodes: [worker], unknown: true },
    { nodes: [{ ...worker, role: 'researcher' }] }, { nodes: [{ ...worker, prompt: ' ' }] },
    { nodes: [{ ...worker, dependencies: null }] }, { nodes: [{ ...worker, id: 'Worker' }] }, { nodes: [{ ...worker, id: '__proto__' }] },
    { nodes: [{ ...worker, model: 2 }] }, { nodes: [{ ...worker, preset: '' }] },
    { nodes: [{ ...worker, tools: {} }] }, { nodes: [{ ...worker, tools: { allow: ['read', 7] } }] },
    { nodes: Array.from({ length: 17 }, (_, i) => ({ id: `n${i}`, prompt: 'p', dependencies: [] })) },
  ])('rejects malformed graph %j', input => {
    expect(() => prepareArchitecture(input)).toThrow(/^graph: /)
  })

  it('runs each node once after its dependencies and passes their replies and files', async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = []
    const graph = normalizeArchitecture({ nodes: [{ ...reviewer, preset: 'read-only-checker', tools: { deny: ['bash'] } }, worker] })
    const result = await run(compileArchitecture(graph), async (prompt, options) => {
      calls.push({ prompt, options })
      return options.name === 'worker' ? reply('verified evidence', ['out/worker/evidence.md']) : reply('review complete')
    }, { topic: 'source' })
    expect(calls.map(call => call.options.name)).toEqual(['worker', 'reviewer'])
    expect(calls[0]?.prompt).toBe('Find evidence\n\nInput:\n{\n  "topic": "source"\n}')
    expect(calls[1]?.prompt).toContain('Result of worker:\nverified evidence\nFiles presented by worker: out/worker/evidence.md')
    expect(calls[1]?.options).toEqual({ name: 'reviewer', preset: 'read-only-checker', tools: { deny: ['bash'] } })
    expect(result).toEqual({ architecture: architectureVersion(graph), outputs: { worker: 'verified evidence', reviewer: 'review complete' } })
  })

  it('starts a dependant as soon as its own inputs are ready', async () => {
    let releaseSlow: (value: MemberReply) => void = () => {}
    const slow = new Promise<MemberReply>(resolve => { releaseSlow = resolve })
    const calls: string[] = []
    const nodes = [
      { id: 'slow', prompt: 'slow', dependencies: [] },
      { id: 'fast', prompt: 'fast', dependencies: [] },
      { id: 'next', prompt: 'next', dependencies: ['fast'] },
      { id: 'other', prompt: 'other', dependencies: ['fast'] },
    ]
    const pending = run(prepareArchitecture({ nodes }).script, async (_prompt, options) => {
      calls.push(String(options.name))
      return options.name === 'slow' ? slow : reply(String(options.name))
    })
    try {
      await vi.waitFor(() => {
        expect(calls).toContain('next')
        expect(calls).toContain('other')
      })
      expect(calls.filter(name => name === 'fast')).toHaveLength(1)
    } finally {
      releaseSlow(reply('slow'))
      await pending
    }
  })

  it('keeps prompts as data and never starts a dependant of a failed member', async () => {
    const hostile = { id: 'hostile', prompt: '"; throw new Error("injected"); //', dependencies: [] as string[] }
    const prompts: string[] = []
    await run(prepareArchitecture({ nodes: [hostile] }).script, async prompt => {
      prompts.push(prompt)
      return reply('ok')
    })
    expect(prompts).toEqual([hostile.prompt])
    const started: string[] = []
    await expect(run(prepareArchitecture({ nodes: [worker, reviewer, { id: 'side', prompt: 'side', dependencies: [] }] }).script, async (_prompt, options) => {
      started.push(String(options.name))
      if (options.name === 'worker') throw new Error('member worker failed')
      return reply('fine')
    })).rejects.toThrow('member worker failed')
    expect(started.sort()).toEqual(['side', 'worker'])
  })
})

describe('graph store', () => {
  const graph = { nodes: [worker] }

  it('publishes one complete file under concurrent saves and loads it back', async () => {
    const dir = await tempDir()
    const saved = await Promise.all(Array.from({ length: 8 }, () => saveArchitecture(dir, graph)))
    expect(new Set(saved.map(row => row.version)).size).toBe(1)
    expect(await readdir(dir)).toEqual([`${saved[0]!.version}.json`])
    expect(JSON.parse(await readFile(join(dir, `${saved[0]!.version}.json`), 'utf8'))).toEqual({ format: 1, architecture: { nodes: [worker] } })
    expect(await loadArchitecture(dir, saved[0]!.version)).toEqual(saved[0])
  })

  it('refuses a damaged file and does not overwrite it on a repeated save', async () => {
    const dir = await tempDir()
    const saved = await saveArchitecture(dir, graph)
    const path = join(dir, `${saved.version}.json`)
    const damaged = JSON.stringify({ format: 1, architecture: { nodes: [{ ...worker, prompt: 'changed' }] } })
    await writeFile(path, damaged)
    await expect(loadArchitecture(dir, saved.version)).rejects.toMatchObject({ code: 'session/corrupt' })
    await expect(saveArchitecture(dir, graph)).rejects.toThrow(`hashes to`)
    expect(await readFile(path, 'utf8')).toBe(damaged)
    expect(await readdir(dir)).toEqual([`${saved.version}.json`])
  })

  it.each([null, { format: 2, architecture: graph }, { format: 1, architecture: graph, adopted: true }, { format: 1 }])('refuses the saved record %j', async record => {
    const dir = await tempDir()
    const saved = await saveArchitecture(dir, graph)
    await writeFile(join(dir, `${saved.version}.json`), JSON.stringify(record))
    await expect(loadArchitecture(dir, saved.version)).rejects.toThrow('is not a format 1 record')
  })

  it('refuses a bad version and writes nothing for an invalid graph', async () => {
    const dir = await tempDir()
    await expect(loadArchitecture(dir, '../escape')).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(loadArchitecture(dir, '0'.repeat(64))).rejects.toMatchObject({ code: 'session/corrupt' })
    await expect(saveArchitecture(join(dir, 'graphs'), { nodes: [reviewer] })).rejects.toThrow('unknown node worker')
    expect(await readdir(dir)).toEqual([])
  })
})
