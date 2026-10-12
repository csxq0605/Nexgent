import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isNexgentError, MANIFEST_FILE, type CapabilityDecision } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { CapabilityIntegrityError, CapabilityStore, type AdoptInput } from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'

const GATE: AdoptInput = { trigger: 'gate', reason: 'quality-up', detail: 'test adoption' }
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
  it('adopts a verified bundle with a decision first, then resolves it for new sessions', async () => {
    const { capabilities, seen } = await store()
    const bundle = await capabilities.write(sampleComponents())
    const adopted = await capabilities.adopt(bundle.version, { ...GATE, candidateId: '8b1f2a6e-3c4d-4e5f-9a0b-1c2d3e4f5a6b' })
    expect(adopted?.activation.version).toBe(bundle.version)
    expect(adopted?.decision).toMatchObject({ outcome: 'adopted', trigger: 'gate', fromVersion: 'baseline', toVersion: bundle.version, revision: 1 })
    expect((await capabilities.history())[0]!.decisionId).toBe(adopted!.decision.id)
    expect(await capabilities.decision(adopted!.decision.id)).toEqual(adopted!.decision)
    expect(seen).toEqual([adopted!.decision])
    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe(bundle.version)
    expect(resolved.rollbacks).toEqual([])
    expect(resolved.problem).toBeUndefined()
  })

  it('refuses to adopt a damaged or missing bundle and writes nothing', async () => {
    const { capabilities } = await store()
    const bundle = await capabilities.write(sampleComponents())
    await appendFile(join(bundle.directory!, 'skills', 'summarize-orders', 'SKILL.md'), '!')
    await expect(capabilities.adopt(bundle.version, GATE)).rejects.toBeInstanceOf(CapabilityIntegrityError)
    await expect(capabilities.adopt('f'.repeat(64), GATE)).rejects.toBeInstanceOf(CapabilityIntegrityError)
    expect(await capabilities.history()).toEqual([])
    expect(await capabilities.decisions()).toEqual([])
  })

  it('returns null when the observed tail is stale', async () => {
    const { capabilities, seen } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    const observed = await capabilities.activation()
    expect(await capabilities.adopt(first.version, GATE, observed)).not.toBeNull()
    expect(await capabilities.adopt(second.version, GATE, observed)).toBeNull()
    expect(seen).toHaveLength(1)
  })

  it('rolls back manually to the previous version and refuses past the baseline', async () => {
    const { capabilities } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await capabilities.adopt(first.version, GATE)
    await capabilities.adopt(second.version, GATE)
    const back = await capabilities.rollback(MANUAL)
    expect(back?.activation.version).toBe(first.version)
    expect(back?.decision).toMatchObject({ outcome: 'rolled-back', reason: 'manual', fromVersion: second.version, toVersion: first.version, revision: 3 })
    expect((await capabilities.rollback(MANUAL))?.activation.version).toBe('baseline')
    const error = await capabilities.rollback(MANUAL).catch((caught: unknown) => caught)
    expect(isNexgentError(error, 'config/invalid')).toBe(true)
    expect((await capabilities.resolveAdopted()).bundle.version).toBe('baseline')
  })

  it('records rejections without a revision', async () => {
    const { capabilities, seen } = await store()
    const decision = await capabilities.recordDecision({ outcome: 'rejected', reason: 'quality-down', trigger: 'gate', fromVersion: 'baseline', toVersion: 'baseline', detail: 'worse' })
    expect(await capabilities.decisions()).toEqual([decision])
    expect(seen).toEqual([decision])
    expect(await capabilities.history()).toEqual([])
  })

  it('rolls back a tampered adopted bundle at load time and keeps every version', async () => {
    const { capabilities, seen } = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await capabilities.adopt(first.version, GATE)
    await capabilities.adopt(second.version, GATE)
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
    await capabilities.adopt(first.version, GATE)
    await capabilities.adopt(second.version, GATE)
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
    await capabilities.adopt(first.version, GATE)
    await capabilities.adopt(second.version, GATE)
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
