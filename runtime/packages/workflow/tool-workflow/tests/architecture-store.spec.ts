import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { loadArchitecture, saveArchitecture } from '../src/architecture-store.ts'

const graph = { nodes: [{ id: 'worker', role: 'researcher', prompt: 'Do the task', dependencies: [] }] }
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexgent-architecture-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('saved native architectures', () => {
  it('publishes one complete record under concurrent saves and loads without prior session state', async () => {
    const root = await directory()
    const saved = await Promise.all(Array.from({ length: 8 }, () => saveArchitecture(root, graph)))
    expect(new Set(saved.map(row => row.version)).size).toBe(1)
    expect(await readdir(root)).toEqual([`${saved[0]!.version}.json`])
    const loaded = await loadArchitecture(root, saved[0]!.version)
    expect(loaded).toEqual(saved[0])
  })

  it('rejects corrupted content and cannot overwrite it on a repeated save', async () => {
    const root = await directory()
    const saved = await saveArchitecture(root, graph)
    const path = join(root, `${saved.version}.json`)
    const damaged = JSON.stringify({ format: 1, architecture: { nodes: [{ ...graph.nodes[0], prompt: 'changed' }] } })
    await writeFile(path, damaged)
    await expect(loadArchitecture(root, saved.version)).rejects.toThrow('digest mismatch')
    await expect(saveArchitecture(root, graph)).rejects.toThrow('digest mismatch')
    expect(await readFile(path, 'utf8')).toBe(damaged)
    expect(await readdir(root)).toEqual([`${saved.version}.json`])
  })

  it.each([null, { format: 2, architecture: graph }, { format: 1, architecture: graph, adopted: true }, { format: 1 }])('rejects unsupported record %j', async (record) => {
    const root = await directory()
    const saved = await saveArchitecture(root, graph)
    await writeFile(join(root, `${saved.version}.json`), JSON.stringify(record))
    await expect(loadArchitecture(root, saved.version)).rejects.toThrow('invalid saved architecture record')
  })

  it('rejects unsafe, missing and malformed definitions before use', async () => {
    const root = await directory()
    await expect(loadArchitecture(root, '../escape')).rejects.toThrow('SHA-256')
    await expect(loadArchitecture(root, '0'.repeat(64))).rejects.toThrow('ENOENT')
    await expect(saveArchitecture(root, { nodes: [] })).rejects.toThrow('at least one')
    expect(await readdir(root)).toEqual([])
  })
})
