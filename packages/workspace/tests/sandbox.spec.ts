import { mkdir, symlink, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  comparablePath,
  createSandbox,
  isWithin,
  stripVerbatimPrefix,
  toDecision,
  windowsPathIssue,
} from '../src/index.js'
import { project, tempDir } from './helpers.js'

async function trySymlink(target: string, path: string, type: 'file' | 'dir' | 'junction'): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    // Windows without Developer Mode / admin cannot create symlinks.
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

describe('sandbox modes × path escapes', () => {
  for (const mode of ['read-only', 'workspace-write', 'full-access'] as const) {
    describe(mode, () => {
      it('handles a write outside the project', async () => {
        const { sandbox, outside } = await project(mode)
        const decision = await sandbox.checkWrite(nodePath.join(outside, 'x.txt'))
        if (mode === 'full-access') expect(decision.allowed).toBe(true)
        else expect(decision).toMatchObject({ allowed: false, code: mode === 'read-only' ? 'read-only-mode' : 'outside-write-roots' })
      })

      it('handles a `..` escape', async () => {
        const { sandbox, workspace } = await project(mode)
        const assessment = await sandbox.assessWrite(workspace.resolve('../outside/escape.txt'))
        if (mode === 'full-access') {
          expect(assessment.kind).toBe('allow')
        } else {
          expect(assessment.kind).toBe('deny')
          // The error carries the resolved absolute path.
          expect(assessment.path).toBe(nodePath.join(nodePath.dirname(workspace.root), 'outside', 'escape.txt'))
        }
      })

      it('handles a symlink escape (file and directory)', async () => {
        const { sandbox, workspace, outside } = await project(mode)
        await writeFile(nodePath.join(outside, 'secret.txt'), 'x')
        const fileLink = nodePath.join(workspace.root, 'link.txt')
        const dirLink = nodePath.join(workspace.root, 'linkdir')
        if (!(await trySymlink(nodePath.join(outside, 'secret.txt'), fileLink, 'file'))) return
        await trySymlink(outside, dirLink, process.platform === 'win32' ? 'junction' : 'dir')
        const viaFile = await sandbox.assessWrite(fileLink)
        const viaDir = await sandbox.assessWrite(nodePath.join(dirLink, 'new.txt'))
        const readViaDir = await sandbox.assessRead(nodePath.join(dirLink, 'secret.txt'))
        if (mode === 'full-access') {
          expect([viaFile.kind, viaDir.kind, readViaDir.kind]).toEqual(['allow', 'allow', 'allow'])
        } else {
          const writeCode = mode === 'read-only' ? 'read-only-mode' : 'symlink-escape'
          expect(viaFile).toMatchObject({ kind: 'deny', code: writeCode })
          expect(viaDir).toMatchObject({ kind: 'deny', code: writeCode })
          expect(readViaDir).toMatchObject({ kind: 'deny', code: 'symlink-escape' })
        }
      })

      it('allows writing inside the project only when not read-only', async () => {
        const { sandbox, workspace } = await project(mode)
        const decision = await sandbox.checkWrite(workspace.resolve('src/a.ts'))
        expect(decision.allowed).toBe(mode !== 'read-only')
      })
    })
  }

  it('follows a dangling symlink to where a write would land', async () => {
    const { sandbox, workspace, outside } = await project()
    const link = nodePath.join(workspace.root, 'dangling.txt')
    if (!(await trySymlink(nodePath.join(outside, 'not-yet.txt'), link, 'file'))) return
    expect(await sandbox.assessWrite(link)).toMatchObject({ kind: 'deny', code: 'symlink-escape' })
  })

  it('allows a symlink that stays inside the project', async () => {
    const { sandbox, workspace } = await project()
    await mkdir(nodePath.join(workspace.root, 'real'))
    if (!(await trySymlink(nodePath.join(workspace.root, 'real'), nodePath.join(workspace.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'))) return
    expect((await sandbox.assessWrite(nodePath.join(workspace.root, 'alias', 'f.txt'))).kind).toBe('allow')
  })
})

describe('.nexgent/ and protected patterns (workspace-write)', () => {
  it('applies the .nexgent/ table', async () => {
    const { sandbox, workspace } = await project()
    const r = (p: string) => sandbox.assessRead(workspace.resolve(p)).then(a => a.kind)
    const w = (p: string) => sandbox.assessWrite(workspace.resolve(p)).then(a => a.kind)
    expect(await r('.nexgent/sessions/x/session.jsonl')).toBe('deny')
    expect(await w('.nexgent/sessions/x')).toBe('deny')
    expect(await r('.nexgent/ledgers/2026-10/requests.jsonl')).toBe('deny')
    expect(await r('.nexgent/capabilities/a')).toBe('deny')
    expect(await r('.nexgent/materials/a.pdf')).toBe('allow')
    expect(await w('.nexgent/materials/x')).toBe('deny')
    expect(await r('.nexgent/outputs/x')).toBe('allow')
    expect(await w('.nexgent/outputs/x')).toBe('allow')
    expect(await r('.nexgent/config.json')).toBe('allow')
    expect(await w('.nexgent/config.json')).toBe('deny')
  })

  it('denies writes to .git and node_modules but allows reads', async () => {
    const { sandbox, workspace } = await project()
    for (const p of ['.git/HEAD', 'node_modules/a.js', 'packages/x/node_modules/b/index.js', '.pnpm-store/v3/x']) {
      expect(await sandbox.assessWrite(workspace.resolve(p))).toMatchObject({ kind: 'deny', code: 'denied-pattern' })
      expect((await sandbox.assessRead(workspace.resolve(p))).kind).toBe('allow')
    }
    expect((await sandbox.assessWrite(workspace.resolve('.github/workflows/ci.yml'))).kind).toBe('allow')
  })

  it('escalates sensitive files to approval', async () => {
    const { sandbox, workspace } = await project()
    expect(await sandbox.assessWrite(workspace.resolve('.env'))).toMatchObject({ kind: 'ask', risk: 'medium', pattern: '.env' })
    expect(await sandbox.assessRead(workspace.resolve('config/.env.local'))).toMatchObject({ kind: 'ask', risk: 'low' })
    expect((await sandbox.assessRead(workspace.resolve('certs/server.pem'))).kind).toBe('ask')
    expect((await sandbox.assessRead(workspace.resolve('id_rsa.pub'))).kind).toBe('ask')
    expect(toDecision(await sandbox.assessWrite(workspace.resolve('.npmrc')))).toMatchObject({ allowed: false })
  })

  it('honours extraReadRoots for reads only', async () => {
    const { workspace, outside } = await project()
    const extra = await tempDir()
    const sandbox = await createSandbox({ root: workspace.root, extraReadRoots: [extra] })
    expect((await sandbox.checkRead(nodePath.join(extra, 'a.txt'))).allowed).toBe(true)
    expect((await sandbox.checkRead(nodePath.join(outside, 'a.txt'))).allowed).toBe(false)
    expect((await sandbox.checkWrite(nodePath.join(extra, 'a.txt'))).allowed).toBe(false)
  })

  it('allows the session temp directory', async () => {
    const { workspace } = await project()
    const base = await tempDir()
    const sandbox = await createSandbox({ root: workspace.root, tempBase: base })
    expect((await sandbox.checkWrite(nodePath.join(base, 'nexgent-s1', 'x'))).allowed).toBe(true)
    expect((await sandbox.checkWrite(nodePath.join(base, 'other', 'x'))).allowed).toBe(false)
  })

  it('exposes the resolved policy', async () => {
    const { sandbox, workspace } = await project('read-only')
    expect(sandbox.policy).toMatchObject({ mode: 'read-only', writeRoots: [], readRoots: [workspace.root] })
    expect(sandbox.policy.commands.timeoutMs).toBe(120_000)
    expect(sandbox.withMode('workspace-write').policy.writeRoots).toEqual([workspace.root])
  })
})

describe('path normalization (pure, both flavours)', () => {
  it('compares Windows paths case-insensitively and without the verbatim prefix', () => {
    expect(comparablePath('C:/Users/Me/Proj/', 'win32')).toBe('c:\\users\\me\\proj')
    expect(stripVerbatimPrefix('\\\\?\\C:\\x')).toBe('C:\\x')
    expect(stripVerbatimPrefix('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x')
    expect(isWithin('C:\\Proj', 'c:\\proj\\SRC\\a.ts', 'win32')).toBe(true)
    expect(isWithin('C:\\Proj', '\\\\?\\C:\\Proj\\a.ts', 'win32')).toBe(true)
    expect(isWithin('C:\\Proj', 'D:\\Proj\\a.ts', 'win32')).toBe(false)
    expect(isWithin('C:\\Proj', 'C:\\Project\\a.ts', 'win32')).toBe(false)
    expect(isWithin('\\\\srv\\share\\proj', '\\\\srv\\other\\proj\\a', 'win32')).toBe(false)
  })

  it('rejects device names, streams and UNC outside UNC projects', () => {
    expect(windowsPathIssue('C:\\proj\\NUL', ['C:\\proj'])).toMatch(/device/)
    expect(windowsPathIssue('C:\\proj\\com1.txt', ['C:\\proj'])).toMatch(/device/)
    expect(windowsPathIssue('C:\\proj\\a.txt:stream', ['C:\\proj'])).toMatch(/stream/)
    expect(windowsPathIssue('\\\\srv\\share\\a', ['C:\\proj'])).toMatch(/UNC/)
    expect(windowsPathIssue('\\\\srv\\share\\proj\\a', ['\\\\srv\\share\\proj'])).toBeUndefined()
    expect(windowsPathIssue('C:\\proj\\console.txt', ['C:\\proj'])).toBeUndefined()
  })

  it('is case-sensitive and separator-exact on POSIX', () => {
    expect(isWithin('/a/proj', '/a/proj/x', 'posix')).toBe(true)
    expect(isWithin('/a/proj', '/a/Proj/x', 'posix')).toBe(false)
    expect(isWithin('/a/proj', '/a/project', 'posix')).toBe(false)
    expect(isWithin('/', '/anything', 'posix')).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('Windows host paths', () => {
  it('accepts a differently-cased root and the verbatim prefix; rejects other drives, UNC and NUL', async () => {
    const { sandbox, workspace } = await project()
    const upper = workspace.root.toUpperCase()
    expect((await sandbox.checkWrite(`${upper}\\a.txt`)).allowed).toBe(true)
    expect((await sandbox.checkWrite(`\\\\?\\${workspace.root}\\a.txt`)).allowed).toBe(true)
    const otherDrive = workspace.root[0]!.toUpperCase() === 'Z' ? 'Y:\\x.txt' : 'Z:\\x.txt'
    expect((await sandbox.checkWrite(otherDrive)).allowed).toBe(false)
    expect((await sandbox.checkWrite('\\\\server\\share\\x.txt')).allowed).toBe(false)
    expect((await sandbox.checkWrite(`${workspace.root}\\NUL`)).allowed).toBe(false)
  })
})
