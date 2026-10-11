/**
 * `DeliverableStore` over `.nexgent/outputs/`. Normative text:
 * `docs/spec/data-formats.md` §成果元数据 and `docs/spec/agent-hooks.md`
 * §步骤 2 工具 (which deliverable a `present` adds a version to).
 */
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  DELIVERABLE_FILES_DIR,
  DELIVERABLE_METADATA_FILE,
  NexgentError,
  type DeliverableDiff,
  type DeliverableFile,
  type DeliverableFileDiff,
  type DeliverableStore,
  type DeliverableSummary,
  type DeliverableVersion,
  type PresentInput,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { formatIssues, validateDeliverableVersion } from '@nexgent/session'
import { textHunks } from './diff.js'
import {
  copyWithHash,
  guessMediaType,
  isKnownBinaryType,
  isNotFound,
  realpathNative,
  isTaskingId,
  newId,
  removeTempEntries,
  renameWithRetry,
  syncDir,
  TEMP_PREFIX,
  writeJsonFile,
} from './files-util.js'
import { assertSafePortablePath, resolveProjectFile, type ProjectFile } from './project-paths.js'

/** Files larger than this are diffed as binary (change only). */
export const DIFF_TEXT_LIMIT = 2 * 1024 * 1024

/** Max files one `present` takes (the tool schema says the same). */
export const PRESENT_MAX_FILES = 50

/** How often `present` re-picks the version number when another writer took it. */
const VERSION_ATTEMPTS = 5

/** Options of {@link LocalDeliverableStore}. */
export interface LocalDeliverableStoreOptions {
  /** Clock for `presentedAt` (tests pin it). */
  readonly now?: () => Date
}

const VERSION_DIR = /^v([1-9][0-9]*)$/

/** Deliverables of one project, stored under `layout.outputs`. */
export class LocalDeliverableStore implements DeliverableStore {
  private readonly now: () => Date
  private realRoot: string | undefined
  /** Serializes `present` within the process (the rename protocol covers other processes). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly layout: WorkspaceLayout, options: LocalDeliverableStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** Remove `.tmp-*` leftovers of interrupted `present`s; called once at startup. */
  async cleanup(): Promise<number> {
    let removed = 0
    let entries: string[]
    try {
      entries = await readdir(this.layout.outputs)
    } catch {
      return 0
    }
    removed += await removeTempEntries(this.layout.outputs)
    for (const entry of entries) {
      if (isTaskingId(entry)) removed += await removeTempEntries(nodePath.join(this.layout.outputs, entry))
    }
    return removed
  }

