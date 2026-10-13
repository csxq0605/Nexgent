/**
 * Step 4 task snapshots and checks (`data-formats.md` §任务快照与检查): the
 * `ctx.taskRecorder` the kernel calls when a root task starts and when each
 * of its turns ends.
 *
 * - Snapshot: every project file in `turn.files` scope (no `.nexgent/`,
 *   `.git/`, `node_modules/`; regular files only) is stored once under
 *   `.nexgent/snapshots/objects/<sha256>`, the sorted list under
 *   `trees/<sha256>.json` (named by the hash of its canonical JSON), and the
 *   pointer under `tasks/<taskId>.t<turn>.json` at the start of every root
 *   turn (step 5, per turn). A workspace over
 *   `CAPABILITY_LIMITS.maxSnapshotBytes` gets `tree: null`.
 * - Checks: `file-exists` for every file of the deliverables the task tree
 *   presented, `parses` for those that are JSON, CSV or XLSX, and
 *   `test-command` for the last few test-runner commands that exited 0. The
 *   specs and results go to `checks/<taskId>.t<turn>.json` at each root turn
 *   end and the results into `task.outcome.checks`.
 * - Step-4 names: `tasks/<taskId>.json` is still written for the task's
 *   first snapshot (never replaced) and `checks/<taskId>.json` for the latest
 *   turn's checks, so step-4 readers keep working.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  CAPABILITY_LIMITS,
  canonicalJson,
  perTurnFileName,
  SNAPSHOTS_DIR,
  writeFileAtomic,
  type JsonValue,
  type ParseFormat,
  type ProcessRunner,
  type SnapshotFile,
  type SnapshotTree,
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
import { isIgnoredPath } from './turn-files.js'

/** At most this many test commands are re-run per task (the latest ones). */
export const MAX_TEST_COMMANDS = 3

/** Deadline of one re-run test command. */
export const TEST_COMMAND_TIMEOUT_MS = 120_000

/**
 * Commands that run a test suite (and nothing else first): package-manager
 * `test` scripts, common runners, `make test|check`. Only these become
 * `test-command` checks; other shell calls (builds, scripts that write
 * files) are not re-run.
 */
