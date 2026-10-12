import { describe, expect, it } from 'vitest'
import {
  buildManifest,
  CapabilityManifestError,
  checkRelativePath,
  isCapabilityVersion,
  manifestVersion,
  normalizeManifest,
  serializeManifest,
  sha256,
} from '../src/index.js'
import { sampleComponents } from './helpers.js'

describe('manifest', () => {
  it('derives the same version regardless of input order', () => {
    const forward = buildManifest(sampleComponents())
    const reversed = buildManifest([...sampleComponents()].reverse().map(component => ({ ...component, files: [...component.files].reverse() })))
    expect(serializeManifest(reversed)).toBe(serializeManifest(forward))
    expect(manifestVersion(reversed)).toBe(manifestVersion(forward))
    expect(manifestVersion(forward)).toBe(sha256(serializeManifest(forward)))
  })

  it('changes the version when one byte of one file changes', () => {
    expect(manifestVersion(buildManifest(sampleComponents('a')))).not.toBe(manifestVersion(buildManifest(sampleComponents('b'))))
  })

  it('sorts components by type then name and files by path, with fixed fields', () => {
    const manifest = buildManifest(sampleComponents())
    expect(manifest.components.map(component => component.path)).toEqual(['function-module/order-tools', 'skill/summarize-orders'])
    expect(manifest.components[1]!.files.map(file => file.path)).toEqual(['SKILL.md', 'reference/columns.md'])
    expect(Object.keys(manifest.components[0]!)).toEqual(['type', 'name', 'path', 'files'])
    expect(manifest.components[0]!.files[0]!.size).toBeGreaterThan(0)
  })

  it('accepts the empty bundle', () => {
    expect(normalizeManifest({ format: 1, components: [] })).toEqual({ format: 1, components: [] })
  })

  it.each([
    ['unknown type', [{ type: 'macro', name: 'x', files: [{ path: 'a', content: '' }] }]],
    ['bad name', [{ type: 'skill', name: 'Bad Name', files: [{ path: 'a', content: '' }] }]],
    ['no files', [{ type: 'skill', name: 'x', files: [] }]],
    ['duplicate component', [{ type: 'skill', name: 'x', files: [{ path: 'a', content: '' }] }, { type: 'skill', name: 'x', files: [{ path: 'b', content: '' }] }]],
    ['case-insensitive clash', [{ type: 'skill', name: 'x', files: [{ path: 'A.md', content: '' }, { path: 'a.md', content: '' }] }]],
    ['file and directory', [{ type: 'skill', name: 'x', files: [{ path: 'a', content: '' }, { path: 'a/b', content: '' }] }]],
    ['parent segment', [{ type: 'skill', name: 'x', files: [{ path: '../escape', content: '' }] }]],
  ])('rejects %s', (_label, components) => {
    expect(() => buildManifest(components as never)).toThrow(CapabilityManifestError)
  })

  it.each(['/abs', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'a/..', 'con:x', 'a?b', 'trailing.', 'a/b ', ''])('rejects the path %j', path => {
    expect(() => checkRelativePath(path)).toThrow(CapabilityManifestError)
  })

  it('rejects unknown fields, a wrong format and a path that is not <type>/<name>', () => {
    const good = JSON.parse(serializeManifest(buildManifest(sampleComponents()))) as { components: Record<string, unknown>[] }
    expect(() => normalizeManifest({ ...good, extra: 1 })).toThrow(/unknown fields/)
    expect(() => normalizeManifest({ ...good, format: 2 })).toThrow(/format/)
    const moved = { format: 1, components: [{ ...good.components[0], path: 'elsewhere/x' }] }
    expect(() => normalizeManifest(moved)).toThrow(/path must be/)
    const badHash = { format: 1, components: [{ ...good.components[0], files: [{ path: 'a', sha256: 'XYZ', size: 1 }] }] }
    expect(() => normalizeManifest(badHash)).toThrow(/sha256/)
  })

  it('recognizes versions', () => {
    expect(isCapabilityVersion('baseline')).toBe(true)
    expect(isCapabilityVersion('a'.repeat(64))).toBe(true)
    expect(isCapabilityVersion('A'.repeat(64))).toBe(false)
    expect(isCapabilityVersion('latest')).toBe(false)
  })
})
