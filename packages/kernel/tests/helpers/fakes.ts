/**
 * In-memory fakes of the step-1 contracts for kernel tests: a scripted
 * LLMProvider, a SessionStore that projects records per data-formats.md, a
 * Ledger, a Workspace, and plugin wrappers for profile boot.
 */
import { mkdirSync } from 'node:fs'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import {
  addUsage,
  NexgentError,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type CheckpointRecord,
  type Ledger,
  type LedgerRecord,
  type LedgerRecordInput,
  type LLMCompleteOptions,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type LLMUsage,
  type SessionInit,
  type SessionLock,
  type SessionReadResult,
  type SessionRecord,
  type SessionRecordInput,
  type SessionState,
  type SessionStore,
  type Workspace,
} from '../../src/index.js'

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** One scripted response: a list of events, or a generator that may wait on the request signal. */
export type ScriptStep =
  | readonly LLMStreamEvent[]
  | ((request: LLMRequest, options: LLMCompleteOptions | undefined) => AsyncIterable<LLMStreamEvent>)

export const usage = (input: number, output: number): LLMUsage => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cacheReadTokens: 0,
  reasoningTokens: 0,
})

/** Events of a plain text reply. */
export function textReply(text: string, used: LLMUsage = usage(10, 5)): LLMStreamEvent[] {
  return [{ type: 'text.delta', text }, { type: 'usage', usage: used }, { type: 'done', finishReason: 'stop' }]
}

/** Events of a reply that calls one tool. */
export function toolCallReply(id: string, name: string, args: unknown, text = '', used: LLMUsage = usage(10, 5)): LLMStreamEvent[] {
  const json = JSON.stringify(args)
  return [
    ...(text === '' ? [] : [{ type: 'text.delta' as const, text }]),
    { type: 'tool-call.start', index: 0, id, name },
    { type: 'tool-call.delta', index: 0, argumentsDelta: json },
    { type: 'tool-call.end', index: 0, call: { id, name, arguments: json } },
    { type: 'usage', usage: used },
    { type: 'done', finishReason: 'tool-calls' },
  ]
}

/** Resolve after `ms`, or when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** A provider that answers request N with `script[N]` and records every request. */
export class ScriptedLLM implements LLMProvider {
  readonly info = { id: 'mimo', endpoint: 'https://example.invalid/v1', defaultModel: 'scripted-model' }
  readonly requests: LLMRequest[] = []
  readonly options: (LLMCompleteOptions | undefined)[] = []
  private index = 0

  constructor(private readonly script: ScriptStep[]) {}

  /** Append more steps. */
  push(...steps: ScriptStep[]): void {
    this.script.push(...steps)
  }

  complete(request: LLMRequest, options?: LLMCompleteOptions): AsyncIterable<LLMStreamEvent> {
    this.requests.push(request)
    this.options.push(options)
    const step = this.script[this.index++]
    if (step === undefined) return (async function* () {
      yield { type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'script exhausted' } } as LLMStreamEvent
    })()
    if (typeof step === 'function') return step(request, options)
    return (async function* () {
      for (const event of step) {
        if (request.signal?.aborted === true) {
          yield { type: 'done', finishReason: 'aborted' } as LLMStreamEvent
          return
        }
        yield event
      }
    })()
  }
}

/** History messages of a request without the system prompt. */
export function conversation(request: LLMRequest): LLMMessage[] {
  return request.messages.filter(message => message.role !== 'system')
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function project(records: readonly SessionRecord[], from?: CheckpointRecord): SessionState {
  let state: SessionState | undefined = from?.state
  const messages = [...(state?.messages ?? [])]
  let meta = state?.metadata
  for (const record of records) {
    if (from !== undefined && record.seq <= from.coversSeq) continue
    switch (record.type) {
      case 'session.start':
        meta = {
          createdAt: record.ts,
          projectRoot: record.projectRoot,
          model: record.model,
          sandboxMode: record.sandboxMode,
          grants: [],
          ...(record.title === undefined ? {} : { title: record.title }),
          lastTurn: 0,
          totalUsage: ZERO_USAGE,
          lastSeq: record.seq,
        }
        break
      case 'turn.start':
        meta = { ...meta!, lastTurn: record.turn, openTurn: record.turn }
        break
      case 'turn.end': {
        const { openTurn: _drop, ...rest } = meta!
        meta = rest
        break
      }
      case 'user.message':
        messages.push({ role: 'user', content: record.content })
        break
      case 'assistant.message':
        if (!(record.interrupted === true && record.content === '')) {
          messages.push({ role: 'assistant', content: record.content, ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls }) })
        }
        meta = { ...meta!, totalUsage: addUsage(meta!.totalUsage, record.usage) }
        break
      case 'tool.result':
        messages.push({ role: 'tool', toolCallId: record.toolCallId, name: record.name, content: record.content, isError: record.isError })
        break
      case 'approval.grant':
        meta = { ...meta!, grants: [...meta!.grants, record.grant] }
        break
      default:
        break
    }
    meta = { ...meta!, lastSeq: record.seq }
  }
  state = { sessionId: records[0]!.sessionId, version: 1, messages, metadata: meta! }
  return state
}

