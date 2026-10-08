/**
 * `scriptedModelServer` — a local HTTP server that speaks the
 * OpenAI-compatible `POST …/chat/completions` API (SSE streaming and plain
 * JSON) and replays a script, one entry per request, with fault injection.
 *
 * Design follows deepseek-harness `test-support/llm-mock-server`
 * (request-scoped behaviors, captured wire requests, chunk counting); the
 * code is a rewrite for the OpenAI chat-completions wire format.
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

/** A chat message as it appears on the wire (loosely typed: tests assert on it). */
export interface ChatWireMessage {
  readonly role: string
  readonly content?: unknown
  readonly tool_calls?: ReadonlyArray<{
    readonly id?: string
    readonly type?: string
    readonly function?: { readonly name?: string; readonly arguments?: string }
  }>
  readonly tool_call_id?: string
  readonly [key: string]: unknown
}

/** The parsed JSON body of a chat-completions request. */
export interface ChatCompletionBody {
  readonly model?: string
  readonly messages?: readonly ChatWireMessage[]
  readonly tools?: readonly unknown[]
  readonly stream?: boolean
  readonly stream_options?: { readonly include_usage?: boolean }
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

/** One captured chat-completions request. */
export interface RecordedModelRequest {
  /** 0-based request number (only chat-completions requests count). */
  readonly index: number
  readonly method: string
  /** Request path including any `/v1` prefix. */
  readonly path: string
  /** Lower-cased headers; the `authorization` value is replaced by `<scheme> [redacted]`. */
  readonly headers: Readonly<Record<string, string>>
  /** Whether an `Authorization` header was present. */
  readonly hasAuthorization: boolean
  /** Parsed JSON body (`undefined` when the body was not JSON). */
  readonly body: ChatCompletionBody | undefined
  /** Raw body text. */
  readonly rawBody: string
  /** SSE `data:` events written so far. */
  chunksSent: number
  /** Server-side outcome; `pending` while the response is still open. */
  outcome: ModelRequestOutcome
}

/** Options for {@link scriptedModelServer}. */
export interface ScriptedModelServerOptions {
  /** Replies in order, one per chat-completions request. */
  readonly script?: readonly ScriptEntry<ChatCompletionBody>[]
  /** Port to listen on; `0` (default) picks a free port. */
  readonly port?: number
  /** Host to bind (default `127.0.0.1`). */
  readonly host?: string
  /** Delay before each SSE chunk in ms (default 0); a turn's `chunkDelayMs` wins. */
  readonly chunkDelayMs?: number
}

/** A running scripted server. */
export interface ScriptedModelServer {
  /** Base URL for an OpenAI-compatible client, e.g. `http://127.0.0.1:43123/v1`. */
  readonly baseUrl: string
  /** Bound port. */
  readonly port: number
  /** Chat-completions requests received so far, in order. */
  readonly requests: readonly RecordedModelRequest[]
  /** Script entries not yet consumed. */
  readonly remaining: number
  /** Append entries to the script. */
  push(...entries: ScriptEntry<ChatCompletionBody>[]): void
  /** Resolve once at least `count` requests have arrived (rejects after `timeoutMs`, default 5000). */
  waitForRequests(count: number, timeoutMs?: number): Promise<readonly RecordedModelRequest[]>
  /** Throw if any script entry is still unconsumed. */
  assertConsumed(): void
  /** Destroy open connections (including stalled ones) and stop listening. */
  close(): Promise<void>
}

/** OpenAI wire usage from contract-term scripted usage. Fields without a value are omitted. */
export function toWireUsage(usage: ScriptedUsage): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (usage.inputTokens !== undefined) wire['prompt_tokens'] = usage.inputTokens + (usage.cacheReadTokens ?? 0)
  if (usage.outputTokens !== undefined) wire['completion_tokens'] = usage.outputTokens
  if (usage.totalTokens !== undefined) wire['total_tokens'] = usage.totalTokens
  if (usage.cacheReadTokens !== undefined) wire['prompt_tokens_details'] = { cached_tokens: usage.cacheReadTokens }
  if (usage.reasoningTokens !== undefined) wire['completion_tokens_details'] = { reasoning_tokens: usage.reasoningTokens }
  return wire
}

const WIRE_FINISH = { 'stop': 'stop', 'tool-calls': 'tool_calls', 'max-tokens': 'length' } as const

