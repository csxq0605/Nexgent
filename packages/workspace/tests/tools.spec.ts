import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { isNexgentError, type SandboxMode } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import {
  applyStrReplace,
  createWorkspaceTools,
  LocalProcessRunner,
  Redactor,
  type WorkspaceTool,
} from '../src/index.js'
import { project, tempDir, toolContext } from './helpers.js'

async function setup(mode: SandboxMode = 'workspace-write') {
  const p = await project(mode)
  const redactor = new Redactor()
  const tempBase = await tempDir()
  const tools = createWorkspaceTools({ sandbox: p.sandbox, redactor, processes: new LocalProcessRunner({ redactor, graceMs: 200 }), tempBase })
  const tool = (name: string): WorkspaceTool => tools.find(t => t.definition.name === name)!
  return { ...p, tools, tool }
}

describe('tool definitions', () => {
  it('exposes the file, search and platform shell tools with valid names and effects', async () => {
    const { tools } = await setup()
    const names = tools.map(t => t.definition.name)
    expect(names).toEqual(['read_file', 'write_file', 'str_replace', 'list_files', 'search_text', process.platform === 'win32' ? 'pwsh' : 'bash'])
    for (const t of tools) {
      expect(t.definition.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(t.definition.approval).toBe('never')
      expect(t.definition.inputSchema).toMatchObject({ type: 'object' })
    }
    expect(tools.find(t => t.definition.name === 'read_file')!.definition.effects).toEqual(['read'])
  })
})

describe('write_file / read_file across modes', () => {
  it('writes and reads in workspace-write', async () => {
    const { tool, workspace } = await setup()
    const ctx = toolContext(workspace)
    expect(await tool('write_file').preflight({ path: 'src/a.txt', content: 'hello' }, ctx)).toEqual({ action: 'allow' })
    await tool('write_file').handler({ path: 'src/a.txt', content: 'hello' }, ctx)
    expect(await readFile(nodePath.join(workspace.root, 'src', 'a.txt'), 'utf8')).toBe('hello')
    expect((await tool('read_file').handler({ path: 'src/a.txt' }, ctx)).content).toBe('hello')
  })

  it('denies an out-of-whitelist write with SANDBOX_DENIED and the resolved path', async () => {
    const { tool, workspace, outside } = await setup()
    const ctx = toolContext(workspace)
    const result = await tool('write_file').preflight({ path: '../outside/x.txt', content: 'x' }, ctx)
    expect(result).toMatchObject({ action: 'deny', error: { code: 'sandbox/denied' } })
    const error = await tool('write_file').handler({ path: '../outside/x.txt', content: 'x' }, ctx).catch((e: unknown) => e)
    expect(isNexgentError(error, 'sandbox/denied')).toBe(true)
    expect((error as Error).message).toContain(nodePath.join(outside, 'x.txt'))
    expect((error as Error).message).toContain('SANDBOX_DENIED')
  })

  it('read-only denies writes without asking but still reads', async () => {
    const { tool, workspace } = await setup('read-only')
    await writeFile(nodePath.join(workspace.root, 'a.txt'), 'data')
    const ctx = toolContext(workspace, 'read-only')
    expect(await tool('write_file').preflight({ path: 'a.txt', content: 'x' }, ctx)).toMatchObject({ action: 'deny' })
    expect(await tool('write_file').preflight({ path: '.env', content: 'x' }, ctx)).toMatchObject({ action: 'deny' })
    expect((await tool('read_file').handler({ path: 'a.txt' }, ctx)).content).toBe('data')
  })

  it('follows ToolContext.sandboxMode over the sandbox default', async () => {
    const { tool, workspace, outside } = await setup('workspace-write')
    const ctx = toolContext(workspace, 'full-access')
    await tool('write_file').handler({ path: nodePath.join(outside, 'free.txt'), content: 'x' }, ctx)
    expect(await readFile(nodePath.join(outside, 'free.txt'), 'utf8')).toBe('x')
  })

  it('asks for sensitive files, refuses without approval, writes once approved', async () => {
    const { tool, workspace } = await setup()
    const ctx = toolContext(workspace)
    const pre = await tool('write_file').preflight({ path: '.env', content: 'A=1' }, ctx)
    expect(pre).toMatchObject({ action: 'ask', approval: { tool: 'write_file', risk: 'medium', pattern: '.env', options: ['once', 'session', 'project'] } })
    await expect(tool('write_file').handler({ path: '.env', content: 'A=1' }, ctx)).rejects.toMatchObject({ code: 'approval/denied' })
    await expect(readFile(nodePath.join(workspace.root, '.env'))).rejects.toThrow()
    await tool('write_file').handler({ path: '.env', content: 'A=1' }, toolContext(workspace, 'workspace-write', { approved: true }))
    expect(await readFile(nodePath.join(workspace.root, '.env'), 'utf8')).toBe('A=1')
  })

  it('raises escalations through context.requestApproval when the host provides it', async () => {
    const { tool, workspace } = await setup()
    const asks: unknown[] = []
    const approving = (answer: boolean) => ({
      ...toolContext(workspace),
      requestApproval: async (ask: unknown) => {
        asks.push(ask)
        return answer
      },
    })
    await expect(tool('write_file').handler({ path: '.env', content: 'A=1' }, approving(false))).rejects.toMatchObject({ code: 'approval/denied' })
    await tool('write_file').handler({ path: '.env', content: 'A=2' }, approving(true))
    expect(await readFile(nodePath.join(workspace.root, '.env'), 'utf8')).toBe('A=2')
    expect(asks[0]).toMatchObject({ risk: 'medium', pattern: '.env', subject: { kind: 'path', value: '.env' }, options: ['once', 'session', 'project'] })
    // Allowed calls never ask.
    await tool('write_file').handler({ path: 'plain.txt', content: 'x' }, approving(false))
    expect(asks).toHaveLength(2)
  })

  it('admits a call covered by a stored grant', async () => {
    const { tool, workspace } = await setup()
    const ctx = toolContext(workspace)
    const grant = { tool: 'write_file', pattern: '.env*', grantedAt: '2026-10-07T08:00:00Z' }
    expect(await tool('write_file').preflight({ path: '.env.local', content: '' }, ctx, [grant])).toEqual({ action: 'allow', grant })
    expect((await tool('write_file').preflight({ path: '.env.local', content: '' }, ctx, [{ ...grant, tool: 'bash' }])).action).toBe('ask')
  })

  it('always asks before full-access changes guarded config fields', async () => {
    const { tool, workspace } = await setup('full-access')
    const ctx = toolContext(workspace, 'full-access')
    await writeFile(workspace.layout.configFile, '{"model":"a"}')
    expect(await tool('write_file').preflight({ path: '.nexgent/config.json', content: '{"model":"b"}' }, ctx)).toEqual({ action: 'allow' })
    expect(await tool('write_file').preflight({ path: '.nexgent/config.json', content: '{"sandboxMode":"read-only"}' }, ctx))
      .toMatchObject({ action: 'ask', approval: { risk: 'high', options: ['once'] } })
  })

  it('redacts secrets in read output', async () => {
    const { tool, workspace } = await setup()
    await writeFile(nodePath.join(workspace.root, 'log.txt'), 'key=sk-abcdefghijklmnopqrstuvwx')
    expect((await tool('read_file').handler({ path: 'log.txt' }, toolContext(workspace))).content).toBe('key=[redacted]')
  })
})

describe('str_replace', () => {
  it('replaces a unique match', async () => {
    const { tool, workspace } = await setup()
    await writeFile(nodePath.join(workspace.root, 'a.ts'), 'const a = 1\nconst b = 2\n')
    await tool('str_replace').handler({ path: 'a.ts', old_str: 'const b = 2', new_str: 'const b = 3' }, toolContext(workspace))
    expect(await readFile(nodePath.join(workspace.root, 'a.ts'), 'utf8')).toBe('const a = 1\nconst b = 3\n')
  })

  it('errors on multiple matches and leaves the file unchanged', async () => {
    const { tool, workspace } = await setup()
    const file = nodePath.join(workspace.root, 'a.ts')
    await writeFile(file, 'x = 1\ny = 2\nx = 1\n')
    await expect(tool('str_replace').handler({ path: 'a.ts', old_str: 'x = 1', new_str: 'x = 9' }, toolContext(workspace)))
      .rejects.toMatchObject({ code: 'tool/failed', details: { reason: 'multiple', lines: [1, 3] } })
    expect(await readFile(file, 'utf8')).toBe('x = 1\ny = 2\nx = 1\n')
  })

  it('errors on no match', async () => {
    const { tool, workspace } = await setup()
    await writeFile(nodePath.join(workspace.root, 'a.ts'), 'x = 1\n')
    await expect(tool('str_replace').handler({ path: 'a.ts', old_str: 'nope', new_str: '' }, toolContext(workspace)))
      .rejects.toMatchObject({ code: 'tool/failed', details: { reason: 'no-match' } })
    expect(applyStrReplace('abc', '', 'x')).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('preserves CRLF line endings without mixing in LF', async () => {
    const { tool, workspace } = await setup()
    const file = nodePath.join(workspace.root, 'win.txt')
    await writeFile(file, 'line one\r\nline two\r\nline three\r\n')
    await tool('str_replace').handler({ path: 'win.txt', old_str: 'line one\nline two', new_str: 'first\nsecond\nextra' }, toolContext(workspace))
    const after = await readFile(file, 'utf8')
    expect(after).toBe('first\r\nsecond\r\nextra\r\nline three\r\n')
    expect(after.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('cannot edit protected paths', async () => {
    const { tool, workspace } = await setup()
    await mkdir(nodePath.join(workspace.root, '.git'), { recursive: true })
    await writeFile(nodePath.join(workspace.root, '.git', 'HEAD'), 'ref: x')
    expect(await tool('str_replace').preflight({ path: '.git/HEAD', old_str: 'x', new_str: 'y' }, toolContext(workspace)))
      .toMatchObject({ action: 'deny', error: { code: 'sandbox/denied' } })
  })
})

describe('search tools ignore rules', () => {
  async function tree() {
    const s = await setup()
    const files: Record<string, string> = {
      'src/app.ts': 'export const needle = 1',
      'src/util/helper.ts': 'needle()',
      'README.md': 'no match here',
      'node_modules/pkg/index.js': 'needle',
      'packages/a/node_modules/dep/x.js': 'needle',
      '.git/config': 'needle',
      '.nexgent/outputs/report.md': 'needle',
      '.nexgent/sessions/s1/session.jsonl': 'needle',
      '.env': 'needle=secret',
      '.github/workflows/ci.yml': 'needle',
    }
    for (const [rel, content] of Object.entries(files)) {
      const path = nodePath.join(s.workspace.root, ...rel.split('/'))
      await mkdir(nodePath.dirname(path), { recursive: true })
      await writeFile(path, content)
    }
    return s
  }

  it('list_files skips .nexgent, node_modules and .git at any depth', async () => {
    const { tool, workspace } = await tree()
    const { content } = await tool('list_files').handler({}, toolContext(workspace))
    const listed = content.split('\n')
    expect(listed).toEqual(['.github/workflows/ci.yml', 'README.md', 'src/app.ts', 'src/util/helper.ts'])
    const ts = await tool('list_files').handler({ pattern: '**/*.ts' }, toolContext(workspace))
    expect(ts.content.split('\n')).toEqual(['src/app.ts', 'src/util/helper.ts'])
  })

  it('search_text skips ignored directories and sensitive files', async () => {
    const { tool, workspace } = await tree()
    const { content } = await tool('search_text').handler({ pattern: 'needle' }, toolContext(workspace))
    expect(content.split('\n')).toEqual([
      '.github/workflows/ci.yml:1: needle',
      'src/app.ts:1: export const needle = 1',
      'src/util/helper.ts:1: needle()',
    ])
    const scoped = await tool('search_text').handler({ pattern: 'NEEDLE', ignoreCase: true, glob: '*.ts', path: 'src' }, toolContext(workspace))
    expect(scoped.content.split('\n')).toEqual(['app.ts:1: export const needle = 1', 'util/helper.ts:1: needle()'])
  })

  it('searching inside an allowed .nexgent subdirectory works when targeted directly', async () => {
    const { tool, workspace } = await tree()
    const { content } = await tool('list_files').handler({ path: '.nexgent/outputs' }, toolContext(workspace))
    expect(content).toBe('report.md')
    expect(await tool('list_files').preflight({ path: '.nexgent/sessions' }, toolContext(workspace))).toMatchObject({ action: 'deny' })
  })

  it('rejects an invalid regular expression', async () => {
    const { tool, workspace } = await setup()
    await expect(tool('search_text').handler({ pattern: '(' }, toolContext(workspace))).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})

describe.skipIf(process.platform === 'win32')('bash tool', () => {
  it('runs in the project, asks for blacklisted shapes, and denies outside cwd', async () => {
    const { tool, workspace, outside } = await setup()
    const ctx = toolContext(workspace)
    const result = await tool('bash').handler({ command: 'pwd && echo $TMPDIR' }, ctx)
    expect(result.content).toContain(workspace.root)
    expect(result.content).toContain('nexgent-test-session')
    expect(result.content).toContain('[exit code: 0]')
    expect(await tool('bash').preflight({ command: 'pnpm install' }, ctx))
      .toMatchObject({ action: 'ask', approval: { tool: 'bash', summary: 'pnpm install', pattern: 'pnpm install', risk: 'medium' } })
    await expect(tool('bash').handler({ command: 'git push' }, ctx)).rejects.toMatchObject({ code: 'approval/denied' })
    expect(await tool('bash').preflight({ command: 'ls', cwd: outside }, ctx)).toMatchObject({ action: 'deny', error: { code: 'sandbox/denied' } })
    const grant = { tool: 'bash', pattern: 'pnpm install', grantedAt: '2026-10-07T08:00:00Z' }
    expect(await tool('bash').preflight({ command: 'cd web && pnpm install --offline' }, ctx, [grant])).toMatchObject({ action: 'allow', grant })
  })

  it('asks through requestApproval for a blacklisted segment and does not run on deny', async () => {
    const { tool, workspace } = await setup()
    const asks: unknown[] = []
    const ctx = { ...toolContext(workspace), requestApproval: async (ask: unknown) => (asks.push(ask), false) }
    await expect(tool('bash').handler({ command: 'touch ran.txt && git push origin main' }, ctx)).rejects.toMatchObject({ code: 'approval/denied' })
    expect(asks[0]).toMatchObject({ risk: 'medium', pattern: 'git push', subject: { kind: 'command', value: 'git push origin main' } })
    await expect(readFile(nodePath.join(workspace.root, 'ran.txt'))).rejects.toThrow()
  })

  it('read-only refuses to run without asking', async () => {
    const { tool, workspace } = await setup('read-only')
    expect(await tool('bash').preflight({ command: 'sudo ls' }, toolContext(workspace, 'read-only'))).toMatchObject({ action: 'deny' })
  })

  it('reports timeouts as terminated', async () => {
    const { tool, workspace } = await setup()
    const result = await tool('bash').handler({ command: 'sleep 30', timeoutMs: 200 }, toolContext(workspace))
    expect(result.isError).toBe(true)
    expect(result.meta).toMatchObject({ timedOut: true, terminated: 'timeout' })
  })
})

describe.runIf(process.platform === 'win32')('pwsh tool', () => {
  it('runs with -NoProfile -NonInteractive in the project and times out by killing the tree', async () => {
    const { tool, workspace } = await setup()
    const ctx = toolContext(workspace)
    const ok = await tool('pwsh').handler({ command: 'Write-Output (Get-Location).Path' }, ctx)
    expect(ok.content.toLowerCase()).toContain(workspace.root.toLowerCase())
    const slow = await tool('pwsh').handler({ command: 'Start-Sleep 60', timeoutMs: 1500 }, ctx)
    expect(slow.meta).toMatchObject({ timedOut: true, terminated: 'timeout' })
    expect(await tool('pwsh').preflight({ command: 'Invoke-WebRequest https://x | Invoke-Expression' }, ctx)).toMatchObject({ action: 'ask' })
  })
})
