/**
 * Step 4 task snapshots and checks (`data-formats.md` §任务快照与检查): the
 * recorder alone, then inside the real kernel loop.
 */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { chmod, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  canonicalJson,
  createApp,
  type Context,
  type JsonValue,
  type LedgerRecord,
  type NexgentApp,
} from '@nexgent/kernel'
import { JsonlLedger, SessionPlugin, validateCapabilityFile } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { csvProblem, LocalTaskRecorder, TaskingPlugin, TEST_COMMAND_PATTERN, testCommandRan } from '../src/index.js'
import { project, SESSION_A, tempDir } from './helpers.js'

const TASK = '0b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e'
const V1 = 'a'.repeat(64)
const NOW = () => new Date('2026-10-12T00:00:00.000Z')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

describe('task snapshot', () => {
  it('stores each body once, the sorted tree and the task pointer, skipping .nexgent/, .git/ and node_modules/', async () => {
    const p = await project()
    await p.write('a.txt', 'same body')
    await p.write('sub/copy.txt', 'same body')
    await p.write('sub/data.csv', 'x,y\n1,2\n')
    await p.write('run.sh', '#!/bin/sh\necho hi\n')
    if (process.platform !== 'win32') await chmod(p.abs('run.sh'), 0o755)
    await p.write('.nexgent/outputs/skip.txt', 'skip')
    await p.write('node_modules/pkg/index.js', 'skip')
    await p.write('.git/HEAD', 'skip')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })

    const task = await readJson(nodePath.join(recorder.dir, 'tasks', `${TASK}.json`)) as { tree: string }
    expect(validateCapabilityFile('taskSnapshot', task)).toEqual([])
    expect(task).toEqual({ formatVersion: 1, taskId: TASK, sessionId: SESSION_A, takenAt: NOW().toISOString(), tree: task.tree, capabilityVersion: V1 })
    const treeText = (await readFile(nodePath.join(recorder.dir, 'trees', `${task.tree}.json`), 'utf8')).trimEnd()
    const tree = JSON.parse(treeText) as { files: { path: string; sha256: string; executable?: true }[] }
    expect(validateCapabilityFile('snapshotTree', tree)).toEqual([])
    expect(createHash('sha256').update(canonicalJson(tree as unknown as JsonValue)).digest('hex')).toBe(task.tree)
    expect(tree.files.map(file => file.path)).toEqual(['a.txt', 'run.sh', 'sub/copy.txt', 'sub/data.csv'])
    if (process.platform !== 'win32') expect(tree.files.find(file => file.path === 'run.sh')?.executable).toBe(true)
    const objects = await readdir(nodePath.join(recorder.dir, 'objects'))
    expect(objects.sort()).toEqual([...new Set(tree.files.map(file => file.sha256))].sort())
    expect(await readFile(nodePath.join(recorder.dir, 'objects', tree.files[0]!.sha256), 'utf8')).toBe('same body')

    // A second task over the same files reuses the tree and the objects.
    await recorder.begin({ taskId: '1b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e', sessionId: SESSION_A, capabilityVersion: V1 })
    expect(await readdir(nodePath.join(recorder.dir, 'trees'))).toHaveLength(1)
    expect(await readdir(nodePath.join(recorder.dir, 'objects'))).toHaveLength(objects.length)
  })

  it('records a workspace over the size limit without a tree', async () => {
    const p = await project()
    await p.write('big.txt', '0123456789')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW, maxSnapshotBytes: 5 })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: 'baseline' })
    const task = await readJson(nodePath.join(recorder.dir, 'tasks', `${TASK}.json`))
    expect(validateCapabilityFile('taskSnapshot', task)).toEqual([])
    expect(task).toMatchObject({ tree: null, omitted: { reason: 'too-large', bytes: 10 }, capabilityVersion: 'baseline' })
  })
})

const T2 = '1b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e'
const T3 = '2b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e'

