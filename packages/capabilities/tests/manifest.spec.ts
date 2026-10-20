import { canonicalManifestText, isNexgentError } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { buildManifest, checkComponentPath, checkManifest, isCapabilityVersion, manifestVersion, sha256 } from '../src/index.js'
import { sampleComponents } from './helpers.js'

function invalid(run: () => unknown): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(isNexgentError(caught, 'config/invalid')).toBe(true)
}

describe('manifest', () => {
  it('derives the same version regardless of input order', () => {
    const forward = buildManifest(sampleComponents())
    const reversed = buildManifest([...sampleComponents()].reverse().map(component => ({ ...component, files: [...component.files].reverse() })))
    expect(canonicalManifestText(reversed)).toBe(canonicalManifestText(forward))
    expect(manifestVersion(reversed)).toBe(manifestVersion(forward))
    expect(manifestVersion(forward)).toBe(sha256(canonicalManifestText(forward)))
  })

  it('changes the version when one byte of one file changes', () => {
    expect(manifestVersion(buildManifest(sampleComponents('a')))).not.toBe(manifestVersion(buildManifest(sampleComponents('b'))))
  })

  it('orders components by kind (contract order) then name, files by path, with contract fields', () => {
    const manifest = buildManifest(sampleComponents())
    expect(manifest.components.map(component => `${component.kind}/${component.name}`)).toEqual(['function-module/order-tools', 'skill/summarize-orders'])
    expect(manifest.components[1]!.files.map(file => file.path)).toEqual(['SKILL.md', 'reference/columns.md'])
    expect(Object.keys(manifest)).toEqual(['formatVersion', 'components'])
    expect(Object.keys(manifest.components[0]!.files[0]!)).toEqual(['path', 'sha256', 'bytes'])
  })

  it('accepts the empty bundle', () => {
    expect(checkManifest({ formatVersion: 1, components: [] })).toEqual({ formatVersion: 1, components: [] })
  })

  it.each([
    ['unknown kind', [{ kind: 'macro', name: 'x', files: [{ path: 'a', content: '' }] }]],
    ['underscore in name', [{ kind: 'skill', name: 'bad_name', files: [{ path: 'SKILL.md', content: '' }] }]],
    ['name starting with a digit', [{ kind: 'skill', name: '1x', files: [{ path: 'SKILL.md', content: '' }] }]],
    ['missing entry file', [{ kind: 'skill', name: 'x', files: [{ path: 'README.md', content: '' }] }]],
    ['duplicate component', [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '' }] }, { kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: 'b' }] }]],
    ['case-insensitive clash', [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '' }, { path: 'skill.md', content: '' }] }]],
    ['file and directory', [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '' }, { path: 'a', content: '' }, { path: 'a/b', content: '' }] }]],
    ['parent segment', [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '' }, { path: '../escape', content: '' }] }]],
    ['two context policies', [{ kind: 'context-policy', name: 'a', files: [{ path: 'policy.json', content: '{}' }] }, { kind: 'context-policy', name: 'b', files: [{ path: 'policy.json', content: '{}' }] }]],
    ['a file over 1 MiB', [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: 'x'.repeat(1_048_577) }] }]],
  ])('rejects %s', (_label, components) => {
    invalid(() => buildManifest(components as never))
  })

  it.each(['/abs', 'C:/x', 'a\\b', 'a//b', './a', 'a/./b', 'a/..', 'a?b', 'trailing.', 'a/b ', ''])('rejects the path %j', path => {
    invalid(() => checkComponentPath(path))
  })

  it('rejects unknown fields and the round-1 field names', () => {
    const good = JSON.parse(canonicalManifestText(buildManifest(sampleComponents()))) as Record<string, unknown>
    invalid(() => checkManifest({ ...good, extra: 1 }))
    invalid(() => checkManifest({ format: 1, components: [] }))
    invalid(() => checkManifest({ formatVersion: 1, components: [{ type: 'skill', name: 'x', path: 'skill/x', files: [] }] }))
  })

  it('recognizes versions', () => {
    expect(isCapabilityVersion('baseline')).toBe(true)
    expect(isCapabilityVersion('a'.repeat(64))).toBe(true)
    expect(isCapabilityVersion('A'.repeat(64))).toBe(false)
    expect(isCapabilityVersion('latest')).toBe(false)
  })
})