/** A SessionStore keeping each session as an array of records. */
export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, SessionRecord[]>()
  readonly locks = new Set<string>()
  /** Fail the next append whose type matches. */
  failNext: string | undefined

  async create(init: SessionInit): Promise<SessionLock> {
    if (this.sessions.has(init.sessionId)) throw new NexgentError('session/exists', init.sessionId)
    this.sessions.set(init.sessionId, [])
    const lock = await this.lock(init.sessionId)
    await this.append(init.sessionId, {
      type: 'session.start',
      version: 1,
      projectRoot: init.projectRoot,
      model: init.model,
      sandboxMode: init.sandboxMode,
      ...(init.title === undefined ? {} : { title: init.title }),
    })
    return lock
  }

  async append(sessionId: string, record: SessionRecordInput): Promise<SessionRecord> {
    const records = this.sessions.get(sessionId)
    if (records === undefined) throw new NexgentError('session/not-found', sessionId)
    if (!this.locks.has(sessionId)) throw new NexgentError('session/locked', `not locked: ${sessionId}`)
    if (this.failNext === record.type) {
      this.failNext = undefined
      throw new NexgentError('session/invalid-record', 'injected failure')
    }
    const full = JSON.parse(JSON.stringify({ ...record, seq: records.length + 1, ts: new Date().toISOString(), sessionId })) as SessionRecord
    records.push(full)
    return full
  }

  async readAll(sessionId: string): Promise<SessionReadResult> {
    const records = this.sessions.get(sessionId)
    if (records === undefined) throw new NexgentError('session/not-found', sessionId)
    return { records: [...records] }
  }

  async latestCheckpoint(sessionId: string): Promise<CheckpointRecord | undefined> {
    const records = (await this.readAll(sessionId)).records
    return [...records].reverse().find((record): record is CheckpointRecord => record.type === 'checkpoint')
  }

  async resume(sessionId: string): Promise<SessionState> {
    const { records } = await this.readAll(sessionId)
    const checkpoint = await this.latestCheckpoint(sessionId)
    return project(records, checkpoint)
  }

  async lock(sessionId: string): Promise<SessionLock> {
    if (!this.sessions.has(sessionId)) throw new NexgentError('session/not-found', sessionId)
    if (this.locks.has(sessionId)) throw new NexgentError('session/locked', sessionId)
    this.locks.add(sessionId)
    return { sessionId, path: `/locks/${sessionId}`, info: { pid: process.pid, ts: new Date().toISOString(), host: 'test' } }
  }

  async release(lock: SessionLock): Promise<void> {
    this.locks.delete(lock.sessionId)
  }

  /** Record types of one session, in order. */
  types(sessionId: string): string[] {
    return (this.sessions.get(sessionId) ?? []).map(record => record.type)
  }

  /** Records of one session of a type. */
  of<T extends SessionRecord['type']>(sessionId: string, type: T): Extract<SessionRecord, { type: T }>[] {
    return (this.sessions.get(sessionId) ?? []).filter((record): record is Extract<SessionRecord, { type: T }> => record.type === type)
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** A Ledger keeping records in an array. */
export class MemoryLedger implements Ledger {
  readonly records: LedgerRecord[] = []
  writeFailures = 0
  fail = false

  async append(record: LedgerRecordInput): Promise<LedgerRecord> {
    if (this.fail) {
      this.writeFailures += 1
      throw new NexgentError('ledger/write-failed', 'injected failure')
    }
    const full = { ...record, ts: new Date().toISOString() } as LedgerRecord
    this.records.push(full)
    return full
  }

  async *read(): AsyncIterable<LedgerRecord> {
    yield* this.records
  }

  of<T extends LedgerRecord['type']>(type: T): Extract<LedgerRecord, { type: T }>[] {
    return this.records.filter((record): record is Extract<LedgerRecord, { type: T }> => record.type === type)
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** A workspace rooted at `root`; `ensureLayout` creates the directories. */
export function fakeWorkspace(root: string): Workspace {
  const layout = resolveWorkspaceLayout(root)
  return {
    root: layout.root,
    layout,
    resolve: input => (input.startsWith('/') ? input : `${layout.root}/${input}`),
    relative: absolute => absolute.slice(layout.root.length + 1),
    sessionDir: id => `${layout.sessions}/${id}`,
    ensureLayout: async () => {
      mkdirSync(layout.sessions, { recursive: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/** A plugin that provides `value` as service `name`. */
export function servicePlugin(name: string, value: unknown): Plugin {
  return {
    name: `fake-${name}`,
    apply: (ctx: Context) => {
      ctx.provide(name, value)
    },
  }
}
