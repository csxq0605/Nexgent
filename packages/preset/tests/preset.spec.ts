/**
 * Presets (`data-formats.md` §预设): the built-ins satisfy the frozen
 * `PresetFile` contract, project files are checked with readable errors, a
 * project preset replaces a built-in of the same name, and paths with
 * spaces or Windows separators resolve.
 */
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { assertPresetFile, BUILTIN_PRESET_NAMES, isNexgentError } from '@nexgent/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, DEFAULT_PRESET_NAME, describePresets, parsePresetFile, PresetRegistry } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

/** A project root (with a space in its name, as Windows user folders often have). */
async function project(files: Record<string, string> = {}): Promise<string> {
  const base = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), 'nxpreset-')))
  dirs.push(base)
  const root = nodePath.join(base, 'My Project')
  await mkdir(nodePath.join(root, '.nexgent', 'presets'), { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(nodePath.join(root, '.nexgent', 'presets', name), text)
  return root
}

const file = (fields: Record<string, unknown>) => JSON.stringify({ formatVersion: 1, description: 'A preset.', ...fields })

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    if (isNexgentError(error)) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('expected a rejection')
}

describe('built-in presets', () => {
  it('are the three contract names, each a valid preset file, the read-only ones narrowed to read-only', () => {
    expect(Object.keys(BUILTIN_PRESETS)).toEqual([...BUILTIN_PRESET_NAMES])
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      expect(() => assertPresetFile({ formatVersion: 1, ...preset })).not.toThrow()
      expect(preset.persona).toContain('{{model}}')
    }
    expect(BUILTIN_PRESETS['read-only-analyst'].sandboxMode).toBe('read-only')
    expect(BUILTIN_PRESETS['read-only-checker'].sandboxMode).toBe('read-only')
    expect(BUILTIN_PRESETS['general-executor'].sandboxMode).toBeUndefined()
    expect(BUILTIN_PRESETS['general-executor'].tools).toBeUndefined()
    expect(DEFAULT_PRESET_NAME).toBe('general-executor')
  })
})

describe('PresetRegistry', () => {
  it('lists the built-ins when the project has no presets directory', async () => {
    const base = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), 'nxpreset-')))
    dirs.push(base)
    const { presets, errors } = await new PresetRegistry(base).load()
    expect(presets.map(entry => [entry.preset.name, entry.source])).toEqual(BUILTIN_PRESET_NAMES.map(name => [name, 'builtin']))
    expect(errors).toEqual([])
    expect(describePresets(presets).split('\n')).toHaveLength(3)
  })

  it('loads project presets, lets one replace a built-in, and resolves both', async () => {
    const root = await project({
      'sql-reviewer.json': file({ name: 'sql-reviewer', persona: 'You review SQL.', tools: { deny: ['bash'] }, effort: 'high', maxSteps: 8 }),
      'general-executor.json': file({ name: 'general-executor', description: 'Project executor.', sandboxMode: 'workspace-write' }),
      'notes.txt': 'not a preset',
    })
    const registry = new PresetRegistry(root)
    const { presets, errors } = await registry.load()
    expect(errors).toEqual([])
    expect(presets.map(entry => [entry.preset.name, entry.source])).toEqual([
      ['read-only-analyst', 'builtin'],
      ['read-only-checker', 'builtin'],
      ['general-executor', 'project'],
      ['sql-reviewer', 'project'],
    ])
    expect(presets[3]!.file).toBe(nodePath.join(root, '.nexgent', 'presets', 'sql-reviewer.json'))
    expect(await registry.resolve('sql-reviewer')).toEqual({
      name: 'sql-reviewer', description: 'A preset.', persona: 'You review SQL.', tools: { deny: ['bash'] }, effort: 'high', maxSteps: 8,
    })
    expect(await registry.resolve('general-executor')).toEqual({ name: 'general-executor', description: 'Project executor.', sandboxMode: 'workspace-write' })
    expect(await registry.resolve('read-only-checker')).toBe(BUILTIN_PRESETS['read-only-checker'])
  })

  it('reports each broken file with a message naming the problem and keeps the good ones', async () => {
    const root = await project({
      'bad-json.json': '{ "formatVersion": 1, ',
      'extra.json': file({ name: 'extra', color: 'blue' }),
      'mismatch.json': file({ name: 'other-name' }),
      'wide.json': file({ name: 'wide', sandboxMode: 'everything' }),
      'version.json': JSON.stringify({ formatVersion: 2, name: 'version', description: 'x' }),
      'Upper.json': file({ name: 'upper' }),
      'empty-desc.json': file({ name: 'empty-desc', description: '  ' }),
      'tools.json': file({ name: 'tools', tools: { allow: 'bash' } }),
      'good.json': file({ name: 'good' }),
    })
    const { presets, errors } = await new PresetRegistry(root).load()
    expect(presets.map(entry => entry.preset.name)).toEqual([...BUILTIN_PRESET_NAMES, 'good'])
    const byFile = Object.fromEntries(errors.map(error => [nodePath.basename(error.file), error.message]))
    expect(Object.keys(byFile).sort()).toEqual(['Upper.json', 'bad-json.json', 'empty-desc.json', 'extra.json', 'mismatch.json', 'tools.json', 'version.json', 'wide.json'])
    expect(byFile['bad-json.json']).toMatch(/not valid JSON/)
    expect(byFile['extra.json']).toMatch(/unknown fields: color/)
    expect(byFile['mismatch.json']).toMatch(/"other-name" must equal the file name "mismatch"/)
    expect(byFile['wide.json']).toMatch(/sandboxMode/)
    expect(byFile['version.json']).toMatch(/formatVersion must be 1/)
    expect(byFile['Upper.json']).toMatch(/file name must match/)
    expect(byFile['empty-desc.json']).toMatch(/description/)
    expect(byFile['tools.json']).toMatch(/allow/)
  })

  it('resolve: a broken file is config/invalid naming the file; an unknown name lists what exists', async () => {
    const root = await project({ 'broken.json': file({ name: 'broken', effort: 'extreme' }) })
    const registry = new PresetRegistry(root)
    const broken = await rejection(registry.resolve('broken'))
    expect(broken.code).toBe('config/invalid')
    expect(broken.message).toContain(nodePath.join('.nexgent', 'presets', 'broken.json'))
    expect(broken.message).toMatch(/effort/)
    const unknown = await rejection(registry.resolve('nope'))
    expect(unknown).toEqual({ code: 'tool/invalid-input', message: 'unknown preset "nope"; available: read-only-analyst, read-only-checker, general-executor' })
  })

  it('refuses oversized files', async () => {
    const root = await project({ 'big.json': file({ name: 'big', persona: 'x'.repeat(70_000) }) })
    const { errors } = await new PresetRegistry(root).load()
    expect(errors[0]?.message).toMatch(/larger than 65536 bytes/)
  })

  it('parsePresetFile drops formatVersion', () => {
    expect(parsePresetFile(file({ name: 'a' }), 'a')).toEqual({ name: 'a', description: 'A preset.' })
  })

  it('builds the presets directory with the platform separator under a Windows-style root', () => {
    // path.join on the host keeps the root as given; on Windows the separators become backslashes.
    const registry = new PresetRegistry(nodePath.join('C:', 'Users', 'Wang Jie', 'proj'))
    expect(registry.directory.endsWith(nodePath.join('proj', '.nexgent', 'presets'))).toBe(true)
  })
})
