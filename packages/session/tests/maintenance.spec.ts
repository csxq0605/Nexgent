import { spawn } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLayout, type CheckpointRecord, type SessionRecord } from '@nexgent/kernel'
import {
  JsonlSessionStore,
  processStartTime,
  projectSession,
  readSessionSummary,
  resolveLatestCheckpoint,
  scanSessionLog,
  summarizeSession,
  SUMMARY_FILE_NAME,
  type JsonlSessionStoreOptions,
} from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

async function setup(options: Partial<JsonlSessionStoreOptions> = {}) {
  const root = await tempDir()
  const layout = resolveWorkspaceLayout(root)
  const store = new JsonlSessionStore({ layout, fsync: 'boundaries', checkpointOnRelease: false, ...options })
  return { root, layout, store }
}

async function writeTurns(store: JsonlSessionStore, root: string, turns: number, from = 1): Promise<void> {
  const lock = from === 1 ? await store.create(sessionInit(root)) : await store.lock(SESSION_ID)
  for (let turn = from; turn < from + turns; turn += 1) {
    for (const record of turnRecords(turn, `prompt ${turn} ${'x'.repeat(200)}`)) await store.append(SESSION_ID, record)
  }
  await store.release(lock)
}

function checkpointsOf(records: readonly SessionRecord[]): CheckpointRecord[] {
  return records.filter((record): record is CheckpointRecord => record.type === 'checkpoint')
}

