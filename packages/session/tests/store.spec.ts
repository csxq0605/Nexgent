import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isNexgentError,
  resolveWorkspaceLayout,
  type NexgentErrorCode,
  type SessionRecord,
  type SessionRecordInput,
} from '@nexgent/kernel'
import { encodeLine, JsonlSessionStore, projectSession, type JsonlSessionStoreOptions } from '../src/index.js'
import { SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

async function expectCode(promise: Promise<unknown>, code: NexgentErrorCode): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(isNexgentError(error) ? error.code : error).toBe(code)
    return
  }
  expect.unreachable(`expected ${code}`)
}

async function setup(options: Partial<JsonlSessionStoreOptions> = {}) {
  const root = await tempDir()
  const layout = resolveWorkspaceLayout(root)
  const store = new JsonlSessionStore({ layout, ...options })
  return { root, layout, store }
}

/** Create a session with `turns` complete turns and release it; returns the file path. */
async function writeSession(store: JsonlSessionStore, root: string, turns: number): Promise<string> {
  const lock = await store.create(sessionInit(root))
  for (let turn = 1; turn <= turns; turn += 1) {
    for (const record of turnRecords(turn)) await store.append(SESSION_ID, record)
  }
  await store.release(lock)
  return store.sessionFile(SESSION_ID)
}

describe('JsonlSessionStore: layout and basic writes', () => {
  it('writes .nexgent/sessions/<id>/session.jsonl and .lock per the spec layout', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root, { title: 'T' }))
    const dir = join(root, '.nexgent', 'sessions', SESSION_ID)
    expect(lock.path).toBe(join(dir, '.lock'))
    expect(lock.sessionId).toBe(SESSION_ID)
    expect(lock.info.pid).toBe(process.pid)
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toEqual(lock.info)
    expect((await readdir(dir)).sort()).toEqual(['.lock', 'session.jsonl'])
    await store.release(lock)
    expect(await readdir(dir)).toEqual(['session.jsonl'])

    const text = await readFile(join(dir, 'session.jsonl'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.includes('\r')).toBe(false)
    const start = JSON.parse(text.split('\n')[0] as string) as Record<string, unknown>
    expect(Object.keys(start).slice(0, 4)).toEqual(['type', 'seq', 'ts', 'sessionId'])
    expect(start).toMatchObject({ type: 'session.start', seq: 1, version: 1, projectRoot: root, title: 'T' })
  })

  it('appends with assigned seq/ts/sessionId and reads every record back', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const lock = await store.create(sessionInit(root))
    const written: SessionRecord[] = []
    for (const record of turnRecords(1)) written.push(await store.append(SESSION_ID, record))
    expect(written.map(record => record.seq)).toEqual([2, 3, 4, 5, 6, 7])
    for (const record of written) {
      expect(record.sessionId).toBe(SESSION_ID)
      expect(record.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    }
    await store.release(lock)
    const { records, truncation } = await new JsonlSessionStore({ sessionsDir: store.sessionsDir }).readAll(SESSION_ID)
    expect(truncation).toBeUndefined()
    expect(records.slice(1)).toEqual(written)
  })

  it('ignores caller-supplied seq/ts/sessionId', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    const smuggled = { type: 'turn.start', turn: 1, seq: 99, ts: 'x', sessionId: 'evil' } as unknown as SessionRecordInput
    const record = await store.append(SESSION_ID, smuggled)
    expect(record).toMatchObject({ seq: 2, sessionId: SESSION_ID })
    await store.release(lock)
  })

  it('rejects invalid records with session/invalid-record and writes nothing', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const lock = await store.create(sessionInit(root))
    const before = await readFile(store.sessionFile(SESSION_ID))
    const bad: unknown[] = [
      { type: 'session.start', version: 1, projectRoot: '/x', model: 'm', sandboxMode: 'read-only' },
      { type: 'turn.start' },
      { type: 'turn.start', turn: 0 },
      { type: 'user.message', turn: 1, content: 'x', source: 'user', extra: true },
      { type: 'user.message', turn: 1, content: undefined, source: 'user' },
      { type: 'tool.result', turn: 1, step: 1, toolCallId: 'c', name: 'n', content: 'c', isError: false, durationMs: Number.NaN },
      { type: 'mystery' },
      { type: 'checkpoint', coversSeq: 1, state: { sessionId: SESSION_ID, version: 1, messages: [], metadata: {} } },
    ]
    for (const record of bad) await expectCode(store.append(SESSION_ID, record as SessionRecordInput), 'session/invalid-record')
    expect(await readFile(store.sessionFile(SESSION_ID))).toEqual(before)
    // The store is still usable and seq did not advance.
    expect((await store.append(SESSION_ID, { type: 'turn.start', turn: 1 })).seq).toBe(2)
    await store.release(lock)
  })

  it('rejects unsafe session ids', async () => {
    const { root, store } = await setup()
    for (const sessionId of ['../escape', 'a/b', '', '.hidden']) {
      await expectCode(store.create(sessionInit(root, { sessionId })), 'session/invalid-record')
    }
  })

  it('create rejects session/exists; lock and readAll reject session/not-found', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    await expectCode(store.create(sessionInit(root)), 'session/locked')
    await store.release(lock)
    await expectCode(store.create(sessionInit(root)), 'session/exists')
    await expectCode(new JsonlSessionStore({ sessionsDir: store.sessionsDir }).create(sessionInit(root)), 'session/exists')
    await expectCode(store.lock('missing'), 'session/not-found')
    await expectCode(store.readAll('missing'), 'session/not-found')
    await expectCode(store.resume('missing'), 'session/not-found')
  })

  it('append requires the lock held by this store', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    const other = new JsonlSessionStore({ sessionsDir: store.sessionsDir })
    await expectCode(other.append(SESSION_ID, { type: 'turn.start', turn: 1 }), 'session/locked')
    await store.release(lock)
    await expectCode(store.append(SESSION_ID, { type: 'turn.start', turn: 1 }), 'session/locked')
    // Reading needs no lock.
    expect((await other.readAll(SESSION_ID)).records).toHaveLength(1)
  })

  it("supports fsync: 'boundaries'", async () => {
    const { root, store } = await setup({ fsync: 'boundaries' })
    await writeSession(store, root, 2)
    expect((await store.resume(SESSION_ID)).messages).toHaveLength(8)
  })
})

