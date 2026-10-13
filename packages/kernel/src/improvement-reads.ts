/**
 * Step 5 read-only slices behind the diagnose session's tools
 * (`improve_read_session`, `improve_read_ledger`; `agent-hooks.md` §步骤 5):
 * one session's records narrowed by turn range and record type, and the
 * project ledger narrowed by attribution, each cut to a byte cap
 * (`IMPROVEMENT_LIMITS.defaultSliceBytes`, at most `maxSliceBytes`). The
 * tools themselves (and their redaction) belong to `@nexgent/evolve`; these
 * helpers only read through the `SessionStore` and `Ledger` contracts.
 */
import { IMPROVEMENT_LIMITS } from './contracts/improvement.js'
import type { Ledger, LedgerRecord, LedgerRecordType } from './contracts/ledger.js'
import type { SessionRecord, SessionStore } from './contracts/session.js'

/** Input of {@link readSessionSlice} (the `improve_read_session` tool input). */
export interface SessionSliceQuery {
  readonly sessionId: string
  /** First turn kept (inclusive). With a turn range, records without a `turn` (e.g. `session.start`) are left out. */
  readonly fromTurn?: number
  /** Last turn kept (inclusive). */
  readonly toTurn?: number
  /** Record types kept; all when absent. */
  readonly types?: readonly string[]
  /** Byte cap of the result; default {@link IMPROVEMENT_LIMITS.defaultSliceBytes}, clamped to 1 … {@link IMPROVEMENT_LIMITS.maxSliceBytes}. */
  readonly maxBytes?: number
}

/** Input of {@link readLedgerSlice} (the `improve_read_ledger` tool input). */
export interface LedgerSliceQuery {
  readonly taskId?: string
  readonly sessionId?: string
  readonly memberId?: string
  readonly capabilityVersion?: string
  readonly types?: readonly string[]
  readonly maxBytes?: number
}

/** A byte-capped slice, oldest record first. */
export interface RecordSlice<T> {
  /** The records that fit, in file order. */
  readonly records: readonly T[]
  /** Records that matched the query. */
  readonly matched: number
  /** Whether matching records were left out because of the byte cap. */
  readonly truncated: boolean
  /** UTF-8 bytes of the kept records as JSON lines (one `\n` each). */
  readonly bytes: number
  /** The cap that applied. */
  readonly maxBytes: number
}

/** The cap a query asks for, clamped to the contract's bounds. */
export function sliceBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return IMPROVEMENT_LIMITS.defaultSliceBytes
  return Math.min(IMPROVEMENT_LIMITS.maxSliceBytes, Math.max(1, Math.floor(maxBytes)))
}

/** Keep matching records, oldest first, while their JSON lines fit in the cap; later matches only count. */
class SliceBuilder<T> {
  readonly records: T[] = []
  matched = 0
  bytes = 0
  truncated = false

  constructor(readonly maxBytes: number) {}

  add(record: T): void {
    this.matched += 1
    if (this.truncated) return
    const size = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true
      return
    }
    this.records.push(record)
    this.bytes += size
  }

  result(): RecordSlice<T> {
    return { records: this.records, matched: this.matched, truncated: this.truncated, bytes: this.bytes, maxBytes: this.maxBytes }
  }
}

/**
 * Pure part of {@link readSessionSlice}: narrow records already read.
 * @param records - one session's records in file order.
 */
export function sliceSessionRecords(records: readonly SessionRecord[], query: Omit<SessionSliceQuery, 'sessionId'>): RecordSlice<SessionRecord> {
  const types = query.types === undefined ? undefined : new Set(query.types)
  const ranged = query.fromTurn !== undefined || query.toTurn !== undefined
  const slice = new SliceBuilder<SessionRecord>(sliceBytes(query.maxBytes))
  for (const record of records) {
    if (types !== undefined && !types.has(record.type)) continue
    if (ranged) {
      const turn = (record as { turn?: unknown }).turn
      if (typeof turn !== 'number') continue
      if (query.fromTurn !== undefined && turn < query.fromTurn) continue
      if (query.toTurn !== undefined && turn > query.toTurn) continue
    }
    slice.add(record)
  }
  return slice.result()
}

/**
 * A read-only slice of one session (any session of the project, open or
 * not). An unknown session rejects with the store's `session/not-found`.
 */
export async function readSessionSlice(store: Pick<SessionStore, 'readAll'>, query: SessionSliceQuery): Promise<RecordSlice<SessionRecord>> {
  const { records } = await store.readAll(query.sessionId)
  return sliceSessionRecords(records, query)
}

/** A read-only slice of the project ledger, narrowed by attribution (every given field must match). */
export async function readLedgerSlice(ledger: Pick<Ledger, 'read'>, query: LedgerSliceQuery): Promise<RecordSlice<LedgerRecord>> {
  const slice = new SliceBuilder<LedgerRecord>(sliceBytes(query.maxBytes))
  const range = {
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.types === undefined ? {} : { types: query.types as readonly LedgerRecordType[] }),
  }
  for await (const record of ledger.read(range)) {
    if (query.sessionId !== undefined && record.sessionId !== query.sessionId) continue
    if (query.types !== undefined && !query.types.includes(record.type)) continue
    if (query.taskId !== undefined && record.taskId !== query.taskId) continue
    if (query.memberId !== undefined && record.memberId !== query.memberId) continue
    if (query.capabilityVersion !== undefined && record.capabilityVersion !== query.capabilityVersion) continue
    slice.add(record)
  }
  return slice.result()
}
