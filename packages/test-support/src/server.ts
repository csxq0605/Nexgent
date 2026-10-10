/**
 * `scriptedModelServer` — a local HTTP server that speaks the Anthropic
 * Messages API (`POST /v1/messages`, SSE streaming and plain JSON) and
 * replays a script, one entry per request, with fault injection.
 *
 * Design follows deepseek-harness `test-support/llm-mock-server`
 * (request-scoped behaviors, captured wire requests, chunk counting); the
 * code is a rewrite for the Messages API wire format.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  contentChunks,
  finishReasonOf,
  normalizeFault,
  resolveEntry,
  resolveToolCalls,
  sleep,
  type ScriptEntry,
  type ScriptedTurn,
  type ScriptedUsage,
} from './script.js'

/** The parsed JSON body of a Messages API request (loosely typed: tests assert on it). */
export interface MessagesRequestBody {
  readonly model?: string
  readonly max_tokens?: number
  readonly system?: unknown
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content?: unknown; readonly [key: string]: unknown }>
  readonly tools?: readonly unknown[]
  readonly thinking?: unknown
  readonly output_config?: unknown
  readonly stream?: boolean
  readonly [key: string]: unknown
}

/** How a recorded request ended at the server. */
export type ModelRequestOutcome =
  | 'pending'
  | 'completed'
  | 'stalled'
  | 'disconnected'
  | 'http-error'
  | 'malformed'
  | 'exhausted'
  | 'client-closed'

/** One captured Messages API request. */
export interface RecordedModelRequest {
  /** 0-based request number (only `/v1/messages` requests count). */
  readonly index: number
  readonly method: string
  /** Request path without the query string. */
  readonly path: string
  /** Lower-cased headers; `x-api-key` is replaced by `[redacted]` and `authorization` by `<scheme> [redacted]`. */
  readonly headers: Readonly<Record<string, string>>
  /** Whether an `x-api-key` (or `Authorization`) header was present. */
  readonly hasApiKey: boolean
  /** Parsed JSON body (`undefined` when the body was not JSON). */
  readonly body: MessagesRequestBody | undefined
  /** Raw body text. */
  readonly rawBody: string
  /** SSE events written so far. */
  chunksSent: number
  /** Server-side outcome; `pending` while the response is still open. */
  outcome: ModelRequestOutcome
}

/** Options for {@link scriptedModelServer}. */
export interface ScriptedModelServerOptions {
  /** Replies in order, one per `/v1/messages` request. */
  readonly script?: readonly ScriptEntry<MessagesRequestBody>[]
  /** Port to listen on; `0` (default) picks a free port. */
  readonly port?: number
  /** Host to bind (default `127.0.0.1`). */
  readonly host?: string
  /** Delay before each SSE event in ms (default 0); a turn's `chunkDelayMs` wins. */
  readonly chunkDelayMs?: number
}

/** A running scripted server. */
export interface ScriptedModelServer {
  /** Origin for the SDK's `baseURL` / `NEXGENT_API_BASE_URL`, e.g. `http://127.0.0.1:43123` (no path). */
  readonly baseUrl: string
  /** Bound port. */
  readonly port: number
  /** `/v1/messages` requests received so far, in order. */
  readonly requests: readonly RecordedModelRequest[]
  /** Script entries not yet consumed. */
  readonly remaining: number
  /** Append entries to the script. */
  push(...entries: ScriptEntry<MessagesRequestBody>[]): void
  /** Resolve once at least `count` requests have arrived (rejects after `timeoutMs`, default 5000). */
  waitForRequests(count: number, timeoutMs?: number): Promise<readonly RecordedModelRequest[]>
  /** Throw if any script entry is still unconsumed. */
  assertConsumed(): void
  /** Destroy open connections (including stalled ones) and stop listening. */
  close(): Promise<void>
}

/** Messages API usage split into the `message_start` and `message_delta` parts. */
export interface WireUsageParts {
  /** `message_start.message.usage`: input and cache counts. */
  readonly start: Record<string, unknown>
  /** `message_delta.usage`: output count. */
  readonly delta: Record<string, unknown>
}

/**
 * Messages API usage from contract-term scripted usage. Fields without a
 * value are omitted (`totalTokens` and `reasoningTokens` have no wire field).
 */
export function toWireUsage(usage: ScriptedUsage): WireUsageParts {
  const start: Record<string, unknown> = {}
  const delta: Record<string, unknown> = {}
  if (usage.inputTokens !== undefined) start['input_tokens'] = usage.inputTokens
  if (usage.cacheReadTokens !== undefined) start['cache_read_input_tokens'] = usage.cacheReadTokens
  if (usage.outputTokens !== undefined) delta['output_tokens'] = usage.outputTokens
  return { start, delta }
}

const WIRE_STOP = { 'stop': 'end_turn', 'tool-calls': 'tool_use', 'max-tokens': 'max_tokens', 'refusal': 'refusal' } as const

type Block = { readonly start: Record<string, unknown>; readonly deltas: readonly Record<string, unknown>[] }

