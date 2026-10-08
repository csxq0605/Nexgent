/**
 * A minimal Server-Sent Events reader: bytes in, the `data` payload of each
 * event out. Only the `data` field matters for `/chat/completions`; `event`,
 * `id`, `retry` and comment lines are ignored. Accepts `\n`, `\r\n` and `\r`
 * line endings and events split across arbitrary chunk boundaries.
 */

/**
 * Iterate the `data` payloads of an SSE byte stream. Multiple `data:` lines
 * of one event are joined with `\n`. A trailing event without a closing
 * blank line is still delivered at end of stream.
 * @param chunks - the response body, chunk by chunk.
 */
export async function* readSseData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let pendingCR = false

  const takeLine = function* (line: string): Generator<string> {
    if (line === '') {
      if (data.length > 0) yield data.join('\n')
      data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') return
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    data.push(value)
  }

  const drain = function* (final: boolean): Generator<string> {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i]
      if (ch === '\n' && pendingCR) {
        pendingCR = false
        start = i + 1
        continue
      }
      pendingCR = false
      if (ch === '\n' || ch === '\r') {
        yield* takeLine(buffer.slice(start, i))
        if (ch === '\r') pendingCR = true
        start = i + 1
      }
    }
    buffer = buffer.slice(start)
    if (final) {
      if (buffer !== '') yield* takeLine(buffer)
      buffer = ''
      yield* takeLine('')
    }
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    yield* drain(false)
  }
  buffer += decoder.decode()
  yield* drain(true)
}
