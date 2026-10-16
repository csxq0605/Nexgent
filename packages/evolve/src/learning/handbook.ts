/**
 * The handbook files of layer 1 (ADR 0018 decision 4; `data-formats.md`
 * §经验手册) and the lexical retrieval over them.
 *
 * - {@link HandbookLog}: one append-only `ops.jsonl` (user level
 *   `<NEXGENT_HOME>/handbook/`, project level `<project data>/handbook/`),
 *   `seq` from 1 without gaps, appended under a lock file so several app
 *   processes never interleave. Reading keeps the valid prefix; an append
 *   first cuts a torn tail (a process died mid-write) so `seq` stays
 *   contiguous.
 * - {@link retrieveEntries}: BM25 over the text and keywords of the
 *   retrievable entries a task may see (project entries of this project,
 *   user entries when `learning.useShared` is on), at most
 *   {@link HANDBOOK_TOP_K}.
 *
 * Interim home: the contract names `@nexgent/capabilities` as the store
 * (V1); until V1 lands the improvement flow keeps this minimal store, written
 * strictly to the contract, so V1 can take the files over unchanged.
 */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  foldHandbook,
  HANDBOOK_ACTORS,
  HANDBOOK_ENTRY_STATUSES,
  HANDBOOK_OP_KINDS,
  HANDBOOK_SCOPES,
  HANDBOOK_TOP_K,
  isRetrievable,
  type HandbookEntry,
  type HandbookOp,
} from '@nexgent/kernel'
import { withFileLock } from '../lock.js'
import { tokenize } from './text.js'

/** File name of a handbook log inside its directory. */
export const HANDBOOK_OPS_FILE = 'ops.jsonl'
/** Lock file next to it. */
export const HANDBOOK_LOCK_FILE = 'ops.lock'