async function treeOf(recorder: LocalTaskRecorder, taskId: string): Promise<{ path: string; sha256: string }[]> {
  const task = await readJson(nodePath.join(recorder.dir, 'tasks', `${taskId}.json`)) as { tree: string }
  return (await readJson(nodePath.join(recorder.dir, 'trees', `${task.tree}.json`)) as { files: { path: string; sha256: string }[] }).files
}

describe('incremental snapshots', () => {
  it('skips gitignored paths, including nested .gitignore files, and never enters ignored directories', async () => {
    const p = await project()
    await p.write('.gitignore', 'dist/\n*.log\n')
    await p.write('src/.gitignore', 'gen.ts\n')
    await p.write('src/app.ts', 'app')
    await p.write('src/gen.ts', 'gen')
    await p.write('dist/big.js', 'bundle')
    await p.write('run.log', 'log')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    expect((await treeOf(recorder, TASK)).map(file => file.path)).toEqual(['.gitignore', 'src/.gitignore', 'src/app.ts'])
    // The size limit counts only what is snapshotted.
    const small = new LocalTaskRecorder(p.workspace.layout, { now: NOW, maxSnapshotBytes: 40 })
    await p.write('dist/huge.js', 'x'.repeat(10_000))
    await small.begin({ taskId: T2, sessionId: SESSION_A, capabilityVersion: V1 })
    expect(await readJson(nodePath.join(small.dir, 'tasks', `${T2}.json`))).toMatchObject({ tree: expect.any(String) })
  })

  it('reuses recorded hashes of unchanged files and re-reads changed, new and object-less ones', async () => {
    const p = await project()
    const old = new Date(Date.now() - 3_600_000)
    const same = await p.write('same.txt', 'aaaa')
    await utimes(same, old, old)
    await p.write('other.txt', 'oooo')
    await utimes(p.abs('other.txt'), old, old)
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    const first = await treeOf(recorder, TASK)
    expect(JSON.parse(await readFile(nodePath.join(recorder.dir, 'index.json'), 'utf8'))).toMatchObject({
      formatVersion: 1,
      files: { 'same.txt': { size: 4, sha256: first[1]!.sha256 } },
    })
    expect(await recorder.indexedPaths()).toEqual(new Set(['other.txt', 'same.txt']))

    // Same size and mtime: the recorded hash is trusted without reading the file (the documented cost of the index).
    await writeFile(same, 'bbbb')
    await utimes(same, old, old)
    // A changed size and a new file are read; a removed object is stored again.
    await writeFile(p.abs('other.txt'), 'changed!')
    await p.write('new.txt', 'nnnn')
    await rm(nodePath.join(recorder.dir, 'objects', first[0]!.sha256 === first[1]!.sha256 ? 'none' : first[0]!.sha256))
    await recorder.begin({ taskId: T2, sessionId: SESSION_A, capabilityVersion: V1 })
    const second = await treeOf(recorder, T2)
    const byPath = Object.fromEntries(second.map(file => [file.path, file.sha256]))
    expect(byPath['same.txt']).toBe(first.find(file => file.path === 'same.txt')!.sha256)
    expect(byPath['other.txt']).toBe(createHash('sha256').update('changed!').digest('hex'))
    expect(byPath['new.txt']).toBe(createHash('sha256').update('nnnn').digest('hex'))
    for (const file of second) await expect(stat(nodePath.join(recorder.dir, 'objects', file.sha256))).resolves.toBeTruthy()
  })

  it('ignores a corrupt index and rebuilds it', async () => {
    const p = await project()
    await p.write('a.txt', 'a')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    await writeFile(nodePath.join(recorder.dir, 'index.json'), '{not json')
    await recorder.begin({ taskId: T2, sessionId: SESSION_A, capabilityVersion: V1 })
    expect((await treeOf(recorder, T2)).map(file => file.path)).toEqual(['a.txt'])
    expect((await recorder.indexedPaths())?.has('a.txt')).toBe(true)
  })
})

