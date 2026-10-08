/**
 * In-memory stand-ins for the `Ledger` and `Credentials` contracts (the real
 * ones live in `@nexgent/session` and the kernel).
 */
import {
  NexgentError,
  type CredentialInfo,
  type Credentials,
  type Ledger,
  type LedgerRange,
  type LedgerRecord,
  type LedgerRecordInput,
} from '@nexgent/kernel'

/** A {@link Ledger} that keeps records in an array; `failWrites` makes every append reject. */
export class MemoryLedger implements Ledger {
  readonly records: LedgerRecord[] = []
  writeFailures = 0
  constructor(private readonly failWrites = false) {}

  async append(record: LedgerRecordInput): Promise<LedgerRecord> {
    if (this.failWrites) {
      this.writeFailures++
      throw new NexgentError('ledger/write-failed', 'simulated write failure')
    }
    const full = { ...record, ts: new Date().toISOString() } as LedgerRecord
    this.records.push(full)
    return full
  }

  async *read(range: LedgerRange = {}): AsyncIterable<LedgerRecord> {
    for (const record of this.records) {
      if (range.types !== undefined && !range.types.includes(record.type)) continue
      if (range.sessionId !== undefined && record.sessionId !== range.sessionId) continue
      yield record
    }
  }
}

/** {@link Credentials} backed by a plain map. */
export function memoryCredentials(values: Record<string, string | undefined>): Credentials {
  return {
    async get(name: string): Promise<string | undefined> {
      const value = values[name]
      return value === '' ? undefined : value
    },
    async describe(name: string): Promise<CredentialInfo> {
      return values[name] === undefined || values[name] === '' ? { configured: false } : { configured: true, source: 'env' }
    },
  }
}
