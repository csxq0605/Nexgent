import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNTIME_NOT_WIRED_CODE as CLI_NOT_WIRED_CODE } from '../src/index.js'
import {
  buildScript,
  isRuntimeNotWired,
  openTurns,
  parseJsonLines,
  requestMentions,
  RUNTIME_NOT_WIRED_CODE,
  seqContiguous,
  sessionIdFrom,
  taskOutcomes,
  TASKS,
  turnEndKinds,
  unpairedRequests,
  WRITE_TOOL,
} from '../../../scripts/accept-common/scenario.mjs'

const script = fileURLToPath(new URL('../../../scripts/accept-step1.mjs', import.meta.url))

const rec = (type: string, fields: Record<string, unknown>, seq: number) => ({ type, seq, ...fields })

describe('accept-step1 scenario helpers', () => {
  it('agrees with the CLI on the not-wired code', () => {
    expect(RUNTIME_NOT_WIRED_CODE).toBe(CLI_NOT_WIRED_CODE)
    const events = parseJsonLines(`{"type":"error","error":{"code":"${CLI_NOT_WIRED_CODE}"}}\n`)
    expect(isRuntimeNotWired({ code: 2 }, events)).toBe(true)
    expect(isRuntimeNotWired({ code: 1 }, events)).toBe(false)
  })

  it('scripts five model requests: tool call, answer, stall, tool call, answer', () => {
    const entries = buildScript()
    expect(entries).toHaveLength(5)
    expect((entries[0]?.toolCalls as Array<{ name: string }>)[0]?.name).toBe(WRITE_TOOL)
    expect(entries[2]?.fault).toEqual({ kind: 'timeout', afterChunks: 3 })
  })

  it('parses JSON lines leniently and finds the session id', () => {
    const events = parseJsonLines('noise\r\n{"type":"session","sessionId":"s1"}\n\n{"type":"final"}\n')
    expect(events.map(e => e.type)).toEqual(['session', 'final'])
    expect(sessionIdFrom(events)).toBe('s1')
    expect(sessionIdFrom([])).toBeUndefined()
  })

  it('reads turn state from session records', () => {
    const records = [
      rec('session.start', {}, 1),
      rec('turn.start', { turn: 1 }, 2),
      rec('turn.end', { turn: 1, reason: { kind: 'completed' } }, 3),
      rec('turn.start', { turn: 2 }, 4),
    ]
    expect(turnEndKinds(records).get(1)).toBe('completed')
    expect(openTurns(records)).toEqual([2])
    expect(seqContiguous(records)).toBe(true)
    expect(seqContiguous([rec('a', {}, 1), rec('b', {}, 3)])).toBe(false)
  })

  it('pairs ledger requests and filters outcomes', () => {
    const ledger = [
      { type: 'llm.request.start', requestId: 'a' },
      { type: 'llm.request.end', requestId: 'a' },
      { type: 'llm.request.start', requestId: 'b' },
      { type: 'task.outcome', sessionId: 's', status: 'completed' },
      { type: 'task.outcome', sessionId: 't', status: 'failed' },
    ]
    expect(unpairedRequests(ledger)).toEqual({ withoutEnd: ['b'], withoutStart: [] })
    expect(taskOutcomes(ledger, 's')).toHaveLength(1)
  })

  it('detects history in a resumed request body (string content and Messages API text blocks)', () => {
    const body = { messages: [{ role: 'system', content: 'x' }, { role: 'user', content: TASKS.write }] }
    expect(requestMentions(body, TASKS.write)).toBe(true)
    expect(requestMentions(body, TASKS.resume)).toBe(false)
    expect(requestMentions(undefined, 'x')).toBe(false)
    const blocks = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: TASKS.write }] },
        { role: 'assistant', content: [{ type: 'text', text: TASKS.resume }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      ],
    }
    expect(requestMentions(blocks, TASKS.write)).toBe(true)
    expect(requestMentions(blocks, TASKS.resume)).toBe(false)
  })
})

describe('scripts/accept-step1.mjs', () => {
  it('never reports a fake pass: exits 0 (pass) or 2 (not runnable yet) with a matching summary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-accept-test-'))
    try {
      const out = path.join(dir, 'summary.json')
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', path.join(dir, 'work')], { encoding: 'utf8', timeout: 180_000 })
      expect([0, 2], result.stderr).toContain(result.status)
      const summary = await fs.readFile(out, 'utf8').then(text => JSON.parse(text) as { result: string }).catch(() => undefined)
      if (result.status === 0) expect(summary?.result).toBe('pass')
      else expect(result.stderr).toContain('not runnable yet')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 200_000)
})
