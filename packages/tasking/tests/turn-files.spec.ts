import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createWorkspaceServices } from '@nexgent/workspace'
import { describe, expect, it } from 'vitest'
import { isIgnoredPath, LocalTurnFileTracker } from '../src/index.js'
import { project, SESSION_A, toolContext } from './helpers.js'

const SHELL_TIMEOUT = 120_000
/** Longer than the tracker's clock-skew allowance: files written before this are "old" at turn start. */
const SETTLE_MS = 30
const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS))
const shellCall = (sessionId: string, turn: number, name = 'bash') => ({ sessionId, turn, callId: `c-${name}`, name, isError: false })

describe('turn file tracker', () => {
  it('after a shell call reports added, modified and deleted files (with a baseline), ignoring .nexgent/, node_modules/, .git/ and .gitignore entries', async () => {
    const p = await project()
    await p.write('keep.txt', 'same')
    await p.write('edit.txt', 'v1')
    await p.write('gone.txt', 'bye')
    await p.write('nested/deep/old.md', 'x')
    await p.write('.gitignore', 'dist/\n*.log\n')
    await settle()
    const tracker = new LocalTurnFileTracker(p.root, { baseline: async () => new Set(['keep.txt', 'edit.txt', 'gone.txt', 'nested/deep/old.md', '.gitignore']) })
    await tracker.beginTurn(SESSION_A, 1)

    await p.write('new/file.csv', 'a,b\n')
    await p.write('dist/bundle.js', 'ignored')
    await p.write('run.log', 'ignored')
    await p.write('edit.txt', 'v2 longer')
    await rm(p.abs('gone.txt'))
    await rm(p.abs('nested'), { recursive: true })
    await p.write('.nexgent/outputs/x.txt', 'ignored')
    await p.write('node_modules/pkg/index.js', 'ignored')
    await p.write('src/node_modules/inner.js', 'ignored')
    await p.write('.git/HEAD', 'ignored')
    tracker.observe(shellCall(SESSION_A, 1))

    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([
      { path: 'edit.txt', change: 'modified' },
      { path: 'gone.txt', change: 'deleted' },
      { path: 'nested/deep/old.md', change: 'deleted' },
      { path: 'new/file.csv', change: 'added' },
    ])
    // the turn is closed: a second end reports nothing
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([])
  })

  it('catches a same-size rewrite and keeps turns of different sessions apart', async () => {
    const p = await project()
    await p.write('a.txt', 'aaaa')
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 1)
    await tracker.beginTurn('other', 4)
    await p.write('a.txt', 'bbbb')
    tracker.observe(shellCall(SESSION_A, 1))
    // A turn that ran no shell and reported no write has no changes, whatever else happened in the project.
    expect(await tracker.endTurn('other', 4)).toEqual([])
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([{ path: 'a.txt', change: 'modified' }])
  })

  it('does not look at the tree when the turn ran no shell tool', async () => {
    const p = await project()
    await p.write('a.txt', 'a')
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 1)
    await p.write('b.txt', 'b')
    tracker.observe({ ...shellCall(SESSION_A, 1, 'read_file'), meta: { path: p.abs('a.txt') } })
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([])
  })

  it('treats a tool whose observed effects include execute as shell-like, and one without them by name', async () => {
    const p = await project()
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 1)
    await tracker.beginTurn(SESSION_A, 2)
    await tracker.beginTurn(SESSION_A, 3)
    await p.write('made.txt', 'x')
    tracker.observe({ ...shellCall(SESSION_A, 1, 'custom_runner'), effects: ['execute'] } as never)
    tracker.observe({ ...shellCall(SESSION_A, 2, 'bash'), effects: ['read'] } as never)
    tracker.observe(shellCall(SESSION_A, 3, 'run_code'))
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([{ path: 'made.txt', change: 'added' }])
    expect(await tracker.endTurn(SESSION_A, 2)).toEqual([])
    expect(await tracker.endTurn(SESSION_A, 3)).toEqual([{ path: 'made.txt', change: 'added' }])
  })

  it('attributes each session its own write-tool paths and keeps another session\'s writes out of a shell scan', async () => {
    const p = await project()
    await p.write('old.txt', 'o')
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    const B = 'bbbbbbbb-1111-4111-8111-111111111111'
    await tracker.beginTurn(SESSION_A, 1)
    await tracker.beginTurn(B, 1)
    // B writes through a tool; A writes through a tool and runs a shell command that makes another file.
    const fromB = await p.write('from-b.txt', 'b')
    tracker.observe({ sessionId: B, turn: 1, callId: 'b1', name: 'write_file', isError: false, meta: { path: fromB, created: true } })
    const fromA = await p.write('from-a.txt', 'a')
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'a1', name: 'write_file', isError: false, meta: { path: fromA, created: true } })
    await p.write('shell-made.txt', 's')
    tracker.observe(shellCall(SESSION_A, 1))
    // A: its own write, its shell's file; never B's write even though the scan sees it.
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([
      { path: 'from-a.txt', change: 'added' },
      { path: 'shell-made.txt', change: 'added' },
    ])
    // B ran no shell, so the unreported shell-made file is nobody's to claim; B keeps only its own write.
    expect(await tracker.endTurn(B, 1)).toEqual([{ path: 'from-b.txt', change: 'added' }])
  })

  it('credits an unreported change to every session whose shell ran in the overlap, and to a later session only what is after its start', async () => {
    const p = await project()
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    const B = 'bbbbbbbb-1111-4111-8111-111111111111'
    await tracker.beginTurn(SESSION_A, 1)
    await tracker.beginTurn(B, 1)
    await p.write('both.txt', 'x')
    tracker.observe(shellCall(SESSION_A, 1))
    tracker.observe(shellCall(B, 1))
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([{ path: 'both.txt', change: 'added' }])
    // A session that starts later and runs a shell does not get a file older than its start.
    await settle()
    await tracker.beginTurn(SESSION_A, 2)
    tracker.observe(shellCall(SESSION_A, 2))
    expect(await tracker.endTurn(SESSION_A, 2)).toEqual([])
    expect(await tracker.endTurn(B, 1)).toEqual([{ path: 'both.txt', change: 'added' }])
  })

  it('uses file-tool meta: writes count, reads and errors do not', async () => {
    const p = await project()
    await p.write('read.txt', 'r')
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 2)
    const target = await p.write('written.txt', 'w')
    tracker.observe({ sessionId: SESSION_A, turn: 2, callId: 'c1', name: 'write_file', isError: false, meta: { path: target, bytes: 1, created: true } })
    tracker.observe({ sessionId: SESSION_A, turn: 2, callId: 'c2', name: 'read_file', isError: false, meta: { path: p.abs('read.txt'), bytes: 1 } })
    tracker.observe({ sessionId: SESSION_A, turn: 2, callId: 'c3', name: 'str_replace', isError: true, meta: { path: p.abs('read.txt') } })
    tracker.observe({ sessionId: SESSION_A, turn: 2, callId: 'c4', name: 'write_file', isError: false, meta: { path: p.abs('.nexgent/config.json') } })
    tracker.observe({ sessionId: SESSION_A, turn: 9, callId: 'c5', name: 'write_file', isError: false, meta: { path: p.abs('read.txt') } })
    tracker.observe({ sessionId: SESSION_A, turn: 2, callId: 'c6', name: 'write_file', isError: false, meta: 'not an object' })
    expect(await tracker.endTurn(SESSION_A, 2)).toEqual([{ path: 'written.txt', change: 'added' }])
  })

  it('reports tool writes when the end scan is aborted, without inventing deletions', async () => {
    const p = await project()
    for (let i = 0; i < 20; i++) await p.write(`d${i}/f.txt`, String(i))
    await settle()
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 1)
    const target = await p.write('d3/f.txt', 'changed!')
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c1', name: 'str_replace', isError: false, meta: { path: target } })
    const aborted = AbortSignal.abort()
    expect(await tracker.endTurn(SESSION_A, 1, aborted)).toEqual([{ path: 'd3/f.txt', change: 'modified' }])
  })

  it('stops at the scan limit and still reports tool writes', async () => {
    const p = await project()
    for (let i = 0; i < 10; i++) await p.write(`f${i}.txt`, String(i))
    await settle()
    const tracker = new LocalTurnFileTracker(p.root, { scanLimit: 3 })
    await tracker.beginTurn(SESSION_A, 1)
    const target = await p.write('zz.txt', 'new')
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c1', name: 'write_file', isError: false, meta: { path: target } })
    tracker.observe(shellCall(SESSION_A, 1))
    const changes = await tracker.endTurn(SESSION_A, 1)
    // The tool-reported write is reported once, even though the shell scan stops at its limit.
    expect(changes.filter(change => change.path === 'zz.txt')).toEqual([{ path: 'zz.txt', change: 'added' }])
    expect(changes.some(change => change.change === 'deleted')).toBe(false)
  })

  it('sees files changed through the shell tool (bash / pwsh), which report no paths', async () => {
    const p = await project()
    await p.write('data.csv', 'a\n')
    await p.write('old.txt', 'x')
    const services = await createWorkspaceServices({ root: p.root, create: false })
    const shell = services.tools.find(tool => tool.definition.name === (process.platform === 'win32' ? 'pwsh' : 'bash'))!
    await settle()
    const tracker = new LocalTurnFileTracker(p.root, { baseline: async () => new Set(['data.csv', 'old.txt']) })
    await tracker.beginTurn(SESSION_A, 1)
    const command = process.platform === 'win32'
      ? "Add-Content -Path data.csv -Value 'b'; New-Item -ItemType Directory -Path out | Out-Null; Set-Content -Path out/made.txt -Value 'made'; Remove-Item old.txt"
      : "printf 'b\\n' >> data.csv && mkdir out && printf made > out/made.txt && rm old.txt"
    const result = await shell.handler({ command }, toolContext(p.workspace, { approved: true }))
    expect(result.isError ?? false, result.content).toBe(false)
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c1', name: shell.definition.name, isError: false, ...(result.meta === undefined ? {} : { meta: result.meta }) })
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([
      { path: 'data.csv', change: 'modified' },
      { path: 'old.txt', change: 'deleted' },
      { path: 'out/made.txt', change: 'added' },
    ])
  }, SHELL_TIMEOUT)

  it('knows which paths it never reports', () => {
    expect(isIgnoredPath('.nexgent/outputs/a')).toBe(true)
    expect(isIgnoredPath('a/node_modules/b.js')).toBe(true)
    expect(isIgnoredPath('a/.git/HEAD')).toBe(true)
    expect(isIgnoredPath('node_modules')).toBe(false)
    expect(isIgnoredPath('src/app.ts')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('treats .NEXGENT and Node_Modules as ignored on Windows', async () => {
    const p = await project()
    const tracker = new LocalTurnFileTracker(p.root)
    await tracker.beginTurn(SESSION_A, 1)
    await mkdir(p.abs('Node_Modules'), { recursive: true })
    await writeFile(p.abs('Node_Modules/x.js'), 'x')
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c', name: 'write_file', isError: false, meta: { path: p.abs('.NEXGENT/config.json') } })
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c', name: 'write_file', isError: false, meta: { path: p.abs('Dir\\Sub.txt').toUpperCase() } })
    await p.write('Dir/Sub.txt', 'x')
    expect(await tracker.endTurn(SESSION_A, 1)).toEqual([{ path: 'Dir/Sub.txt', change: 'added' }])
  })
})
