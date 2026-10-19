// Adapted from Nexgent PR #4 runtime/packages/bundle/nexgent-app/src/architecture-trials.ts (archive/python-host): one receipt file per trial, opened `wx`, one fsynced line per event.
/**
 * Gate receipts `.nexgent/capabilities/trials/<trialId>.jsonl`
 * (`data-formats.md` §候选与门控). The file is created with exclusive create
 * (a trial id is never reused) and every line is validated and fsynced before
 * the gate starts its next run, so a killed gate leaves a readable prefix: a
 * trial without `trial.end` was interrupted and counts as `unknown`.
 *
 * Beside each running trial the gate keeps `<trialId>.lock` (its process id),
 * and beside each candidate it ever tried `<candidateId>.attempt`, created
 * exclusively before the first receipt: a candidate is tried at most once
 * (PR #4 "attempted candidates never replay"), and a trial whose lock names
 * a dead process is recognised as interrupted on the next start.
 */
import { mkdir, open, readdir, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { retryTransient } from '../fs-retry.js'
import { CAPABILITY_DIRS, NexgentError, type TrialReceipt } from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'

/** Directory name of receipts inside `.nexgent/capabilities/`. */
export const TRIALS_DIR = CAPABILITY_DIRS.trials

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Receipt input: the writer adds `format`, `trialId` and `ts`. */
export type ReceiptInput = TrialReceipt extends infer R ? R extends TrialReceipt ? Omit<R, 'format' | 'trialId' | 'ts'> : never : never

/** An open receipt file. */
export class TrialReceiptWriter {
  readonly trialId: string
  readonly path: string
  readonly #handle: FileHandle
  readonly #now: () => Date

  private constructor(trialId: string, path: string, handle: FileHandle, now: () => Date) {
    this.trialId = trialId
    this.path = path
    this.#handle = handle
    this.#now = now
  }

  /**
   * Create `trials/<trialId>.jsonl` exclusively.
   * @throws `internal` when the id is malformed or already used.
   */
  static async create(capabilitiesDir: string, trialId: string, now: () => Date = () => new Date()): Promise<TrialReceiptWriter> {
    if (!UUID.test(trialId)) throw new NexgentError('internal', `trial id must be a lowercase uuid v4: ${trialId}`)
    const directory = join(capabilitiesDir, TRIALS_DIR)
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${trialId}.jsonl`)
    let handle: FileHandle
    try {
      handle = await open(path, 'wx', 0o644)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NexgentError('internal', `trial ${trialId} already has receipts`)
      throw error
    }
    return new TrialReceiptWriter(trialId, path, handle, now)
  }

  /**
   * Validate, write and fsync one line.
   * @throws `config/invalid` when the line breaks the receipt schema (nothing is written).
   */
  async append(input: ReceiptInput): Promise<TrialReceipt> {
    const { type, ...rest } = input
    const ordered = { type, format: 1, trialId: this.trialId, ts: this.#now().toISOString(), ...rest } as unknown as TrialReceipt
    const issues = validateCapabilityFile('trialReceipt', ordered)
    if (issues.length > 0) throw new NexgentError('config/invalid', `invalid trial receipt ${input.type}: ${issues[0]!.path} ${issues[0]!.message}`)
    await this.#handle.write(`${JSON.stringify(ordered)}\n`)
    await this.#handle.sync()
    return ordered
  }

  async close(): Promise<void> {
    await this.#handle.close()
  }
}

/** Every line of one trial that parses and validates, in file order (a torn last line is dropped). */
export async function readTrialReceipts(capabilitiesDir: string, trialId: string): Promise<TrialReceipt[]> {
  if (!UUID.test(trialId)) throw new NexgentError('session/not-found', `no trial ${JSON.stringify(trialId)}`)
  let raw: string
  try {
    raw = await readFile(join(capabilitiesDir, TRIALS_DIR, `${trialId}.jsonl`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NexgentError('session/not-found', `no trial ${trialId}`)
    throw error
  }
  const receipts: TrialReceipt[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      break
    }
    if (validateCapabilityFile('trialReceipt', value).length > 0 || (value as TrialReceipt).trialId !== trialId) break
    receipts.push(value as TrialReceipt)
  }
  return receipts
}

/** One trial as a reader sees it. */
export interface TrialSummary {
  readonly trialId: string
  readonly candidateId: string
  readonly startedAt: string
  readonly receipts: readonly TrialReceipt[]
  /** The `trial.end` line; absent while running or after an interruption. */
  readonly end?: Extract<TrialReceipt, { type: 'trial.end' }>
}

/** Every trial with a readable `trial.start`, oldest first; optionally of one candidate. */
export async function listTrials(capabilitiesDir: string, candidateId?: string): Promise<TrialSummary[]> {
  let names: string[]
  try {
    names = await readdir(join(capabilitiesDir, TRIALS_DIR))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const trials: TrialSummary[] = []
  for (const name of names) {
    const id = name.endsWith('.jsonl') ? name.slice(0, -6) : ''
    if (!UUID.test(id)) continue
    const receipts = await readTrialReceipts(capabilitiesDir, id).catch(() => [] as TrialReceipt[])
    const start = receipts[0]
    if (start?.type !== 'trial.start') continue
    if (candidateId !== undefined && start.candidateId !== candidateId) continue
    const end = receipts.find((receipt): receipt is Extract<TrialReceipt, { type: 'trial.end' }> => receipt.type === 'trial.end')
    trials.push({ trialId: id, candidateId: start.candidateId, startedAt: start.ts, receipts, ...(end === undefined ? {} : { end }) })
  }
  return trials.sort((left, right) => (left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : 0))
}

/**
 * Mark `candidateId` as attempted (exclusive create of `trials/<id>.attempt`).
 * @returns `false` when it was attempted before (by this or another process).
 */
export async function claimAttempt(capabilitiesDir: string, candidateId: string): Promise<boolean> {
  if (!UUID.test(candidateId)) throw new NexgentError('internal', `candidate id must be a lowercase uuid v4: ${candidateId}`)
  const directory = join(capabilitiesDir, TRIALS_DIR)
  await mkdir(directory, { recursive: true })
  try {
    // A transient Windows sharing violation (EPERM / EACCES / EBUSY) is retried, not taken for "attempted".
    const handle = await retryTransient(() => open(join(directory, `${candidateId}.attempt`), 'wx', 0o644))
    await handle.close()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** Whether `candidateId` was ever attempted. */
export async function wasAttempted(capabilitiesDir: string, candidateId: string): Promise<boolean> {
  try {
    await readFile(join(capabilitiesDir, TRIALS_DIR, `${candidateId}.attempt`))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Write `trials/<trialId>.lock` with this process id (removed by {@link releaseTrialLock}).
 * A transient Windows sharing violation (EPERM / EACCES / EBUSY) on create is retried with backoff.
 */
export async function writeTrialLock(capabilitiesDir: string, trialId: string, pid: number = process.pid, io: { readonly open?: typeof open; readonly delays?: readonly number[] } = {}): Promise<void> {
  const create = io.open ?? open
  const handle = await retryTransient(() => create(join(capabilitiesDir, TRIALS_DIR, `${trialId}.lock`), 'wx', 0o644), io.delays)
  try {
    await handle.writeFile(`${pid}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Remove a trial's lock. */
export async function releaseTrialLock(capabilitiesDir: string, trialId: string): Promise<void> {
  await retryTransient(() => rm(join(capabilitiesDir, TRIALS_DIR, `${trialId}.lock`), { force: true }))
}

/** Whether the process named by a trial's lock is alive (no lock: not running). */
export async function trialRunning(capabilitiesDir: string, trialId: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(join(capabilitiesDir, TRIALS_DIR, `${trialId}.lock`), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
