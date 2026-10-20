/**
 * Capability-bundle skills (step 4): tried > project > adopted > user >
 * built-in for one name, per session; the `skill` component check.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilitySkillLookup, FileSkillRegistry, validateCapabilitySkill } from '../src/index.js'
import { skillText, tempDir, writeProjectSkill } from './helpers.js'

async function skillFile(dir: string, name: string, description: string): Promise<string> {
  await mkdir(join(dir, name), { recursive: true })
  await writeFile(join(dir, name, 'SKILL.md'), skillText(name, description))
  return join(dir, name, 'SKILL.md')
}

describe('capability skills', () => {
  it('merges tried and adopted skills around the project ones; a mismatched name is a problem, not a skill', async () => {
    const root = await tempDir()
    const empty = await tempDir()
    const caps = await tempDir()
    await writeProjectSkill(root, 'shared', skillText('shared', 'project shared'))
    await writeProjectSkill(root, 'tried-over', skillText('tried-over', 'project tried-over'))
    const registry = new FileSkillRegistry({ projectRoot: root, builtinDir: empty })
    const layers = [
      { name: 'shared', entryPath: await skillFile(join(caps, 'a'), 'shared', 'adopted shared'), tried: false },
      { name: 'only-adopted', entryPath: await skillFile(join(caps, 'a'), 'only-adopted', 'adopted only'), tried: false },
      { name: 'tried-over', entryPath: await skillFile(join(caps, 't'), 'tried-over', 'tried wins'), tried: true },
      { name: 'renamed', entryPath: await skillFile(join(caps, 'a'), 'wrong-name', 'mismatch'), tried: false },
    ]
    const catalog = await registry.catalog(layers)
    expect(catalog.skills.map(skill => [skill.name, skill.description])).toEqual([
      ['only-adopted', 'adopted only'], ['shared', 'project shared'], ['tried-over', 'tried wins'],
    ])
    expect(catalog.problems.map(problem => problem.reason)).toEqual([expect.stringContaining('differs from the component name renamed')])
    expect((await registry.load('tried-over', layers)).manifest.description).toBe('tried wins')
    await expect(registry.load('only-adopted')).rejects.toMatchObject({ code: 'tool/not-found' })
  })

  it('the lookup asks ctx.capabilities for the session and marks drafts as tried', async () => {
    const lookup = capabilitySkillLookup(() => ({
      components: async (sessionId: string) => [
        { name: 'a', entryPath: `/x/${sessionId}/a`, version: 'draft' },
        { name: 'b', entryPath: '/x/b', version: 'f'.repeat(64) },
      ],
      registerValidator: () => () => {},
    }))
    expect(await lookup('s1')).toEqual([{ name: 'a', entryPath: '/x/s1/a', tried: true }, { name: 'b', entryPath: '/x/b', tried: false }])
    expect(await capabilitySkillLookup(() => undefined)('s1')).toEqual([])
  })

  it('validates a SKILL.md component', () => {
    const input = (text: string | undefined) => ({
      component: { kind: 'skill', name: 'notes' },
      files: new Map(text === undefined ? [] : [['SKILL.md', new Uint8Array(Buffer.from(text))]]),
      directory: '/d',
    })
    expect(() => validateCapabilitySkill(input(skillText('notes')))).not.toThrow()
    expect(() => validateCapabilitySkill(input(skillText('other')))).toThrow(/other/)
    expect(() => validateCapabilitySkill(input('no front matter'))).toThrow(/front matter/)
    expect(() => validateCapabilitySkill(input(undefined))).toThrow(/missing SKILL.md/)
  })
})
