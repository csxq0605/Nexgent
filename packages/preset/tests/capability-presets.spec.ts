/**
 * Capability-bundle presets (step 4): for one name a tried preset beats the
 * project's file, which beats an adopted one, which beats a built-in; the
 * lookup reads `ctx.capabilities` only when it is loaded.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capabilityPresetFiles, capabilityPresetLookup, PresetRegistry, sessionPresetRegistry } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

const text = (name: string, description: string) => JSON.stringify({ formatVersion: 1, name, description })

async function setup(): Promise<{ root: string; adopted: string; tried: string; broken: string }> {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'nxcappreset-'))
  dirs.push(root)
  await mkdir(nodePath.join(root, '.nexgent', 'presets'), { recursive: true })
  await writeFile(nodePath.join(root, '.nexgent', 'presets', 'reviewer.json'), text('reviewer', 'project reviewer'))
  const write = async (dir: string, body: string) => {
    await mkdir(nodePath.join(root, dir), { recursive: true })
    await writeFile(nodePath.join(root, dir, 'preset.json'), body)
    return nodePath.join(root, dir, 'preset.json')
  }
  return {
    root,
    adopted: await write('adopted', text('reviewer', 'adopted reviewer')),
    tried: await write('tried', text('general-executor', 'tried executor')),
    broken: await write('broken', '{'),
  }
}

describe('capability presets', () => {
  it('tried > project > adopted > built-in, and a broken one is reported by name', async () => {
    const { root, adopted, tried, broken } = await setup()
    const registry = new PresetRegistry(root, [
      { name: 'reviewer', file: adopted, tried: false },
      { name: 'general-executor', file: tried, tried: true },
      { name: 'analyst-x', file: adopted.replace('adopted', 'adopted'), tried: false },
      { name: 'oops', file: broken, tried: false },
    ])
    expect((await registry.resolve('reviewer')).description).toBe('project reviewer')
    expect((await registry.resolve('general-executor')).description).toBe('tried executor')
    const { presets, errors } = await registry.load()
    expect(presets.find(entry => entry.preset.name === 'general-executor')?.source).toBe('capability')
    expect(errors.map(error => error.file)).toEqual(expect.arrayContaining([adopted, broken]))
    await expect(registry.resolve('oops')).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('an adopted preset is used when the project has none of that name', async () => {
    const { root, adopted } = await setup()
    await rm(nodePath.join(root, '.nexgent', 'presets', 'reviewer.json'))
    expect((await new PresetRegistry(root, [{ name: 'reviewer', file: adopted, tried: false }]).resolve('reviewer')).description).toBe('adopted reviewer')
  })

  it('reads ctx.capabilities per session, and nothing when it is not loaded', async () => {
    const { root, adopted } = await setup()
    await rm(nodePath.join(root, '.nexgent', 'presets', 'reviewer.json'))
    const seen: string[] = []
    let loaded = true
    const ctx = {
      get: (name: string) => (name === 'capabilities' && loaded
        ? { components: async (sessionId: string) => { seen.push(sessionId); return [{ name: 'reviewer', entryPath: adopted, version: 'a'.repeat(64) }] } }
        : undefined),
    }
    const lookup = capabilityPresetLookup(ctx)
    expect(await capabilityPresetFiles('s-1', lookup)).toEqual([{ name: 'reviewer', file: adopted, tried: false }])
    expect((await (await sessionPresetRegistry(root, 's-2', lookup)).resolve('reviewer')).description).toBe('adopted reviewer')
    expect(seen).toEqual(['s-1', 's-2'])
    loaded = false
    await expect((await sessionPresetRegistry(root, 's-3', lookup)).resolve('reviewer')).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})