describe('incremental checkpoints', () => {
  it('chain on the previous checkpoint and reconstruct to the projection', async () => {
    const { root, store } = await setup({ checkpointEvery: 10 })
    await writeTurns(store, root, 8)
    const { records } = await store.readAll(SESSION_ID)
    const checkpoints = checkpointsOf(records)
    expect(checkpoints.length).toBeGreaterThanOrEqual(3)
    expect(checkpoints[0]).not.toHaveProperty('base')
    checkpoints.slice(1).forEach((checkpoint, index) => {
      const previous = checkpoints[index] as CheckpointRecord
      expect(checkpoint.base).toBe(previous.seq)
      expect(checkpoint.keep).toBe(projectSession(records.slice(0, previous.coversSeq)).messages.length)
      expect(checkpoint.state.messages.length).toBeLessThan(projectSession(records.slice(0, checkpoint.coversSeq)).messages.length)
    })
    for (const checkpoint of checkpoints) {
      const resolved = resolveLatestCheckpoint(records.slice(0, checkpoint.seq))
      expect(resolved?.state).toEqual(projectSession(records.slice(0, checkpoint.coversSeq)))
    }
    const reader = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const result = await reader.resumeDetailed(SESSION_ID)
    expect(result.checkpointSeq).toBe(checkpoints.at(-1)?.seq)
    expect(result.state).toEqual({ ...projectSession(records), metadata: { ...projectSession(records).metadata, lastSeq: records.length } })
    expect((await reader.latestCheckpoint(SESSION_ID))?.state).toEqual(projectSession(records.slice(0, checkpoints.at(-1)!.coversSeq)))
  })

  it('a checkpoint right after a compaction is full, and the chain restarts on it', async () => {
    const { root, store } = await setup({ checkpointEvery: 10 })
    const lock = await store.create(sessionInit(root))
    for (let turn = 1; turn <= 3; turn += 1) for (const record of turnRecords(turn)) await store.append(SESSION_ID, record)
    await store.append(SESSION_ID, {
      type: 'compaction', turn: 3, step: 3, summary: 's', keepMessages: 4, compactedMessages: 8, requestId: 'r', usage: KNOWN_USAGE,
      trigger: { inputTokens: 2, threshold: 1 },
    })
    await store.checkpoint(SESSION_ID)
    for (const record of turnRecords(4)) await store.append(SESSION_ID, record)
    await store.checkpoint(SESSION_ID)
    await store.release(lock)
    const { records } = await store.readAll(SESSION_ID)
    const checkpoints = checkpointsOf(records)
    const afterCompaction = checkpoints.filter(checkpoint => checkpoint.seq > records.findIndex(r => r.type === 'compaction') + 1)
    expect(afterCompaction[0]).not.toHaveProperty('base')
    expect(afterCompaction[1]?.base).toBe(afterCompaction[0]?.seq)
    expect((await new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) }).resume(SESSION_ID)).messages)
      .toEqual(projectSession(records).messages)
  })

  it('falls back to the previous usable checkpoint (or the start) when a base is missing', async () => {
    const { root, store } = await setup({ checkpointEvery: 10 })
    await writeTurns(store, root, 8)
    const file = store.sessionFile(SESSION_ID)
    const lines = (await readFile(file, 'utf8')).split('\n')
    const { records } = await store.readAll(SESSION_ID)
    const checkpoints = checkpointsOf(records)
    // Damage the second checkpoint: the third (whose base it is) is unusable, so resume uses the first.
    lines[(checkpoints[1] as CheckpointRecord).seq - 1] = 'garbage'
    await writeFile(file, lines.join('\n'))
    const reader = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const result = await reader.resumeDetailed(SESSION_ID)
    expect(result.skipped).toHaveLength(1)
    expect(result.checkpointSeq).toBe(checkpoints[0]?.seq)
    const valid = (await reader.readAll(SESSION_ID)).records
    expect(result.state.messages).toEqual(projectSession(valid).messages)
    expect(result.state.metadata).toEqual({ ...projectSession(valid).metadata, lastSeq: valid.at(-1)?.seq })
    // Damage the first as well: replay from session.start.
    lines[(checkpoints[0] as CheckpointRecord).seq - 1] = 'garbage'
    await writeFile(file, lines.join('\n'))
    const none = await reader.resumeDetailed(SESSION_ID)
    expect(none.checkpointSeq).toBeUndefined()
    expect(none.state.messages).toEqual(projectSession((await reader.readAll(SESSION_ID)).records).messages)
  })

  it('keeps the file growing about linearly with the number of turns', async () => {
    const small = await setup({ checkpointEvery: 10 })
    await writeTurns(small.store, small.root, 30)
    const large = await setup({ checkpointEvery: 10 })
    await writeTurns(large.store, large.root, 90)
    const sizeSmall = (await stat(small.store.sessionFile(SESSION_ID))).size
    const sizeLarge = (await stat(large.store.sessionFile(SESSION_ID))).size
    // Full-state checkpoints would make this ratio about 9; incremental ones keep it near 3.
    expect(sizeLarge / sizeSmall).toBeLessThan(4)
  })

  it('stores a caller-written full checkpoint incrementally, and reads old full checkpoints as before', async () => {
    const { root, store } = await setup({ checkpointEvery: 1000 })
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    const first = (await store.append(SESSION_ID, { type: 'checkpoint', coversSeq: 7, state: projectSession((await store.readAll(SESSION_ID)).records) })) as CheckpointRecord
    expect(first).not.toHaveProperty('base')
    for (const record of turnRecords(2)) await store.append(SESSION_ID, record)
    const all = (await store.readAll(SESSION_ID)).records
    const second = (await store.append(SESSION_ID, { type: 'checkpoint', coversSeq: all.length, state: projectSession(all) })) as CheckpointRecord
    expect(second).toMatchObject({ base: first.seq, keep: 4 })
    expect(second.state.messages).toHaveLength(4)
    await store.release(lock)
    const { records } = await store.readAll(SESSION_ID)
    expect((await store.latestCheckpoint(SESSION_ID))?.state).toEqual(projectSession(records.slice(0, second.coversSeq)))
    // A new store continues the chain after a restart.
    const again = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root), fsync: 'boundaries' })
    const lock2 = await again.lock(SESSION_ID)
    for (const record of turnRecords(3)) await again.append(SESSION_ID, record)
    const third = (await again.checkpoint(SESSION_ID)) as CheckpointRecord
    expect(third.base).toBe(second.seq)
    await again.release(lock2)
  })

  it('rejects an incremental checkpoint that names the wrong base', async () => {
    const { root, store } = await setup({ checkpointEvery: 1000 })
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await store.checkpoint(SESSION_ID)
    const state = projectSession((await store.readAll(SESSION_ID)).records)
    await expect(store.append(SESSION_ID, { type: 'checkpoint', coversSeq: 8, base: 3, keep: 1, state: { ...state, messages: state.messages.slice(1) } })).rejects.toMatchObject({ code: 'session/invalid-record' })
    await store.release(lock)
  })
})

