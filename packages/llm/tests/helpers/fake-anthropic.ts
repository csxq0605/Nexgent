/**
 * A small Anthropic Messages API fake for `@nexgent/llm` tests: a node:http
 * server that answers `POST /v1/messages` by replaying a scripted response —
 * usually a recorded SSE fixture from `tests/fixtures/` — and records every
 * request it received.
 *
 * Kept local to this package so `@nexgent/llm` and `@nexgent/test-support`
 * stay independent; the replay format (raw SSE text, one event per
 * blank-line block) is the one {@link recordSse} writes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

/** Directory holding the recorded fixtures. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** What the fake does for one request. */
export interface FakeReply {
  /** HTTP status; default 200. */
  readonly status?: number
  /** Extra response headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Raw SSE pieces written one by one (see {@link loadSseFixture}). */
  readonly sse?: readonly string[]
  /** A plain body (used for error statuses). */
  readonly body?: string
  /** Delay between SSE pieces in ms; default 0. */
  readonly delayMs?: number
  /** Never send response headers (the client must time out). */
  readonly hangBeforeHeaders?: boolean
  /** After this many SSE pieces, stop writing but keep the connection open. */
  readonly hangAfter?: number
  /** After this many SSE pieces, destroy the socket (network drop). */
  readonly destroyAfter?: number
  /** Echo the request's `x-api-key` header into an error body (redaction tests). */
  readonly echoApiKey?: boolean
}

/** One request the fake received. */
export interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

/** A running fake. */
export interface FakeAnthropic {
  /** Bare origin, e.g. `http://127.0.0.1:1234` (the SDK appends `/v1/messages`). */
  readonly baseUrl: string
  readonly port: number
  readonly requests: CapturedRequest[]
  /** Resolves when the client side of the connection closes for request `n` (0-based). */
  closed(n: number): Promise<void>
  close(): Promise<void>
}

/**
 * Split raw SSE text into one piece per event, normalizing CRLF so a Windows
 * checkout replays identically.
 * @param text - raw `text/event-stream` content.
 */
export function splitSse(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n\n/).filter(piece => piece.trim() !== '').map(piece => `${piece}\n\n`)
}

/**
 * Load a recorded SSE fixture as replay pieces.
 * @param name - file name under `tests/fixtures/`, without `.sse`.
 */
export function loadSseFixture(name: string): string[] {
  return splitSse(readFileSync(`${FIXTURES_DIR}${name}.sse`, 'utf8'))
}

/** Serialize one SSE event the way the API writes it. */
export function sseEvent(data: Record<string, unknown>): string {
  return `event: ${String(data['type'])}\ndata: ${JSON.stringify(data)}\n\n`
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Start the fake.
 * @param replies - one reply per request in order (the last one repeats), or a function of the request index.
 */
export async function startFakeAnthropic(
  replies: readonly FakeReply[] | ((index: number, request: CapturedRequest) => FakeReply),
): Promise<FakeAnthropic> {
  const requests: CapturedRequest[] = []
  const closedWaiters = new Map<number, { promise: Promise<void>; resolve: () => void }>()
  const sockets = new Set<Socket>()
  const waiter = (n: number): { promise: Promise<void>; resolve: () => void } => {
    let entry = closedWaiters.get(n)
    if (entry === undefined) {
      let resolve!: () => void
      const promise = new Promise<void>(r => { resolve = r })
      entry = { promise, resolve }
      closedWaiters.set(n, entry)
    }
    return entry
  }

  const handler: http.RequestListener = (req, res) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => {
      void (async () => {
        const text = Buffer.concat(parts).toString('utf8')
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(text) as Record<string, unknown>
        } catch {
          // keep empty
        }
        const captured: CapturedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
        const index = requests.length
        requests.push(captured)
        res.on('close', () => waiter(index).resolve())
        const reply = typeof replies === 'function' ? replies(index, captured) : replies[Math.min(index, replies.length - 1)]
        const path = (req.url ?? '').split('?')[0]
        if (reply === undefined || req.method !== 'POST' || path !== '/v1/messages') {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}')
          return
        }
        if (reply.hangBeforeHeaders === true) return
        const status = reply.status ?? 200
        if (reply.sse === undefined) {
          const errorBody = reply.echoApiKey === true
            ? JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${String(req.headers['x-api-key'] ?? '')}` } })
            : reply.body ?? ''
          res.writeHead(status, { 'content-type': 'application/json', ...reply.headers }).end(errorBody)
          return
        }
        res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...reply.headers })
        res.flushHeaders()
        for (const [i, piece] of reply.sse.entries()) {
          if (reply.hangAfter !== undefined && i >= reply.hangAfter) return
          if (reply.destroyAfter !== undefined && i >= reply.destroyAfter) {
            await sleep(30)
            req.socket.destroy()
            return
          }
          if (res.destroyed) return
          res.write(piece)
          if ((reply.delayMs ?? 0) > 0) await sleep(reply.delayMs ?? 0)
        }
        if (reply.hangAfter !== undefined && reply.hangAfter >= reply.sse.length) return
        if (reply.destroyAfter !== undefined && reply.destroyAfter >= reply.sse.length) {
          await sleep(30)
          req.socket.destroy()
          return
        }
        res.end()
      })()
    })
  }

  const server = http.createServer(handler)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    closed: n => waiter(n).promise,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** A port nothing listens on (bound then released), for connection-refused tests. */
export async function closedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/**
 * Record a real streaming response into a fixture file (manual use only; the
 * test suite never calls a real endpoint). The request body is not written,
 * so the key cannot end up in the fixture.
 * @param baseUrl - API origin, e.g. `https://api.anthropic.com`.
 * @param apiKey - the API key.
 * @param body - request body (must have `stream: true`).
 * @param file - destination path.
 */
export async function recordSse(baseUrl: string, apiKey: string, body: Record<string, unknown>, file: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  writeFileSync(file, await response.text(), 'utf8')
}
