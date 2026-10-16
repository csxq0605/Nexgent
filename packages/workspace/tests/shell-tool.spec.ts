import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BackgroundShells,
  capStreams,
  capText,
  createWorkspaceTools,
  HeadTailBuffer,
  LocalProcessRunner,
  MODEL_OUTPUT_CHARS,
  Redactor,
  requestsUnsandboxed,
  backgroundShellsFor,
  type ShellSandboxDeps,
  type ShellToolDeps,
  type WorkspaceTool,
} from '../src/index.js'
import { createOsSandbox } from '../src/os-sandbox.js'
import { pidAlive, project, tempDir, toolContext } from './helpers.js'

const posix = process.platform !== 'win32'
const hasBwrap = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0 && spawnSync('socat', ['-V']).status === 0

async function setup(os?: (root: string) => ShellSandboxDeps) {
  const p = await project()
  const redactor = new Redactor()
  const tempBase = await tempDir()
  const deps: ShellToolDeps = {
    sandbox: p.sandbox,
    redactor,
    processes: new LocalProcessRunner({ redactor, graceMs: 200 }),
    tempBase,
    ...(os === undefined ? {} : { os: os(p.workspace.root) }),
  }
  const tools = createWorkspaceTools(deps)
  const tool = (name: string): WorkspaceTool => tools.find(t => t.definition.name === name)!
  return { ...p, deps, tool, tempBase }
}

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