describe('skipped lines and torn tails together', () => {
  it('reports skipped lines, still cuts a torn final line, and never deletes the skipped ones', async () => {
    const { root, store } = await setup()
    await writeTurns(store, root, 1)
    const file = store.sessionFile(SESSION_ID)
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines[2] = '{"nope":true}'
    const text = `${lines.join('\n')}{"type":"turn.start","seq":9`
    await writeFile(file, text)
    const read = await store.readAll(SESSION_ID)
    expect(read.skipped).toHaveLength(1)
    expect(read.truncation?.line).toBe(8)
    const lock = await store.lock(SESSION_ID)
    expect((await store.append(SESSION_ID, { type: 'turn.start', turn: 2 })).seq).toBe(9) // 8 = the error record
    await store.release(lock)
    const after = await readFile(file, 'utf8')
    expect(after).toContain('{"nope":true}')
    expect(after).not.toMatch(/"seq":9\n/) // the torn line is gone
    expect((await store.readAll(SESSION_ID)).truncation).toBeUndefined()
    const scan = scanSessionLog(await readFile(file), SESSION_ID)
    expect(scan.skipped).toHaveLength(1)
  })
})

describe('resume writes the truth about interrupted tool calls', () => {
  it('appends an error tool.result per unanswered call before the interrupted turn.end, for the lock holder only', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    await store.append(SESSION_ID, { type: 'turn.start', turn: 1 })
    await store.append(SESSION_ID, { type: 'user.message', turn: 1, content: 'go', source: 'user' })
    await store.append(SESSION_ID, {
      type: 'assistant.message', turn: 1, step: 1, requestId: 'r1', content: '', usage: KNOWN_USAGE, finishReason: 'tool-calls',
      toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }, { id: 'b', name: 'bash', arguments: '{}' }],
    })
    await store.append(SESSION_ID, { type: 'tool.result', turn: 1, step: 1, toolCallId: 'a', name: 'read_file', content: 'ok', isError: false, durationMs: 1 })
    // killed while `b` runs
    await store.release(lock)
    const file = store.sessionFile(SESSION_ID)

    const readOnly = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const before = await readFile(file)
    expect((await readOnly.resumeDetailed(SESSION_ID)).interruptedToolCalls).toBeUndefined()
    expect(await readFile(file)).toEqual(before)

    const writer = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root), checkpointOnRelease: false })
    const lock2 = await writer.lock(SESSION_ID)
    const resumed = await writer.resumeDetailed(SESSION_ID)
    expect(resumed.interruptedToolCalls).toBe(1)
    expect(resumed.interruptedTurn).toBe(1)
    const { records } = await writer.readAll(SESSION_ID)
    expect(records.slice(-2).map(record => record.type)).toEqual(['tool.result', 'turn.end'])
    expect(records.at(-2)).toMatchObject({
      toolCallId: 'b', name: 'bash', turn: 1, step: 1, isError: true, durationMs: 0,
      content: 'Error: the call was interrupted before it returned a result.',
      error: { code: 'tool/aborted' },
    })
    const calls = new Set<string>()
    const results = new Set<string>()
    for (const message of resumed.state.messages) {
      if (message.role === 'assistant') for (const call of message.toolCalls ?? []) calls.add(call.id)
      if (message.role === 'tool') results.add(message.toolCallId)
    }
    expect(results).toEqual(calls)
    expect((await writer.resumeDetailed(SESSION_ID)).interruptedToolCalls).toBeUndefined()
    await writer.release(lock2)
  })
})

