import { describe, expect, it } from 'vitest'
import { parseSkillFile, splitFrontMatter } from '../src/index.js'

describe('SKILL.md front matter', () => {
  it('parses name, description, when_to_use and tools, and returns the body', () => {
    const parsed = parseSkillFile(
      '---\nname: csv-report\ndescription: Build a CSV report.\nwhen_to_use: the user asks for a report\ntools: [read_file, write_file]\nextra: ignored\n---\n\n# Steps\n1. Read.\n',
      '/p/SKILL.md',
      'project',
    )
    expect(parsed).toEqual({
      ok: true,
      manifest: { name: 'csv-report', description: 'Build a CSV report.', whenToUse: 'the user asks for a report', source: 'project', path: '/p/SKILL.md', tools: ['read_file', 'write_file'] },
      body: '# Steps\n1. Read.\n',
    })
  })

  it('accepts a BOM, CRLF line ends and folds a multi-line description into one line', () => {
    const parsed = parseSkillFile('﻿---\r\nname: a\r\ndescription: >\r\n  first\r\n  second\r\n---\r\nbody', '/a', 'builtin')
    expect(parsed).toMatchObject({ ok: true, manifest: { name: 'a', description: 'first second' }, body: 'body' })
    expect(splitFrontMatter('---\nname: x\n---')).toEqual({ yaml: 'name: x', body: '' })
  })

  it.each([
    ['no front matter', '# Title\nname: x', /missing front matter/],
    ['invalid YAML', '---\nname: [x\n---\n', /invalid YAML/],
    ['a list instead of a mapping', '---\n- a\n---\n', /mapping/],
    ['a bad name', '---\nname: Bad_Name\ndescription: d\n---\n', /name must match/],
    ['a missing name', '---\ndescription: d\n---\n', /name must match/],
    ['a missing description', '---\nname: x\n---\n', /description is required/],
    ['a blank description', '---\nname: x\ndescription: "  "\n---\n', /description is required/],
    ['tools not an array of strings', '---\nname: x\ndescription: d\ntools: [1]\n---\n', /tools must be/],
    ['when_to_use not a string', '---\nname: x\ndescription: d\nwhen_to_use: [a]\n---\n', /when_to_use/],
  ])('rejects %s', (_label, text, reason) => {
    const parsed = parseSkillFile(text, '/x', 'project')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.reason).toMatch(reason)
  })
})
