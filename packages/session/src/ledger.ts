/**
 * `JsonlLedger`: the `ctx.ledger` implementation over
 * `.nexgent/ledgers/<yyyy-mm>/requests.jsonl`.
 *
 * Normative text: `docs/spec/data-formats.md` §账本记录. Contract:
 * `packages/kernel/src/contracts/ledger.ts`. Each append opens the month file
 * for appending, writes the whole line in one call, `fsync`s and closes, so a
 * month rollover needs no state and no handle outlives the call. Appends are
 * serialized within the instance so lines never interleave.
 */
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  LEDGER_FILE_NAME,
  ledgerMonth,
  NexgentError,
  type Ledger,
  type LedgerRange,
  type LedgerRecord,
  type LedgerRecordInput,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { encodeLine } from './jsonl.js'
import { formatIssues } from './schema/session-schema.js'
import { isLedgerRecordType, validateLedgerRecord } from './schema/ledger-schema.js'

/** Options for {@link JsonlLedger}. Give `layout` or `ledgersDir`. */
export interface JsonlLedgerOptions {
  /** Workspace layout; the ledger lives in `layout.ledgers`. */
  readonly layout?: WorkspaceLayout
  /** Absolute ledgers directory; overrides `layout`. */
  readonly ledgersDir?: string
  /** Clock used to stamp `ts`; default `new Date()`. */
  readonly now?: () => Date
}

const MONTH_DIR = /^\d{4}-\d{2}$/

/** The JSONL ledger. */
export class JsonlLedger implements Ledger {
  /** Absolute ledgers directory. */
  readonly ledgersDir: string
  private failures = 0
  private skipped = 0
  private chain: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(options: JsonlLedgerOptions) {
    const dir = options.ledgersDir ?? options.layout?.ledgers
    if (dir === undefined) throw new TypeError('JsonlLedger needs `layout` or `ledgersDir`')
    this.ledgersDir = dir
    this.now = options.now ?? (() => new Date())
  }

  get writeFailures(): number {
    return this.failures
  }

  /** Lines skipped by `read` so far (unknown `type`, unparsable or schema-invalid). */
  get skippedRecords(): number {
    return this.skipped
  }

  /** The file a record stamped `ts` goes to. */
  fileFor(ts: string): string {
    return join(this.ledgersDir, ledgerMonth(ts), LEDGER_FILE_NAME)
  }

  /**
   * @throws {NexgentError} `ledger/invalid-record` when the record has unknown
   *   fields or fails the schema (nothing is written, `writeFailures` unchanged);
   *   `ledger/write-failed` when the file cannot be written (`writeFailures` + 1).
   */
  append(input: LedgerRecordInput): Promise<LedgerRecord> {
    const { type, ...rest } = input as LedgerRecordInput & { ts?: unknown }
    delete rest.ts
    const record = { type, ts: this.now().toISOString(), ...rest } as LedgerRecord
    const issues = validateLedgerRecord(record, { forbidAdditionalProperties: true })
    if (issues.length > 0) {
      return Promise.reject(
        new NexgentError('ledger/invalid-record', `invalid ledger record: ${formatIssues(issues)}`, {
          details: { issues: issues.map(issue => ({ ...issue })) },
        }),
      )
    }
    const result = this.chain.catch(() => {}).then(() => this.write(record))
    this.chain = result
    return result
  }

  async *read(range: LedgerRange = {}): AsyncIterable<LedgerRecord> {
    const from = range.from === undefined ? undefined : Date.parse(range.from)
    const to = range.to === undefined ? undefined : Date.parse(range.to)
    const fromMonth = range.from === undefined ? undefined : ledgerMonth(range.from)
    const toMonth = range.to === undefined ? undefined : ledgerMonth(range.to)
    const types = range.types === undefined ? undefined : new Set<string>(range.types)
    await this.chain.catch(() => {})
    for (const month of await this.months()) {
      if (fromMonth !== undefined && month < fromMonth) continue
      if (toMonth !== undefined && month > toMonth) continue
      let data: string
      try {
        data = await readFile(join(this.ledgersDir, month, LEDGER_FILE_NAME), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const lines = data.split('\n')
      // The last element is '' for a well-formed file, or a torn line left by a crash: skip it either way.
      lines.pop()
      for (const line of lines) {
        const record = this.parse(line)
        if (record === undefined) continue
        if (types !== undefined && !types.has(record.type)) continue
        if (range.sessionId !== undefined && record.sessionId !== range.sessionId) continue
        const ts = Date.parse(record.ts)
        if (from !== undefined && ts < from) continue
        if (to !== undefined && ts > to) continue
        yield record
      }
    }
  }

  private parse(line: string): LedgerRecord | undefined {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.skipped += 1
      return undefined
    }
    const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined
    if (!isLedgerRecordType(type) || validateLedgerRecord(value).length > 0) {
      this.skipped += 1
      return undefined
    }
    return value as LedgerRecord
  }

  private async months(): Promise<string[]> {
    try {
      const entries = await readdir(this.ledgersDir, { withFileTypes: true })
      return entries
        .filter(entry => entry.isDirectory() && MONTH_DIR.test(entry.name))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async write(record: LedgerRecord): Promise<LedgerRecord> {
    const file = this.fileFor(record.ts)
    try {
      await mkdir(dirname(file), { recursive: true })
      const handle = await open(file, 'a+')
      try {
        // A torn last line (crash mid-write) must not swallow this record: start a fresh line.
        const { size } = await handle.stat()
        let prefix = ''
        if (size > 0) {
          const last = Buffer.alloc(1)
          await handle.read(last, 0, 1, size - 1)
          if (last[0] !== 0x0a) prefix = '\n'
        }
        await handle.write(prefix + encodeLine(record), null, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return record
    } catch (error) {
      this.failures += 1
      throw new NexgentError('ledger/write-failed', `ledger write failed: ${(error as Error).message}`, {
        cause: error,
        details: { file, type: record.type },
      })
    }
  }
}
