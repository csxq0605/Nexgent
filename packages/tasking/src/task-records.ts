/**
 * Step 4 task snapshots and checks (`data-formats.md` §任务快照与检查): the
 * `ctx.taskRecorder` the kernel calls when a root task starts and when each
 * of its turns ends.
 *
 * - Snapshot: every project file in `turn.files` scope (regular files, not
 *   `.nexgent/`, `.git/`, `node_modules/` and nothing `.gitignore` excludes)
 *   is stored once under `.nexgent/snapshots/objects/<sha256>`, the sorted
 *   list under `trees/<sha256>.json` (named by the hash of its canonical
 *   JSON), and the pointer under `tasks/<taskId>.t<turn>.json` at the start
 *   of every root turn (step 5, per turn). A workspace over
 *   `CAPABILITY_LIMITS.maxSnapshotBytes` gets `tree: null`. It is
 *   incremental: `snapshots/index.json` remembers each file's size, mtime
 *   and hash from the previous snapshot, so only new or changed files are
 *   read and hashed; the expensive part of a snapshot is the `lstat` walk.
 *   After each snapshot, records older than 30 days (and, over the size cap,
 *   the oldest ones) are pruned unless retained, then unreferenced trees and
 *   objects are deleted.
 * - Checks: `file-exists` for every file of the deliverables the task tree
 *   presented, `parses` for those that are JSON, CSV or XLSX, and
 *   `test-command` for the last few test-runner commands the model ran in
 *   the project root. A `test-command` result is the exit code of the
 *   model's own run; nothing is re-run at turn end. The specs and results go
 *   to `checks/<taskId>.t<turn>.json` at each root turn end and the results
 *   into `task.outcome.checks`.
 * - Step-4 names: `tasks/<taskId>.json` is still written for the task's
 *   first snapshot (never replaced) and `checks/<taskId>.json` for the latest
 *   turn's checks, so step-4 readers keep working.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  CAPABILITY_LIMITS,
  CHECK_COMMAND_ID_PREFIX,
  canonicalJson,
  perTurnFileName,
  SNAPSHOTS_DIR,
  writeFileAtomic,
  type JsonValue,
  type ParseFormat,
  type SnapshotFile,
  type SnapshotTree,
  type CheckCommandRun,
  type TaskBeginInput,
  type TaskCheck,
  type TaskCheckSpec,
  type TaskChecksRecord,
  type TaskEndInput,
  type TaskEndResult,
  type TaskRecorder,
  type TaskSnapshotRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { isNotFound } from './files-util.js'
import { walkProject, type WalkedEntry } from './project-walk.js'

/** At most this many test commands the model ran become checks per turn (the latest ones). */
export const MAX_TEST_COMMANDS = 3

/**
 * Commands that run a test suite (and nothing else first): package-manager
 * `test` scripts, common runners, `make test|check`. Only these become
 * `test-command` checks; other shell calls (builds, scripts that write
 * files) never do.
 */
