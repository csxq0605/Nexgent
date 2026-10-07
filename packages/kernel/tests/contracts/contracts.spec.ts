import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  addUsage,
  addUsageCount,
  applyProfilePatches,
  assertToolRestriction,
  DEFAULT_PROJECT_CONFIG,
  filterToolNames,
  intersectToolRestrictions,
  isInsideRoot,
  isJsonValue,
  isNexgentError,
  isTerminalEvent,
  isToolAdmitted,
  isUsageKnown,
  LEDGER_RECORD_TYPES,
  ledgerMonth,
  mergeJsonObjects,
  NexgentError,
  normalizeWorkspacePath,
  resolveProjectConfig,
  resolveWorkspaceLayout,
  SESSION_RECORD_TYPES,
  toErrorInfo,
  toUsageCount,
  UNKNOWN_USAGE,
  ZERO_USAGE,
  type AppProfile,
  type CheckpointRecord,
  type Credentials,
  type DoneEvent,
  type FinishReason,
  type Ledger,
  type LedgerRecord,
  type LedgerRecordInput,
  type LedgerRecordType,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type LLMStreamEventType,
  type LLMUsage,
  type ProcessRunner,
  type Sandbox,
  type SandboxDecision,
  type SandboxMode,
  type SessionRecord,
  type SessionRecordInput,
  type SessionRecordType,
  type SessionState,
  type SessionStore,
  type ToolContext,
  type ToolDefinition,
  type ToolHandler,
  type ToolRegistry,
  type ToolRestriction,
  type UsageCount,
  type Workspace,
} from '../../src/index.js'
import * as path from 'node:path'