describe('lock by pid and process start time', () => {
  async function plantLock(store: JsonlSessionStore, startedAt: string | undefined) {
    const path = store.lockFile(SESSION_ID)
    await writeFile(path, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), host: hostname(), ...(startedAt === undefined ? {} : { startedAt }) }))
  }

  it('records its own start time in the lock file', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    expect(Math.abs(Date.parse(lock.info.startedAt as string) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000)
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toEqual(lock.info)
    await store.release(lock)
  })

  it('a live pid with another start time is a reused pid: the lock is stale', async () => {
    const { root, store } = await setup()
    await store.release(await store.create(sessionInit(root)))
    await plantLock(store, new Date(Date.now() - 3_600_000).toISOString())
    const other = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await other.lock(SESSION_ID)
    expect(lock.info.pid).toBe(process.pid)
    await other.release(lock)
  })

  it('the same pid with the matching start time (or none recorded) stays locked', async () => {
    const { root, store } = await setup()
    await store.release(await store.create(sessionInit(root)))
    for (const startedAt of [new Date(Date.now() - process.uptime() * 1000 + 800).toISOString(), undefined]) {
      await plantLock(store, startedAt)
      const other = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
      await expect(other.lock(SESSION_ID)).rejects.toMatchObject({ code: 'session/locked' })
    }
  })

  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('reads another process start time', async () => {
    const before = Date.now()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      const started = processStartTime(child.pid as number)
      expect(started).toBeDefined()
      expect(Math.abs((started as Date).getTime() - before)).toBeLessThan(3000)
    } finally {
      child.kill()
    }
  })
})

describe('summary cache', () => {
  async function released(options: Partial<JsonlSessionStoreOptions> = {}) {
    const ctx = await setup(options)
    await writeTurns(ctx.store, ctx.root, 3)
    return ctx
  }

  it('is written on release and equals what a full read gives', async () => {
    const { store } = await released()
    const cache = JSON.parse(await readFile(join(store.sessionDir(SESSION_ID), SUMMARY_FILE_NAME), 'utf8')) as { entry: unknown; source: { size: number } }
    const { records } = await store.readAll(SESSION_ID)
    expect(cache.entry).toEqual(summarizeSession(records))
    expect(cache.source.size).toBe((await stat(store.sessionFile(SESSION_ID))).size)
    expect(await readSessionSummary(store.sessionsDir, SESSION_ID)).toEqual(summarizeSession(records))
  })

  it('is used while the file is unchanged, rebuilt when it changed, and recreated when missing', async () => {
    const { store, root } = await released()
    const path = join(store.sessionDir(SESSION_ID), SUMMARY_FILE_NAME)
    const cache = JSON.parse(await readFile(path, 'utf8')) as { entry: Record<string, unknown> }
    await writeFile(path, JSON.stringify({ ...cache, entry: { ...cache.entry, title: 'marker' } }))
    expect((await readSessionSummary(store.sessionsDir, SESSION_ID))?.title).toBe('marker') // hit
    await writeTurns(store, root, 1, 4) // the file changed
    const fresh = await readSessionSummary(store.sessionsDir, SESSION_ID)
    expect(fresh).toEqual(summarizeSession((await store.readAll(SESSION_ID)).records))
    expect(fresh?.lastTurn).toBe(4)
    await writeFile(path, '{')
    expect(await readSessionSummary(store.sessionsDir, SESSION_ID)).toEqual(fresh)
    expect(JSON.parse(await readFile(path, 'utf8')).entry).toEqual(fresh)
  })

  it('is refreshed after each turn.end while the session stays locked', async () => {
    const { store, root } = await setup()
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    const cached = await readSessionSummary(store.sessionsDir, SESSION_ID, { rewrite: false })
    expect(cached?.lastTurn).toBe(1)
    const cache = JSON.parse(await readFile(join(store.sessionDir(SESSION_ID), SUMMARY_FILE_NAME), 'utf8')) as { source: { size: number } }
    expect(cache.source.size).toBe((await stat(store.sessionFile(SESSION_ID))).size)
    await store.release(lock)
  })

  it('marks an open turn as interrupted and an improvement session as such, and skips unreadable sessions', async () => {
    const { store, root } = await setup()
    const lock = await store.create(sessionInit(root))
    await store.append(SESSION_ID, { type: 'turn.start', turn: 1 })
    await store.release(lock)
    expect((await readSessionSummary(store.sessionsDir, SESSION_ID))?.interrupted).toBe(true)
    await writeFile(store.sessionFile(SESSION_ID), 'garbage')
    expect(await readSessionSummary(store.sessionsDir, SESSION_ID)).toBeUndefined()
    expect(await readSessionSummary(store.sessionsDir, 'missing')).toBeUndefined()
  })
})