describe('output cap', () => {
  it('keeps head and tail of a text and says how much was omitted', () => {
    const text = `${'a'.repeat(20_000)}${'b'.repeat(20_000)}`
    const capped = capText(text, 30_000)
    expect(capped.truncated).toBe(true)
    expect(capped.text.length).toBeLessThan(30_100)
    expect(capped.text.startsWith('a'.repeat(15_000))).toBe(true)
    expect(capped.text.endsWith('b'.repeat(15_000))).toBe(true)
    expect(capped.text).toContain('[nexgent: 10000 chars omitted from the middle]')
    expect(capText('short', 30_000)).toEqual({ text: 'short', truncated: false })
  })

  it('does not split surrogate pairs', () => {
    const capped = capText('😀'.repeat(100), 51)
    expect(capped.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('budgets stdout and stderr together', () => {
    const { stdout, stderr, truncated } = capStreams('o'.repeat(50_000), 'e'.repeat(2_000))
    expect(truncated).toBe(true)
    expect(stderr).toBe('e'.repeat(2_000))
    expect(stdout.length + stderr.length).toBeLessThan(MODEL_OUTPUT_CHARS + 100)
  })

  it('HeadTailBuffer keeps the first and last bytes', () => {
    const buffer = new HeadTailBuffer(10)
    buffer.push(Buffer.from('0123456789ABCDEFGHIJ'))
    expect(buffer.dropped).toBe(10)
    expect(buffer.text()).toBe('01234\n[nexgent: 10 bytes omitted from the middle]\nFGHIJ')
    const small = new HeadTailBuffer(10)
    small.push(Buffer.from('abc'))
    small.push(Buffer.from('def'))
    expect(small.text()).toBe('abcdef')
  })
})

describe.skipIf(!posix)('bash tool output', () => {
  it('caps large output, keeps head and tail, saves the complete output to the session temp dir', async () => {
    const { tool, workspace } = await setup()
    const result = await tool('bash').handler({ command: 'echo HEAD; seq 1 40000; echo TAIL >&2' }, toolContext(workspace))
    expect(result.content.length).toBeLessThan(MODEL_OUTPUT_CHARS + 1000)
    expect(result.content).toMatch(/^HEAD\n1\n2\n/)
    expect(result.content).toContain('[nexgent:')
    expect(result.content).toContain('40000')
    expect(result.content).toContain('[stderr]\nTAIL')
    const path = /stdout: (\S+\.stdout\.log)/.exec(result.content)?.[1]
    expect(path).toBeDefined()
    expect(path).toContain('nexgent-test-session')
    const full = await readFile(path!, 'utf8')
    expect(full.startsWith('HEAD\n1\n')).toBe(true)
    expect(full.endsWith('\n40000\n')).toBe(true)
    expect(result.meta).toMatchObject({ truncated: true })
  })

  it('does not leave files or notes for small output, and redacts secrets', async () => {
    const { tool, workspace, tempBase } = await setup()
    const result = await tool('bash').handler({ command: 'echo hi sk-ABCDEFGHIJKLMNOPQRST' }, toolContext(workspace))
    expect(result.content).toBe('hi [redacted]\n[exit code: 0]')
    const dir = nodePath.join(tempBase, 'nexgent-test-session')
    expect(spawnSync('sh', ['-c', `ls ${dir}`], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })

  it('mentions sandbox and background options in the description', async () => {
    const { tool } = await setup()
    const { description } = tool('bash').definition
    expect(description).toContain('run_in_background')
    expect(description).toContain('sandbox:false')
    expect(description).toContain('30000')
  })
})

describe.skipIf(!posix)('background shell', () => {
  it('returns at once, reads new output incrementally, and reports the exit code', async () => {
    const { tool, workspace, deps } = await setup()
    disposers.push(() => backgroundShellsFor(deps).disposeAll())
    const ctx = toolContext(workspace)
    const started = await tool('bash').handler({ command: 'echo one; sleep 0.4; echo two; sleep 0.4; exit 7', run_in_background: true }, ctx)
    const id = /background process (bg-\d+)/.exec(started.content)?.[1]
    expect(id).toBeDefined()
    expect(started.meta).toMatchObject({ background: true, id })
    let first = ''
    for (let i = 0; i < 50 && !first.includes('one'); i++) {
      await new Promise(r => setTimeout(r, 50))
      first = (await tool('shell_output').handler({ id }, ctx)).content
    }
    expect(first).toContain('one')
    expect(first).toContain('[status: running')
    let rest = ''
    for (let i = 0; i < 80 && !rest.includes('exited'); i++) {
      await new Promise(r => setTimeout(r, 50))
      rest += (await tool('shell_output').handler({ id }, ctx)).content
    }
    expect(rest).toContain('two')
    expect(rest).not.toContain('one\n')
    expect(rest).toContain('exited with code 7')
    expect((await tool('shell_output').handler({ id }, ctx)).content).not.toContain('two')
  })

  it('shell_kill ends the whole tree', async () => {
    const { tool, workspace, deps } = await setup()
    disposers.push(() => backgroundShellsFor(deps).disposeAll())
    const ctx = toolContext(workspace)
    const started = await tool('bash').handler({ command: 'sleep 600 & echo $!; wait', run_in_background: true }, ctx)
    const id = /(bg-\d+)/.exec(started.content)![1]!
    let pid = 0
    for (let i = 0; i < 50 && pid === 0; i++) {
      await new Promise(r => setTimeout(r, 50))
      pid = Number(/^(\d+)/m.exec((await tool('shell_output').handler({ id }, ctx)).content)?.[1] ?? 0)
    }
    expect(pid).toBeGreaterThan(0)
    expect(pidAlive(pid)).toBe(true)
    const killed = await tool('shell_kill').handler({ id }, ctx)
    expect(killed.content).toContain('killed')
    expect(pidAlive(pid)).toBe(false)
  })

  it('disposeSession kills the processes of that session only', async () => {
    const dir = await tempDir()
    const shells = new BackgroundShells({ graceMs: 200 })
    disposers.push(() => shells.disposeAll())
    const start = (sessionId: string) => shells.start({ sessionId, command: 'bash', args: ['-c', 'sleep 600 & echo $!; wait'], cwd: dir, label: 'x', logPath: nodePath.join(dir, `${sessionId}.log`) })
    const a = start('s1')
    const b = start('s2')
    const pids: Record<string, number> = {}
    for (const [session, status] of [['s1', a], ['s2', b]] as const) {
      for (let i = 0; i < 50 && pids[session] === undefined; i++) {
        await new Promise(r => setTimeout(r, 50))
        const n = Number(/^(\d+)/m.exec(shells.read(session, status.id)?.output ?? '')?.[1])
        if (n > 0) pids[session] = n
      }
    }
    expect(shells.read('s2', a.id)).toBeUndefined()
    await shells.disposeSession('s1')
    expect(pidAlive(pids.s1!)).toBe(false)
    expect(pidAlive(pids.s2!)).toBe(true)
    expect(shells.list('s1')).toEqual([])
    await shells.disposeSession('s2')
    expect(pidAlive(pids.s2!)).toBe(false)
  })

  it('unknown ids are an input error', async () => {
    const { tool, workspace } = await setup()
    await expect(tool('shell_output').handler({ id: 'bg-99' }, toolContext(workspace))).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tool('shell_kill').handler({ id: 'bg-99' }, toolContext(workspace))).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('redacts secrets that are split across chunks', async () => {
    const dir = await tempDir()
    const shells = new BackgroundShells({ graceMs: 200 })
    disposers.push(() => shells.disposeAll())
    const log = nodePath.join(dir, 'l.log')
    const status = shells.start({ sessionId: 's', command: 'bash', args: ['-c', 'printf "key sk-ABCDEFGH"; sleep 0.2; echo IJKLMNOPQRST done'], cwd: dir, label: 'x', logPath: log })
    let all = ''
    for (let i = 0; i < 60 && !all.includes('done'); i++) {
      await new Promise(r => setTimeout(r, 50))
      all += shells.read('s', status.id)?.output ?? ''
    }
    expect(all).toBe('key [redacted] done\n')
    expect(await readFile(log, 'utf8')).toBe('key [redacted] done\n')
  })
})

describe('unsandboxed request', () => {
  it('is read from the input', () => {
    expect(requestsUnsandboxed({ command: 'ls', sandbox: false })).toBe(true)
    expect(requestsUnsandboxed({ command: 'ls', sandbox: true })).toBe(false)
    expect(requestsUnsandboxed({ command: 'ls' })).toBe(false)
  })
})

describe.skipIf(!hasBwrap)('bash tool in the OS sandbox', () => {
  async function sandboxed(extra: Partial<ShellSandboxDeps> & { required?: boolean; network?: boolean; readOnly?: boolean } = {}) {
    const osSandbox = createOsSandbox()
    disposers.push(() => osSandbox.dispose())
    const home = await tempDir('nxhome-')
    const protectedDir = nodePath.join(home, '.ssh')
    await mkdir(protectedDir, { recursive: true })
    const s = await setup(root => ({
      sandbox: osSandbox,
      inputs: () => ({
        enabled: true,
        required: extra.required ?? false,
        projectRoot: root,
        readOnly: extra.readOnly ?? false,
        extraWriteRoots: [],
        denyRead: [protectedDir],
        network: extra.network ?? true,
      }),
      ...(extra.approveUnsandboxed === undefined ? {} : { approveUnsandboxed: extra.approveUnsandboxed }),
    }))
    return { ...s, protectedDir }
  }

  it('runs inside the project, blocks outside writes and tells the model why', async () => {
    const { tool, workspace, outside } = await sandboxed()
    const ctx = toolContext(workspace)
    const ok = await tool('bash').handler({ command: 'echo fine > inside.txt && cat inside.txt' }, ctx)
    expect(ok.content).toContain('fine')
    expect(ok.meta).toMatchObject({ sandboxed: true, exitCode: 0 })
    const bad = await tool('bash').handler({ command: `echo x > ${outside}/leak.txt` }, ctx)
    expect(bad.meta).toMatchObject({ sandboxed: true })
    expect(bad.content).not.toContain('[exit code: 0]')
    expect(bad.content).toContain('sandbox_violations')
    await expect(readFile(nodePath.join(outside, 'leak.txt'), 'utf8')).rejects.toThrow()
  })

  it('blocks the project .nexgent directory and credential directories', async () => {
    const { tool, workspace, protectedDir } = await sandboxed()
    const ctx = toolContext(workspace)
    const nx = await tool('bash').handler({ command: 'echo x > .nexgent/hack.json; echo "rc=$?"' }, ctx)
    expect(nx.content).not.toContain('rc=0')
    const ls = await tool('bash').handler({ command: `ls -A ${protectedDir} | wc -l` }, ctx)
    expect(ls.content.split('\n')[0]).toBe('0')
  })

  it('read-only policy allows reading but not writing the project', async () => {
    const { tool, workspace } = await sandboxed({ readOnly: true })
    const result = await tool('bash').handler({ command: 'ls > /dev/null && echo listed; echo x > f.txt; echo "rc=$?"' }, toolContext(workspace))
    expect(result.content).toContain('listed')
    expect(result.content).not.toContain('rc=0')
  })

  it('sandbox:false needs approval from the host hook', async () => {
    const calls: string[] = []
    const denied = await sandboxed()
    const ctx = toolContext(denied.workspace)
    await expect(denied.tool('bash').handler({ command: `echo x > ${denied.outside}/a.txt`, sandbox: false }, ctx)).rejects.toMatchObject({ code: 'approval/denied' })
    const allowed = await sandboxed({ approveUnsandboxed: async (_c, request) => (calls.push(request.command), true) })
    const result = await allowed.tool('bash').handler({ command: `echo x > ${allowed.outside}/a.txt && echo done`, sandbox: false }, toolContext(allowed.workspace))
    expect(result.content).toContain('done')
    expect(result.content).toContain('ran outside the system sandbox')
    expect(result.meta).toMatchObject({ sandboxed: false })
    expect(calls).toHaveLength(1)
    expect(await readFile(nodePath.join(allowed.outside, 'a.txt'), 'utf8')).toBe('x\n')
  })

  it('background commands run in the sandbox too', async () => {
    const { tool, workspace, outside, deps } = await sandboxed()
    disposers.push(() => backgroundShellsFor(deps).disposeAll())
    const ctx = toolContext(workspace)
    const started = await tool('bash').handler({ command: `echo x > ${outside}/bg.txt; echo "rc=$?"`, run_in_background: true }, ctx)
    const id = /(bg-\d+)/.exec(started.content)![1]!
    let out = ''
    for (let i = 0; i < 60 && !out.includes('exited'); i++) {
      await new Promise(r => setTimeout(r, 50))
      out += (await tool('shell_output').handler({ id }, ctx)).content
    }
    expect(out).toContain('rc=1')
    expect(started.meta).toMatchObject({ sandboxed: true })
  })

  it('network:false cuts the network of the command', async () => {
    const { tool, workspace } = await sandboxed({ network: false })
    const result = await tool('bash').handler({ command: `timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'; echo "rc=$?"` }, toolContext(workspace))
    expect(result.content).not.toContain('rc=0')
  })
})

describe('required sandbox without an OS sandbox', () => {
  it('refuses to run the command', async () => {
    const osSandbox = createOsSandbox({ platform: 'win32' })
    const s = await setup(root => ({
      sandbox: osSandbox,
      inputs: () => ({ enabled: true, required: true, projectRoot: root, readOnly: false, extraWriteRoots: [], denyRead: [], network: true }),
    }))
    if (!posix) return
    await expect(s.tool('bash').handler({ command: 'echo should-not-run > ran.txt' }, toolContext(s.workspace)))
      .rejects.toMatchObject({ code: 'sandbox/denied' })
    await expect(readFile(nodePath.join(s.workspace.root, 'ran.txt'))).rejects.toThrow()
  })

  it('runs under the command policy alone when not required', async () => {
    const osSandbox = createOsSandbox({ platform: 'win32' })
    const s = await setup(root => ({
      sandbox: osSandbox,
      inputs: () => ({ enabled: true, projectRoot: root, readOnly: false, extraWriteRoots: [], denyRead: [], network: true }),
    }))
    if (!posix) return
    const result = await s.tool('bash').handler({ command: 'echo ok' }, toolContext(s.workspace))
    expect(result.content).toContain('ok')
    expect(result.meta).toMatchObject({ sandboxed: false })
  })
})