  present(input: PresentInput): Promise<DeliverableVersion> {
    const run = this.queue.then(() => this.presentNow(input))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async presentNow(input: PresentInput): Promise<DeliverableVersion> {
    if (input.paths.length === 0) throw new NexgentError('tool/invalid-input', 'present needs at least one path')
    if (input.paths.length > PRESENT_MAX_FILES) throw new NexgentError('tool/invalid-input', `present takes at most ${PRESENT_MAX_FILES} paths, got ${input.paths.length}`)
    if (input.summary.trim() === '') throw new NexgentError('tool/invalid-input', 'present needs a one-sentence summary')
    const realRoot = await this.root()
    const files: ProjectFile[] = []
    for (const path of input.paths) {
      const file = await resolveProjectFile(this.layout.root, realRoot, path)
      if (!files.some(existing => existing.path === file.path)) files.push(file)
    }
    const primary = files[0]!.path

    let deliverableId: string
    let previous: DeliverableVersion | undefined
    if (input.deliverableId !== undefined) {
      const versions = isTaskingId(input.deliverableId) ? await this.versions(input.deliverableId) : []
      previous = versions[versions.length - 1]
      if (previous === undefined) {
        throw new NexgentError('tool/invalid-input', `no deliverable with id ${input.deliverableId}; omit deliverableId to create a new deliverable`, { details: { deliverableId: input.deliverableId } })
      }
      deliverableId = input.deliverableId
    } else {
      previous = await this.latestWithPrimary(primary, input.sessionId)
      deliverableId = previous?.deliverableId ?? newId()
    }

    const title = input.title?.trim() || previous?.title || nodePath.posix.basename(primary)
    const dir = nodePath.join(this.layout.outputs, deliverableId)
    await mkdir(dir, { recursive: true })
    const temp = nodePath.join(dir, `${TEMP_PREFIX}${newId()}`)
    try {
      const snapshot: DeliverableFile[] = []
      for (const file of files) {
        const copy = await copyWithHash(file.absolute, nodePath.join(temp, DELIVERABLE_FILES_DIR, ...file.path.split('/')))
        snapshot.push({ path: file.path, size: copy.size, sha256: copy.sha256, mediaType: guessMediaType(file.path) })
      }
      const presentedAt = this.now().toISOString()
      for (let attempt = 1; ; attempt++) {
        const existing = await this.versionNumbers(deliverableId)
        const version = existing.length === 0 ? 1 : existing[existing.length - 1]! + 1
        const metadata: DeliverableVersion = {
          formatVersion: 1,
          deliverableId,
          version,
          title,
          summary: input.summary,
          files: snapshot,
          presentedAt,
          sessionId: input.sessionId,
          turn: input.turn,
          toolCallId: input.toolCallId,
          ...(input.member === undefined ? {} : { memberId: input.member.memberId, memberName: input.member.memberName }),
        }
        const issues = validateDeliverableVersion(metadata)
        if (issues.length > 0) throw new NexgentError('tool/invalid-input', `invalid deliverable metadata: ${formatIssues(issues)}`)
        await writeJsonFile(nodePath.join(temp, DELIVERABLE_METADATA_FILE), metadata)
        await syncDir(temp)
        try {
          await renameWithRetry(temp, nodePath.join(dir, `v${version}`))
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if ((code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') && attempt < VERSION_ATTEMPTS) continue
          throw error
        }
        await syncDir(dir)
        return metadata
      }
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      throw error
    }
  }

  async list(): Promise<readonly DeliverableSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.layout.outputs)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const summaries: DeliverableSummary[] = []
    for (const entry of entries) {
      if (!isTaskingId(entry)) continue
      const versions = await this.versions(entry)
      const latest = versions[versions.length - 1]
      if (latest === undefined) continue
      summaries.push({ deliverableId: entry, title: latest.title, versions })
    }
    const first = (summary: DeliverableSummary) => summary.versions[0]!.presentedAt
    return summaries.sort((a, b) => (first(a) === first(b) ? a.deliverableId.localeCompare(b.deliverableId) : first(a) < first(b) ? -1 : 1))
  }

  async get(deliverableId: string, version: number): Promise<DeliverableVersion | undefined> {
    if (!isTaskingId(deliverableId) || !Number.isSafeInteger(version) || version < 1) return undefined
    return this.readVersion(deliverableId, version)
  }

  async diff(deliverableId: string, from: number, to: number): Promise<DeliverableDiff> {
    const before = await this.get(deliverableId, from)
    const after = await this.get(deliverableId, to)
    for (const [version, found] of [[from, before], [to, after]] as const) {
      if (found === undefined) throw new NexgentError('workspace/not-found', `deliverable ${deliverableId} has no version ${version}`, { details: { deliverableId, version } })
    }
    const beforeFiles = new Map(before!.files.map(file => [file.path, file]))
    const afterFiles = new Map(after!.files.map(file => [file.path, file]))
    const paths = [...after!.files.map(file => file.path), ...before!.files.map(file => file.path).filter(path => !afterFiles.has(path))]
    const files: DeliverableFileDiff[] = []
    for (const path of paths) {
      const a = beforeFiles.get(path)
      const b = afterFiles.get(path)
      const change = a === undefined ? 'added' : b === undefined ? 'removed' : a.sha256 === b.sha256 ? 'unchanged' : 'modified'
      const textA = a === undefined ? '' : await this.readSnapshotText(deliverableId, from, a)
      const textB = b === undefined ? '' : await this.readSnapshotText(deliverableId, to, b)
      if (textA === undefined || textB === undefined) {
        files.push({ path, change, binary: true })
        continue
      }
      files.push(change === 'unchanged' ? { path, change, binary: false } : { path, change, binary: false, hunks: textHunks(textA, textB) })
    }
    return { deliverableId, from, to, files }
  }

  snapshotPath(deliverableId: string, version: number, path: string): string {
    if (!isTaskingId(deliverableId)) throw new NexgentError('tool/invalid-input', `not a deliverable id: ${deliverableId}`)
    if (!Number.isSafeInteger(version) || version < 1) throw new NexgentError('tool/invalid-input', `not a version number: ${version}`)
    assertSafePortablePath(path)
    return nodePath.join(this.layout.outputs, deliverableId, `v${version}`, DELIVERABLE_FILES_DIR, ...path.split('/'))
  }

  /** Every valid version of one deliverable, ascending. */
  async versions(deliverableId: string): Promise<DeliverableVersion[]> {
    const found: DeliverableVersion[] = []
    for (const version of await this.versionNumbers(deliverableId)) {
      const metadata = await this.readVersion(deliverableId, version)
      if (metadata !== undefined) found.push(metadata)
    }
    return found
  }

  private async versionNumbers(deliverableId: string): Promise<number[]> {
    let entries: string[]
    try {
      entries = await readdir(nodePath.join(this.layout.outputs, deliverableId))
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return entries
      .map(entry => VERSION_DIR.exec(entry)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
  }

  private async readVersion(deliverableId: string, version: number): Promise<DeliverableVersion | undefined> {
    let raw: string
    try {
      raw = await readFile(nodePath.join(this.layout.outputs, deliverableId, `v${version}`, DELIVERABLE_METADATA_FILE), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (validateDeliverableVersion(parsed).length > 0) return undefined
    const metadata = parsed as DeliverableVersion
    return metadata.deliverableId === deliverableId && metadata.version === version ? metadata : undefined
  }

  /**
   * The most recently presented deliverable whose latest version has
   * `primary` as its first file and was presented by `sessionId` (step 3: two
   * sessions, e.g. two members, presenting one path never append to each other).
   */
  private async latestWithPrimary(primary: string, sessionId: string): Promise<DeliverableVersion | undefined> {
    let best: DeliverableVersion | undefined
    for (const summary of await this.list()) {
      const latest = summary.versions[summary.versions.length - 1]!
      if (latest.files[0]?.path !== primary || latest.sessionId !== sessionId) continue
      if (best === undefined || latest.presentedAt >= best.presentedAt) best = latest
    }
    return best
  }

  /** Snapshot text, or `undefined` when the file is binary or too large to diff by line. */
  private async readSnapshotText(deliverableId: string, version: number, file: DeliverableFile): Promise<string | undefined> {
    if (isKnownBinaryType(file.mediaType) || file.size > DIFF_TEXT_LIMIT) return undefined
    const path = this.snapshotPath(deliverableId, version, file.path)
    try {
      if ((await stat(path)).size > DIFF_TEXT_LIMIT) return undefined
      const bytes = await readFile(path)
      if (bytes.includes(0)) return undefined
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      if (isNotFound(error)) throw new NexgentError('workspace/not-found', `snapshot file missing: ${path}`, { details: { path } })
      return undefined
    }
  }

  private async root(): Promise<string> {
    this.realRoot ??= await realpathNative(this.layout.root)
    return this.realRoot
  }
}