export const TEST_COMMAND_PATTERN = new RegExp([
  String.raw`^(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b`,
  String.raw`^(?:npx\s+|pnpm\s+(?:exec\s+)?)?(?:vitest|jest|mocha)\b`,
  String.raw`^(?:uv\s+run\s+)?pytest\b`,
  String.raw`^python3?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`^node\s+--test\b`,
  String.raw`^(?:go|cargo)\s+test\b`,
  String.raw`^make\s+(?:test|check)\b`,
].join('|'))

const PARSE_FORMATS: Readonly<Record<string, ParseFormat>> = { '.json': 'json', '.csv': 'csv', '.xlsx': 'xlsx' }

/** Options of {@link LocalTaskRecorder}. */
export interface LocalTaskRecorderOptions {
  /** Runs `test-command` checks (read when checks run); without one they are not derived. */
  readonly processes?: () => ProcessRunner | undefined
  /** Clock for `takenAt` / `checkedAt` (tests pin it). */
  readonly now?: () => Date
  /** Snapshot size limit (default `CAPABILITY_LIMITS.maxSnapshotBytes`; tests lower it). */
  readonly maxSnapshotBytes?: number
}

interface WalkedFile {
  readonly path: string
  readonly absolute: string
  readonly bytes: number
  readonly executable: boolean
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
    const files = await this.walk()
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    let tree: string | null = null
    if (bytes <= this.maxBytes) tree = await this.storeTree(files)
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
  }

  async end(input: TaskEndInput): Promise<TaskEndResult> {
    const specs = this.specs(input)
    const results: TaskCheck[] = []
    for (const spec of specs) results.push({ ...(await this.run(spec, input.signal)), target: spec.id })
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

  /** The check specs a task's deliverables and test commands give. */
  specs(input: Pick<TaskEndInput, 'deliverableFiles' | 'commands'>): TaskCheckSpec[] {
    const specs: TaskCheckSpec[] = []
    input.deliverableFiles.forEach((path, index) => {
      specs.push({ id: `file-${index + 1}`, name: 'file-exists', path })
      const format = PARSE_FORMATS[nodePath.posix.extname(path).toLowerCase()]
      if (format !== undefined) specs.push({ id: `parse-${index + 1}`, name: 'parses', path, format })
    })
    if (this.options.processes?.() !== undefined) {
      const tests: { command: string; shell: 'bash' | 'pwsh' }[] = []
      for (const call of input.commands) {
        const command = call.command.trim()
        if (!TEST_COMMAND_PATTERN.test(command)) continue
        const at = tests.findIndex(test => test.command === command && test.shell === call.shell)
        if (at >= 0) tests.splice(at, 1)
        tests.push({ command, shell: call.shell })
      }
      tests.slice(-MAX_TEST_COMMANDS).forEach((test, index) => {
        specs.push({ id: `test-${index + 1}`, name: 'test-command', command: test.command, shell: test.shell })
      })
    }
    return specs
  }

  private async run(spec: TaskCheckSpec, signal: AbortSignal | undefined): Promise<Omit<TaskCheck, 'target'>> {
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
        const processes = this.options.processes?.()
        if (processes === undefined) return { name: spec.name, passed: false, detail: 'no process runner' }
        const result = await processes.run({
          command: spec.shell === 'bash' ? 'bash' : 'pwsh',
          args: spec.shell === 'bash' ? ['-c', spec.command] : ['-NoProfile', '-NonInteractive', '-Command', spec.command],
          cwd: this.layout.root,
          timeoutMs: TEST_COMMAND_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        }).catch((error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }))
        if ('failed' in result) return { name: spec.name, passed: false, detail: `could not start: ${result.failed}`.slice(0, 200) }
        if (result.timedOut) return { name: spec.name, passed: false, detail: 'timed out' }
        if (result.aborted) return { name: spec.name, passed: false, detail: 'cancelled' }
        return result.exitCode === 0
          ? { name: spec.name, passed: true }
          : { name: spec.name, passed: false, detail: `exit code ${result.exitCode ?? `signal ${result.signal ?? 'unknown'}`}` }
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

  private absolute(path: string): string {
    return nodePath.join(this.layout.root, ...path.split('/'))
  }

  /** Project files in snapshot scope, sorted by portable path. */
  private async walk(): Promise<WalkedFile[]> {
    const files: WalkedFile[] = []
    const visit = async (dir: string, prefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isNotFound(error)) return
        throw error
      }
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const absolute = nodePath.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (isIgnoredPath(`${path}/x`)) continue
          await visit(absolute, path)
        } else if (entry.isFile()) {
          if (isIgnoredPath(path)) continue
          const info = await lstat(absolute)
          files.push({ path, absolute, bytes: info.size, executable: process.platform !== 'win32' && (info.mode & 0o111) !== 0 })
        }
      }
    }
    await visit(this.layout.root, '')
    return files.sort((a, b) => compare(a.path, b.path))
  }

  /** Store each body once and the tree; returns the tree id. */
  private async storeTree(files: readonly WalkedFile[]): Promise<string> {
    const entries: SnapshotFile[] = []
    for (const file of files) {
      const digest = await this.storeObject(file.absolute)
      entries.push({ path: file.path, sha256: digest, bytes: file.bytes, ...(file.executable ? { executable: true as const } : {}) })
    }
    const tree: SnapshotTree = { formatVersion: 1, files: entries }
    const text = canonicalJson(tree as unknown as JsonValue)
    const id = sha256(text)
    const target = nodePath.join(this.dir, 'trees', `${id}.json`)
    if (!(await exists(target))) await this.writeText(nodePath.join('trees', `${id}.json`), `${text}\n`)
    return id
  }

  /** Copy a file into `objects/<sha256>` unless that body is stored already. */
  private async storeObject(absolute: string): Promise<string> {
    const digest = await hashFile(absolute)
    const objects = nodePath.join(this.dir, 'objects')
    const target = nodePath.join(objects, digest)
    if (await exists(target)) return digest
    await mkdir(objects, { recursive: true })
    const temp = nodePath.join(objects, `.tmp-${randomUUID()}`)
    try {
      const body = await readFile(absolute)
      // The file may have changed between hashing and reading: store it under the hash of what was read.
      const actual = createHash('sha256').update(body).digest('hex')
      const handle = await open(temp, 'wx')
      try {
        await handle.writeFile(body)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, nodePath.join(objects, actual))
      return actual
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
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