/** The content blocks of a turn as (start block, deltas) pairs. */
function blocksOf(turn: ScriptedTurn, requestNumber: number): Block[] {
  const blocks: Block[] = []
  if (turn.reasoning !== undefined && turn.reasoning !== '') {
    blocks.push({
      start: { type: 'thinking', thinking: '', signature: '' },
      deltas: [{ type: 'thinking_delta', thinking: turn.reasoning }, { type: 'signature_delta', signature: `scripted-signature-${requestNumber}` }],
    })
  }
  const text = contentChunks(turn)
  if (text.length > 0) blocks.push({ start: { type: 'text', text: '' }, deltas: text.map((t) => ({ type: 'text_delta', text: t })) })
  for (const call of resolveToolCalls(turn, requestNumber)) {
    blocks.push({
      start: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      deltas: call.chunks.map((partial_json) => ({ type: 'input_json_delta', partial_json })),
    })
  }
  return blocks
}

/** The `message_delta` event of a turn. */
function messageDelta(turn: ScriptedTurn, usage: WireUsageParts | undefined): Record<string, unknown> {
  const stop = finishReasonOf(turn)
  const delta: Record<string, unknown> = { stop_reason: WIRE_STOP[stop], stop_sequence: null }
  if (stop === 'refusal') {
    delta['stop_details'] = {
      type: 'refusal',
      category: turn.stopDetails?.category ?? null,
      explanation: turn.stopDetails?.explanation ?? null,
    }
  }
  return { type: 'message_delta', delta, usage: usage?.delta ?? {} }
}

/** Build the SSE event objects for one turn, in API order. */
function streamEvents(turn: ScriptedTurn, requestNumber: number, model: string): Record<string, unknown>[] {
  const usage = turn.usage === undefined ? undefined : toWireUsage(turn.usage)
  const out: Record<string, unknown>[] = [{
    type: 'message_start',
    message: {
      id: `msg_scripted_${requestNumber}`, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: usage?.start ?? {},
    },
  }]
  const blocks = blocksOf(turn, requestNumber)
  const tools = blocks.flatMap((block, index) => block.start['type'] === 'tool_use' ? [index] : [])
  const plain = blocks.flatMap((block, index) => block.start['type'] === 'tool_use' ? [] : [index])
  const emitBlock = (index: number): void => {
    const block = blocks[index]!
    out.push({ type: 'content_block_start', index, content_block: block.start })
    for (const delta of block.deltas) out.push({ type: 'content_block_delta', index, delta })
    out.push({ type: 'content_block_stop', index })
  }
  for (const index of plain) emitBlock(index)
  if (turn.interleaveToolCalls === true && tools.length > 1) {
    // Parallel calls with their argument fragments round-robined across open blocks.
    for (const index of tools) out.push({ type: 'content_block_start', index, content_block: blocks[index]!.start })
    const rounds = Math.max(0, ...tools.map((index) => blocks[index]!.deltas.length))
    for (let r = 0; r < rounds; r++) {
      for (const index of tools) {
        const delta = blocks[index]!.deltas[r]
        if (delta !== undefined) out.push({ type: 'content_block_delta', index, delta })
      }
    }
    for (const index of tools) out.push({ type: 'content_block_stop', index })
  } else {
    for (const index of tools) emitBlock(index)
  }
  out.push(messageDelta(turn, usage))
  out.push({ type: 'message_stop' })
  return out
}

