/**
 * Small text helpers shared by the providers and the compactor.
 */

/**
 * Cut a UTF-8 buffer to at most `maxBytes` without splitting a character,
 * preferring the last line break in the kept part when it is not too far back.
 * Pure.
 * @returns the kept text and whether anything was dropped.
 */
export function truncateUtf8(buffer: Uint8Array, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (buffer.byteLength <= maxBytes) return { text: decodeUtf8(buffer), truncated: false }
  let end = Math.max(0, maxBytes)
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character start.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--
  let kept = buffer.subarray(0, end)
  const lastNewline = kept.lastIndexOf(0x0a)
  if (lastNewline >= Math.floor(end * 0.8)) kept = kept.subarray(0, lastNewline + 1)
  return { text: decodeUtf8(kept), truncated: true }
}

/** Decode UTF-8, replacing invalid sequences, and drop a leading BOM. Pure. */
export function decodeUtf8(buffer: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Whether a buffer decodes as UTF-8 without errors and has no NUL in its first 8 KiB. Pure. */
export function looksLikeText(buffer: Uint8Array): boolean {
  if (buffer.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * A Markdown code fence that the content cannot close: one backtick more
 * than the longest backtick run in `content`, at least three. Pure.
 */
export function fenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Keep the head and tail of a long string with a marker in between. Pure. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.ceil(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head)
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n[… ${omitted} characters omitted …]\n${tail === 0 ? '' : text.slice(text.length - tail)}`
}

/** Human-readable byte count (`18234` → `17.8 KiB`). Pure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
