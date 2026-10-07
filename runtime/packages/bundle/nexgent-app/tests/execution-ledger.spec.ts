import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExecutionLedger from '../src/execution-ledger.ts'
import type { ExecutionLedgerRecord } from '../src/execution-ledger.ts'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, fsyncSync: vi.fn(original.fsyncSync) }
})

afterEach(() => { vi.restoreAllMocks() })

async function fixture(): Promise<{ ctx: Context; ledger: ExecutionLedger; read: () => ExecutionLedgerRecord[] }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const directory = fs.mkdtempSync(join(tmpdir(), 'nexgent-ledger-test-'))
  await ctx.plugin(ExecutionLedger, { directory })
  const ledger = ctx.executionLedger
  return { ctx, ledger, read: () => fs.readFileSync(ledger.file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ExecutionLedgerRecord) }
}

const options: GenerateOptions = { provider: 'mimo', model: 'mimo-v2.6-pro', messages: [], sessionId: SessionId('parent') }
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const sample: StreamChunk = { type: 'usage', usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3, totalTokens: 18 } }

function stream(ctx: Context, chunks: StreamChunk[], request = options): AsyncIterable<StreamChunk> {
  return ctx.waterfall(ctx.llm, 'llm/stream', request, async function * () { yield * chunks })
}

async function consume(input: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of input) chunks.push(chunk)
  return chunks
}

describe('native application execution ledger', () => {
  it('preserves every chunk and records the last detached usage sample for each actual invocation', async () => {
    const { ctx, ledger, read } = await fixture()
    try {
      const chunks = [sample, { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } } satisfies StreamChunk, finish]
      expect(await consume(stream(ctx, chunks))).toEqual(chunks)
      expect(await consume(stream(ctx, [sample, finish]))).toEqual([sample, finish])
      const records = read()
      expect(records).toHaveLength(4)
      expect(records[0]).toMatchObject({ type: 'request-start', provider: 'mimo', model: 'mimo-v2.6-pro', sessionId: 'parent' })
      expect(records[0]?.type).toBe('request-start')
      const start = records[0]
      if (start?.type !== 'request-start') throw new Error('Missing request start')
      expect(records[1]).toMatchObject({ type: 'request-end', id: start.id, termination: 'exhausted', finishReason: 'stop', usageState: 'reported', usage: { inputTokens: 20, outputTokens: 5 } })
      expect(records[2]).not.toMatchObject({ id: start.id })
      expect(records[3]).toMatchObject({ usage: sample.usage })
      expect(ledger.writeFailures).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('records auxiliary calls and missing usage without fabricating session identity or token totals', async () => {
    const { ctx, read } = await fixture()
    try {
      await consume(stream(ctx, [finish], { provider: 'mimo', model: 'mimo-v2.6-pro', messages: [], purpose: 'session-title' }))
      expect(read()[0]).toMatchObject({ purpose: 'session-title' })
      expect(read()[0]).not.toHaveProperty('sessionId')
      expect(read()[1]).toMatchObject({ usageState: 'missing' })
      expect(read()[1]).not.toHaveProperty('usage')
    } finally { await ctx.fiber.dispose() }
  })

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('marks malformed provider counts invalid: %s', async (inputTokens) => {
    const { ctx, read } = await fixture()
    try {
      await consume(stream(ctx, [{ type: 'usage', usage: { inputTokens, outputTokens: 2 } }, finish]))
      expect(read()[1]).toMatchObject({ usageState: 'invalid' })
      expect(read()[1]).not.toHaveProperty('usage')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a missing required counter while preserving a later valid observation', async () => {
    const { ctx, read } = await fixture()
    try {
      const missing = { type: 'usage', usage: { outputTokens: 2 } } as StreamChunk
      await consume(stream(ctx, [missing, finish]))
      await consume(stream(ctx, [missing, sample, finish]))
      expect(read()[1]).toMatchObject({ usageState: 'invalid' })
      expect(read()[3]).toMatchObject({ usageState: 'reported', usage: sample.usage })
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps a thrown middleware failure and records the reported work before it', async () => {
    const { ctx, read } = await fixture()
    try {
      const error = new Error('private provider response')
      const source = ctx.waterfall(ctx.llm, 'llm/stream', options, async function * () { yield sample; throw error })
      await expect(consume(source)).rejects.toBe(error)
      expect(read()[1]).toMatchObject({ termination: 'threw', usageState: 'reported' })
      expect(JSON.stringify(read())).not.toContain(error.message)
    } finally { await ctx.fiber.dispose() }
  })

  it('records consumer cancellation without hiding it behind an observed finish chunk', async () => {
    const { ctx, read } = await fixture()
    try {
      for await (const _chunk of stream(ctx, [sample, finish])) break
      expect(read()[1]).toMatchObject({ termination: 'consumer-closed', usageState: 'reported' })
      expect(read()[1]).not.toHaveProperty('finishReason')
    } finally { await ctx.fiber.dispose() }
  })

  it('captures aborted and failed native settlements without converting them to success', async () => {
    const { ctx, read } = await fixture()
    try {
      for (const kind of ['error', 'aborted'] as const) {
        const terminal: StreamChunk = { type: 'finish', reason: { kind, failure: { code: 'ABORTED', message: 'private response' } } }
        expect(await consume(stream(ctx, [terminal]))).toEqual([terminal])
      }
      expect(read()[1]).toMatchObject({ finishReason: 'error', usageState: 'missing' })
      expect(read()[3]).toMatchObject({ finishReason: 'aborted', usageState: 'missing' })
      expect(JSON.stringify(read())).not.toContain('private response')
    } finally { await ctx.fiber.dispose() }
  })

  it('records overlapping streams with independent identities and retains an unfinished start', async () => {
    const { ctx, read } = await fixture()
    try {
      const first = stream(ctx, [sample, finish])[Symbol.asyncIterator]()
      const second = stream(ctx, [finish])[Symbol.asyncIterator]()
      await first.next()
      await second.next()
      expect(read().map(record => record.type)).toEqual(['request-start', 'request-start'])
      await second.next()
      expect(read()).toHaveLength(3)
      await first.return?.()
      expect(new Set(read().flatMap(record => record.type === 'ledger-close' ? [] : [record.id])).size).toBe(2)
      expect(read()[3]).toMatchObject({ termination: 'consumer-closed' })
    } finally { await ctx.fiber.dispose() }
  })

  it('does not replace the model response when storage fails, and exposes incomplete accounting', async () => {
    const { ctx, ledger, read } = await fixture()
    try {
      vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk failure') })
      expect(await consume(stream(ctx, [finish]))).toEqual([finish])
      expect(ledger.writeFailures).toBe(1)
      expect(read()).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
    expect(read().at(-1)).toMatchObject({ type: 'ledger-close', writeFailures: 1 })
  })

  it('closes its file on disposal and reports a late settlement as incomplete', async () => {
    const { ctx, ledger, read } = await fixture()
    const iterator = stream(ctx, [sample, finish])[Symbol.asyncIterator]()
    try {
      await iterator.next()
      await ctx.fiber.dispose()
      await iterator.return?.()
      expect(ledger.writeFailures).toBe(1)
      expect(read()).toHaveLength(2)
      expect(read()[1]).toMatchObject({ type: 'ledger-close', writeFailures: 0 })
    } finally { await iterator.return?.(); await ctx.fiber.dispose() }
  })

  it('refuses relative storage locations before opening a file', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      await expect(ctx.plugin(ExecutionLedger, { directory: 'relative' })).rejects.toThrow('must be absolute')
    } finally { await ctx.fiber.dispose() }
  })
})