/** Build a non-streaming `message` body for one turn. */
function messageBody(turn: ScriptedTurn, requestNumber: number, model: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (turn.reasoning !== undefined && turn.reasoning !== '') {
    content.push({ type: 'thinking', thinking: turn.reasoning, signature: `scripted-signature-${requestNumber}` })
  }
  const text = contentChunks(turn).join('')
  if (text !== '') content.push({ type: 'text', text })
  for (const call of resolveToolCalls(turn, requestNumber)) {
    let input: unknown
    try {
      input = JSON.parse(call.arguments)
    } catch {
      input = { _raw: call.arguments }
    }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input })
  }
  const delta = messageDelta(turn, turn.usage === undefined ? undefined : toWireUsage(turn.usage))
  const usage = turn.usage === undefined ? {} : { ...toWireUsage(turn.usage).start, ...toWireUsage(turn.usage).delta }
  return {
    id: `msg_scripted_${requestNumber}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    ...delta['delta'] as Record<string, unknown>,
    usage,
  }
}

function redactHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const text = Array.isArray(value) ? value.join(', ') : value
    if (key === 'x-api-key') headers[key] = '[redacted]'
    else if (key === 'authorization') headers[key] = `${text.split(' ')[0] ?? ''} [redacted]`.trim()
    else headers[key] = text
  }
  return headers
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

function errorBody(type: string, message: string): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}

/**
 * Start a scripted Anthropic Messages API server on loopback.
 *
 * Every `POST /v1/messages` (any query string) consumes one script entry.
 * With `"stream": true` the reply is SSE (`event: <type>\ndata: {json}\n\n`
 * per event, in API order: `message_start`, per block `content_block_start`
 * / `content_block_delta`* / `content_block_stop`, `message_delta`,
 * `message_stop`); otherwise one `message` JSON body. Other paths get 404
 * and consume nothing. An exhausted script answers 500.
 * @param options - script, port and pacing.
 */
export async function scriptedModelServer(options: ScriptedModelServerOptions = {}): Promise<ScriptedModelServer> {
  const queue = [...(options.script ?? [])]
  const requests: RecordedModelRequest[] = []
  const sockets = new Set<Socket>()
  const waiters = new Set<() => void>()
  const host = options.host ?? '127.0.0.1'

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const rawBody = await readBody(req)
    if (req.method !== 'POST' || path !== '/v1/messages') {
      sendJson(res, 404, errorBody('not_found_error', `no route for ${req.method} ${path}`))
      return
    }
    let body: MessagesRequestBody | undefined
    try {
      const parsed: unknown = JSON.parse(rawBody)
      body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as MessagesRequestBody : undefined
    } catch {
      body = undefined
    }
    const record: RecordedModelRequest = {
      index: requests.length,
      method: req.method,
      path,
      headers: redactHeaders(req),
      hasApiKey: req.headers['x-api-key'] !== undefined || req.headers.authorization !== undefined,
      body,
      rawBody,
      chunksSent: 0,
      outcome: 'pending',
    }
    requests.push(record)
    for (const wake of waiters) wake()

    let closed = false
    res.on('close', () => {
      closed = true
      if (record.outcome === 'pending') record.outcome = 'client-closed'
    })

    const entry = queue.shift()
    if (entry === undefined) {
      record.outcome = 'exhausted'
      sendJson(res, 500, errorBody('script_exhausted', `scriptedModelServer: script exhausted at request #${record.index + 1}`))
      return
    }
    const turn = resolveEntry(entry, body ?? {}, record.index)
    const fault = normalizeFault(turn.fault)
    const model = typeof body?.model === 'string' ? body.model : 'scripted-model'
    const requestNumber = record.index + 1
    const delay = turn.chunkDelayMs ?? options.chunkDelayMs ?? 0

    if (fault?.kind === 'http-error') {
      record.outcome = 'http-error'
      sendJson(res, fault.status, errorBody('scripted_error', fault.message ?? `scripted HTTP ${fault.status}`), fault.headers)
      return
    }
    if (fault?.kind === 'disconnect' && (fault.afterChunks ?? 1) === 0) {
      record.outcome = 'disconnected'
      req.socket.destroy()
      return
    }

    if (body?.stream !== true) {
      if (fault?.kind === 'timeout') {
        record.outcome = 'stalled'
        return
      }
      if (fault?.kind === 'disconnect') {
        record.outcome = 'disconnected'
        req.socket.destroy()
        return
      }
      if (fault?.kind === 'malformed-json') {
        record.outcome = 'malformed'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"id":"msg_broken","type":"message","content":[{')
        return
      }
      record.outcome = 'completed'
      sendJson(res, 200, messageBody(turn, requestNumber, model))
      return
    }

    const events = streamEvents(turn, requestNumber, model)
    const cut = fault === undefined
      ? events.length
      : Math.min(events.length, fault.afterChunks ?? (fault.kind === 'disconnect' ? 1 : 0))
    if (fault?.kind === 'timeout' && cut === 0) {
      // Never respond at all: not even headers.
      record.outcome = 'stalled'
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
    res.flushHeaders()
    for (const event of events.slice(0, cut)) {
      await sleep(delay)
      if (closed) return
      res.write(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
      record.chunksSent++
    }
    if (closed) return
    switch (fault?.kind) {
      case 'timeout':
        record.outcome = 'stalled'
        return
      case 'disconnect':
        record.outcome = 'disconnected'
        req.socket.destroy()
        return
      case 'malformed-json':
        record.outcome = 'malformed'
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":\n\n')
        record.chunksSent++
        res.end()
        return
      default:
        record.outcome = 'completed'
        res.end()
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, errorBody('server_bug', String(error)))
      else res.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  const urlHost = host.includes(':') ? `[${host}]` : host

  return {
    baseUrl: `http://${urlHost}:${port}`,
    port,
    get requests() { return requests },
    get remaining() { return queue.length },
    push(...entries) { queue.push(...entries) },
    assertConsumed() {
      if (queue.length > 0) throw new Error(`scriptedModelServer: ${queue.length} script entr${queue.length === 1 ? 'y' : 'ies'} not consumed`)
    },
    waitForRequests(count, timeoutMs = 5000) {
      if (requests.length >= count) return Promise.resolve(requests)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`scriptedModelServer: expected ${count} requests within ${timeoutMs}ms, got ${requests.length}`))
        }, timeoutMs)
        function check(): void {
          if (requests.length < count) return
          clearTimeout(timer)
          waiters.delete(check)
          resolve(requests)
        }
        waiters.add(check)
      })
    },
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
