/**
 * Request-aware script entries for the scripted model server: recognise
 * what kind of request arrived (a compaction summary request, a turn
 * mentioning some text) and fail loudly when a scenario's request order
 * drifts, instead of silently answering the wrong request.
 */
import type { ScriptedTurn } from './script.js'
import type { MessagesRequestBody } from './server.js'

/** A server script entry that looks at the request it answers. */
export type RequestEntry = (request: MessagesRequestBody, index: number) => ScriptedTurn

/** All text of a request (system prompt and every text / tool_result block), joined with newlines. */
export function requestText(body: MessagesRequestBody | undefined): string {
  if (body === undefined) return ''
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item)
    } else if (value !== null && typeof value === 'object') {
      const block = value as Record<string, unknown>
      if (typeof block['text'] === 'string') parts.push(block['text'])
      if (block['content'] !== undefined) visit(block['content'])
    }
  }
  visit(body.system)
  visit(body.messages)
  return parts.join('\n')
}

/**
 * Whether this is an auxiliary request (the compaction summary request): it
 * carries no tools (docs/spec/agent-hooks.md §压缩: “不带工具”).
 */
export function isAuxiliaryRequest(body: MessagesRequestBody): boolean {
  return !Array.isArray(body.tools) || body.tools.length === 0
}

/**
 * Answer with `turn` only when `predicate` holds; otherwise answer with an
 * HTTP 418 whose message names the expectation, so the run fails where the
 * scenario went off script.
 * @param label - what the entry expects, e.g. `compaction summary request`.
 */
export function expectRequest(
  label: string,
  predicate: (request: MessagesRequestBody) => boolean,
  turn: ScriptedTurn | RequestEntry,
): RequestEntry {
  return (request, index) => {
    if (!predicate(request)) {
      return { fault: { kind: 'http-error', status: 418, message: `scripted server: request #${index + 1} is not the expected ${label}` } }
    }
    return typeof turn === 'function' ? turn(request, index) : turn
  }
}

/** Fault "压缩请求失败": the next request must be the compaction summary request; answer it with HTTP `status`. */
export function failCompaction(status = 500): RequestEntry {
  return expectRequest('compaction summary request', isAuxiliaryRequest, {
    fault: { kind: 'http-error', status, message: 'scripted compaction failure' },
  })
}

/** Answer the compaction summary request with `summary`. */
export function compactionSummary(summary: string, usage?: ScriptedTurn['usage']): RequestEntry {
  return expectRequest('compaction summary request', isAuxiliaryRequest, usage === undefined ? { content: summary } : { content: summary, usage })
}