/** An operation before the log assigns `formatVersion`, `seq` and (unless given) `at`. */
export type HandbookOpInput = HandbookOp extends infer Op ? (Op extends HandbookOp ? Omit<Op, 'formatVersion' | 'seq' | 'at'> & { readonly at?: string } : never) : never

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a parsed line is a well-formed operation at position `seq` (shape only; bounds are the writer's). */
export function isHandbookOp(value: unknown, seq: number): value is HandbookOp {
  if (!isRecord(value)) return false
  if (value.formatVersion !== 1 || value.seq !== seq || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return false
  if (typeof value.entryId !== 'string' || !UUID.test(value.entryId)) return false
  if (!HANDBOOK_ACTORS.includes(value.actor as never) || !HANDBOOK_OP_KINDS.includes(value.op as never)) return false
  if (value.reason !== undefined && typeof value.reason !== 'string') return false
  if (value.source !== undefined && !(isRecord(value.source) && typeof value.source.taskId === 'string')) return false
  switch (value.op) {
    case 'add':
      return typeof value.text === 'string' && Array.isArray(value.keywords) && value.keywords.every(k => typeof k === 'string') && HANDBOOK_SCOPES.includes(value.scope as never)
        && (value.status === undefined || value.status === 'trial' || value.status === 'active')
        && (value.supersedes === undefined || (Array.isArray(value.supersedes) && value.supersedes.every(id => typeof id === 'string')))
    case 'edit':
      return (value.text === undefined || typeof value.text === 'string') && (value.keywords === undefined || (Array.isArray(value.keywords) && value.keywords.every(k => typeof k === 'string')))
    case 'status':
      return HANDBOOK_ENTRY_STATUSES.includes(value.status as never)
    default:
      return true
  }
}

/** The valid prefix of a log's text, and how many bytes of it are valid. */
function parseLog(text: string): { readonly ops: HandbookOp[]; readonly validLength: number } {
  const ops: HandbookOp[] = []
  let offset = 0
  let validLength = 0
  for (const line of text.split('\n')) {
    const end = offset + line.length + 1
    if (line.trim() === '') {
      offset = end
      if (end <= text.length) validLength = end
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      break
    }
    if (!isHandbookOp(value, ops.length + 1) || end > text.length) break
    ops.push(value)
    offset = end
    validLength = end
  }
  return { ops, validLength }
}

/** One handbook log file. */
export class HandbookLog {
  readonly directory: string
  readonly file: string
  readonly #lock: string

  constructor(directory: string) {
    this.directory = directory
    this.file = join(directory, HANDBOOK_OPS_FILE)
    this.#lock = join(directory, HANDBOOK_LOCK_FILE)
  }

  async #text(): Promise<string> {
    try {
      return await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** Every valid operation, in order (a missing file is an empty log). */
  async read(): Promise<HandbookOp[]> {
    return parseLog(await this.#text()).ops
  }

  /** The current entries (the fold of the whole log). */
  async entries(): Promise<HandbookEntry[]> {
    return foldHandbook(await this.read())
  }

  /**
   * Append operations atomically with respect to other writers: under the
   * lock, read the log, cut a torn tail, number the new operations after
   * the last valid one and append them. `prepare` sees the log as it is
   * under the lock and returns what to append (so checks against the
   * current entries and the write cannot race).
   * @returns the operations as written.
   */
  async append(prepare: (current: readonly HandbookOp[]) => readonly HandbookOpInput[] | Promise<readonly HandbookOpInput[]>, now: () => Date = () => new Date()): Promise<HandbookOp[]> {
    await mkdir(this.directory, { recursive: true })
    return withFileLock(this.#lock, async () => {
      const text = await this.#text()
      const { ops, validLength } = parseLog(text)
      const inputs = await prepare(ops)
      if (inputs.length === 0) return []
      if (validLength < text.length) await writeFile(this.file, text.slice(0, validLength))
      let seq = ops.length
      const written = inputs.map(input => ({ formatVersion: 1, seq: (seq += 1), ...input, at: input.at ?? now().toISOString() }) as HandbookOp)
      await appendFile(this.file, written.map(op => `${JSON.stringify(op)}\n`).join(''))
      return written
    })
  }
}

/** Where a project's two logs are. */
export interface HandbookLogs {
  readonly user: HandbookLog
  readonly project: HandbookLog
}

/** The logs of a project: user level below the Nexgent home, project level below the project data directory. */
export function handbookLogs(home: string, projectDataDir: string): HandbookLogs {
  return { user: new HandbookLog(join(home, 'handbook')), project: new HandbookLog(join(projectDataDir, 'handbook')) }
}

/** What a task of a project may see. */
export interface HandbookView {
  readonly projectId: string
  /** `learning.useShared`. */
  readonly useShared: boolean
}

/** The retrievable entries a task of the project may see (project entries of this project; user entries when shared). */
export function visibleEntries(user: readonly HandbookEntry[], project: readonly HandbookEntry[], view: HandbookView): HandbookEntry[] {
  return [
    ...project.filter(entry => isRetrievable(entry) && (entry.projectId === undefined || entry.projectId === view.projectId)),
    ...(view.useShared ? user.filter(entry => isRetrievable(entry)) : []),
  ]
}

/** One retrieved entry with its score. */
export interface RetrievedEntry {
  readonly entry: HandbookEntry
  readonly score: number
}

const K1 = 1.2
const B = 0.75

/** An entry's document: its text and its keywords (keywords count twice: they name where it applies). */
function documentTokens(entry: Pick<HandbookEntry, 'text' | 'keywords'>): string[] {
  const keywordTokens = entry.keywords.flatMap(keyword => tokenize(keyword))
  return [...tokenize(entry.text), ...keywordTokens, ...keywordTokens]
}

/**
 * BM25 of `query` over `entries` (pure): the best `limit` with a positive
 * score, best first; ties keep the input order. Active entries rank before
 * trial ones of equal score.
 */
export function retrieveEntries(query: string, entries: readonly HandbookEntry[], limit = HANDBOOK_TOP_K): RetrievedEntry[] {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || entries.length === 0 || limit <= 0) return []
  const docs = entries.map(entry => {
    const tokens = documentTokens(entry)
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    return { entry, length: tokens.length, tf }
  })
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const term of terms) df.set(term, docs.filter(doc => doc.tf.has(term)).length)
  const scored = docs.map((doc, index) => {
    let score = 0
    for (const term of terms) {
      const f = doc.tf.get(term) ?? 0
      if (f === 0) continue
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / average)))
    }
    return { entry: doc.entry, score, index }
  })
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.entry.status === b.entry.status ? 0 : a.entry.status === 'active' ? -1 : 1) || a.index - b.index)
    .slice(0, limit)
    .map(({ entry, score }) => ({ entry, score }))
}
