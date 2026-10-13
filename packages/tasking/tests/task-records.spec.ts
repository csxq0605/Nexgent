/**
 * Step 4 task snapshots and checks (`data-formats.md` §任务快照与检查): the
 * recorder alone, then inside the real kernel loop.
 */
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { chmod, readdir, readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  canonicalJson,
  createApp,
  type Context,
  type JsonValue,
  type LedgerRecord,
  type NexgentApp,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSpec,
} from '@nexgent/kernel'
import { JsonlLedger, SessionPlugin, validateCapabilityFile } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { csvProblem, LocalTaskRecorder, TaskingPlugin, TEST_COMMAND_PATTERN } from '../src/index.js'
import { project, SESSION_A, tempDir } from './helpers.js'

const TASK = '0b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e'
const V1 = 'a'.repeat(64)
const NOW = () => new Date('2026-10-12T00:00:00.000Z')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

/** A process runner that answers each command with a fixed exit code. */
function fakeProcesses(exitCodes: Record<string, number>): ProcessRunner & { readonly specs: ProcessSpec[] } {
  const specs: ProcessSpec[] = []
  return {
    specs,
    async run(spec): Promise<ProcessResult> {
      specs.push(spec)
      const script = spec.args?.at(-1) ?? ''
      return { exitCode: exitCodes[script] ?? 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1 }
    },
  }
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
    const processes = fakeProcesses({ 'npm test': 1 })
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW, processes: () => processes })
    const { specs, results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: ['ok.json', 'bad.json', 'ok.csv', 'ragged.csv', 'missing.txt', 'book.xlsx', 'fake.xlsx'],
      commands: [
        { command: 'pytest -q', shell: 'bash' },
        { command: 'ls -la', shell: 'bash' },
        { command: 'npm test', shell: 'bash' },
        { command: 'pytest -q ', shell: 'bash' },
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
      ['test-1', false, 'exit code 1'], ['test-2', true, undefined],
    ])
    expect(processes.specs.map(spec => [spec.command, spec.args?.at(-1), spec.cwd])).toEqual([['bash', 'npm test', p.root], ['bash', 'pytest -q', p.root]])
    const record = await readJson(nodePath.join(recorder.dir, 'checks', `${TASK}.json`))
    expect(validateCapabilityFile('taskChecks', record)).toEqual([])
    expect(record).toMatchObject({ formatVersion: 1, taskId: TASK, sessionId: SESSION_A, checkedAt: NOW().toISOString() })
  })

  it('derives no test-command checks without a process runner', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout)
    expect(recorder.specs({ deliverableFiles: [], commands: [{ command: 'pytest', shell: 'bash' }] })).toEqual([])
  })

  it('recognises test-runner commands only', () => {
    for (const command of ['pytest', 'python -m pytest tests', 'python3 -m unittest', 'npm test', 'pnpm run test', 'npx vitest run', 'node --test', 'go test ./...', 'cargo test', 'make check']) {
      expect(TEST_COMMAND_PATTERN.test(command)).toBe(true)
    }
    for (const command of ['test -f x', 'ls', 'python make_report.py', 'npm install', 'echo pytest', 'rm -rf build && pytest']) {
      expect(TEST_COMMAND_PATTERN.test(command)).toBe(false)
    }
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

  it('snapshots the root task before the first request and writes the checks into task.outcome', async () => {
    const base = await tempDir()
    const root = nodePath.join(base, 'proj')
    let snapshotsAtFirstRequest: string[] = []
    const llm = scriptedProvider([
      () => {
        snapshotsAtFirstRequest = readdirSync(nodePath.join(root, '.nexgent', 'snapshots', 'tasks'))
        return { toolCalls: [{ name: 'write_file', arguments: { path: 'out/summary.json', content: '{"total": 180}' } }] }
      },
      { toolCalls: [{ name: 'present', arguments: { paths: ['out/summary.json'], summary: 'Totals.' } }] },
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