describe('contracts: type-level shape', () => {
  it('llm: stream events are a closed tagged union with one terminal pair', () => {
    expectTypeOf<LLMStreamEventType>().toEqualTypeOf<
      'text.delta' | 'reasoning.delta' | 'tool-call.start' | 'tool-call.delta' | 'tool-call.end' | 'usage' | 'done' | 'error'
    >()
    expectTypeOf<DoneEvent['finishReason']>().toEqualTypeOf<'stop' | 'tool-calls' | 'max-tokens' | 'aborted'>()
    expectTypeOf<FinishReason>().toEqualTypeOf<'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'>()
    expectTypeOf<Extract<LLMStreamEvent, { type: 'error' }>['error']['code']>().toBeString()
  })

  it('llm: every usage field is number | unknown and the request carries thinking + signal + id', () => {
    expectTypeOf<UsageCount>().toEqualTypeOf<number | 'unknown'>()
    expectTypeOf<LLMUsage[keyof LLMUsage]>().toEqualTypeOf<UsageCount>()
    expectTypeOf<LLMRequest['thinking']>().toEqualTypeOf<'off' | 'on'>()
    expectTypeOf<LLMRequest['requestId']>().toBeString()
    expectTypeOf<LLMRequest['signal']>().toEqualTypeOf<AbortSignal | undefined>()
    expectTypeOf<LLMMessage['role']>().toEqualTypeOf<'system' | 'user' | 'assistant' | 'tool'>()
    expectTypeOf<ReturnType<LLMProvider['complete']>>().toEqualTypeOf<AsyncIterable<LLMStreamEvent>>()
  })

  it('tools: definition policy fields, handler signature, registry surface', () => {
    expectTypeOf<ToolDefinition['effects'][number]>().toEqualTypeOf<'read' | 'write' | 'execute' | 'network'>()
    expectTypeOf<ToolDefinition['approval']>().toEqualTypeOf<'never' | 'ask' | 'always'>()
    expectTypeOf<ToolContext>().toHaveProperty('workspace').toEqualTypeOf<Workspace>()
    expectTypeOf<ToolContext['sandboxMode']>().toEqualTypeOf<SandboxMode>()
    expectTypeOf<ToolContext['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<Parameters<ToolHandler>>().toEqualTypeOf<[unknown, ToolContext]>()
    expectTypeOf<ToolRegistry>().toHaveProperty('register')
    expectTypeOf<ToolRegistry>().toHaveProperty('unregister')
    expectTypeOf<ToolRegistry>().toHaveProperty('list')
    expectTypeOf<ToolRegistry>().toHaveProperty('get')
    expectTypeOf<ToolRegistry>().toHaveProperty('restrict')
    expectTypeOf<ToolRestriction>().toEqualTypeOf<{ readonly allow?: readonly string[]; readonly deny?: readonly string[] }>()
  })

  it('session: the v1 record set, common fields and the store surface', () => {
    expectTypeOf<SessionRecordType>().toEqualTypeOf<
      'session.start' | 'user.message' | 'assistant.message' | 'tool.result' | 'turn.start' | 'turn.end' | 'checkpoint' | 'error'
    >()
    expectTypeOf<SessionRecord['seq']>().toBeNumber()
    expectTypeOf<SessionRecord['ts']>().toBeString()
    expectTypeOf<SessionRecord['sessionId']>().toBeString()
    // the store stamps seq/ts/sessionId; callers cannot pass them
    expectTypeOf<SessionRecordInput>().not.toHaveProperty('seq')
    expectTypeOf<CheckpointRecord['state']>().toEqualTypeOf<SessionState>()
    expectTypeOf<CheckpointRecord['coversSeq']>().toBeNumber()
    expectTypeOf<SessionState['messages'][number]['role']>().toEqualTypeOf<'user' | 'assistant' | 'tool'>()
    expectTypeOf<Extract<SessionRecord, { type: 'turn.end' }>['reason']['kind']>().toEqualTypeOf<
      'completed' | 'cancelled' | 'error' | 'max-tokens' | 'interrupted'
    >()
    expectTypeOf<SessionStore>().toHaveProperty('create')
    expectTypeOf<SessionStore>().toHaveProperty('append')
    expectTypeOf<SessionStore>().toHaveProperty('readAll')
    expectTypeOf<SessionStore>().toHaveProperty('latestCheckpoint')
    expectTypeOf<SessionStore>().toHaveProperty('resume')
    expectTypeOf<SessionStore>().toHaveProperty('lock')
    expectTypeOf<SessionStore>().toHaveProperty('release')
    expectTypeOf<ReturnType<SessionStore['resume']>>().toEqualTypeOf<Promise<SessionState>>()
  })

  it('ledger: record set, request-end status with unknown usage, no slot for prompt bodies or secrets', () => {
    expectTypeOf<LedgerRecordType>().toEqualTypeOf<'llm.request.start' | 'llm.request.end' | 'tool.call' | 'task.outcome'>()
    type End = Extract<LedgerRecord, { type: 'llm.request.end' }>
    expectTypeOf<End['status']>().toEqualTypeOf<'ok' | 'error' | 'aborted' | 'unknown'>()
    expectTypeOf<End['usage']>().toEqualTypeOf<LLMUsage>()
    expectTypeOf<End['latencyMs']>().toBeNumber()
    expectTypeOf<End['httpStatus']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<End>().toHaveProperty('endpoint')
    expectTypeOf<End>().toHaveProperty('model')
    expectTypeOf<LedgerRecord>().not.toHaveProperty('messages')
    expectTypeOf<LedgerRecord>().not.toHaveProperty('content')
    expectTypeOf<LedgerRecord>().not.toHaveProperty('apiKey')
    expectTypeOf<Extract<LedgerRecord, { type: 'tool.call' }>>().not.toHaveProperty('arguments')
    type Outcome = Extract<LedgerRecord, { type: 'task.outcome' }>
    expectTypeOf<Outcome['capabilityVersion']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Outcome['memberId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Outcome['executionForm']>().toEqualTypeOf<'direct' | 'delegated' | 'workflow' | undefined>()
    expectTypeOf<Outcome['taskId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<LedgerRecordInput>().not.toHaveProperty('ts')
    expectTypeOf<Ledger>().toHaveProperty('append')
    expectTypeOf<Ledger>().toHaveProperty('read')
  })

  it('workspace, credentials: modes, decisions and the two small services', () => {
    expectTypeOf<SandboxMode>().toEqualTypeOf<'read-only' | 'workspace-write' | 'full-access'>()
    expectTypeOf<Extract<SandboxDecision, { allowed: false }>['reason']>().toBeString()
    expectTypeOf<Sandbox>().toHaveProperty('checkRead')
    expectTypeOf<Sandbox>().toHaveProperty('checkWrite')
    expectTypeOf<Sandbox>().toHaveProperty('checkCommand')
    expectTypeOf<ProcessRunner>().toHaveProperty('run')
    expectTypeOf<ReturnType<Credentials['get']>>().toEqualTypeOf<Promise<string | undefined>>()
  })
})

describe('contracts: pure helpers', () => {
  it('usage arithmetic treats unknown as absorbing', () => {
    expect(addUsageCount(1, 2)).toBe(3)
    expect(addUsageCount(1, 'unknown')).toBe('unknown')
    expect(addUsageCount('unknown', 0)).toBe('unknown')
    const known: LLMUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, reasoningTokens: 0 }
    expect(addUsage()).toEqual(ZERO_USAGE)
    expect(addUsage(known, known)).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, reasoningTokens: 0 })
    const partial: LLMUsage = { ...known, totalTokens: 'unknown' }
    expect(addUsage(known, partial)).toEqual({ ...addUsage(known, known), totalTokens: 'unknown' })
    expect(addUsage(known, UNKNOWN_USAGE)).toEqual(UNKNOWN_USAGE)
    expect(isUsageKnown(known)).toBe(true)
    expect(isUsageKnown(partial)).toBe(false)
    expect(Object.isFrozen(UNKNOWN_USAGE)).toBe(true)
  })

  it('toUsageCount never fabricates a number', () => {
    expect(toUsageCount(42)).toBe(42)
    expect(toUsageCount(0)).toBe(0)
    expect(toUsageCount(undefined)).toBe('unknown')
    expect(toUsageCount(-1)).toBe('unknown')
    expect(toUsageCount(1.5)).toBe('unknown')
    expect(toUsageCount(Number.NaN)).toBe('unknown')
    expect(toUsageCount('7')).toBe('unknown')
  })

  it('isTerminalEvent recognizes only done and error', () => {
    expect(isTerminalEvent({ type: 'done', finishReason: 'stop' })).toBe(true)
    expect(isTerminalEvent({ type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'x' } })).toBe(true)
    expect(isTerminalEvent({ type: 'text.delta', text: 'hi' })).toBe(false)
    expect(isTerminalEvent({ type: 'usage', usage: UNKNOWN_USAGE })).toBe(false)
  })

  it('tool restrictions intersect: every allow must admit, any deny removes', () => {
    const names = ['read_file', 'write_file', 'bash', 'search']
    expect(filterToolNames(names, [])).toEqual(names)
    expect(filterToolNames(names, [{ allow: ['read_file', 'bash', 'search'] }, { allow: ['bash', 'search', 'write_file'] }])).toEqual(['bash', 'search'])
    expect(filterToolNames(names, [{ allow: ['read_file', 'bash'] }, { deny: ['bash'] }])).toEqual(['read_file'])
    expect(filterToolNames(names, [{ deny: ['bash'] }, { deny: ['search'] }])).toEqual(['read_file', 'write_file'])
    expect(isToolAdmitted('bash', [{ allow: [] }])).toBe(false)
    // allow-then-deny and deny-then-allow give the same answer: order does not matter
    const a: ToolRestriction = { allow: ['read_file', 'bash'] }
    const d: ToolRestriction = { deny: ['bash'] }
    expect(filterToolNames(names, [a, d])).toEqual(filterToolNames(names, [d, a]))
  })

  it('intersectToolRestrictions folds to one equivalent mask', () => {
    const names = ['a', 'b', 'c', 'd']
    const sets: ToolRestriction[][] = [
      [],
      [{ allow: ['a', 'b', 'c'] }, { allow: ['b', 'c', 'd'] }],
      [{ allow: ['a', 'b'] }, { deny: ['b'] }, { deny: ['d'] }],
      [{ deny: ['a'] }],
    ]
    for (const restrictions of sets) {
      const folded = intersectToolRestrictions(restrictions)
      expect(filterToolNames(names, [folded])).toEqual(filterToolNames(names, restrictions))
    }
    expect(intersectToolRestrictions([])).toEqual({})
    expect(intersectToolRestrictions([{ allow: ['c', 'a', 'b'] }, { allow: ['b', 'c'] }])).toEqual({ allow: ['b', 'c'] })
    expect(intersectToolRestrictions([{ deny: ['x'] }, { deny: ['y', 'x'] }])).toEqual({ deny: ['x', 'y'] })
  })

  it('assertToolRestriction rejects every malformed mask with config/invalid', () => {
    expect(() => assertToolRestriction({ allow: ['a'] })).not.toThrow()
    expect(() => assertToolRestriction({ deny: [] })).not.toThrow()
    for (const bad of [null, [], 'x', {}, { allow: 'a' }, { allow: [1] }, { allow: ['a'], extra: true }]) {
      let caught: unknown
      try {
        assertToolRestriction(bad)
      } catch (error) {
        caught = error
      }
      expect(isNexgentError(caught, 'config/invalid'), JSON.stringify(bad)).toBe(true)
    }
  })

  it('NexgentError carries a code and flattens to ErrorInfo', () => {
    const inner = new Error('boom')
    const error = new NexgentError('tool/failed', 'tool blew up', { cause: inner, details: { name: 'bash' } })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NexgentError')
    expect(error.code).toBe('tool/failed')
    expect(error.cause).toBe(inner)
    expect(isNexgentError(error)).toBe(true)
    expect(isNexgentError(error, 'tool/failed')).toBe(true)
    expect(isNexgentError(error, 'internal')).toBe(false)
    expect(isNexgentError(inner)).toBe(false)
    expect(toErrorInfo(error)).toEqual({ name: 'NexgentError', code: 'tool/failed', message: 'tool blew up' })
    expect(toErrorInfo(inner)).toEqual({ name: 'Error', code: 'internal', message: 'boom' })
    expect(toErrorInfo('plain string')).toEqual({ name: 'Error', code: 'internal', message: 'plain string' })
    expect(isJsonValue(toErrorInfo(error))).toBe(true)
  })

  it('isJsonValue admits only round-trippable values', () => {
    expect(isJsonValue({ a: [1, 'x', null, { b: true }] })).toBe(true)
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue({ f: () => 1 })).toBe(false)
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isJsonValue(new Date())).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
  })

  it('workspace layout and path helpers are pure and platform-pinned', () => {
    const posixLayout = resolveWorkspaceLayout('/home/u/proj', path.posix)
    expect(posixLayout).toEqual({
      root: '/home/u/proj',
      dataDir: '/home/u/proj/.nexgent',
      configFile: '/home/u/proj/.nexgent/config.json',
      sessions: '/home/u/proj/.nexgent/sessions',
      materials: '/home/u/proj/.nexgent/materials',
      outputs: '/home/u/proj/.nexgent/outputs',
      capabilities: '/home/u/proj/.nexgent/capabilities',
      ledgers: '/home/u/proj/.nexgent/ledgers',
    })
    const winLayout = resolveWorkspaceLayout('C:\\work\\proj', path.win32)
    expect(winLayout.ledgers).toBe('C:\\work\\proj\\.nexgent\\ledgers')
    expect(() => resolveWorkspaceLayout('relative/dir', path.posix)).toThrow(TypeError)

    expect(normalizeWorkspacePath('/r', 'a/../b', path.posix)).toBe('/r/b')
    expect(normalizeWorkspacePath('/r', '/abs//x/', path.posix)).toBe('/abs/x/')
    expect(isInsideRoot('/r', '/r', path.posix)).toBe(true)
    expect(isInsideRoot('/r', '/r/a/b', path.posix)).toBe(true)
    expect(isInsideRoot('/r', '/r/../etc', path.posix)).toBe(false)
    expect(isInsideRoot('/r', '/rr/a', path.posix)).toBe(false)
    expect(isInsideRoot('C:\\r', 'D:\\r\\a', path.win32)).toBe(false)
  })

  it('ledgerMonth buckets by UTC month', () => {
    expect(ledgerMonth('2026-10-07T23:59:59.000Z')).toBe('2026-10')
    expect(ledgerMonth('2026-10-31T23:30:00-05:00')).toBe('2026-11')
    expect(() => ledgerMonth('not a date')).toThrow(RangeError)
  })

  it('record type lists are complete and in sync with the unions', () => {
    const sessionTypes: readonly SessionRecordType[] = SESSION_RECORD_TYPES
    expect(new Set(sessionTypes).size).toBe(8)
    const ledgerTypes: readonly LedgerRecordType[] = LEDGER_RECORD_TYPES
    expect(new Set(ledgerTypes).size).toBe(4)
  })

  it('project config fills defaults without overwriting given values', () => {
    expect(resolveProjectConfig()).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(resolveProjectConfig({ sandboxMode: 'read-only', costCaps: { perTask: { maxRequests: 3 } } })).toEqual({
      ...DEFAULT_PROJECT_CONFIG,
      sandboxMode: 'read-only',
      costCaps: { perTask: { maxRequests: 3 } },
    })
    expect(DEFAULT_PROJECT_CONFIG.thinking).toBe('off')
    expect(DEFAULT_PROJECT_CONFIG.model).toBe('mimo-v2.6-pro')
  })

  it('profile patches: insert appends, patch deep-merges config, unknown or duplicate ids throw', () => {
    const base: AppProfile = [
      { id: 'llm', name: '@nexgent/llm', config: { endpoint: 'https://a', models: { default: 'x' }, list: [1] } },
      { id: 'session', name: '@nexgent/session' },
    ]
    const result = applyProfilePatches(base, [
      { insert: [{ id: 'ledger', name: '@nexgent/llm/ledger', config: { dir: 'ledgers' } }] },
      { id: 'llm', config: { models: { default: 'mimo-v2.6-pro' }, list: [2, 3] } },
      { id: 'session', disabled: true },
    ])
    expect(result).toEqual([
      { id: 'llm', name: '@nexgent/llm', config: { endpoint: 'https://a', models: { default: 'mimo-v2.6-pro' }, list: [2, 3] } },
      { id: 'session', name: '@nexgent/session', disabled: true },
      { id: 'ledger', name: '@nexgent/llm/ledger', config: { dir: 'ledgers' } },
    ])
    expect(base[0]?.config).toEqual({ endpoint: 'https://a', models: { default: 'x' }, list: [1] })
    expect(() => applyProfilePatches(base, [{ id: 'nope', disabled: true }])).toThrow(NexgentError)
    expect(() => applyProfilePatches(base, [{ insert: [{ id: 'llm', name: 'dup' }] }])).toThrow(/duplicates/)
    expect(mergeJsonObjects({ a: { b: 1, c: 2 } }, { a: { c: 3 }, d: null })).toEqual({ a: { b: 1, c: 3 }, d: null })
  })
})
