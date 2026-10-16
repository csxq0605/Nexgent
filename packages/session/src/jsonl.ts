/**
 * The session JSONL v1 line codec: encode one record as one line, and scan
 * a file into its valid records, the lines skipped on the way and a torn tail.
 *
 * Normative rules: `docs/spec/data-formats.md` §追加与截断规则.
 */
import type { SessionReadResult, SessionRecord, SessionSkippedLine, SessionTruncation } from '@nexgent/kernel'
import { upgradeLegacyUsage } from './schema/common.js'
import { formatIssues, validateSessionRecord } from './schema/session-schema.js'

const NEWLINE = 0x0a
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Encode one record as a JSONL line (`JSON.stringify(record) + "\n"`). */
export function encodeLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

/** {@link SessionReadResult} plus the byte length of the valid content and the highest `seq` seen. */
export interface ScanResult extends SessionReadResult {
  /** Skipped complete lines (always present here; empty when none). */
  readonly skipped: readonly SessionSkippedLine[]
  /** Bytes up to the torn final line (the whole file when there is none); equals the truncation offset when there is one. */
  readonly validBytes: number
  /**
   * The highest `seq` the file carries: the last valid record's, or that of a
   * skipped line that still named the next `seq` (an unknown record from a
   * newer version). A writer appends `lastSeq + 1`, so `seq` stays strictly
   * increasing and never repeats a skipped line's.
   */
  readonly lastSeq: number
}

/**
 * Scan file contents line by line. A complete line (ends with `\n`) that is not
 * a valid record is skipped and reported, and reading continues; only a torn
 * final line (no `\n`) is a truncation. Never throws for bad content; a file
 * whose first line is unreadable yields no records.
 * @param data - raw file bytes.
 * @param sessionId - the session the file belongs to.
 */
export function scanSessionLog(data: Uint8Array, sessionId: string): ScanResult {
  const records: SessionRecord[] = []
  const skipped: SessionSkippedLine[] = []
  let offset = 0
  let line = 1
  let lastSeq = 0 // last valid record
  let maxSeq = 0 // highest plausible seq seen, valid or skipped
  let gap = 0 // lines skipped since the last valid record
  let truncation: SessionTruncation | undefined
  while (offset < data.length) {
    const end = data.indexOf(NEWLINE, offset)
    if (end === -1) {
      truncation = { line, byteOffset: offset, reason: 'incomplete line (no trailing newline)' }
      break
    }
    const checked = checkLine(data.subarray(offset, end), lastSeq, gap, sessionId)
    if ('record' in checked) {
      records.push(checked.record)
      lastSeq = checked.record.seq
      maxSeq = lastSeq
      gap = 0
    } else {
      skipped.push({ line, byteOffset: offset, reason: checked.reason })
      gap += 1
      if (checked.seq !== undefined) maxSeq = Math.max(maxSeq, checked.seq)
    }
    offset = end + 1
    line += 1
  }
  const base = { records, skipped, validBytes: truncation === undefined ? offset : truncation.byteOffset, lastSeq: maxSeq }
  return truncation === undefined ? base : { ...base, truncation }
}

/** The parsed record, or why the line is skipped (and the `seq` it still claims when plausible). */
function checkLine(
  bytes: Uint8Array,
  lastSeq: number,
  gap: number,
  sessionId: string,
): { record: SessionRecord } | { reason: string; seq?: number } {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return { reason: 'invalid UTF-8' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { reason: 'not valid JSON' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { reason: 'not a JSON object' }
  const claimed = value as { seq?: unknown; sessionId?: unknown }
  const seq =
    claimed.sessionId === sessionId &&
    typeof claimed.seq === 'number' &&
    Number.isSafeInteger(claimed.seq) &&
    claimed.seq > lastSeq &&
    claimed.seq <= lastSeq + 1 + gap
      ? claimed.seq
      : undefined
  const issues = validateSessionRecord(value, { allowAdditionalProperties: true })
  if (issues.length > 0) return { reason: `schema: ${formatIssues(issues)}`, ...(seq === undefined ? {} : { seq }) }
  const record = upgradeLegacyUsage(value) as SessionRecord
  const violation = checkSequence(record, lastSeq, sessionId, gap)
  return violation === undefined ? { record } : { reason: violation, ...(seq === undefined ? {} : { seq }) }
}

/**
 * Cross-record rules a single-record schema cannot express: `seq` order,
 * owning session, `session.start` exactly first, `checkpoint` links.
 * @param lastSeq - `seq` of the preceding valid record (0 for the first line).
 * @param skipped - lines skipped since that record: the `seq` may be up to that many further on.
 * @returns the violation, or `undefined` when the record may follow.
 */
export function checkSequence(
  record: SessionRecord,
  lastSeq: number,
  sessionId: string,
  skipped = 0,
): string | undefined {
  const expectedSeq = lastSeq + 1
  if (record.seq < expectedSeq || record.seq > expectedSeq + skipped) {
    return skipped === 0
      ? `seq ${record.seq} where ${expectedSeq} was expected`
      : `seq ${record.seq} where ${expectedSeq}..${expectedSeq + skipped} was expected`
  }
  if (record.sessionId !== sessionId) return `sessionId ${record.sessionId} does not match ${sessionId}`
  if (lastSeq === 0 && record.seq !== 1) return 'first record is not seq 1'
  if (lastSeq === 0 && record.type !== 'session.start') return 'first record is not session.start'
  if (lastSeq !== 0 && record.type === 'session.start') return 'session.start after the first record'
  if (record.type === 'checkpoint') {
    if (record.coversSeq !== record.seq - 1) return `checkpoint.coversSeq ${record.coversSeq} is not seq - 1`
    if (record.state.sessionId !== sessionId) return 'checkpoint state belongs to another session'
    if ((record.base === undefined) !== (record.keep === undefined)) return 'checkpoint.base and checkpoint.keep go together'
    if (record.base !== undefined && record.base >= record.coversSeq) return 'checkpoint.base is not an earlier record'
  }
  return undefined
}