describe('snapshot retention', () => {
  const DAY = 86_400_000
  const days = (n: number) => new Date(Date.parse('2026-10-12T00:00:00.000Z') + n * DAY)

  it('prunes records older than 30 days and the trees and objects only they used, keeping retained ones', async () => {
    const p = await project()
    let now = days(0)
    const retain = new Set([T3])
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: () => now, pruneGraceMs: 0, retain })
    await p.write('a.txt', 'first body')
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    await p.write('a.txt', 'second body!')
    now = days(1)
    await recorder.begin({ taskId: T3, sessionId: SESSION_A, capabilityVersion: V1 })
    await p.write('a.txt', 'third body!!')
    now = days(2)
    await recorder.begin({ taskId: T2, sessionId: SESSION_A, capabilityVersion: V1 })
    expect((await readdir(nodePath.join(recorder.dir, 'tasks'))).sort()).toEqual([`${TASK}.json`, `${T2}.json`, `${T3}.json`].sort())

    now = days(40)
    await p.write('a.txt', 'fourth body!!!')
    await recorder.begin({ taskId: '3b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e', sessionId: SESSION_A, capabilityVersion: V1 })
    const tasks = await readdir(nodePath.join(recorder.dir, 'tasks'))
    expect(tasks).not.toContain(`${TASK}.json`)
    expect(tasks).not.toContain(`${T2}.json`)
    expect(tasks).toContain(`${T3}.json`)
    // Remaining records: the retained one and the new one; each tree and object left is referenced.
    expect(tasks).toHaveLength(2)
    expect(await readdir(nodePath.join(recorder.dir, 'trees'))).toHaveLength(2)
    expect(await readdir(nodePath.join(recorder.dir, 'objects'))).toHaveLength(2)
    const kept = await treeOf(recorder, T3)
    await expect(stat(nodePath.join(recorder.dir, 'objects', kept[0]!.sha256))).resolves.toBeTruthy()
  })

  it('over the size cap deletes the oldest unretained records first; a predicate retains by file name', async () => {
    const p = await project()
    let now = days(0)
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: () => now, pruneGraceMs: 0, sizeCheckIntervalMs: 0, maxStoreBytes: 30, retain: file => file === `${TASK}.json` })
    const ids = [TASK, T2, T3, '3b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e']
    for (const [index, id] of ids.entries()) {
      await p.write('a.txt', `body number ${index}`.padEnd(14, '.'))
      now = days(index + 1)
      await recorder.begin({ taskId: id, sessionId: SESSION_A, capabilityVersion: V1 })
    }
    // 14 bytes per version, cap 30: two versions fit. The retained first record and the newest stay, T2 and T3 go.
    const tasks = (await readdir(nodePath.join(recorder.dir, 'tasks'))).sort()
    expect(tasks).toEqual([`${TASK}.json`, `${ids[3]}.json`].sort())
    expect(await readdir(nodePath.join(recorder.dir, 'objects'))).toHaveLength(2)
  })

  it('never throws into the task when pruning fails', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW, retain: () => { throw new Error('boom') } })
    await p.write('a.txt', 'a')
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    await expect(recorder.begin({ taskId: T2, sessionId: SESSION_A, capabilityVersion: V1 })).resolves.toBeUndefined()
  })
})

