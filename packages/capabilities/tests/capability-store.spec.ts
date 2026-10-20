import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isNexgentError, MANIFEST_FILE, type CapabilityDecision } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { CapabilityStore } from '../src/index.js'
import { adopt, sampleComponents, tempDir } from './helpers.js'

const MANUAL = { trigger: 'manual', reason: 'manual', detail: 'user rolled back' } as const

async function store(): Promise<{ capabilities: CapabilityStore; seen: CapabilityDecision[] }> {
  const seen: CapabilityDecision[] = []
  const capabilities = new CapabilityStore(join(await tempDir(), '.nexgent', 'capabilities'), {
    now: () => new Date('2026-10-12T03:00:00.000Z'),
    onDecision: decision => { seen.push(decision) },
  })
  return { capabilities, seen }
}

describe('CapabilityStore', () => {
  it('rolls back manually to the previous version and refuses past the baseline', async () => {
    const { capabilities, seen } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await adopt(capabilities, first.version)
    await adopt(capabilities, second.version)
    const back = await capabilities.rollback(MANUAL)
    expect(back?.activation.version).toBe(first.version)
    expect(seen).toEqual([back!.decision])
    expect(await capabilities.decision(back!.decision.id)).toEqual(back!.decision)
    expect(back?.decision).toMatchObject({ outcome: 'rolled-back', reason: 'manual', fromVersion: second.version, toVersion: first.version, revision: 3 })
    expect((await capabilities.rollback(MANUAL))?.activation.version).toBe('baseline')
    const error = await capabilities.rollback(MANUAL).catch((caught: unknown) => caught)
    expect(isNexgentError(error, 'config/invalid')).toBe(true)
    expect((await capabilities.resolveAdopted()).bundle.version).toBe('baseline')
  })

  it('rolls back a tampered adopted bundle at load time and keeps every version', async () => {
    const { capabilities, seen } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await adopt(capabilities, first.version)
    await adopt(capabilities, second.version)
    await writeFile(join(second.directory!, 'functions', 'order-tools', 'index.mjs'), 'export function total() { throw new Error("regressed") }\n')

    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe(first.version)
    expect(resolved.rollbacks).toHaveLength(1)
    expect(resolved.rollbacks[0]!.error.reason).toBe('file-mismatch')
    expect(resolved.rollbacks[0]!.decision).toMatchObject({ outcome: 'rolled-back', reason: 'load-failure', trigger: 'load-failure', fromVersion: second.version, toVersion: first.version })
    expect(resolved.rollbacks[0]!.decision.detail).toContain('functions/order-tools/index.mjs')
    expect((await capabilities.history()).at(-1)).toMatchObject({ type: 'rollback', trigger: 'load-failure', from: second.version, version: first.version })
    expect(seen.at(-1)?.reason).toBe('load-failure')
    expect((await capabilities.versions()).sort()).toEqual([first.version, second.version].sort())
    expect((await capabilities.resolveAdopted()).rollbacks).toEqual([])
  })

  it('falls back through several damaged versions down to the baseline', async () => {
    const { capabilities } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await adopt(capabilities, first.version)
    await adopt(capabilities, second.version)
    await writeFile(join(first.directory!, MANIFEST_FILE), '{}')
    await writeFile(join(second.directory!, MANIFEST_FILE), '{}')
    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe('baseline')
    expect(resolved.rollbacks.map(rollback => rollback.version)).toEqual([second.version, first.version])
  })

  it('reports a damaged chain, runs on the last valid revision and writes nothing', async () => {
    const { capabilities } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await adopt(capabilities, first.version)
    await adopt(capabilities, second.version)
    await writeFile(join(capabilities.activationDirectory, '2.json'), '{}')
    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe(first.version)
    expect(resolved.problem?.file).toBe('2.json')
    expect(isNexgentError(await capabilities.rollback(MANUAL).catch((caught: unknown) => caught), 'session/corrupt')).toBe(true)

    // The last valid version is damaged too: baseline, without a revision.
    await writeFile(join(first.directory!, MANIFEST_FILE), '{}')
    const fallback = await capabilities.resolveAdopted()
    expect(fallback.bundle.version).toBe('baseline')
    expect(fallback.fallback?.version).toBe(first.version)
    expect((await capabilities.history()).length).toBe(1)
  })
})
