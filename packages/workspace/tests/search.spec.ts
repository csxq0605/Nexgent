import { mkdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkspaceTools, LocalProcessRunner, Redactor, type WorkspaceTool } from '../src/index.js'
import { project, tempDir, toolContext } from './helpers.js'

async function setup(files: Record<string, string | Buffer>) {
  const p = await project()
  const redactor = new Redactor()
  const tools = createWorkspaceTools({ sandbox: p.sandbox, redactor, processes: new LocalProcessRunner({ redactor, graceMs: 200 }), tempBase: await tempDir() })
  const tool = (name: string): WorkspaceTool => tools.find(t => t.definition.name === name)!
  for (const [rel, content] of Object.entries(files)) {
    const path = nodePath.join(p.workspace.root, ...rel.split('/'))
    await mkdir(nodePath.dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  const ctx = toolContext(p.workspace)
  const search = async (args: Record<string, unknown>) => (await tool('search_text').handler(args, ctx)).content.split('\n')
  const list = async (args: Record<string, unknown> = {}) => (await tool('list_files').handler(args, ctx)).content.split('\n')
  return { ...p, tool, ctx, search, list }
}

describe('gitignore in search tools', () => {
  const files = {
    '.gitignore': 'dist/\n*.log\n!keep.log\n',
    'src/.gitignore': 'gen.ts\n',
    'src/a.ts': 'needle a',
    'src/gen.ts': 'needle gen',
    'gen.ts': 'needle root gen',
    'dist/out.js': 'needle dist',
    'x.log': 'needle log',
    'keep.log': 'needle keep',
    'node_modules/m/i.js': 'needle nm',
  }

  it('honours root and nested rules, negations, and lifts them with includeIgnored', async () => {
    const t = await setup(files)
    expect(await t.list()).toEqual(['.gitignore', 'gen.ts', 'keep.log', 'src/.gitignore', 'src/a.ts', '[5 files total]'])
    expect((await t.search({ pattern: 'needle' })).slice(0, 3)).toEqual(['gen.ts:1: needle root gen', 'keep.log:1: needle keep', 'src/a.ts:1: needle a'])
    const all = await t.list({ includeIgnored: true })
    expect(all).toContain('dist/out.js')
    expect(all).toContain('src/gen.ts')
    expect(all).toContain('x.log')
    expect(all).toContain('node_modules/m/i.js')
    const found = await t.search({ pattern: 'needle', includeIgnored: true, outputMode: 'files_with_matches' })
    expect(found).toContain('dist/out.js')
    expect(found).toContain('node_modules/m/i.js')
  })

  it('applies ancestor rules when searching a subdirectory, and .git/info/exclude', async () => {
    const t = await setup({ ...files, '.git/info/exclude': 'a.ts\n' })
    expect(await t.list({ path: 'src' })).toEqual(['.gitignore', '[1 files total]'])
    // searching inside an ignored directory itself still works
    expect(await t.search({ pattern: 'needle', path: 'dist' })).toEqual(['out.js:1: needle dist'])
  })
})

describe('search_text output', () => {
  const body = Array.from({ length: 12 }, (_, i) => `line${i + 1}${i + 1 === 3 || i + 1 === 9 ? ' hit' : ''}`).join('\n')

  it('prints context lines with separators', async () => {
    const t = await setup({ 'f.txt': body, 'g.txt': 'hit again' })
    expect(await t.search({ pattern: 'hit', context: 1 })).toEqual([
      'f.txt-2- line2', 'f.txt:3: line3 hit', 'f.txt-4- line4',
      '--',
      'f.txt-8- line8', 'f.txt:9: line9 hit', 'f.txt-10- line10',
      '--',
      'g.txt:1: hit again',
    ])
    expect(await t.search({ pattern: 'hit', path: '.', glob: 'f.txt', before: 2, after: 0 })).toEqual([
      'f.txt-1- line1', 'f.txt-2- line2', 'f.txt:3: line3 hit', '--', 'f.txt-7- line7', 'f.txt-8- line8', 'f.txt:9: line9 hit',
    ])
  })

  it('merges overlapping context windows without separators', async () => {
    const t = await setup({ 'f.txt': 'a hit\nb\nc hit\nd' })
    expect(await t.search({ pattern: 'hit', context: 1 })).toEqual(['f.txt:1: a hit', 'f.txt-2- b', 'f.txt:3: c hit', 'f.txt-4- d'])
  })

  it('supports files_with_matches and count modes', async () => {
    const t = await setup({ 'a.txt': 'x\nx\ny', 'b.txt': 'y', 'c.txt': 'x' })
    expect(await t.search({ pattern: 'x', outputMode: 'files_with_matches' })).toEqual(['a.txt', 'c.txt'])
    expect(await t.search({ pattern: 'x', outputMode: 'count' })).toEqual(['a.txt:2', 'c.txt:1', '[3 matches in 2 files]'])
    expect(await t.search({ pattern: 'zzz', outputMode: 'count' })).toEqual(['No matches.'])
  })

  it('is case insensitive on request and rejects bad modes', async () => {
    const t = await setup({ 'a.txt': 'Hello' })
    expect(await t.search({ pattern: 'hello' })).toEqual(['No matches.'])
    expect(await t.search({ pattern: 'hello', ignoreCase: true })).toEqual(['a.txt:1: Hello'])
    await expect(t.tool('search_text').handler({ pattern: 'x', outputMode: 'nope' }, t.ctx)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(t.tool('search_text').handler({ pattern: 'x', offset: -1 }, t.ctx)).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('pages with offset and limit and says how to continue', async () => {
    const t = await setup({ 'a.txt': 'm1\nm2\nm3', 'b.txt': 'm4\nm5' })
    expect(await t.search({ pattern: 'm', limit: 2 })).toEqual(['a.txt:1: m1', 'a.txt:2: m2', '[more results: pass offset 2]'])
    expect(await t.search({ pattern: 'm', limit: 2, offset: 2 })).toEqual(['a.txt:3: m3', 'b.txt:1: m4', '[more results: pass offset 4]'])
    expect(await t.search({ pattern: 'm', limit: 2, offset: 4 })).toEqual(['b.txt:2: m5'])
    expect(await t.search({ pattern: 'm', limit: 2, offset: 9 })).toEqual(['[offset 9 is past the last result]'])
    expect(await t.search({ pattern: 'm', outputMode: 'files_with_matches', limit: 1 })).toEqual(['a.txt', '[more results: pass offset 1]'])
    expect(await t.search({ pattern: 'm', outputMode: 'files_with_matches', limit: 1, offset: 1 })).toEqual(['b.txt'])
  })

  it('keeps maxResults as an alias of limit', async () => {
    const t = await setup({ 'a.txt': 'm1\nm2' })
    expect(await t.search({ pattern: 'm', maxResults: 1 })).toEqual(['a.txt:1: m1', '[more results: pass offset 1]'])
  })

  it('searches multiline patterns', async () => {
    const t = await setup({ 'a.txt': 'start\nmiddle\nend\nother' })
    expect(await t.search({ pattern: 'start.*end', multiline: true })).toEqual(['a.txt:1: start', 'a.txt:2: middle', 'a.txt:3: end'])
    expect(await t.search({ pattern: 'start.*end' })).toEqual(['No matches.'])
    expect(await t.search({ pattern: '^end$', multiline: true, context: 1 })).toEqual(['a.txt-2- middle', 'a.txt:3: end', 'a.txt-4- other'])
  })

  it('searches files over 1 MiB line by line, including CRLF and a final line without newline', async () => {
    const filler = 'padding line without the word\r\n'.repeat(50_000)
    const t = await setup({ 'big.log': `${filler}the needle is here\r\n${filler}last needle` })
    const out = await t.search({ pattern: 'needle' })
    expect(out).toEqual([`big.log:50001: the needle is here`, `big.log:100002: last needle`])
  })

  it('truncates very long printed lines', async () => {
    const t = await setup({ 'a.txt': `${'x'.repeat(500)}needle` })
    const out = await t.search({ pattern: 'x{400}' })
    expect(out[0]!.length).toBeLessThan(330)
    expect(out[0]).toContain('…')
  })

  it('skips binary files and reports how many', async () => {
    const t = await setup({ 'a.bin': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1, 2]), 'b.bin': Buffer.from([0, 0x6e]), 't.txt': 'needle' })
    expect(await t.search({ pattern: 'needle' })).toEqual(['t.txt:1: needle', '[skipped 2 binary files]'])
    expect(await t.search({ pattern: 'zzz' })).toEqual(['No matches.', '[skipped 2 binary files]'])
  })

  it('is deterministic with many files read concurrently', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`d${i % 3}/f${String(i).padStart(2, '0')}.txt`] = `hit ${i}`
    const t = await setup(files)
    const first = await t.search({ pattern: 'hit', outputMode: 'files_with_matches', limit: 100 })
    expect(first).toEqual(Object.keys(files).sort())
    expect(await t.search({ pattern: 'hit', outputMode: 'files_with_matches', limit: 100 })).toEqual(first)
  })
})

describe('sensitive files in search tools', () => {
  const files = { '.env': 'TOKEN=abc needle', '.env.example': 'needle=', 'id_rsa': 'needle key', 'a.ts': 'needle' }

  it('names skipped sensitive files at the end of search_text without reading them', async () => {
    const t = await setup(files)
    const out = await t.search({ pattern: 'needle' })
    expect(out[0]).toBe('.env.example:1: needle=')
    expect(out).toContain('a.ts:1: needle')
    expect(out.join('\n')).not.toContain('TOKEN')
    expect(out.at(-1)).toMatch(/^\[skipped 2 sensitive files, not searched .*: \.env, id_rsa\]$/)
  })

  it('does not name sensitive files that the glob excludes, and caps the list', async () => {
    const many: Record<string, string> = { 'a.ts': 'needle' }
    for (let i = 0; i < 25; i++) many[`s${String(i).padStart(2, '0')}.pem`] = 'needle'
    const t = await setup(many)
    expect((await t.search({ pattern: 'needle', glob: '*.ts' })).join('\n')).not.toContain('sensitive')
    const out = await t.search({ pattern: 'needle' })
    const last = out.at(-1)!
    expect(last).toContain('skipped 25 sensitive files')
    expect(last).toContain('s19.pem')
    expect(last).not.toContain('s20.pem')
    expect(last).toContain('(+5 more)')
  })

  it('lists sensitive files with a marker in list_files', async () => {
    const t = await setup(files)
    expect(await t.list()).toEqual([
      '.env  [sensitive: not read without approval]',
      '.env.example',
      'a.ts',
      'id_rsa  [sensitive: not read without approval]',
      '[4 files total]',
    ])
  })
})

describe('list_files paging', () => {
  it('sorts globally, pages with offset, and reports the total', async () => {
    const files: Record<string, string> = {}
    for (const n of ['b/z.ts', 'a-b.ts', 'a/x.ts', 'c.ts', 'a.ts', 'B.ts']) files[n] = 'x'
    const t = await setup(files)
    const all = await t.list()
    expect(all.slice(0, -1)).toEqual(Object.keys(files).sort())
    expect(await t.list({ limit: 2 })).toEqual(['B.ts', 'a-b.ts', '[showing 1-2 of 6 files; more results: pass offset 2]'])
    expect(await t.list({ limit: 2, offset: 4 })).toEqual(['b/z.ts', 'c.ts', '[showing 5-6 of 6 files total]'])
    expect(await t.list({ limit: 2, offset: 40 })).toEqual(['[offset 40 is past the end: 6 files total]'])
    expect(await t.list({ pattern: '*.nothing' })).toEqual(['No files found.'])
    const r = await t.tool('list_files').handler({ limit: 2 }, t.ctx)
    expect(r.meta).toMatchObject({ total: 6, count: 2, truncated: true })
  })
})

describe('search tool schemas', () => {
  it('declare the new fields and keep the tool names', async () => {
    const t = await setup({})
    const schema = t.tool('search_text').definition.inputSchema as { properties: Record<string, unknown>; required: string[] }
    for (const key of ['outputMode', 'before', 'after', 'context', 'multiline', 'offset', 'limit', 'includeIgnored', 'ignoreCase', 'glob']) {
      expect(schema.properties).toHaveProperty(key)
    }
    expect(schema.required).toEqual(['pattern'])
    const list = t.tool('list_files').definition.inputSchema as { properties: Record<string, unknown> }
    for (const key of ['offset', 'limit', 'includeIgnored']) expect(list.properties).toHaveProperty(key)
  })
})
