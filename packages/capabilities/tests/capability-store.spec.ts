import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CapabilityActivationError, CapabilityIntegrityError, CapabilityStore, MANIFEST_FILE } from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'

async function store(): Promise<CapabilityStore> {
  return new CapabilityStore(join(await tempDir(), '.nexgent', 'capabilities'), { now: () => new Date('2026-10-12T03:00:00.000Z') })
}

describe('CapabilityStore', () => {
  it('adopts a verified bundle and resolves it for new sessions', async () => {
    const capabilities = await store()
    const bundle = await capabilities.write(sampleComponents())
    const adopted = await capabilities.adopt(bundle.version, { decision: 'd1' })
    expect(adopted?.version).toBe(bundle.version)
    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe(bundle.version)
    expect(resolved.rollbacks).toEqual([])
    expect(await capabilities.versions()).toEqual([bundle.version])
  })

  it('refuses to adopt a damaged or missing bundle and publishes nothing', async () => {
    const capabilities = await store()
    const bundle = await capabilities.write(sampleComponents())
    await appendFile(join(bundle.directory!, 'skill', 'summarize-orders', 'SKILL.md'), '!')
    await expect(capabilities.adopt(bundle.version, {})).rejects.toBeInstanceOf(CapabilityIntegrityError)
    await expect(capabilities.adopt('f'.repeat(64), {})).rejects.toBeInstanceOf(CapabilityIntegrityError)
    expect(await capabilities.history()).toEqual([])
  })

  it('returns null when the observed tail is stale', async () => {
    const capabilities = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    const observed = await capabilities.activation()
    expect(await capabilities.adopt(first.version, {}, observed)).not.toBeNull()
    expect(await capabilities.adopt(second.version, {}, observed)).toBeNull()
  })

  it('rolls back manually to the previous version and refuses past the baseline', async () => {
    const capabilities = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await capabilities.adopt(first.version, {})
    await capabilities.adopt(second.version, {})
    expect((await capabilities.rollback({ trigger: 'manual' }))?.version).toBe(first.version)
    expect((await capabilities.rollback({ trigger: 'manual' }))?.version).toBe('baseline')
    await expect(capabilities.rollback({})).rejects.toBeInstanceOf(CapabilityActivationError)
    expect((await capabilities.resolveAdopted()).bundle.version).toBe('baseline')
  })

  it('rolls back a tampered adopted bundle at load time and keeps every version', async () => {
    const capabilities = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await capabilities.adopt(first.version, {})
    await capabilities.adopt(second.version, {})
    await writeFile(join(second.directory!, 'function-module', 'order-tools', 'index.mjs'), 'export function total() { throw new Error("regressed") }\n')

    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe(first.version)
    expect(resolved.rollbacks).toHaveLength(1)
    expect(resolved.rollbacks[0]!.error.reason).toBe('file-mismatch')
    const history = await capabilities.history()
    expect(history.at(-1)).toMatchObject({
      type: 'rollback',
      from: second.version,
      version: first.version,
      evidence: { trigger: 'load-failure', failedVersion: second.version, reason: 'file-mismatch', path: 'function-module/order-tools/index.mjs' },
    })
    expect((await capabilities.versions()).sort()).toEqual([first.version, second.version].sort())
    // Resolving again is stable: nothing more to roll back.
    expect((await capabilities.resolveAdopted()).rollbacks).toEqual([])
  })

  it('falls back through several damaged versions down to the baseline', async () => {
    const capabilities = await store()
    const first = await capabilities.write(sampleComponents('a'))
    const second = await capabilities.write(sampleComponents('b'))
    await capabilities.adopt(first.version, {})
    await capabilities.adopt(second.version, {})
    await writeFile(join(first.directory!, MANIFEST_FILE), '{}')
    await writeFile(join(second.directory!, MANIFEST_FILE), '{}')
    const resolved = await capabilities.resolveAdopted()
    expect(resolved.bundle.version).toBe('baseline')
    expect(resolved.rollbacks.map(rollback => rollback.version)).toEqual([second.version, first.version])
  })

  it('surfaces a corrupt chain to the caller', async () => {
    const capabilities = await store()
    const bundle = await capabilities.write(sampleComponents())
    await capabilities.adopt(bundle.version, {})
    await writeFile(join(capabilities.activationDirectory, '1.json'), '{}')
    await expect(capabilities.resolveAdopted()).rejects.toBeInstanceOf(CapabilityActivationError)
  })
})
