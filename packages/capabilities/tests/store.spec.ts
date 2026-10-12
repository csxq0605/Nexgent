import { appendFile, chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isNexgentError, MANIFEST_FILE } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_BUNDLE,
  CapabilityIntegrityError,
  componentDirectory,
  listBundleVersions,
  loadBundle,
  writeBundle,
  type CapabilityIntegrityReason,
} from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'

async function expectIntegrity(promise: Promise<unknown>, reason: CapabilityIntegrityReason): Promise<CapabilityIntegrityError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(CapabilityIntegrityError)
  expect(isNexgentError(error, 'session/corrupt')).toBe(true)
  expect((error as CapabilityIntegrityError).reason).toBe(reason)
  return error as CapabilityIntegrityError
}

describe('bundle store', () => {
  it('writes a bundle under its version and loads it back verified', async () => {
    const dir = await tempDir()
    const stored = await writeBundle(dir, sampleComponents())
    expect(stored.directory).toBe(join(dir, stored.version))
    expect(await readdir(dir)).toEqual([stored.version])
    const loaded = await loadBundle(dir, stored.version)
    expect(loaded).toEqual(stored)
    const skill = loaded.manifest.components.find(component => component.kind === 'skill')!
    expect(await readFile(join(componentDirectory(loaded, skill), 'SKILL.md'), 'utf8')).toContain('summarize-orders')
    expect((await readFile(join(stored.directory!, MANIFEST_FILE), 'utf8')).endsWith('\n')).toBe(true)
    expect(await listBundleVersions(dir)).toEqual([stored.version])
  })

  it('is idempotent: the same content keeps one directory and is never rewritten', async () => {
    const dir = await tempDir()
    const first = await writeBundle(dir, sampleComponents())
    const again = await writeBundle(dir, [...sampleComponents()].reverse())
    expect(again.version).toBe(first.version)
    expect(await readdir(dir)).toEqual([first.version])
    const all = await Promise.all(Array.from({ length: 6 }, () => writeBundle(dir, sampleComponents('c'))))
    expect(new Set(all.map(bundle => bundle.version)).size).toBe(1)
    expect((await readdir(dir)).sort()).toEqual([first.version, all[0]!.version].sort())
  })

  it('refuses to reuse a damaged existing version', async () => {
    const dir = await tempDir()
    const stored = await writeBundle(dir, sampleComponents())
    await appendFile(join(stored.directory!, 'skills', 'summarize-orders', 'SKILL.md'), 'x')
    await expectIntegrity(writeBundle(dir, sampleComponents()), 'file-mismatch')
  })

  it('writes nothing for invalid input', async () => {
    const dir = await tempDir()
    const error = await writeBundle(dir, [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '' }, { path: '../out', content: '' }] }]).catch((caught: unknown) => caught)
    expect(isNexgentError(error, 'config/invalid')).toBe(true)
    expect(await listBundleVersions(dir)).toEqual([])
  })

  it('loads the baseline without touching the disk', async () => {
    expect(await loadBundle(join(await tempDir(), 'missing'), 'baseline')).toBe(BASELINE_BUNDLE)
    expect(BASELINE_BUNDLE.manifest.components).toEqual([])
  })

  describe('rejects tampering', () => {
    it('one changed byte', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      const file = join(stored.directory!, 'functions', 'order-tools', 'index.mjs')
      const bytes = await readFile(file)
      bytes[0] = bytes[0]! ^ 1
      await writeFile(file, bytes)
      const error = await expectIntegrity(loadBundle(dir, stored.version), 'file-mismatch')
      expect(error.path).toBe('functions/order-tools/index.mjs')
    })

    it('a missing file', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      await rm(join(stored.directory!, 'skills', 'summarize-orders', 'reference', 'columns.md'))
      await expectIntegrity(loadBundle(dir, stored.version), 'file-missing')
    })

    it('an added file', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      await writeFile(join(stored.directory!, 'skills', 'summarize-orders', 'extra.md'), 'sneaky')
      const error = await expectIntegrity(loadBundle(dir, stored.version), 'unexpected-entry')
      expect(error.path).toBe('skills/summarize-orders/extra.md')
    })

    it.skipIf(process.platform === 'win32')('a symlink in place of a file', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      await writeFile(join(dir, 'outside.md'), 'region, amount\n')
      const target = join(stored.directory!, 'skills', 'summarize-orders', 'reference', 'columns.md')
      await rm(target)
      await symlink(join(dir, 'outside.md'), target)
      await expectIntegrity(loadBundle(dir, stored.version), 'unexpected-entry')
    })

    it('an edited manifest (consistent with edited files) under the old version', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      const manifestFile = join(stored.directory!, MANIFEST_FILE)
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { components: { files: { bytes: number }[] }[] }
      manifest.components[0]!.files[0]!.bytes += 1
      await writeFile(manifestFile, JSON.stringify(manifest))
      await expectIntegrity(loadBundle(dir, stored.version), 'version-mismatch')
    })

    it('a corrupt manifest, a missing bundle and a malformed version', async () => {
      const dir = await tempDir()
      const stored = await writeBundle(dir, sampleComponents())
      await writeFile(join(stored.directory!, MANIFEST_FILE), '{not json')
      await expectIntegrity(loadBundle(dir, stored.version), 'manifest')
      await expectIntegrity(loadBundle(dir, 'f'.repeat(64)), 'missing')
      await expectIntegrity(loadBundle(dir, '../x'), 'missing')
    })
  })

  it('ignores staging leftovers and the activation directory when listing', async () => {
    const dir = await tempDir()
    const stored = await writeBundle(dir, sampleComponents())
    await mkdir(join(dir, '.staging-crashed'))
    await mkdir(join(dir, 'activation'))
    expect(await listBundleVersions(dir)).toEqual([stored.version])
    expect(await listBundleVersions(join(dir, 'nope'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves no staging directory behind when a write fails', async () => {
    const dir = await tempDir()
    await chmod(dir, 0o500)
    try {
      await expect(writeBundle(dir, sampleComponents())).rejects.toThrow()
    } finally {
      await chmod(dir, 0o700)
    }
    expect(await readdir(dir)).toEqual([])
  })
})