describe('JsonlSessionStore: checkpoints', () => {
  it('writes a checkpoint right after the turn.end that reaches N records', async () => {
    const { root, store } = await setup({ checkpointEvery: 10, checkpointOnRelease: false })
    await writeSession(store, root, 4)
    const { records } = await store.readAll(SESSION_ID)
    const checkpoints = records.filter(record => record.type === 'checkpoint')
    // turn.end at seq 7 (7 < 10), 13 (>= 10) -> checkpoint 14; turn.end at 20 (6 since), 26 (12) -> checkpoint 27.
    expect(checkpoints.map(record => record.seq)).toEqual([14, 27])
    for (const checkpoint of checkpoints) {
      if (checkpoint.type !== 'checkpoint') continue
      expect(records[checkpoint.seq - 2]?.type).toBe('turn.end')
      expect(checkpoint.coversSeq).toBe(checkpoint.seq - 1)
      expect(checkpoint.state).toEqual(projectSession(records.slice(0, checkpoint.coversSeq)))
    }
    expect(await store.latestCheckpoint(SESSION_ID)).toEqual(checkpoints.at(-1))
  })

  it('uses N = 50 by default', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    await writeSession(store, root, 9) // turn.end at 7, 13, ..., 49, 55
    const { records } = await store.readAll(SESSION_ID)
    expect(records.filter(record => record.type === 'checkpoint').map(record => record.seq)).toEqual([56])
  })

  it('writes a closing checkpoint on release only when there are new records', async () => {
    const { root, store } = await setup()
    await writeSession(store, root, 1)
    let { records } = await store.readAll(SESSION_ID)
    expect(records.at(-1)).toMatchObject({ type: 'checkpoint', seq: 8, coversSeq: 7 })
    const lock = await store.lock(SESSION_ID)
    await store.release(lock)
    ;({ records } = await store.readAll(SESSION_ID))
    expect(records).toHaveLength(8)
  })

  it('checkpoint() forces one; a caller checkpoint must carry the projected state', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    const forced = await store.checkpoint(SESSION_ID)
    expect(forced).toMatchObject({ seq: 8, coversSeq: 7 })
    expect(await store.checkpoint(SESSION_ID)).toBeUndefined()
    await store.append(SESSION_ID, { type: 'turn.start', turn: 2 })
    const { records } = await store.readAll(SESSION_ID)
    const state = projectSession(records)
    await expectCode(
      store.append(SESSION_ID, { type: 'checkpoint', coversSeq: 9, state: { ...state, messages: [] } }),
      'session/invalid-record',
    )
    await expectCode(store.append(SESSION_ID, { type: 'checkpoint', coversSeq: 3, state }), 'session/invalid-record')
    expect(await store.append(SESSION_ID, { type: 'checkpoint', coversSeq: 9, state })).toMatchObject({ seq: 10 })
    await store.release(lock)
  })

  it('resume starts from the latest checkpoint and folds only the records after it', async () => {
    const { root, store } = await setup({ checkpointEvery: 10, checkpointOnRelease: false })
    await writeSession(store, root, 5) // checkpoints at 14 and 27, then turn 5 = seq 28..33
    const result = await store.resumeDetailed(SESSION_ID)
    expect(result.checkpointSeq).toBe(27)
    expect(result.folded).toBe(6)
    const { records } = await store.readAll(SESSION_ID)
    expect(result.state.messages).toEqual(projectSession(records).messages)
    expect(result.state.metadata).toEqual(projectSession(records).metadata)
  })

  it('resume with a checkpoint stays fast on a 10k-record session', async () => {
    const { root, store } = await setup()
    const sessionId = SESSION_ID
    const stamp = (input: SessionRecordInput, seq: number) =>
      ({ ...input, seq, ts: '2026-10-07T08:00:00.000Z', sessionId }) as SessionRecord
    const records: SessionRecord[] = [
      stamp({ type: 'session.start', version: 1, projectRoot: root, model: 'm', sandboxMode: 'read-only' }, 1),
    ]
    let turn = 0
    while (records.length < 10_000) {
      turn += 1
      for (const input of turnRecords(turn)) records.push(stamp(input, records.length + 1))
    }
    const coversSeq = records.length
    records.push(stamp({ type: 'checkpoint', coversSeq, state: projectSession(records) }, coversSeq + 1))
    for (let extra = turn + 1; extra <= turn + 3; extra += 1) {
      for (const input of turnRecords(extra)) records.push(stamp(input, records.length + 1))
    }
    const dir = join(store.sessionsDir, sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), records.map(encodeLine).join(''))

    const reader = new JsonlSessionStore({ sessionsDir: store.sessionsDir })
    const started = performance.now()
    const result = await reader.resumeDetailed(sessionId)
    const elapsed = performance.now() - started
    expect(result.folded).toBe(18) // three turns after the checkpoint; nothing before it is replayed
    expect(result.checkpointSeq).toBe(coversSeq + 1)
    expect(result.state).toEqual({ ...projectSession(records), metadata: { ...projectSession(records).metadata } })
    expect(elapsed).toBeLessThan(3000)
  }, 30_000)
})

