// Adapted from deepseek-harness@46a7f68b packages/bundle/headless/src/json-stream.ts (MIT)
/**
 * Bounded JSON-lines serialization for `--json` output: every string and key
 * is capped, and one line (newline included) is capped, so a huge tool
 * result cannot produce an unbounded line. The terminal `final` event is
 * written unbounded by the renderer.
 */

/** Default per-string and per-key cap in UTF-8 bytes. */
export const MAX_STRING_BYTES = 8 * 1024

/** Default cap on one serialized line, its newline included. */
export const MAX_EVENT_BYTES = 32 * 1024

/** Containers nested deeper than this are cut. */
const MAX_DEPTH = 64

interface BoundState {
  truncated: boolean
}

/** Truncate a string to `maxBytes` of UTF-8, dropping a split trailing character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const decoded = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return decoded.endsWith('�') ? decoded.slice(0, -1) : decoded
}

function boundString(value: string, maxBytes: number, state: BoundState): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  state.truncated = true
  return truncateUtf8(value, maxBytes)
}

function boundValue(value: unknown, maxBytes: number, state: BoundState, depth: number): unknown {
  if (typeof value === 'string') return boundString(value, maxBytes, state)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) {
    state.truncated = true
    return '[truncated: depth]'
  }
  if (Array.isArray(value)) return value.map(item => boundValue(item, maxBytes, state, depth + 1))
  // A null prototype keeps a literal `__proto__` key as data.
  const bounded = Object.create(null) as Record<string, unknown>
  for (const [key, item] of Object.entries(value)) {
    bounded[boundString(key, maxBytes, state)] = boundValue(item, maxBytes, state, depth + 1)
  }
  return bounded
}

/**
 * Serialize one event under both caps. When the line is still too long,
 * scalar fields survive and structured ones are dropped; at the extreme only
 * `type` and `truncated` remain. Any cut adds `truncated: true`.
 * @returns the JSON line without its trailing newline.
 */
export function boundJsonLine(
  event: Readonly<Record<string, unknown>>,
  maxStringBytes: number = MAX_STRING_BYTES,
  maxEventBytes: number = MAX_EVENT_BYTES,
): string {
  const limit = maxEventBytes - 1
  const state: BoundState = { truncated: false }
  const bounded = boundValue(event, maxStringBytes, state, 0) as Record<string, unknown>
  if (state.truncated) bounded.truncated = true
  const line = JSON.stringify(bounded)
  if (Buffer.byteLength(line, 'utf8') <= limit) return line
  const scalars = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(bounded)) {
    if (value === null || typeof value !== 'object') scalars[key] = value
  }
  scalars.truncated = true
  const short = JSON.stringify(scalars)
  if (Buffer.byteLength(short, 'utf8') <= limit) return short
  return JSON.stringify({ type: bounded.type, truncated: true })
}