describe('per-turn records (step 5)', () => {
  it('writes a snapshot and a checks record per root turn, keeping the step-4 names for turn 1 and the latest checks', async () => {
    const p = await project()
    await p.write('out/a.json', '{"n": 1}')
    let now = new Date('2026-10-13T00:00:00.000Z')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: () => now })
    const end = (turn: number) => recorder.end({ taskId: TASK, sessionId: SESSION_A, turn, deliverableFiles: ['out/a.json'], commands: [] })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1, turn: 1 })
    await end(1)
    // The feedback turn: the deliverable is now broken.
    await p.write('out/a.json', '{"n": ')
    now = new Date('2026-10-13T01:00:00.000Z')
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1, turn: 2 })
    const second = await end(2)
    expect(second.results.map(result => result.passed)).toEqual([true, false])

    expect((await readdir(nodePath.join(recorder.dir, 'tasks'))).sort()).toEqual([`${TASK}.json`, `${TASK}.t1.json`, `${TASK}.t2.json`])
    expect((await readdir(nodePath.join(recorder.dir, 'checks'))).sort()).toEqual([`${TASK}.json`, `${TASK}.t1.json`, `${TASK}.t2.json`])
    const t1 = await readJson(nodePath.join(recorder.dir, 'tasks', `${TASK}.t1.json`)) as { tree: string; turn: number }
    const t2 = await readJson(nodePath.join(recorder.dir, 'tasks', `${TASK}.t2.json`)) as { tree: string; turn: number }
    for (const record of [t1, t2]) expect(validateCapabilityFile('taskSnapshot', record)).toEqual([])
    expect([t1.turn, t2.turn]).toEqual([1, 2])
    expect(t2.tree).not.toBe(t1.tree)
    // The step-4 snapshot name keeps the first turn; the step-4 checks name holds the latest.
    expect(await readJson(nodePath.join(recorder.dir, 'tasks', `${TASK}.json`))).toEqual(t1)
    const c1 = await readJson(nodePath.join(recorder.dir, 'checks', `${TASK}.t1.json`)) as { turn: number; results: { passed: boolean }[] }
    const c2 = await readJson(nodePath.join(recorder.dir, 'checks', `${TASK}.t2.json`))
    for (const record of [c1, c2]) expect(validateCapabilityFile('taskChecks', record)).toEqual([])
    expect(c1).toMatchObject({ turn: 1, results: [{ passed: true }, { passed: true }] })
    expect(c2).toMatchObject({ turn: 2, results: [{ passed: true }, { passed: false }] })
    expect(await readJson(nodePath.join(recorder.dir, 'checks', `${TASK}.json`))).toEqual(c2)
  })

  it('writes only the step-4 names when no turn is given', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1 })
    await recorder.end({ taskId: TASK, sessionId: SESSION_A, deliverableFiles: [], commands: [] })
    expect(await readdir(nodePath.join(recorder.dir, 'tasks'))).toEqual([`${TASK}.json`])
    expect(await readdir(nodePath.join(recorder.dir, 'checks'))).toEqual([`${TASK}.json`])
  })
})

