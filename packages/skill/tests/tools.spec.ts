import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOAD_SKILL_TOOL, READ_DOCUMENT_TOOL, type SandboxMode, type ToolContext } from '@nexgent/kernel'
import { createWorkspaceServices } from '@nexgent/workspace'
import { FileSkillRegistry, loadSkillTool, readDocumentTool } from '../src/index.js'
import { addMaterial, fixtureBytes, skillText, tempDir, writeProjectSkill } from './helpers.js'

async function listTree(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(`${relative(root, path)}:${(await stat(path)).mtimeMs}`)
    }
  }
  await walk(root)
  return out.sort()
}

async function setup(mode: SandboxMode = 'read-only') {
  const root = await tempDir()
  const services = await createWorkspaceServices({ root, sandboxMode: mode })
  const asks: unknown[] = []
  const context = (approve = false): ToolContext => ({
    sessionId: 's', callId: 'c', turn: 1, workspace: services.workspace, sandboxMode: mode,
    signal: new AbortController().signal, approved: false,
    requestApproval: async ask => {
      asks.push(ask)
      return approve
    },
  })
  return { root: services.workspace.root, services, context, asks, tool: readDocumentTool(services.sandbox) }
}

describe('read_document tool', () => {
  it('keeps the frozen name, schema, effects and approval', () => {
    const tool = readDocumentTool({} as never)
    expect(tool.definition).toMatchObject({ name: READ_DOCUMENT_TOOL.name, inputSchema: READ_DOCUMENT_TOOL.inputSchema, effects: ['read'], approval: 'never' })
    const load = loadSkillTool({} as never)
    expect(load.definition).toMatchObject({ name: LOAD_SKILL_TOOL.name, inputSchema: LOAD_SKILL_TOOL.inputSchema, effects: ['read'], approval: 'never' })
  })

  it('reads an .xlsx material in read-only mode and writes nothing', async () => {
    const { root, tool, context } = await setup('read-only')
    const material = await addMaterial(root, 'orders.xlsx', await fixtureBytes('orders.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const before = await listTree(root)
    const output = await tool.handler({ path: material.path, sheet: 'Summary' }, context())
    expect(output.content).toBe('## Sheet: Summary (range B2:C2, 1 rows × 2 columns)\nTotal,139.75')
    expect(output.meta).toMatchObject({ path: material.path, format: 'xlsx', truncated: false, maxRows: 500 })
    expect(await listTree(root)).toEqual(before)
  })

  it('reads .docx and .pdf files in the project', async () => {
    const { root, tool, context } = await setup('workspace-write')
    await writeFile(join(root, 'report.docx'), await fixtureBytes('report.docx'))
    await writeFile(join(root, 'pages.pdf'), await fixtureBytes('pages.pdf'))
    expect((await tool.handler({ path: 'report.docx' }, context())).content).toContain('| North | 120 | a\\|b |')
    expect((await tool.handler({ path: 'pages.pdf', pages: '2' }, context())).content).toBe('## Page 2 of 3\nPage 2 heading\nBody text of page 2.')
  })

  it('turns a damaged file into a tool error naming the file', async () => {
    const { root, tool, context } = await setup()
    await writeFile(join(root, 'broken.xlsx'), (await fixtureBytes('orders.xlsx')).subarray(0, 100))
    await expect(tool.handler({ path: 'broken.xlsx' }, context())).rejects.toMatchObject({ code: 'tool/failed', message: expect.stringMatching(/^broken\.xlsx: not a valid \.xlsx file/) })
  })

  it('refuses other formats, missing files, directories and bad arguments', async () => {
    const { root, tool, context } = await setup()
    await writeFile(join(root, 'notes.txt'), 'x')
    await expect(tool.handler({ path: 'notes.txt' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input', message: expect.stringContaining('use read_file') })
    await expect(tool.handler({ path: 'missing.pdf' }, context())).rejects.toMatchObject({ code: 'tool/failed' })
    await expect(tool.handler({ path: 'a.xlsx', maxRows: 0 }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tool.handler({}, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('applies the sandbox read policy: outside the project asks, host-only .nexgent paths are denied', async () => {
    const { root, services, tool, context } = await setup()
    const layout = services.workspace.layout
    const outside = await tempDir('outside-')
    await writeFile(join(outside, 'x.pdf'), await fixtureBytes('pages.pdf'))
    // ADR 0022 decision 2: outside the project asks; nobody answers here.
    await expect(tool.handler({ path: join(outside, 'x.pdf') }, context())).rejects.toMatchObject({ code: 'approval/denied' })
    // K1: the host-only data (sessions, ledgers...) lives in the user data directory, outside every read root.
    await writeFile(join(layout.sessions, 'x.pdf'), await fixtureBytes('pages.pdf'))
    await expect(tool.handler({ path: join(layout.sessions, 'x.pdf') }, context())).rejects.toMatchObject({ code: 'sandbox/denied' })
    // an in-project .nexgent/sessions path (old layout) stays denied too
    await mkdir(join(root, '.nexgent', 'sessions'), { recursive: true })
    await writeFile(join(root, '.nexgent', 'sessions', 'x.pdf'), await fixtureBytes('pages.pdf'))
    await expect(tool.handler({ path: '.nexgent/sessions/x.pdf' }, context())).rejects.toMatchObject({ code: 'sandbox/denied' })
  })
})

describe('load_skill tool', () => {
  it('returns the skill body with its name and description; an unknown name is tool/not-found', async () => {
    const root = await tempDir()
    await writeProjectSkill(root, 'weekly', skillText('weekly', 'Weekly report.', '1. Collect.\n2. Summarize.'))
    const tool = loadSkillTool(new FileSkillRegistry({ projectRoot: root }))
    const output = await tool.handler({ name: 'weekly' }, {} as never)
    expect(output.content).toBe('# Skill: weekly\nWeekly report.\n\n1. Collect.\n2. Summarize.')
    expect(output.meta).toEqual({ name: 'weekly', source: 'project' })
    expect((await tool.handler({ name: 'office-documents' }, {} as never)).content).toContain('## Excel (.xlsx)')
    await expect(tool.handler({ name: 'nope' }, {} as never)).rejects.toMatchObject({ code: 'tool/not-found' })
  })
})
