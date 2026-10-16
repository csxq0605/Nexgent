/**
 * `run_code` over a real workspace sandbox: the project host functions read
 * and write within the caller's sandbox, refuse paths outside it and the
 * host's `.nexgent/` data, and follow the session's mode.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_CODE_TOOL, type SandboxMode, type ToolContext } from '@nexgent/kernel'
import { createWorkspaceServices } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { runCodeTool } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix = 'nexgent-ptc-tool-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function setup(mode: SandboxMode = 'workspace-write') {
  const root = await tempDir()
  const services = await createWorkspaceServices({ root, sandboxMode: mode })
  await services.workspace.ensureLayout()
  const asks: unknown[] = []
  const context = (options: { mode?: SandboxMode; approve?: boolean; signal?: AbortSignal } = {}): ToolContext => ({
    sessionId: 's1', callId: 'c1', turn: 1, workspace: services.workspace, sandboxMode: options.mode ?? mode,
    signal: options.signal ?? new AbortController().signal, approved: false,
    requestApproval: async ask => {
      asks.push(ask)
      return options.approve ?? false
    },
  })
  const tool = runCodeTool(services.sandbox)
  const run = (code: string, options: Parameters<typeof context>[0] = {}, extra: Record<string, unknown> = {}) => tool.handler({ code, ...extra }, context(options))
  return { root: services.workspace.root, tool, run, asks }
}

describe('run_code', () => {
  it('uses the contract name, schema, effects and approval', async () => {
    const { tool } = await setup()
    expect(tool.definition).toMatchObject({ name: 'run_code', inputSchema: RUN_CODE_TOOL.inputSchema, effects: ['read', 'write', 'execute'], approval: 'never', selfSandboxed: true })
    expect(tool.definition.description).toContain('readFile')
    expect(tool.definition.description).not.toMatch(/spreadsheet/i)
  })

  it('reads and writes project files through host functions and returns the result', async () => {
    const { root, run } = await setup()
    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'data', 'numbers.txt'), '3\n4\n5\n')
    const output = await run(`
      const numbers = (await readFile('data/numbers.txt')).trim().split('\\n').map(Number)
      const total = numbers.reduce((a, b) => a + b, 0)
      const written = await writeFile('out/total.txt', String(total))
      console.log('total', total)
      return { total, written, listing: await listDir('data'), there: await exists('out/total.txt') }`)
    expect(output.isError).toBe(false)
    expect(output.content).toContain('Output:\ntotal 12')
    expect(output.content).toContain('"total": 12')
    expect(await readFile(join(root, 'out', 'total.txt'), 'utf8')).toBe('12')
    expect(output.meta).toMatchObject({ status: 'completed', calls: 4 })
    // An existing file is replaced only with overwrite: true.
    const again = await run(`try { await writeFile('out/total.txt', 'x') } catch (error) { return error.message }`)
    expect(again.content).toContain('already exists; pass { overwrite: true }')
    await run(`await writeFile('out/total.txt', 'x', { overwrite: true })`)
    expect(await readFile(join(root, 'out', 'total.txt'), 'utf8')).toBe('x')
  })

  it('asks for files outside the project and refuses the host data under .nexgent/', async () => {
    const { root, run } = await setup()
    const outside = await tempDir('nexgent-ptc-outside-')
    await writeFile(join(outside, 'secret.txt'), 'outside secret')
    await mkdir(join(root, '.nexgent', 'sessions', 'x'), { recursive: true })
    await writeFile(join(root, '.nexgent', 'sessions', 'x', 'session.jsonl'), '{}\n')
    const output = await run(`
      const out = {}
      for (const [key, path] of Object.entries({ abs: ${JSON.stringify(join(outside, 'secret.txt'))}, up: '../${outside.split(/[\\/]/).pop()}/secret.txt', session: '.nexgent/sessions/x/session.jsonl' })) {
        try { out[key] = await readFile(path) } catch (error) { out[key] = error.message.split(':')[0] }
      }
      try { await writeFile(${JSON.stringify(join(outside, 'new.txt'))}, 'x') } catch (error) { out.write = error.message.split(':')[0] }
      return out`)
    expect(output.isError).toBe(false)
    expect(output.content).not.toContain('outside secret')
    // ADR 0022 decision 2: outside the project asks; nobody answers here, so it is not approved.
    expect(output.content).toContain('"abs": "approval/denied"')
    expect(output.content).toContain('"up": "approval/denied"')
    expect(output.content).toContain('"session": "sandbox/denied"')
    expect(output.content).toMatch(/"write": "(sandbox|approval)\/denied"/)
  })

  it('refuses every write in read-only mode but still runs read-only code', async () => {
    const { root, run } = await setup('read-only')
    await writeFile(join(root, 'a.txt'), 'hello')
    const output = await run(`
      const text = await readFile('a.txt')
      try { await writeFile('b.txt', text) } catch (error) { return { text, write: error.message } }`)
    expect(output.isError).toBe(false)
    expect(output.content).toContain('"text": "hello"')
    expect(output.content).toContain('sandbox/denied: SANDBOX_DENIED: write b.txt')
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow()
  })

  it('has no spreadsheet host functions (they are opt-in tools of the spreadsheets skill)', async () => {
    const { run } = await setup()
    for (const fn of ['readSpreadsheet', 'writeSpreadsheet']) {
      const output = await run(`return typeof ${fn}`)
      expect(output.isError).toBe(false)
      expect(output.content).toContain('"undefined"')
    }
    const called = await run("return await readSpreadsheet('a.xlsx')")
    expect(called.isError).toBe(true)
    expect(called.content).toContain('readSpreadsheet is not defined')
  })

  it('reports a timeout and a failure as errors with the output so far', async () => {
    const { run } = await setup()
    const slow = await run('console.log("before"); await new Promise(() => {})', {}, { timeoutMs: 1_000 })
    expect(slow.isError).toBe(true)
    expect(slow.content).toMatch(/^Timed out after \d+ ms/)
    expect(slow.content).toContain('before')
    const thrown = await run('const x = 1\nthrow new RangeError("too far")')
    expect(thrown.isError).toBe(true)
    expect(thrown.content).toContain('Failed after')
    expect(thrown.content).toContain('RangeError: too far')
    await expect(run('1', {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})
