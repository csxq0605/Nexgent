import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrganizationLibrary } from '@nexgent/capabilities'
import { resolveWorkspaceLayout, SNAPSHOTS_DIR, type SessionRecord, type WorkspaceLayout } from '@nexgent/kernel'
import { diffTrees, latestTask, retryMessage, RetryManager, type RetryView } from '../src/retry.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** A replay entry stand-in: checks the organization it was given, changes files, prints a result. */
const ENTRY = `
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
const forced = JSON.parse(readFileSync(join(request.projectRoot, '.nexgent', 'retry-organization.json'), 'utf8'))
writeFileSync(join(request.projectRoot, 'a.txt'), 'retry a ' + forced.decision)
writeFileSync(join(request.projectRoot, 'new.txt'), 'added by retry')
if (existsSync(join(request.projectRoot, 'old.txt'))) rmSync(join(request.projectRoot, 'old.txt'))
writeFileSync(join(request.projectRoot, '..', 'message.txt'), request.messages[0].text)
process.stdout.write('\\nNEXGENT_REPLAY_RESULT ' + JSON.stringify({ outcome: 'completed', usage: { inputTokens: 1, outputTokens: 1 }, requestCount: 1, estimatedUsd: 0.25 }) + '\\n')
`

function rec(type: string, fields: Record<string, unknown>, seq: number): SessionRecord {
  return { type, seq, ts: '2026-10-19T00:00:00.000Z', sessionId: SESSION, ...fields } as unknown as SessionRecord
}

function records(turns: number): SessionRecord[] {
  const out = [rec('session.start', { model: 'claude-sonnet-5-5' }, 1)]
  for (let turn = 1; turn <= turns; turn += 1) {
    out.push(
      rec('turn.start', { turn, organization: { decision: 'team', chosenBy: 'default' } }, out.length + 1),
      rec('user.message', { turn, content: `request ${turn}`, source: 'user' }, out.length + 2),
      rec('organization', { turn, toolCallId: 't', organizationId: 'o', name: 'plan-build-review', roles: [], workflowId: 'w' }, out.length + 3),
      rec('turn.files', { turn, changes: [{ path: 'a.txt', change: 'modified' }, { path: 'orig.txt', change: 'added' }] }, out.length + 4),
      rec('turn.end', { turn, reason: { kind: 'completed' } }, out.length + 5),
    )
  }
  return out
}

describe('retry helpers', () => {
  it('diffs trees and builds the message', () => {
    expect(diffTrees(new Map([['a', '1'], ['b', '2'], ['.nexgent/x', '3']]), new Map([['a', '9'], ['c', '4']]))).toEqual([
      { path: 'a', change: 'changed' },
      { path: 'b', change: 'deleted' },
      { path: 'c', change: 'added' },
    ])
    expect(retryMessage([], 'do it')).toBe('do it')
    expect(retryMessage(['first'], 'do it')).toContain('- first')
  })

  it('offers only a finished user task the organizer decided', () => {
    const task = latestTask(records(2))
    expect(task).toMatchObject({ turn: 2, text: 'request 2', earlier: ['request 1'], side: { decision: 'team', organization: 'plan-build-review' }, files: ['a.txt', 'orig.txt'] })
    expect(latestTask(records(1).slice(0, -1))).toBeUndefined()
  })
})

