import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS_DIR, FileSkillRegistry, renderSkillList, skillsProvider, MAX_SKILL_FILE_BYTES } from '../src/index.js'
import { skillText, tempDir, writeProjectSkill } from './helpers.js'

describe('skill discovery', () => {
  it('ships the office-documents and spreadsheets skills', async () => {
    const root = await tempDir()
    const catalog = await new FileSkillRegistry({ projectRoot: root }).catalog()
    expect(catalog.problems).toEqual([])
    expect(catalog.skills).toEqual([
      expect.objectContaining({ name: 'office-documents', source: 'builtin', path: join(BUILTIN_SKILLS_DIR, 'office-documents', 'SKILL.md'), tools: ['read_document'] }),
      expect.objectContaining({ name: 'spreadsheets', source: 'builtin', path: join(BUILTIN_SKILLS_DIR, 'spreadsheets', 'SKILL.md'), tools: ['read_spreadsheet', 'write_spreadsheet'] }),
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

  it('adds user skills between built-in and project skills (project > user > built-in)', async () => {
    const root = await tempDir()
    const builtin = await tempDir('nexgent-builtin-')
    const user = await tempDir('nexgent-user-')
    for (const name of ['all', 'bu']) {
      await mkdir(join(builtin, name))
      await writeFile(join(builtin, name, 'SKILL.md'), skillText(name, 'Built-in version.'))
    }
    for (const name of ['all', 'bu', 'mine']) {
      await mkdir(join(user, name))
      await writeFile(join(user, name, 'SKILL.md'), skillText(name, 'User version.', 'User body.'))
    }
    await mkdir(join(user, 'broken'))
    await writeFile(join(user, 'broken', 'SKILL.md'), '---\nname: broken\n---\n')
    await writeProjectSkill(root, 'all', skillText('all', 'Project version.'))
    const registry = new FileSkillRegistry({ projectRoot: root, builtinDir: builtin, userDir: user })
    const catalog = await registry.catalog()
    expect(catalog.skills.map(skill => [skill.name, skill.source, skill.description])).toEqual([
      ['all', 'project', 'Project version.'],
      ['bu', 'user', 'User version.'],
      ['mine', 'user', 'User version.'],
    ])
    expect(catalog.problems.map(problem => problem.path)).toEqual([join(user, 'broken', 'SKILL.md')])
    expect((await registry.load('mine')).body).toBe('User body.\n')
    expect((await new FileSkillRegistry({ projectRoot: root, builtinDir: builtin, userDir: join(user, 'missing') }).catalog()).skills.map(skill => skill.source))
      .toEqual(['project', 'builtin'])
    expect((await new FileSkillRegistry({ projectRoot: root, builtinDir: builtin }).catalog()).skills.map(skill => skill.source))
      .toEqual(['project', 'builtin'])
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
  const input = (sessionId: string, messages: unknown[] = []) => ({ sessionId, state: { messages } }) as never

  it('injects the skill list only when it differs from the last one injected into that session, never as a system section', async () => {
    const root = await tempDir()
    const empty = skillsProvider(new FileSkillRegistry({ projectRoot: root, builtinDir: join(root, 'none') }))
    expect(await empty.beginTurn(input('s1'))).toEqual({})
    const provider = skillsProvider(new FileSkillRegistry({ projectRoot: root }))
    expect(provider.id).toBe('skills')
    const first = await provider.beginTurn(input('s1'))
    expect(first.systemSections).toBeUndefined()
    expect(first.inject).toHaveLength(1)
    expect(first.inject![0]).toMatch(/^# Skills\n/)
    expect(first.inject![0]).toContain('call load_skill')
    expect(first.inject![0]).toMatch(/^- office-documents: Read Word .* Use when: a material or project file is a \.docx/m)
    expect(first.inject![0]).toMatch(/^- spreadsheets: /m)
    // Same list, same session: nothing. Another session: injected.
    expect(await provider.beginTurn(input('s1'))).toEqual({})
    expect((await provider.beginTurn(input('s2'))).inject).toHaveLength(1)
    // The list changes (a project skill appears): injected again once.
    await writeProjectSkill(root, 'extra', skillText('extra'))
    const changed = await provider.beginTurn(input('s1'))
    expect(changed.inject![0]).toContain('- extra: Does extra.')
    expect(await provider.beginTurn(input('s1'))).toEqual({})
    expect(renderSkillList([{ name: 'a', description: 'A.', source: 'project', path: '/a' }])).toMatch(/\n- a: A\.$/)
  })
})