export const TEST_COMMAND_PATTERN = new RegExp([
  String.raw`^(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b`,
  String.raw`^(?:npx\s+|pnpm\s+(?:exec\s+)?)?(?:vitest|jest|mocha)\b`,
  String.raw`^(?:uv\s+run\s+)?pytest\b`,
  String.raw`^python3?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`^node\s+--test\b`,
  String.raw`^node\s+\S+\.test\.[cm]?[jt]s(?:\s|$)`,
  String.raw`^(?:go|cargo)\s+test\b`,
  String.raw`^make\s+(?:test|check)\b`,
].join('|'))

/**
 * Exit codes that mean the runner never ran a test: the shell could not
 * execute or find the command (126, 127), or pytest was given a bad path or
 * option (4) or found no tests (5).
 */
const NO_TESTS_RAN: readonly number[] = [126, 127]
const PYTEST_NO_TESTS_RAN: readonly number[] = [4, 5]
const PYTEST_PATTERN = /^(?:uv\s+run\s+)?(?:python3?\s+-m\s+)?pytest\b/

/**
 * Whether a shell call counts as a test run for `test-command` checks: the
 * command matches {@link TEST_COMMAND_PATTERN} and its exit code does not
 * say that no test ran. Step 5 (user decision 2026-10-13, ADR 0006
 * decision 10) keeps failing runs: a failing run is a failing check. Exploratory
 * commands (`ls`, `cat`, builds) never match the pattern, whatever their
 * exit code. `exitCode` absent reads as 0 (step-4 callers).
 */
export function testCommandRan(command: string, exitCode: number | undefined): boolean {
  const text = command.trim()
  if (!TEST_COMMAND_PATTERN.test(text)) return false
  const code = exitCode ?? 0
  if (NO_TESTS_RAN.includes(code)) return false
  if (PYTEST_PATTERN.test(text) && PYTEST_NO_TESTS_RAN.includes(code)) return false
  return true
}

/** The result of one project check command (redesign 3.2): exit code 0 passes. */
function checkRunResult(run: CheckCommandRun): Omit<TaskCheck, 'target'> {
  if (run.exitCode === undefined) return { name: 'test-command', passed: false, detail: run.detail ?? 'the project check command did not run' }
  const detail = `the project check command, exit code ${run.exitCode}${run.detail === undefined ? '' : `: ${run.detail}`}`
  return { name: 'test-command', passed: run.exitCode === 0, detail: detail.slice(0, 300) }
}

const PARSE_FORMATS: Readonly<Record<string, ParseFormat>> = { '.json': 'json', '.csv': 'csv', '.xlsx': 'xlsx' }

/** Task snapshot records older than this are pruned (30 days). */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Format version of `snapshots/index.json`. */
export const SNAPSHOT_INDEX_VERSION = 1

/** One file of the snapshot index: enough to know the file is unchanged without reading it. */
export interface SnapshotIndexEntry {
  readonly size: number
  readonly mtimeMs: number
  readonly sha256: string
}

/**
 * `.nexgent/snapshots/index.json`: the files of the latest snapshot. A file
 * whose size and mtime match is not read again. `writtenAtMs` is when the
 * index was saved (wall clock): entries modified within
 * {@link RACY_WINDOW_MS} of it might have changed again without a new mtime
 * and are re-hashed once.
 */
export interface SnapshotIndex {
  readonly formatVersion: 1
  readonly writtenAtMs: number
  /** When the last size-cap check ran (wall clock); the check is not repeated on every snapshot. */
  readonly prunedAtMs?: number
  readonly files: Readonly<Record<string, SnapshotIndexEntry>>
}

/** Index entries this close to the index's write time are re-hashed (coarse mtime granularity). */
export const RACY_WINDOW_MS = 2_000

/** The size cap is re-checked after this long, or when one snapshot stored more than {@link SIZE_CHECK_NEW_BYTES}. */
export const SIZE_CHECK_INTERVAL_MS = 10 * 60 * 1000
export const SIZE_CHECK_NEW_BYTES = 8 * 1024 * 1024

/** Hashing and copying run this many files at once. */
const STORE_CONCURRENCY = 16
/** Bodies up to this size are read into memory once instead of hashed as a stream and read again. */
const SMALL_OBJECT_BYTES = 1024 * 1024

/** Orphaned objects and trees younger than this are left for a concurrent writer to reference. */
export const DEFAULT_PRUNE_GRACE_MS = 60 * 60 * 1000

/** Which snapshot records pruning must keep: a predicate over the record's file name, or a set of task ids. */
export type SnapshotRetention = ((taskSnapshotFile: string) => boolean) | ReadonlySet<string>

/** Options of {@link LocalTaskRecorder}. */
export interface LocalTaskRecorderOptions {
  /** Clock for `takenAt` / `checkedAt` and record ages (tests pin it). */
  readonly now?: () => Date
  /** Snapshot size limit (default `CAPABILITY_LIMITS.maxSnapshotBytes`; tests lower it). */
  readonly maxSnapshotBytes?: number
  /** Cap on the total bytes of stored objects (default `CAPABILITY_LIMITS.maxSnapshotBytes`). */
  readonly maxStoreBytes?: number
  /** Age after which task snapshot records are pruned (default {@link SNAPSHOT_RETENTION_MS}). */
  readonly retentionMs?: number
  /**
   * Records that must never be pruned (age or size): a function called with
   * the record's file name under `tasks/` (`<taskId>.json` or
   * `<taskId>.t<turn>.json`), or a set of task ids. Read at each prune, so a
   * live set can grow. The task being snapshotted is always kept.
   */
  readonly retain?: SnapshotRetention
  /** Minimum time between size-cap checks (default {@link SIZE_CHECK_INTERVAL_MS}; tests pass 0). */
  readonly sizeCheckIntervalMs?: number
  /** Grace before unreferenced objects and trees are deleted (default {@link DEFAULT_PRUNE_GRACE_MS}). */
  readonly pruneGraceMs?: number
}

/** A `test-command` the model ran, as the specs derive it. */
interface TestRun {
  readonly command: string
  readonly shell: 'bash' | 'pwsh'
  readonly exitCode: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Run `task` over `items`, `limit` at a time, in order of completion. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function retained(retain: SnapshotRetention | undefined, file: string, taskId: string): boolean {
  if (retain === undefined) return false
  if (typeof retain === 'function') return retain(file)
  return retain.has(taskId)
}

interface TaskFileInfo {
  readonly file: string
  readonly taskId: string
  readonly takenAtMs: number
  readonly tree: string | null
}

/** The `ctx.taskRecorder` of one project. */
export class LocalTaskRecorder implements TaskRecorder {
  /** `.nexgent/snapshots/`. */
  readonly dir: string
  private readonly now: () => Date
  private readonly maxBytes: number

  constructor(private readonly layout: WorkspaceLayout, private readonly options: LocalTaskRecorderOptions = {}) {
    this.dir = nodePath.join(layout.dataDir, SNAPSHOTS_DIR)
    this.now = options.now ?? (() => new Date())
    this.maxBytes = options.maxSnapshotBytes ?? CAPABILITY_LIMITS.maxSnapshotBytes
  }

  async begin(input: TaskBeginInput): Promise<void> {
    const { files } = await walkProject(this.layout.root)
    const bytes = files.reduce((sum, file) => sum + file.size, 0)
    let tree: string | null = null
    let newBytes = 0
    if (bytes <= this.maxBytes) ({ tree, newBytes } = await this.storeTree(files))
    const record: TaskSnapshotRecord = {
      formatVersion: 1,
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      takenAt: this.now().toISOString(),
      tree,
      ...(tree === null ? { omitted: { reason: 'too-large' as const, bytes } } : {}),
      capabilityVersion: input.capabilityVersion,
    }
    if (input.turn !== undefined) await this.writeJson(nodePath.join('tasks', perTurnFileName(input.taskId, input.turn)), record)
    // The step-4 name keeps the task's first snapshot.
    const legacy = nodePath.join('tasks', `${input.taskId}.json`)
    if (input.turn === undefined || !(await exists(nodePath.join(this.dir, legacy)))) await this.writeJson(legacy, record)
    // Pruning is housekeeping: it never fails the task.
    await this.prune(input.taskId, newBytes).catch(() => undefined)
  }

  async end(input: TaskEndInput): Promise<TaskEndResult> {
    const specs = this.specs(input)
    const runs = this.testRuns(input)
    const results: TaskCheck[] = []
    const checkRuns = input.checkRuns ?? []
    for (const spec of specs) {
      const own = spec.id.startsWith(CHECK_COMMAND_ID_PREFIX) ? checkRuns[Number(spec.id.slice(CHECK_COMMAND_ID_PREFIX.length)) - 1] : undefined
      results.push({ ...(own === undefined ? await this.run(spec, runs) : checkRunResult(own)), target: spec.id })
    }
    const record: TaskChecksRecord = {
      formatVersion: 1,
      taskId: input.taskId,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      sessionId: input.sessionId,
      checkedAt: this.now().toISOString(),
      specs,
      results,
    }
    if (input.turn !== undefined) await this.writeJson(nodePath.join('checks', perTurnFileName(input.taskId, input.turn)), record)
    // The step-4 name holds the latest turn's checks.
    await this.writeJson(nodePath.join('checks', `${input.taskId}.json`), record)
    return { specs, results }
  }

  /** The check specs a task's deliverables and the test commands the model ran give. */
  specs(input: Pick<TaskEndInput, 'deliverableFiles' | 'commands' | 'checkRuns'>): TaskCheckSpec[] {
    const specs: TaskCheckSpec[] = []
    input.deliverableFiles.forEach((path, index) => {
      specs.push({ id: `file-${index + 1}`, name: 'file-exists', path })
      const format = PARSE_FORMATS[nodePath.posix.extname(path).toLowerCase()]
      if (format !== undefined) specs.push({ id: `parse-${index + 1}`, name: 'parses', path, format })
    })
    this.testRuns(input).forEach((test, index) => {
      specs.push({ id: `test-${index + 1}`, name: 'test-command', command: test.command, shell: test.shell })
    })
    // Redesign 3.2: the project's own check commands, after the model's test runs.
    ;(input.checkRuns ?? []).forEach((run, index) => {
      specs.push({ id: `${CHECK_COMMAND_ID_PREFIX}${index + 1}`, name: 'test-command', command: run.command.trim(), shell: run.shell })
    })
    return specs
  }

  /** The test runs the model made: pattern match, a run that ran tests, newest of each command, last {@link MAX_TEST_COMMANDS}. */
  private testRuns(input: Pick<TaskEndInput, 'commands'>): TestRun[] {
    const tests: TestRun[] = []
    for (const call of input.commands) {
      const command = call.command.trim()
      if (!testCommandRan(command, call.exitCode)) continue
      const at = tests.findIndex(test => test.command === command && test.shell === call.shell)
      if (at >= 0) tests.splice(at, 1)
      tests.push({ command, shell: call.shell, exitCode: call.exitCode ?? 0 })
    }
    return tests.slice(-MAX_TEST_COMMANDS)
  }

  private async run(spec: TaskCheckSpec, runs: readonly TestRun[]): Promise<Omit<TaskCheck, 'target'>> {
    switch (spec.name) {
      case 'file-exists': {
        const info = await stat(this.absolute(spec.path)).catch(() => undefined)
        return info?.isFile() === true ? { name: spec.name, passed: true } : { name: spec.name, passed: false, detail: 'missing' }
      }
      case 'parses': {
        const problem = await this.parseProblem(spec.path, spec.format)
        return problem === undefined ? { name: spec.name, passed: true } : { name: spec.name, passed: false, detail: problem }
      }
      case 'test-command': {
        // The model's own run decides; nothing is executed here.
        const run = runs.find(test => test.command === spec.command && test.shell === spec.shell)
        if (run === undefined) return { name: spec.name, passed: false, detail: 'no recorded run' }
        return { name: spec.name, passed: run.exitCode === 0, detail: `the model's own run, exit code ${run.exitCode}` }
      }
    }
  }

  /** Why a file does not parse as `format`, or `undefined` when it does. */
  private async parseProblem(path: string, format: ParseFormat): Promise<string | undefined> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.absolute(path))
    } catch (error) {
      return isNotFound(error) ? 'missing' : 'unreadable'
    }
    if (format === 'xlsx') {
      // An OOXML workbook is a zip whose directory names the content types and the workbook part.
      const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      const text = bytes.toString('latin1')
      return zip && text.includes('[Content_Types].xml') && text.includes('xl/workbook.xml') ? undefined : 'not an xlsx workbook'
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return 'not UTF-8 text'
    }
    if (format === 'json') {
      try {
        JSON.parse(text)
        return undefined
      } catch {
        return 'invalid JSON'
      }
    }
    return csvProblem(text)
  }

  /**
   * The project paths of the latest snapshot (from `index.json`), the
   * baseline a turn file tracker uses to find shell-made deletions;
   * `undefined` when there is no index.
   */
  async indexedPaths(): Promise<ReadonlySet<string> | undefined> {
    const index = await this.readIndex()
    return index === undefined ? undefined : new Set(Object.keys(index.files))
  }

  private absolute(path: string): string {
    return nodePath.join(this.layout.root, ...path.split('/'))
  }

  private async readIndex(): Promise<SnapshotIndex | undefined> {
    try {
      const parsed = JSON.parse(await readFile(nodePath.join(this.dir, 'index.json'), 'utf8')) as Partial<SnapshotIndex>
      if (parsed.formatVersion !== SNAPSHOT_INDEX_VERSION || typeof parsed.writtenAtMs !== 'number' || parsed.files === null || typeof parsed.files !== 'object') return undefined
      return parsed as SnapshotIndex
    } catch {
      return undefined
    }
  }

  /** Names in `objects/` (one `readdir`, instead of a `stat` per file). */
  private async objectNames(): Promise<Set<string>> {
    try {
      return new Set(await readdir(nodePath.join(this.dir, 'objects')))
    } catch {
      return new Set()
    }
  }

  /**
   * Store each new or changed body once and the tree; returns the tree id.
   * Unchanged files (same size and mtime as in the index, whose object still
   * exists) keep their recorded hash without being read.
   */
  private async storeTree(files: readonly WalkedEntry[]): Promise<{ tree: string; newBytes: number }> {
    const index = await this.readIndex()
    const objects = await this.objectNames()
    let newBytes = 0
    const racyAfter = index === undefined ? 0 : index.writtenAtMs - RACY_WINDOW_MS
    const entries = await mapLimited(files, STORE_CONCURRENCY, async (file): Promise<SnapshotFile & { mtimeMs: number }> => {
      const known = index?.files[file.path]
      let digest: string | undefined
      if (known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs && file.mtimeMs < racyAfter && objects.has(known.sha256)) {
        digest = known.sha256
      } else {
        const had = objects.size
        digest = await this.storeObject(nodePath.join(this.layout.root, ...file.path.split('/')), objects, file.size)
        if (objects.size > had) newBytes += file.size
      }
      const executable = process.platform !== 'win32' && (file.mode & 0o111) !== 0
      return { path: file.path, sha256: digest, bytes: file.size, mtimeMs: file.mtimeMs, ...(executable ? { executable: true as const } : {}) }
    })
    const tree: SnapshotTree = {
      formatVersion: 1,
      files: entries.map(({ mtimeMs: _mtime, ...entry }) => entry),
    }
    const text = canonicalJson(tree as unknown as JsonValue)
    const id = sha256(text)
    const target = nodePath.join(this.dir, 'trees', `${id}.json`)
    if (!(await exists(target))) await this.writeText(nodePath.join('trees', `${id}.json`), `${text}\n`)
    const next: SnapshotIndex = {
      formatVersion: SNAPSHOT_INDEX_VERSION,
      writtenAtMs: Date.now(),
      ...(index?.prunedAtMs === undefined ? {} : { prunedAtMs: index.prunedAtMs }),
      files: Object.fromEntries(entries.map(entry => [entry.path, { size: entry.bytes, mtimeMs: entry.mtimeMs, sha256: entry.sha256 }])),
    }
    // The index is a cache: failing to save it only costs the next snapshot a full read.
    await this.writeText('index.json', JSON.stringify(next)).catch(() => undefined)
    return { tree: id, newBytes }
  }

  /** Copy a file into `objects/<sha256>` unless that body is stored already (`known` lists the stored names). */
  private async storeObject(absolute: string, known: Set<string>, size = Number.POSITIVE_INFINITY): Promise<string> {
    // Small files are read once; large ones are hashed as a stream first so a known body is never held in memory.
    const small = size <= SMALL_OBJECT_BYTES ? await readFile(absolute) : undefined
    const digest = small === undefined ? await hashFile(absolute) : createHash('sha256').update(small).digest('hex')
    if (known.has(digest)) return digest
    const objects = nodePath.join(this.dir, 'objects')
    const target = nodePath.join(objects, digest)
    if (await exists(target)) {
      known.add(digest)
      return digest
    }
    await mkdir(objects, { recursive: true })
    const temp = nodePath.join(objects, `.tmp-${randomUUID()}`)
    try {
      const body = small ?? await readFile(absolute)
      // The file may have changed between hashing and reading: store it under the hash of what was read.
      const actual = createHash('sha256').update(body).digest('hex')
      // No fsync per object: a body lost to a power cut only makes that snapshot unusable as a case.
      await writeFile(temp, body, { flag: 'wx' })
      const stored = nodePath.join(objects, actual)
      try {
        await rename(temp, stored)
      } catch (error) {
        // Two files with the same body stored at once: on Windows the second rename onto the
        // object the first just placed can fail (EPERM). The name is the content hash, so an
        // object already there is this body; anything else is a real failure.
        if (!(await exists(stored))) throw error
        await rm(temp, { force: true }).catch(() => undefined)
      }
      known.add(actual)
      return actual
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Retention: delete task records past {@link LocalTaskRecorderOptions.retentionMs},
   * then the oldest ones while the referenced objects exceed the store cap,
   * then trees and objects no remaining record references. Retained records
   * and the current task's are never deleted.
   */
  private async prune(currentTaskId: string, newBytes: number): Promise<void> {
    const tasksDir = nodePath.join(this.dir, 'tasks')
    const names = (await readdir(tasksDir).catch(() => [] as string[])).filter(name => name.endsWith('.json'))
    const records: TaskFileInfo[] = []
    for (const file of names) {
      try {
        const parsed = JSON.parse(await readFile(nodePath.join(tasksDir, file), 'utf8')) as Partial<TaskSnapshotRecord>
        const takenAtMs = Date.parse(parsed.takenAt ?? '')
        if (typeof parsed.taskId !== 'string' || Number.isNaN(takenAtMs)) continue
        records.push({ file, taskId: parsed.taskId, takenAtMs, tree: typeof parsed.tree === 'string' ? parsed.tree : null })
      } catch {
        // unreadable records are left alone
      }
    }
    const keep = (record: TaskFileInfo): boolean => record.taskId === currentTaskId || retained(this.options.retain, record.file, record.taskId)
    const cutoff = this.now().getTime() - (this.options.retentionMs ?? SNAPSHOT_RETENTION_MS)
    let remaining = records.filter(record => keep(record) || record.takenAtMs >= cutoff)
    const expired = remaining.length !== records.length
    for (const record of records) if (!remaining.includes(record)) await unlink(nodePath.join(tasksDir, record.file)).catch(() => undefined)

    const cap = this.options.maxStoreBytes ?? CAPABILITY_LIMITS.maxSnapshotBytes
    if (!expired) {
      // The size check stats every object: it runs on a timer or after a big snapshot, not on every one.
      const index = await this.readIndex()
      const due = index?.prunedAtMs === undefined || Date.now() - index.prunedAtMs >= (this.options.sizeCheckIntervalMs ?? SIZE_CHECK_INTERVAL_MS) || newBytes > SIZE_CHECK_NEW_BYTES
      if (!due) return
      if (index !== undefined) await this.writeText('index.json', JSON.stringify({ ...index, prunedAtMs: Date.now() })).catch(() => undefined)
      if ((await this.objectsBytes()) <= cap) return
    }

    const trees = new Map<string, readonly SnapshotFile[]>()
    const treeFiles = async (id: string): Promise<readonly SnapshotFile[]> => {
      let files = trees.get(id)
      if (files === undefined) {
        try {
          files = (JSON.parse(await readFile(nodePath.join(this.dir, 'trees', `${id}.json`), 'utf8')) as SnapshotTree).files
        } catch {
          files = []
        }
        trees.set(id, files)
      }
      return files
    }
    const sizes = new Map<string, number>()
    const refs = new Map<string, number>()
    const addRefs = async (record: TaskFileInfo, delta: 1 | -1): Promise<void> => {
      if (record.tree === null) return
      for (const file of await treeFiles(record.tree)) {
        sizes.set(file.sha256, file.bytes)
        refs.set(file.sha256, (refs.get(file.sha256) ?? 0) + delta)
      }
    }
    for (const record of remaining) await addRefs(record, 1)
    let total = 0
    for (const [digest, count] of refs) if (count > 0) total += sizes.get(digest) ?? 0
    const oldestFirst = remaining.filter(record => !keep(record)).sort((a, b) => a.takenAtMs - b.takenAtMs)
    for (const record of oldestFirst) {
      if (total <= cap) break
      await unlink(nodePath.join(tasksDir, record.file)).catch(() => undefined)
      remaining = remaining.filter(other => other !== record)
      if (record.tree === null) continue
      for (const file of await treeFiles(record.tree)) {
        const left = (refs.get(file.sha256) ?? 0) - 1
        refs.set(file.sha256, left)
        if (left === 0) total -= sizes.get(file.sha256) ?? 0
      }
    }

    const liveTrees = new Set(remaining.flatMap(record => (record.tree === null ? [] : [record.tree])))
    const liveObjects = new Set<string>()
    for (const [digest, count] of refs) if (count > 0) liveObjects.add(digest)
    const grace = Date.now() - (this.options.pruneGraceMs ?? DEFAULT_PRUNE_GRACE_MS)
    await this.sweep('trees', name => !liveTrees.has(name.replace(/\.json$/, '')), grace)
    await this.sweep('objects', name => !name.startsWith('.tmp-') && !liveObjects.has(name), grace)
  }

  /** Sum of the sizes of `objects/`. */
  private async objectsBytes(): Promise<number> {
    const dir = nodePath.join(this.dir, 'objects')
    const names = await readdir(dir).catch(() => [] as string[])
    const sizes = await mapLimited(names, 32, async name => (await stat(nodePath.join(dir, name)).catch(() => undefined))?.size ?? 0)
    return sizes.reduce((sum, size) => sum + size, 0)
  }

  /** Delete the entries of `snapshots/<sub>/` that `doomed` selects and that are older than `graceBefore` (ms). */
  private async sweep(sub: string, doomed: (name: string) => boolean, graceBefore: number): Promise<void> {
    const dir = nodePath.join(this.dir, sub)
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!doomed(name)) continue
      const info = await stat(nodePath.join(dir, name)).catch(() => undefined)
      if (info === undefined || info.mtimeMs > graceBefore) continue
      await unlink(nodePath.join(dir, name)).catch(() => undefined)
    }
  }

  private async writeJson(relative: string, value: object): Promise<void> {
    await this.writeText(relative, `${JSON.stringify(value, null, 2)}\n`)
  }

  private async writeText(relative: string, text: string): Promise<void> {
    const target = nodePath.join(this.dir, relative)
    await mkdir(nodePath.dirname(target), { recursive: true })
    await writeFileAtomic(target, text)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** Why text is not CSV (balanced quotes, at least one row, rows of equal width), or `undefined`. */
export function csvProblem(text: string): string | undefined {
  const rows: number[] = []
  let fields = 1
  let quoted = false
  let content = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') i += 1
        else quoted = false
      }
      continue
    }
    if (char === '"') {
      quoted = true
      content = true
    } else if (char === ',') {
      fields += 1
      content = true
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      if (content) rows.push(fields)
      fields = 1
      content = false
    } else {
      content = true
    }
  }
  if (quoted) return 'unbalanced quotes'
  if (content) rows.push(fields)
  if (rows.length === 0) return 'empty'
  const width = rows[0]!
  const ragged = rows.findIndex(count => count !== width)
  return ragged < 0 ? undefined : `row ${ragged + 1} has ${rows[ragged]} fields, expected ${width}`
}
