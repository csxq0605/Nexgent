/**
 * Bounded output capture (`docs/spec/permissions.md` §命令策略 输出上限,
 * ADR 0022 decision 6): a stream keeps its head and its tail with a marker
 * in the middle ({@link HeadTailBuffer}); the text a tool shows the model is
 * capped to about {@link MODEL_OUTPUT_CHARS} characters the same way
 * ({@link capText}); the full output goes to a file ({@link FileSink}).
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { Redactor } from './redact.js'

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

  /** The kept chunks (for {@link HeadTailBuffer}). */
  kept(): readonly Buffer[] {
    return this.chunks
  }

  /** Decode the kept tail; truncated output starts with the marker line. */
  text(): string {
    const body = Buffer.concat(this.chunks).toString('utf8')
    if (this.dropped === 0) return body
    // The cut may split a multi-byte character; drop the replacement chars it leaves.
    return `${truncationMarker(this.dropped)}\n${body.replace(/^�+/, '')}`
  }
}

/** Matches the middle marker written by {@link HeadTailBuffer} and {@link capText}. */
export const OMITTED_MARKER_PATTERN = /\[nexgent: \d+ (?:bytes|chars) omitted[^\]]*\]/

/** The middle marker of head/tail output. */
export function omittedMarker(amount: number, unit: 'bytes' | 'chars' = 'bytes'): string {
  return `[nexgent: ${amount} ${unit} omitted from the middle]`
}

/** Keeps the first and the last part of a byte stream within a fixed budget. */
export class HeadTailBuffer {
  private readonly headLimit: number
  private readonly tailLimit: number
  private head: Buffer[] = []
  private headSize = 0
  private readonly tail: TailBuffer
  /** Total bytes pushed. */
  total = 0

  constructor(readonly maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES) {
    this.headLimit = Math.floor(maxBytes / 2)
    this.tailLimit = maxBytes - this.headLimit
    this.tail = new TailBuffer(this.tailLimit)
  }

  /** Bytes dropped from the middle so far. */
  get dropped(): number {
    return this.tail.dropped
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    let rest = chunk
    if (this.headSize < this.headLimit) {
      const take = Math.min(this.headLimit - this.headSize, rest.length)
      this.head.push(rest.subarray(0, take))
      this.headSize += take
      rest = rest.subarray(take)
    }
    if (rest.length > 0) this.tail.push(rest)
  }

  /** Head, marker, tail; the whole text when nothing was dropped. */
  text(): string {
    const head = Buffer.concat(this.head)
    const tail = Buffer.concat(this.tail.kept())
    if (this.dropped === 0) return Buffer.concat([head, tail]).toString('utf8')
    // A cut may split a multi-byte character; drop the replacement characters it leaves.
    const headText = head.toString('utf8').replace(/\uFFFD+$/, '')
    const tailText = tail.toString('utf8').replace(/^\uFFFD+/, '')
    return `${headText}\n${omittedMarker(this.dropped)}\n${tailText}`
  }
}

/** Default cap on the text of one tool result: about 30 000 characters. */
export const MODEL_OUTPUT_CHARS = 30_000

/** The result of {@link capText}. */
export interface CappedText {
  readonly text: string
  /** Whether characters were omitted by this call. */
  readonly truncated: boolean
}

function safeSlice(text: string, start: number, end: number): string {
  let from = start
  let to = end
  const isLow = (i: number): boolean => { const c = text.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff }
  const isHigh = (i: number): boolean => { const c = text.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff }
  if (from > 0 && from < text.length && isLow(from)) from += 1
  if (to > 0 && to < text.length && isHigh(to - 1)) to -= 1
  return text.slice(from, Math.max(from, to))
}

/** Keep the head and the tail of `text` within `maxChars`, with a marker for the omitted middle. */
export function capText(text: string, maxChars: number = MODEL_OUTPUT_CHARS): CappedText {
  if (text.length <= maxChars) return { text, truncated: false }
  const headLen = Math.floor(maxChars / 2)
  const tailLen = maxChars - headLen
  const head = safeSlice(text, 0, headLen)
  const tail = safeSlice(text, text.length - tailLen, text.length)
  const omitted = text.length - head.length - tail.length
  return { text: `${head}\n${omittedMarker(omitted, 'chars')}\n${tail}`, truncated: true }
}

/**
 * Appends output to a file after redaction. Redaction works on complete
 * lines (an incomplete last line is held back until it ends or the sink is
 * closed) so a secret split across two chunks is still removed. Never throws.
 */
export class FileSink {
  private stream: WriteStream | undefined
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private failed = false
  /** Characters written so far. */
  written = 0

  constructor(readonly path: string, private readonly redactor: Redactor, private readonly onText?: (text: string) => void) {}

  private emit(text: string): void {
    if (text === '') return
    this.onText?.(text)
    if (this.failed) return
    try {
      this.stream ??= createWriteStream(this.path, { flags: 'a' })
      this.stream.on('error', () => { this.failed = true })
      this.stream.write(text)
      this.written += text.length
    } catch {
      this.failed = true
    }
  }

  write(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const cut = this.pending.lastIndexOf('\n')
    if (cut < 0) return
    const complete = this.pending.slice(0, cut + 1)
    this.pending = this.pending.slice(cut + 1)
    this.emit(this.redactor.redact(complete))
  }

  /** Flush the held-back line; resolves when the file is closed. */
  async close(): Promise<void> {
    this.pending += this.decoder.end()
    this.emit(this.redactor.redact(this.pending))
    this.pending = ''
    const stream = this.stream
    if (stream === undefined) return
    await new Promise<void>(resolve => {
      stream.once('error', () => resolve())
      stream.end(() => resolve())
    })
  }
}