describe('task checks', () => {
  it('derives file, parse and test-command checks, runs them and writes the checks record', async () => {
    const p = await project()
    await p.write('ok.json', '{"a": 1}')
    await p.write('bad.json', '{"a": ')
    await p.write('ok.csv', 'a,"b, c"\n1,2\n')
    await p.write('ragged.csv', 'a,b\n1\n')
    await p.write('book.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml xl/workbook.xml')]))
    await p.write('fake.xlsx', 'not a zip')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { specs, results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: ['ok.json', 'bad.json', 'ok.csv', 'ragged.csv', 'missing.txt', 'book.xlsx', 'fake.xlsx'],
      commands: [
        { command: 'pytest -q', shell: 'bash', exitCode: 1 },
        { command: 'ls -la', shell: 'bash', exitCode: 0 },
        { command: 'npm test', shell: 'bash', exitCode: 1 },
        { command: 'pytest -q ', shell: 'bash', exitCode: 0 },
      ],
    })
    expect(specs.map(spec => spec.id)).toEqual([
      'file-1', 'parse-1', 'file-2', 'parse-2', 'file-3', 'parse-3', 'file-4', 'parse-4', 'file-5', 'file-6', 'parse-6', 'file-7', 'parse-7', 'test-1', 'test-2',
    ])
    expect(specs.filter(spec => spec.name === 'test-command')).toEqual([
      { id: 'test-1', name: 'test-command', command: 'npm test', shell: 'bash' },
      { id: 'test-2', name: 'test-command', command: 'pytest -q', shell: 'bash' },
    ])
    expect(results.map(result => [result.target, result.passed, result.detail])).toEqual([
      ['file-1', true, undefined], ['parse-1', true, undefined],
      ['file-2', true, undefined], ['parse-2', false, 'invalid JSON'],
      ['file-3', true, undefined], ['parse-3', true, undefined],
      ['file-4', true, undefined], ['parse-4', false, 'row 2 has 1 fields, expected 2'],
      ['file-5', false, 'missing'],
      ['file-6', true, undefined], ['parse-6', true, undefined],
      ['file-7', true, undefined], ['parse-7', false, 'not an xlsx workbook'],
      ['test-1', false, "the model's own run, exit code 1"], ['test-2', true, "the model's own run, exit code 0"],
    ])
    const record = await readJson(nodePath.join(recorder.dir, 'checks', `${TASK}.json`))
    expect(validateCapabilityFile('taskChecks', record)).toEqual([])
    expect(record).toMatchObject({ formatVersion: 1, taskId: TASK, sessionId: SESSION_A, checkedAt: NOW().toISOString() })
  })

  it('takes test-command results from the recorded exit codes and runs nothing at turn end', async () => {
    const p = await project()
    const marker = p.abs('ran.txt')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    // `make test` would fail in this project (no Makefile) if anything re-ran it; the recorded code wins.
    const { results } = await recorder.end({ taskId: TASK, sessionId: SESSION_A, deliverableFiles: [], commands: [{ command: 'make test', shell: 'bash', exitCode: 0 }, { command: 'pytest', shell: 'bash' }] })
    expect(results.map(result => [result.passed, result.detail])).toEqual([[true, "the model's own run, exit code 0"], [true, "the model's own run, exit code 0"]])
    await expect(stat(marker)).rejects.toThrow()
  })

  it('turns the project check command runs into check-<n> checks after the model\'s test runs (redesign 3.2)', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { specs, results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: [],
      commands: [{ command: 'npm test', shell: 'bash', exitCode: 0 }],
      checkRuns: [{ command: ' ./verify.sh ', shell: 'bash', exitCode: 2 }, { command: 'make lint', shell: 'bash', detail: 'could not run: approval needed' }],
    })
    expect(specs.map(spec => spec.id)).toEqual(['test-1', 'check-1', 'check-2'])
    expect(specs[1]).toMatchObject({ name: 'test-command', command: './verify.sh' })
    expect(results.slice(1).map(result => [result.target, result.passed, result.detail])).toEqual([
      ['check-1', false, 'the project check command, exit code 2'],
      ['check-2', false, 'could not run: approval needed'],
    ])
  })

  it('recognises test-runner commands only', () => {
    for (const command of ['pytest', 'python -m pytest tests', 'python3 -m unittest', 'npm test', 'pnpm run test', 'npx vitest run', 'node --test', 'node checks/totals.test.mjs', 'go test ./...', 'cargo test', 'make check']) {
      expect(TEST_COMMAND_PATTERN.test(command)).toBe(true)
    }
    for (const command of ['test -f x', 'ls', 'python make_report.py', 'npm install', 'echo pytest', 'rm -rf build && pytest', 'node build.mjs', 'node checks/totals.test.mjs.bak']) {
      expect(TEST_COMMAND_PATTERN.test(command)).toBe(false)
    }
  })

  it('keeps failing test runs but not runs where no test ran (step 5, ADR 0006 decision 10)', () => {
    expect(testCommandRan('npm test', 1)).toBe(true)
    expect(testCommandRan('pytest -q', 1)).toBe(true)
    expect(testCommandRan('node checks/totals.test.mjs', 1)).toBe(true)
    expect(testCommandRan('pnpm test', undefined)).toBe(true)
    expect(testCommandRan('vitest run', 127)).toBe(false)
    expect(testCommandRan('npm test', 126)).toBe(false)
    expect(testCommandRan('pytest tests/missing.py', 4)).toBe(false)
    expect(testCommandRan('python -m pytest -k nothing', 5)).toBe(false)
    expect(testCommandRan('go test ./...', 5)).toBe(true)
    expect(testCommandRan('ls missing/', 2)).toBe(false)
    expect(testCommandRan('cat nope.txt', 1)).toBe(false)
  })

  it('records a failing test run as a failing check and drops exploratory failures', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { specs, results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: [],
      commands: [
        { command: 'npm test', shell: 'bash', exitCode: 0 },
        { command: 'ls missing/', shell: 'bash', exitCode: 2 },
        { command: 'vitest run', shell: 'bash', exitCode: 127 },
        { command: 'pytest -q', shell: 'bash', exitCode: 1 },
        { command: 'npm test', shell: 'bash', exitCode: 1 },
      ],
    })
    expect(specs).toEqual([
      { id: 'test-1', name: 'test-command', command: 'pytest -q', shell: 'bash' },
      { id: 'test-2', name: 'test-command', command: 'npm test', shell: 'bash' },
    ])
    expect(results.map(result => [result.target, result.passed, result.detail])).toEqual([
      ['test-1', false, "the model's own run, exit code 1"], ['test-2', false, "the model's own run, exit code 1"],
    ])
  })

  it('checks CSV structure', () => {
    expect(csvProblem('a,b\r\n1,2\r\n')).toBeUndefined()
    expect(csvProblem('a,"multi\nline"\n1,2\n')).toBeUndefined()
    expect(csvProblem('a,"open\n')).toBe('unbalanced quotes')
    expect(csvProblem('\n\n')).toBe('empty')
  })
})

