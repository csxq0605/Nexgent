import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS_DIR, FileSkillRegistry, renderSkillList, skillsProvider, MAX_SKILL_FILE_BYTES } from '../src/index.js'
import { skillText, tempDir, writeProjectSkill } from './helpers.js'

describe('skill discovery', () => {
  it('ships the office-documents skill', async () => {
    const root = await tempDir()
    const catalog = await new FileSkillRegistry({ projectRoot: root }).catalog()
    expect(catalog.problems).toEqual([])
    expect(catalog.skills).toEqual([
      expect.objectContaining({ name: 'office-documents', source: 'builtin', path: join(BUILTIN_SKILLS_DIR, 'office-documents', 'SKILL.md'), tools: ['read_document'] }),
    ])
    const loaded = await new FileSkillRegistry({ projectRoot: root }).load('office-documents')
    expect(loaded.body).toContain('read_document')
    expect(loaded.body).not.toContain('---')
  })

  it('finds project skills, sorts by name, and lets a project skill override a built-in one', async () => {
    const root = await tempDir()
    const builtin = await tempDir('nexgent-builtin-')
    await mkdir(join(builtin, 'shared'))
    await writeFile(join(builtin, 'shared', 'SKILL.md'), skillText('shared', 'Built-in version.'))
    await mkdir(join(builtin, 'base'))
    await writeFile(join(builtin, 'base', 'SKILL.md'), skillText('base'))
    await writeProjectSkill(root, 'shared', skillText('shared', 'Project version.', 'Project body.'))
    await writeProjectSkill(root, 'zeta', skillText('zeta'))
    const registry = new FileSkillRegistry({ projectRoot: root, builtinDir: builtin })
    const catalog = await registry.catalog()
    expect(catalog.skills.map(skill => [skill.name, skill.source, skill.description])).toEqual([
      ['base', 'builtin', 'Does base.'],
      ['shared', 'project', 'Project version.'],
      ['zeta', 'project', 'Does zeta.'],
    ])
    expect((await registry.load('shared')).body).toBe('Project body.\n')
  })

  it('reports bad files as problems without hiding the good ones', async () => {
    const root = await tempDir()
    const builtin = await tempDir('nexgent-builtin-')
    await writeProjectSkill(root, 'good', skillText('good'))
    const bad = await writeProjectSkill(root, 'bad', '---\nname: bad\n---\nno description')
    const dup = await writeProjectSkill(root, 'z-dup', skillText('good', 'Second copy.'))
    const big = await writeProjectSkill(root, 'big', skillText('big', 'Big.', 'x'.repeat(MAX_SKILL_FILE_BYTES)))
    await writeFile(join(root, '.nexgent', 'skills', 'stray.md'), 'not a skill dir')
    await mkdir(join(root, '.nexgent', 'skills', 'empty-dir'))
    await mkdir(join(root, '.nexgent', 'skills', '.hidden'))
    await writeFile(join(root, '.nexgent', 'skills', '.hidden', 'SKILL.md'), 'garbage')
    const catalog = await new FileSkillRegistry({ projectRoot: root, builtinDir: builtin }).catalog()
    expect(catalog.skills.map(skill => skill.name)).toEqual(['good'])
    expect(catalog.problems).toEqual([
      { path: bad, reason: 'description is required (one line)' },
      { path: big, reason: expect.stringContaining('the limit is') },
      { path: dup, reason: expect.stringContaining('duplicate skill name good') },
    ])
    await expect(new FileSkillRegistry({ projectRoot: root, builtinDir: builtin }).load('bad'))
      .rejects.toMatchObject({ code: 'tool/not-found', message: expect.stringContaining('description is required') })
    await expect(new FileSkillRegistry({ projectRoot: root, builtinDir: builtin }).load('nope'))
      .rejects.toMatchObject({ code: 'tool/not-found', message: expect.stringContaining('available: good') })
  })

  it('sees a skill added after the first scan', async () => {
    const root = await tempDir()
    const registry = new FileSkillRegistry({ projectRoot: root, builtinDir: join(root, 'none') })
    expect((await registry.catalog()).skills).toEqual([])
    await writeProjectSkill(root, 'late', skillText('late'))
    expect((await registry.catalog()).skills.map(skill => skill.name)).toEqual(['late'])
  })
})

describe('skills provider', () => {
  it('lists skills in a "Skills" system section and gives nothing without skills', async () => {
    const root = await tempDir()
    const empty = skillsProvider(new FileSkillRegistry({ projectRoot: root, builtinDir: join(root, 'none') }))
    expect(await empty.beginTurn({} as never)).toEqual({})
    const provider = skillsProvider(new FileSkillRegistry({ projectRoot: root }))
    expect(provider.id).toBe('skills')
    const contribution = await provider.beginTurn({} as never)
    expect(contribution.inject).toBeUndefined()
    const [section] = contribution.systemSections!
    expect(section).toMatchObject({ id: 'skills', title: 'Skills' })
    expect(section!.body).toContain('call load_skill')
    expect(section!.body).toMatch(/^- office-documents: Read Word .* Use when: a material or project file is a \.docx/m)
    expect(renderSkillList([{ name: 'a', description: 'A.', source: 'project', path: '/a' }])).toMatch(/\n- a: A\.$/)
  })
})
