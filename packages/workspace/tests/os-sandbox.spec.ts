import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOsSandbox, defaultWriteDenies, type OsSandbox, type OsSandboxPolicy, type SandboxManagerLike } from '../src/os-sandbox.js'
import { tempDir } from './helpers.js'

async function run(sandbox: OsSandbox, script: string, policy: OsSandboxPolicy, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const wrapped = await sandbox.wrap(script, policy)
  if (wrapped.kind !== 'wrapped') throw new Error(`not wrapped: ${wrapped.reason}`)
  return await new Promise(resolve => {
    const child = spawn(wrapped.program, wrapped.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

const hasBwrap = process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0 && spawnSync('socat', ['-V']).status === 0

describe('status none fallback', () => {
  it('reports Windows as having no system sandbox without loading the library', async () => {
    const sandbox = createOsSandbox({ platform: 'win32' })
    const status = await sandbox.probe()
    expect(status).toMatchObject({ kind: 'none' })
    expect((status as { reason: string }).reason).toContain('Windows')
    expect(await sandbox.wrap('echo hi', { writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'a' })).toMatchObject({ kind: 'unavailable' })
    await sandbox.dispose()
  })

  it('reports a missing dependency with its reason and never throws', async () => {
    const manager = fakeManager({ errors: ['bubblewrap (bwrap) not installed'] })
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    expect(await sandbox.probe()).toEqual({ kind: 'none', reason: 'bubblewrap (bwrap) not installed' })
    const wrapped = await sandbox.wrap('ls', { writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'b' })
    expect(wrapped).toEqual({ kind: 'unavailable', reason: 'bubblewrap (bwrap) not installed' })
    expect(manager.calls.initialize).toBe(0)
    await sandbox.dispose()
  })

  it('reports an initialisation failure as none', async () => {
    const manager = fakeManager({ initializeError: new Error('user namespaces are not permitted') })
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    expect(await sandbox.probe()).toEqual({ kind: 'none', reason: 'user namespaces are not permitted' })
    await sandbox.dispose()
  })

  it('initialises once and passes the policy per call', async () => {
    const root = await tempDir()
    const other = await tempDir()
    const manager = fakeManager({})
    const sandbox = createOsSandbox({ platform: 'linux', manager, skipTrial: true })
    await sandbox.wrap('a', { writeRoots: [root], denyWrite: [], denyRead: [], network: true, commandId: '1' })
    await sandbox.wrap('b', { writeRoots: [other], denyWrite: [], denyRead: [], network: false, commandId: '2' })
    expect(manager.calls.initialize).toBe(1)
    expect(manager.wraps[0]!.custom).toMatchObject({ filesystem: { allowWrite: [root] } })
    expect(manager.wraps[0]!.custom).not.toHaveProperty('network')
    expect(manager.wraps[1]!.custom).toMatchObject({ filesystem: { allowWrite: [other] }, network: { allowedDomains: [] } })
    await sandbox.dispose()
    expect(manager.calls.reset).toBe(1)
  })

  it('lists the default write protections of a project', () => {
    expect(defaultWriteDenies('/p')).toEqual([nodePath.join('/p', '.nexgent'), nodePath.join('/p', '.git', 'hooks'), nodePath.join('/p', '.git', 'config')])
  })
})

function fakeManager(options: { errors?: string[]; initializeError?: Error }): SandboxManagerLike & {
  calls: { initialize: number; reset: number }
  wraps: { command: string; custom: unknown }[]
} {
  const calls = { initialize: 0, reset: 0 }
  const wraps: { command: string; custom: unknown }[] = []
  return {
    calls,
    wraps,
    checkDependencies: () => ({ errors: options.errors ?? [], warnings: [] }),
    initialize: async () => {
      calls.initialize += 1
      if (options.initializeError !== undefined) throw options.initializeError
    },
    wrapWithSandbox: async (command, _shell, custom) => {
      wraps.push({ command, custom })
      return command
    },
    annotateStderrWithSandboxFailures: (_c, stderr) => stderr,
    cleanupAfterCommand: () => undefined,
    reset: async () => { calls.reset += 1 },
  }
}

describe.skipIf(!hasBwrap)('bubblewrap sandbox (real)', () => {
  let sandbox: OsSandbox
  let root: string
  let project: string
  let home: string
  let nexgentHome: string
  let outside: string
  let temp: string
  let policy: OsSandboxPolicy

  beforeAll(async () => {
    sandbox = createOsSandbox()
    root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'nxos-')))
    project = nodePath.join(root, 'proj')
    home = nodePath.join(root, 'home')
    nexgentHome = nodePath.join(root, 'nexgent-home')
    outside = nodePath.join(root, 'outside')
    temp = nodePath.join(root, 'tmp')
    await Promise.all([
      mkdir(nodePath.join(project, '.nexgent'), { recursive: true }),
      mkdir(nodePath.join(project, '.git', 'hooks'), { recursive: true }),
      mkdir(nodePath.join(home, '.ssh'), { recursive: true }),
      mkdir(nexgentHome, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(temp, { recursive: true }),
    ])
    await writeFile(nodePath.join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY-MATERIAL')
    await writeFile(nodePath.join(nexgentHome, 'credentials.json'), '{"key":"secret"}')
    await writeFile(nodePath.join(project, '.nexgent', 'config.json'), '{}')
    await writeFile(nodePath.join(project, '.git', 'config'), '[core]\n')
    policy = {
      writeRoots: [project, temp],
      denyWrite: defaultWriteDenies(project),
      denyRead: [nodePath.join(home, '.ssh'), nexgentHome],
      network: true,
      commandId: 'cmd-0',
    }
  }, 60_000)

  afterAll(async () => {
    await sandbox.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const id = (() => { let n = 0; return () => `cmd-${++n}` })()
  const go = (script: string, extra: Partial<OsSandboxPolicy> = {}) => run(sandbox, script, { ...policy, ...extra, commandId: id() }, project)

  it('is active here', async () => {
    expect(await sandbox.probe()).toEqual({ kind: 'active', platform: 'linux' })
  })

  it('allows reading and writing inside the project and the session temp dir', async () => {
    const result = await go(`echo hello > made.txt && cat made.txt && echo t > ${temp}/t.txt && cat ${temp}/t.txt`)
    expect(result).toMatchObject({ code: 0, stdout: 'hello\nt\n' })
    expect(await readFile(nodePath.join(project, 'made.txt'), 'utf8')).toBe('hello\n')
  })

  it('blocks reading a credential file', async () => {
    const result = await go(`cat ${home}/.ssh/id_rsa`)
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('PRIVATE-KEY-MATERIAL')
  })

  it('blocks deleting or reading the Nexgent home', async () => {
    const rm = await go(`rm -rf ${nexgentHome}; ls ${nexgentHome} | wc -l`)
    expect(rm.stdout.trim().split('\n').pop()).toBe('0')
    const cat = await go(`cat ${nexgentHome}/credentials.json`)
    expect(cat.code).not.toBe(0)
    expect(await readFile(nodePath.join(nexgentHome, 'credentials.json'), 'utf8')).toBe('{"key":"secret"}')
  })

  it('blocks writes outside the project, even through sh -c', async () => {
    const result = await go(`sh -c 'echo x > ${outside}/file'`)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/Read-only file system|not permitted|Permission denied/i)
    await expect(readFile(nodePath.join(outside, 'file'), 'utf8')).rejects.toThrow()
  })

  it('keeps .nexgent/, .git/hooks and .git/config read-only inside the project', async () => {
    const result = await go(
      `echo x > .nexgent/new.json; echo "e1=$?"; echo x >> .nexgent/config.json; echo "e2=$?"; echo x > .git/hooks/pre-commit; echo "e3=$?"; echo x >> .git/config; echo "e4=$?"; rm -f .nexgent/config.json; echo "e5=$?"`,
    )
    for (const n of [1, 2, 3, 4, 5]) expect(result.stdout).not.toContain(`e${n}=0`)
    expect(await readFile(nodePath.join(project, '.nexgent', 'config.json'), 'utf8')).toBe('{}')
    expect(await readFile(nodePath.join(project, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('annotates a blocked write for the model', async () => {
    const commandId = id()
    const result = await run(sandbox, `echo x > ${outside}/f`, { ...policy, commandId }, project)
    const annotated = sandbox.annotate(commandId, result.stderr, result.code)
    expect(annotated).toContain('sandbox_violations')
    expect(annotated).toContain(`${outside}/f`)
  })

  it('read-only policy: only the session temp dir is writable', async () => {
    const result = await go(`echo a > ro.txt; echo "p=$?"; echo b > ${temp}/ok.txt; echo "t=$?"`, { writeRoots: [temp], denyWrite: [] })
    expect(result.stdout).toContain('t=0')
    expect(result.stdout).not.toContain('p=0')
  })

  it('network off: no connection, network on: the host network', async () => {
    const off = await go(`timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>&1; echo "rc=$?"`, { network: false })
    expect(off.stdout).not.toContain('rc=0')
    expect(off.stdout).toMatch(/unreachable|rc=[1-9]/)
    const nets = (script: string, network: boolean) => go(script, { network }).then(r => r.stdout.trim())
    const list = "awk 'NR>2{print $1}' /proc/net/dev"
    const host = spawnSync('sh', ['-c', list], { encoding: 'utf8' }).stdout.trim()
    expect(await nets(list, true)).toBe(host)
    expect(await nets(list, false)).toBe('lo:')
  })

  it('node fetch fails without network', async () => {
    const result = await go(
      `node -e "fetch('http://1.1.1.1/').then(()=>process.exit(0),()=>process.exit(3))"`,
      { network: false },
    )
    expect(result.code).toBe(3)
  })

  it('serves two projects with different roots in one process, concurrently', async () => {
    const other = nodePath.join(root, 'proj2')
    await mkdir(other, { recursive: true })
    const [a, b] = await Promise.all([
      run(sandbox, `echo a > mine.txt; echo "w=$?"; echo b > ${other}/theirs.txt; echo "x=$?"`, { ...policy, commandId: id() }, project),
      run(sandbox, `echo a > mine.txt; echo "w=$?"; echo b > ${project}/theirs.txt; echo "x=$?"`, { ...policy, writeRoots: [other, temp], denyWrite: [], commandId: id() }, other),
    ])
    expect(a.stdout).toContain('w=0')
    expect(a.stdout).not.toContain('x=0')
    expect(b.stdout).toContain('w=0')
    expect(b.stdout).not.toContain('x=0')
  })

  it('re-allows reading the project materials inside the Nexgent home, and nothing else there', async () => {
    const materials = nodePath.join(nexgentHome, 'projects', 'p1', 'materials')
    await mkdir(materials, { recursive: true })
    await writeFile(nodePath.join(materials, 'orders.csv'), 'id,amount\n1,2\n')
    const result = await go(`cat ${materials}/orders.csv; cat ${nexgentHome}/credentials.json; echo "rc=$?"; echo x > ${materials}/new.txt; echo "w=$?"`, { allowRead: [materials] })
    expect(result.stdout).toContain('1,2')
    expect(result.stdout).not.toContain('secret')
    expect(result.stdout).toContain('rc=1')
    expect(result.stdout).not.toContain('w=0')
  })

  it('extra approved write roots become writable', async () => {
    const result = await go(`echo y > ${outside}/approved.txt && cat ${outside}/approved.txt`, { writeRoots: [project, temp, outside] })
    expect(result).toMatchObject({ code: 0, stdout: 'y\n' })
  })
})

const hasSetpriv = hasBwrap && spawnSync('setpriv', ['--help']).status === 0

describe.skipIf(!hasSetpriv)('network bridge lifetime (real)', () => {
  it('the bridge processes die with a host process that is killed hard', async () => {
    const dist = nodePath.resolve(import.meta.dirname, '..', 'src', 'os-sandbox.ts')
    const script = `
      const { createOsSandbox } = await import(${JSON.stringify(dist)})
      const { execFileSync } = await import('node:child_process')
      const sandbox = createOsSandbox()
      await sandbox.probe()
      const children = execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' })
      console.log(JSON.stringify(children.split('\\n').filter(line => line.includes('socat')).map(line => Number(line.trim().split(' ')[0]))))
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pids = await new Promise<number[]>(resolve => child.stdout.once('data', (c: Buffer) => resolve(JSON.parse(c.toString()) as number[])))
    expect(pids.length).toBeGreaterThan(0)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
      } catch {
        return false
      }
      const stat = spawnSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' }).stdout
      return !/\) [ZX] /.test(stat)
    }
    const deadline = Date.now() + 3000
    while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    expect(pids.filter(alive)).toEqual([])
  }, 30_000)
})