describe('snapshots and checks in the kernel loop', () => {
  const apps: NexgentApp[] = []
  afterEach(async () => {
    while (apps.length > 0) await apps.pop()!.dispose()
  })

  it('snapshots the root task before the first tool runs and writes the checks into task.outcome', async () => {
    const base = await tempDir()
    const root = nodePath.join(base, 'proj')
    let snapshotsAtFirstRequest: string[] = []
    const llm = scriptedProvider([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'out/summary.json', content: '{"total": 180}' } }] },
      () => {
        // The snapshot runs beside the first model request and is awaited before the first tool (K1), so it exists now.
        snapshotsAtFirstRequest = readdirSync(nodePath.join(app.ctx.workspace.layout.dataDir, 'snapshots', 'tasks'))
        return { toolCalls: [{ name: 'present', arguments: { paths: ['out/summary.json'], summary: 'Totals.' } }] }
      },
      { content: 'Done.' },
    ])
    const app = await createApp({
      patches: [{ id: 'workspace', config: { root } }],
      registry: {
        '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
        '@nexgent/session': SessionPlugin,
        '@nexgent/workspace': WorkspacePlugin,
      },
    })
    apps.push(app)
    await app.ctx.plugin(TaskingPlugin)
    await app.ctx.workspace.ensureLayout()
    const agent = await app.agents.create()
    const taskId = agent.attribution.taskId
    const layout = app.ctx.workspace.layout
    const snapshots = nodePath.join(layout.dataDir, 'snapshots')
    expect((await agent.run('Total the orders.')).reason).toEqual({ kind: 'completed' })
    expect(snapshotsAtFirstRequest.sort()).toEqual([`${taskId}.json`, `${taskId}.t1.json`])
    // The project was empty when the task started.
    const task = await readJson(nodePath.join(snapshots, 'tasks', `${taskId}.json`)) as { tree: string; capabilityVersion: string }
    expect(task.capabilityVersion).toBe('baseline')
    expect(await readJson(nodePath.join(snapshots, 'trees', `${task.tree}.json`))).toEqual({ formatVersion: 1, files: [] })
    await agent.close()

    const records: LedgerRecord[] = []
    for await (const record of new JsonlLedger({ layout }).read()) records.push(record)
    const outcome = records.find(record => record.type === 'task.outcome')
    expect(outcome).toMatchObject({
      checks: [
        { name: 'file-exists', passed: true, target: 'file-1' },
        { name: 'parses', passed: true, target: 'parse-1' },
      ],
    })
    const checks = await readJson(nodePath.join(snapshots, 'checks', `${taskId}.json`))
    expect(validateCapabilityFile('taskChecks', checks)).toEqual([])
    expect(checks).toMatchObject({ specs: [{ id: 'file-1', path: 'out/summary.json' }, { id: 'parse-1', format: 'json' }] })
  })
})