/** Build the SSE chunk objects (without `[DONE]`) for one turn. */
function streamChunks(turn: ScriptedTurn, requestNumber: number, model: string): Record<string, unknown>[] {
  const id = `chatcmpl-scripted-${requestNumber}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const deltas: Record<string, unknown>[] = []
  if (turn.reasoning !== undefined && turn.reasoning !== '') deltas.push({ reasoning_content: turn.reasoning })
  for (const text of contentChunks(turn)) deltas.push({ content: text })
  const calls = resolveToolCalls(turn, requestNumber)
  const starts = calls.map((call, index) => ({
    tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
  }))
  const argDelta = (index: number, text: string): Record<string, unknown> => ({
    tool_calls: [{ index, function: { arguments: text } }],
  })
  if (turn.interleaveToolCalls === true) {
    deltas.push(...starts)
    const rounds = Math.max(0, ...calls.map((c) => c.chunks.length))
    for (let r = 0; r < rounds; r++) {
      calls.forEach((call, index) => {
        const text = call.chunks[r]
        if (text !== undefined) deltas.push(argDelta(index, text))
      })
    }
  } else {
    calls.forEach((call, index) => {
      deltas.push(starts[index]!)
      for (const text of call.chunks) deltas.push(argDelta(index, text))
    })
  }
  if (deltas.length === 0) deltas.push({ content: '' })
  deltas[0] = { role: 'assistant', ...deltas[0] }
  const out = deltas.map((d) => chunk(d))
  out.push(chunk({}, WIRE_FINISH[finishReasonOf(turn)]))
  if (turn.usage !== undefined) {
    out.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: toWireUsage(turn.usage) })
  }
  return out
}

/** Build a non-streaming `chat.completion` body for one turn. */
function completionBody(turn: ScriptedTurn, requestNumber: number, model: string): Record<string, unknown> {
  const calls = resolveToolCalls(turn, requestNumber)
  const message: Record<string, unknown> = { role: 'assistant', content: contentChunks(turn).join('') }
  if (turn.reasoning !== undefined) message['reasoning_content'] = turn.reasoning
  if (calls.length > 0) {
    message['tool_calls'] = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
  }
  const body: Record<string, unknown> = {
    id: `chatcmpl-scripted-${requestNumber}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: WIRE_FINISH[finishReasonOf(turn)] }],
  }
  if (turn.usage !== undefined) body['usage'] = toWireUsage(turn.usage)
  return body
}

function redactHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const text = Array.isArray(value) ? value.join(', ') : value
    headers[key] = key === 'authorization' ? `${text.split(' ')[0] ?? ''} [redacted]`.trim() : text
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

/**
 * Start a scripted OpenAI-compatible model server on loopback.
 *
 * Every `POST` whose path ends in `/chat/completions` consumes one script
 * entry. With `"stream": true` the reply is SSE (`data: {chunk}\n\n` … then
 * `data: [DONE]\n\n`); otherwise one `chat.completion` JSON body. Other
 * paths get 404 and consume nothing. An exhausted script answers 500.
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
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}`, type: 'not_found' } })
      return
    }
    let body: ChatCompletionBody | undefined
    try {
      const parsed: unknown = JSON.parse(rawBody)
      body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ChatCompletionBody : undefined
    } catch {
      body = undefined
    }
    const record: RecordedModelRequest = {
      index: requests.length,
      method: req.method,
      path,
      headers: redactHeaders(req),
      hasAuthorization: req.headers.authorization !== undefined,
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
      sendJson(res, 500, { error: { message: `scriptedModelServer: script exhausted at request #${record.index + 1}`, type: 'script_exhausted' } })
      return
    }
    const turn = resolveEntry(entry, body ?? {}, record.index)
    const fault = normalizeFault(turn.fault)
    const model = typeof body?.model === 'string' ? body.model : 'scripted-model'
    const requestNumber = record.index + 1
    const delay = turn.chunkDelayMs ?? options.chunkDelayMs ?? 0

    if (fault?.kind === 'http-error') {
      record.outcome = 'http-error'
      sendJson(res, fault.status, {
        error: { message: fault.message ?? `scripted HTTP ${fault.status}`, type: 'scripted_error', code: String(fault.status) },
      }, fault.headers)
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
        res.end('{"id":"chatcmpl-broken","choices":[{')
        return
      }
      record.outcome = 'completed'
      sendJson(res, 200, completionBody(turn, requestNumber, model))
      return
    }

    const chunks = streamChunks(turn, requestNumber, model)
    const cut = fault === undefined
      ? chunks.length
      : Math.min(chunks.length, fault.afterChunks ?? (fault.kind === 'disconnect' ? 1 : 0))
    if (fault?.kind === 'timeout' && cut === 0) {
      // Never respond at all: not even headers.
      record.outcome = 'stalled'
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
    res.flushHeaders()
    for (const chunk of chunks.slice(0, cut)) {
      await sleep(delay)
      if (closed) return
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
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
        res.write('data: {"id":"chatcmpl-broken","choices":[{"delta":{"content":\n\n')
        record.chunksSent++
        res.end()
        return
      default:
        record.outcome = 'completed'
        res.end('data: [DONE]\n\n')
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(error), type: 'server_bug' } })
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
    baseUrl: `http://${urlHost}:${port}/v1`,
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
