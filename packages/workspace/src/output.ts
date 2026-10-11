/**
 * Bounded output capture: keep the last `maxBytes` of a stream and report
 * how much was dropped (`docs/spec/permissions.md` §命令策略 输出上限).
 */

/** Default per-stream cap: 64 KiB. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** The first line of truncated output. */
export function truncationMarker(droppedBytes: number): string {
  return `[nexgent: output truncated, dropped ${droppedBytes} bytes]`
}

/** Keeps the tail of a byte stream within a fixed budget. */
export class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  /** Bytes discarded from the front so far. */
  dropped = 0

  constructor(readonly maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES) {}

  /** Append a chunk, discarding the oldest bytes beyond the budget. */
  push(chunk: Buffer): void {
    if (chunk.length >= this.maxBytes) {
      this.dropped += this.size + chunk.length - this.maxBytes
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)]
      this.size = this.maxBytes
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.maxBytes) {
      const head = this.chunks[0]!
      const excess = this.size - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.size -= head.length
        this.dropped += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.size -= excess
        this.dropped += excess
      }
    }
  }

  /** Decode the kept tail; truncated output starts with the marker line. */
  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8')
    if (this.dropped === 0) return body
    // The cut may split a multi-byte character; drop the replacement chars it leaves.
    return `${truncationMarker(this.dropped)}\n${body.replace(/^�+/, '')}`
  }
}