describe('RetryManager', () => {
  let dir: string
  let layout: WorkspaceLayout
  let events: RetryView[]
  let notes: unknown[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexgent-retry-'))
    const root = join(dir, 'project')
    layout = resolveWorkspaceLayout(root)
    await mkdir(layout.dataDir, { recursive: true })
    // Snapshot before turn 1: a.txt and old.txt.
    const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
    const files = [{ path: 'a.txt', text: 'start a' }, { path: 'old.txt', text: 'old' }]
    await mkdir(join(snapshots, 'objects'), { recursive: true })
    await mkdir(join(snapshots, 'trees'), { recursive: true })
    await mkdir(join(snapshots, 'tasks'), { recursive: true })
    for (const file of files) await writeFile(join(snapshots, 'objects', sha(file.text)), file.text)
    const tree = JSON.stringify({ formatVersion: 1, files: files.map(file => ({ path: file.path, sha256: sha(file.text), bytes: file.text.length })) })
    await writeFile(join(snapshots, 'trees', `${sha(tree)}.json`), tree)
    await writeFile(join(snapshots, 'tasks', `task.t1.json`), JSON.stringify({ formatVersion: 1, taskId: 'task', turn: 1, sessionId: SESSION, takenAt: '2026-10-19T00:00:00.000Z', tree: sha(tree), capabilityVersion: 'baseline' }))
    // The project after the original turn.
    await writeFile(join(root, 'a.txt'), 'original a')
    await writeFile(join(root, 'old.txt'), 'old')
    await writeFile(join(root, 'orig.txt'), 'added by original')
    await writeFile(join(dir, 'entry.mjs'), ENTRY)
    events = []
    notes = []
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function manager(library?: OrganizationLibrary): RetryManager {
    return new RetryManager({
      layout,
      records: async () => records(1),
      busy: () => false,
      ...(library === undefined ? {} : { organizations: library }),
      entry: join(dir, 'entry.mjs'),
      env: process.env,
      emit: (_sessionId, view) => events.push(view),
      noteFiles: async (_sessionId, change) => {
        notes.push(change)
      },
    })
  }

  async function finished(retries: RetryManager, retryId: string): Promise<RetryView> {
    for (let i = 0; i < 200; i += 1) {
      const latest = (await retries.state(SESSION)).latest
      if (latest?.retryId === retryId && latest.status !== 'running') return latest
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('retry did not finish')
  }

  it('redoes the task alone, keeps the new result, and undoes it', async () => {
    const library = new OrganizationLibrary(join(dir, 'organizations'))
    const retries = manager(library)
    const state = await retries.state(SESSION)
    expect(state.offer).toEqual({ turn: 1, side: { decision: 'solo' }, estimateUsd: expect.any(Number) })
    const started = await retries.start(SESSION)
    const ready = await finished(retries, started.retryId)
    expect(ready.status).toBe('ready')
    expect(ready.retry).toMatchObject({ side: { decision: 'solo' }, usd: 0.25 })
    expect(ready.retry.files).toEqual([{ path: 'a.txt', change: 'changed' }, { path: 'new.txt', change: 'added' }, { path: 'old.txt', change: 'deleted' }])
    expect(await readFile(join(dir, 'project', 'a.txt'), 'utf8')).toBe('original a')

    const applied = await retries.choose(started.retryId, 'retry')
    expect(applied).toMatchObject({ status: 'applied', undoable: true })
    const root = join(dir, 'project')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('retry a solo')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('added by retry')
    // The original turn's own file goes: the copy never made it.
    await expect(readFile(join(root, 'orig.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'old.txt'), 'utf8')).rejects.toThrow()
    const lines = await library.lines()
    expect(lines.filter(line => line.type === 'run')).toHaveLength(1)

    expect(notes).toEqual([{ toTurn: 1, restored: ['a.txt', 'new.txt'], deleted: ['old.txt', 'orig.txt'], cause: 'retry' }])

    const undone = await retries.undo(started.retryId)
    expect(notes.at(-1)).toEqual({ toTurn: 1, restored: ['a.txt', 'old.txt', 'orig.txt'], deleted: ['new.txt'], cause: 'retry-undo' })
    expect(undone.status).toBe('undone')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('original a')
    expect(await readFile(join(root, 'orig.txt'), 'utf8')).toBe('added by original')
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('old')
    await expect(readFile(join(root, 'new.txt'), 'utf8')).rejects.toThrow()
    expect((await library.runs())[0]?.reworked).toBe(true)
    expect(events.map(event => event.status)).toContain('ready')
  })

  it('keeping the original leaves the files and marks the retry reworked', async () => {
    const library = new OrganizationLibrary(join(dir, 'organizations'))
    const retries = manager(library)
    const started = await retries.start(SESSION)
    await finished(retries, started.retryId)
    const kept = await retries.choose(started.retryId, 'original')
    expect(kept.status).toBe('kept-original')
    expect(await readFile(join(dir, 'project', 'a.txt'), 'utf8')).toBe('original a')
    expect((await library.runs())[0]).toMatchObject({ decision: 'solo', reworked: true })
  })

  it('refuses undo after the files changed again', async () => {
    const retries = manager()
    const started = await retries.start(SESSION)
    await finished(retries, started.retryId)
    await retries.choose(started.retryId, 'retry')
    await writeFile(join(dir, 'project', 'a.txt'), 'edited later')
    expect((await retries.state(SESSION)).latest).toMatchObject({ status: 'applied', undoable: false })
    await expect(retries.undo(started.retryId)).rejects.toThrow(/changed since/)
  })
})