describe('JsonlSessionStore: recovery', () => {
  it('truncation at every byte offset of the last lines recovers the last complete record', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const file = await writeSession(store, root, 3)
    const full = await readFile(file)
    const { records } = await store.readAll(SESSION_ID)
    const lineEnds: number[] = []
    for (let index = 0; index < full.length; index += 1) if (full[index] === 0x0a) lineEnds.push(index + 1)
    expect(lineEnds).toHaveLength(records.length)
    const firstOffset = lineEnds[lineEnds.length - 5] as number // the last four lines, byte by byte
    const offsets = new Set<number>(lineEnds)
    for (let offset = firstOffset; offset < full.length; offset += 1) offsets.add(offset)

    const reader = new JsonlSessionStore({ sessionsDir: store.sessionsDir })
    for (const offset of [...offsets].sort((a, b) => a - b)) {
      await writeFile(file, full.subarray(0, offset))
      const complete = lineEnds.filter(end => end <= offset).length
      const lineStart = complete === 0 ? 0 : (lineEnds[complete - 1] as number)
      const read = await reader.readAll(SESSION_ID)
      expect(read.records, `offset ${offset}`).toEqual(records.slice(0, complete))
      if (offset === lineStart) {
        expect(read.truncation, `offset ${offset}`).toBeUndefined()
      } else {
        expect(read.truncation, `offset ${offset}`).toEqual({
          line: complete + 1,
          byteOffset: lineStart,
          reason: 'incomplete line (no trailing newline)',
        })
      }
      const state = await reader.resume(SESSION_ID)
      expect(state, `offset ${offset}`).toEqual(projectSession(records.slice(0, complete)))
    }
  })

  it('a corrupt middle line stops recovery there and discards everything after it', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const file = await writeSession(store, root, 2)
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines[4] = '{"type":"tool.result", not json'
    await writeFile(file, lines.join('\n'))
    const { records, truncation } = await store.readAll(SESSION_ID)
    expect(records.map(record => record.seq)).toEqual([1, 2, 3, 4])
    expect(truncation).toMatchObject({ line: 5, reason: 'not valid JSON' })
    expect(truncation?.byteOffset).toBe(Buffer.byteLength(lines.slice(0, 4).join('\n')) + 1)
  })

  it('a seq gap, a foreign session id or an unknown type is an invalid line', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const file = await writeSession(store, root, 1)
    const original = await readFile(file, 'utf8')
    const lines = original.split('\n')
    const cases: Array<[(record: Record<string, unknown>) => void, RegExp]> = [
      [record => { record.seq = 9 }, /seq 9 where 3/],
      [record => { record.sessionId = 'other' }, /does not match/],
      [record => { record.type = 'turn.pause' }, /unknown record type/],
    ]
    for (const [mutate, reason] of cases) {
      const record = JSON.parse(lines[2] as string) as Record<string, unknown>
      mutate(record)
      await writeFile(file, [...lines.slice(0, 2), JSON.stringify(record), ...lines.slice(3)].join('\n'))
      const { records, truncation } = await store.readAll(SESSION_ID)
      expect(records).toHaveLength(2)
      expect(truncation?.line).toBe(3)
      expect(truncation?.reason).toMatch(reason)
    }
  })

  it('the next append truncates the bad tail, records an error, and continues seq', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const file = await writeSession(store, root, 1)
    const full = await readFile(file)
    await writeFile(file, Buffer.concat([full, Buffer.from('{"type":"turn.start","seq":8,"ts":"2026-')]))
    const lock = await store.lock(SESSION_ID)
    const record = await store.append(SESSION_ID, { type: 'turn.start', turn: 2 })
    expect(record.seq).toBe(9)
    await store.release(lock)
    const { records, truncation } = await store.readAll(SESSION_ID)
    expect(truncation).toBeUndefined()
    expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const error = records[7]
    expect(error).toMatchObject({ type: 'error', fatal: false, error: { code: 'session/corrupt' } })
    expect(error?.type === 'error' && error.error.message).toMatch(/line 8/)
    expect((await readFile(file)).subarray(0, full.length)).toEqual(full)
  })

  it('throws session/corrupt only when session.start itself is unreadable', async () => {
    const { root, store } = await setup()
    const file = await writeSession(store, root, 0)
    await writeFile(file, '{"type":"session.st')
    await expectCode(store.readAll(SESSION_ID), 'session/corrupt')
    await expectCode(store.lock(SESSION_ID), 'session/corrupt')
    // The failed lock attempt left no lock file behind.
    expect(await readdir(join(store.sessionsDir, SESSION_ID))).toEqual(['session.jsonl'])
  })

  it('resume closes a dangling turn as interrupted only for the lock holder', async () => {
    const { root, store } = await setup({ checkpointOnRelease: false })
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await store.append(SESSION_ID, { type: 'turn.start', turn: 2 })
    await store.append(SESSION_ID, { type: 'user.message', turn: 2, content: 'crash here', source: 'user' })
    // The process "dies" mid-turn: turn 2 is never closed.
    const file = store.sessionFile(SESSION_ID)
    const bytes = await readFile(file)
    await store.release(lock)

    const readOnly = new JsonlSessionStore({ sessionsDir: store.sessionsDir })
    const peek = await readOnly.resumeDetailed(SESSION_ID)
    expect(peek.state.metadata.openTurn).toBe(2)
    expect(peek.interruptedTurn).toBeUndefined()
    expect(await readFile(file)).toEqual(bytes)

    const writer = new JsonlSessionStore({ sessionsDir: store.sessionsDir, checkpointOnRelease: false })
    const lock2 = await writer.lock(SESSION_ID)
    const resumed = await writer.resumeDetailed(SESSION_ID)
    expect(resumed.interruptedTurn).toBe(2)
    expect(resumed.state.metadata.openTurn).toBeUndefined()
    expect(resumed.state.metadata.lastTurn).toBe(2)
    expect(resumed.state.messages.at(-1)).toEqual({ role: 'user', content: 'crash here' })
    const { records } = await writer.readAll(SESSION_ID)
    expect(records.at(-1)).toMatchObject({ type: 'turn.end', turn: 2, reason: { kind: 'interrupted' }, seq: 10 })
    // A second resume has nothing left to close.
    expect((await writer.resumeDetailed(SESSION_ID)).interruptedTurn).toBeUndefined()
    await writer.release(lock2)
  })
})
