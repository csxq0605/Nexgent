/**
 * Read session and ledger JSONL files from a project's `.nexgent/` layout
 * (`docs/spec/data-formats.md`). These are lenient test-side readers: they
 * stop at the first line that is unterminated or not a JSON object (the
 * `kill -9` half line) and report it, but do not re-run the session
 * store's full schema and `seq` validation.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LedgerRecord, LLMRequestEndRecord, SessionRecord } from '@nexgent/kernel'
import { LEDGER_FILE_NAME } from '@nexgent/kernel'

/** Why a JSONL read stopped early. */
export interface JsonlTruncation {
  /** 1-based line number of the first unusable line. */
  readonly line: number
  /** Byte offset where that line starts. */
  readonly byteOffset: number
  readonly reason: 'unterminated' | 'invalid-json' | 'not-an-object'
  /** Lines after it that were ignored (0 for the usual truncated tail). */
  readonly ignoredLines: number
}

/** Result of reading one JSONL file. */
export interface JsonlReadResult<T> {
  readonly path: string
  readonly exists: boolean
  /** Records before the first unusable line. */
  readonly records: T[]
  /** Set when the read stopped early. */
  readonly truncation: JsonlTruncation | undefined
}

/**
 * Read a JSONL file. A missing file yields `exists: false` and no records.
 * @param path - absolute path.
 */
export async function readJsonlFile<T = unknown>(path: string): Promise<JsonlReadResult<T>> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false, records: [], truncation: undefined }
    throw error
  }
  const records: T[] = []
  let offset = 0
  let line = 0
  while (offset < bytes.length) {
    line++
    const nl = bytes.indexOf(0x0a, offset)
    const stop = (reason: JsonlTruncation['reason']): JsonlReadResult<T> => {
      let ignored = 0
      let pos = nl === -1 ? bytes.length : nl + 1
      while (pos < bytes.length) {
        ignored++
        const next = bytes.indexOf(0x0a, pos)
        pos = next === -1 ? bytes.length : next + 1
      }
      return { path, exists: true, records, truncation: { line, byteOffset: offset, reason, ignoredLines: ignored } }
    }
    if (nl === -1) return stop('unterminated')
    const text = bytes.subarray(offset, nl).toString('utf8').replace(/\r$/, '')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return stop('invalid-json')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return stop('not-an-object')
    records.push(value as T)
    offset = nl + 1
  }
  return { path, exists: true, records, truncation: undefined }
}

/** `<projectRoot>/.nexgent/sessions/<sessionId>/session.jsonl`. */
export function sessionFilePath(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.nexgent', 'sessions', sessionId, 'session.jsonl')
}

/**
 * Read one session's records.
 * @param projectRoot - project directory (the parent of `.nexgent/`).
 * @param sessionId - session id.
 */
export function readSessionRecords(projectRoot: string, sessionId: string): Promise<JsonlReadResult<SessionRecord>> {
  return readJsonlFile<SessionRecord>(sessionFilePath(projectRoot, sessionId))
}

/**
 * Session ids present under `.nexgent/sessions/` (directories only), sorted.
 * @param projectRoot - project directory.
 */
export async function listSessionIds(projectRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectRoot, '.nexgent', 'sessions'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Result of {@link readLedgerRecords}. */
export interface LedgerReadResult {
  /** All records, month files in ascending order, file order within. */
  readonly records: LedgerRecord[]
  /** Per-file results (each with its own truncation). */
  readonly files: readonly JsonlReadResult<LedgerRecord>[]
}

/**
 * Read every `.nexgent/ledgers/<yyyy-mm>/requests.jsonl`.
 * @param projectRoot - project directory.
 * @param options - `month` restricts to one `yyyy-mm`.
 */
export async function readLedgerRecords(projectRoot: string, options: { readonly month?: string } = {}): Promise<LedgerReadResult> {
  const root = join(projectRoot, '.nexgent', 'ledgers')
  let months: string[]
  try {
    months = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') months = []
    else throw error
  }
  if (options.month !== undefined) months = months.filter((m) => m === options.month)
  const files: JsonlReadResult<LedgerRecord>[] = []
  for (const month of months) {
    const result = await readJsonlFile<LedgerRecord>(join(root, month, LEDGER_FILE_NAME))
    if (result.exists) files.push(result)
  }
  return { records: files.flatMap((f) => f.records), files }
}

/** Aggregate facts about ledger records, for acceptance summaries. */
export interface LedgerStats {
  /** Distinct `requestId`s seen in start or end records. */
  readonly requestCount: number
  /** End status per request; a start without an end counts as `unknown`. */
  readonly statusCounts: Readonly<Record<'ok' | 'error' | 'aborted' | 'unknown', number>>
  /** Requests whose usage is not fully known (including missing ends). */
  readonly unknownUsageCount: number
  /** Sum of known input tokens (uncached + cache read where known). */
  readonly knownInputTokens: number
  /** Sum of known output tokens. */
  readonly knownOutputTokens: number
  readonly toolCallCount: number
  readonly taskOutcomes: number
}

/**
 * Summarize ledger records per the reading rules of data-formats.md
 * (pair start/end by `requestId`; unpaired start = status and usage unknown).
 * @param records - ledger records.
 */
export function ledgerStats(records: readonly LedgerRecord[]): LedgerStats {
  const ends = new Map<string, LLMRequestEndRecord>()
  const ids = new Set<string>()
  let toolCallCount = 0
  let taskOutcomes = 0
  for (const r of records) {
    if (r.type === 'llm.request.start') ids.add(r.requestId)
    else if (r.type === 'llm.request.end') {
      ids.add(r.requestId)
      ends.set(r.requestId, r)
    } else if (r.type === 'tool.call') toolCallCount++
    else if (r.type === 'task.outcome') taskOutcomes++
  }
  const statusCounts = { ok: 0, error: 0, aborted: 0, unknown: 0 }
  let unknownUsageCount = 0
  let knownInputTokens = 0
  let knownOutputTokens = 0
  for (const id of ids) {
    const end = ends.get(id)
    if (end === undefined) {
      statusCounts.unknown++
      unknownUsageCount++
      continue
    }
    statusCounts[end.status]++
    const u = end.usage
    const fields = [u.inputTokens, u.outputTokens, u.totalTokens, u.cacheReadTokens, u.reasoningTokens]
    if (fields.some((f) => f === 'unknown')) unknownUsageCount++
    if (typeof u.inputTokens === 'number') knownInputTokens += u.inputTokens + (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0)
    if (typeof u.outputTokens === 'number') knownOutputTokens += u.outputTokens
  }
  return { requestCount: ids.size, statusCounts, unknownUsageCount, knownInputTokens, knownOutputTokens, toolCallCount, taskOutcomes }
}
