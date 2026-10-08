/**
 * The session JSONL v1 line codec: encode one record as one line, and scan
 * a file into its valid prefix plus the first invalid line.
 *
 * Normative rules: `docs/spec/data-formats.md` §追加与截断规则.
 */
import type { SessionReadResult, SessionRecord, SessionTruncation } from '@nexgent/kernel'
import { formatIssues, validateSessionRecord } from './schema/session-schema.js'

const NEWLINE = 0x0a
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Encode one record as a JSONL line (`JSON.stringify(record) + "\n"`). */
export function encodeLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

/** {@link SessionReadResult} plus the byte length of the valid prefix. */
export interface ScanResult extends SessionReadResult {
  /** Bytes covered by the valid records; equals the truncation offset when there is one. */
  readonly validBytes: number
}

/**
 * Scan file contents: validate line by line and stop at the first invalid one.
 * Never throws for bad content; an unreadable first line yields no records.
 * @param data - raw file bytes.
 * @param sessionId - the session the file belongs to.
 */
export function scanSessionLog(data: Uint8Array, sessionId: string): ScanResult {
  const records: SessionRecord[] = []
  let offset = 0
  let line = 1
  let truncation: SessionTruncation | undefined
  while (offset < data.length) {
    const end = data.indexOf(NEWLINE, offset)
    if (end === -1) {
      truncation = { line, byteOffset: offset, reason: 'incomplete line (no trailing newline)' }
      break
    }
    const reason = checkLine(data.subarray(offset, end), records, sessionId)
    if (typeof reason === 'string') {
      truncation = { line, byteOffset: offset, reason }
      break
    }
    records.push(reason)
    offset = end + 1
    line += 1
  }
  return truncation === undefined
    ? { records, validBytes: offset }
    : { records, truncation, validBytes: truncation.byteOffset }
}

/** Return the parsed record, or why the line is invalid. */
function checkLine(bytes: Uint8Array, previous: readonly SessionRecord[], sessionId: string): SessionRecord | string {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return 'invalid UTF-8'
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 'not valid JSON'
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not a JSON object'
  const issues = validateSessionRecord(value, { allowAdditionalProperties: true })
  if (issues.length > 0) return `schema: ${formatIssues(issues)}`
  return checkSequence(value as SessionRecord, previous.length, sessionId) ?? (value as SessionRecord)
}

/**
 * Cross-record rules a single-record schema cannot express: `seq` continuity,
 * owning session, `session.start` exactly first, `checkpoint.coversSeq`.
 * @param lastSeq - `seq` of the preceding record (0 for the first line).
 * @returns the violation, or `undefined` when the record may follow.
 */
export function checkSequence(
  record: SessionRecord,
  lastSeq: number,
  sessionId: string,
): string | undefined {
  const expectedSeq = lastSeq + 1
  if (record.seq !== expectedSeq) return `seq ${record.seq} where ${expectedSeq} was expected`
  if (record.sessionId !== sessionId) return `sessionId ${record.sessionId} does not match ${sessionId}`
  if (expectedSeq === 1 && record.type !== 'session.start') return 'first record is not session.start'
  if (expectedSeq !== 1 && record.type === 'session.start') return 'session.start after the first record'
  if (record.type === 'checkpoint') {
    if (record.coversSeq !== record.seq - 1) return `checkpoint.coversSeq ${record.coversSeq} is not seq - 1`
    if (record.state.sessionId !== sessionId) return 'checkpoint state belongs to another session'
  }
  return undefined
}
