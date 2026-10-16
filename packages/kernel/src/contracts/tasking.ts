/**
 * The tasking contract (step 2): materials the user supplies, deliverables
 * the agent presents, feedback on deliverable versions, the session's
 * persistent goal, and the per-turn file-change record.
 *
 * `@nexgent/tasking` implements the stores; the SDK and the `present` tool
 * call them. Normative text: `docs/spec/data-formats.md` §材料元数据,
 * §成果元数据, §反馈, §持久目标; who may write which directory is in
 * `docs/spec/permissions.md` §路径策略与写入限制.
 *
 * Paths in these shapes are project-relative with `/` separators on every
 * platform (`report/summary.csv`, `.nexgent/materials/<id>/orders.csv`), so
 * files and records written on Windows and Linux compare equal.
 */
import type { SessionRecord, HostRecordInput } from './session.js'
import type { ToolEffect } from './tools.js'

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Name of the metadata file inside `materials/<id>/`. */
export const MATERIAL_METADATA_FILE = 'material.json'

/** Whether a material is in use; removal never deletes the copied file. */
export type MaterialStatus = 'active' | 'removed'

/** `.nexgent/materials/<id>/material.json`. */
export interface MaterialMetadata {
  /** Format version; only 1 exists. */
  readonly formatVersion: 1
  /** Lowercase UUID v4; also the directory name. */
  readonly id: string
  /** File name as the user picked it (base name only, unsanitized, for display). */
  readonly originalName: string
  /** Stored copy, project-relative: `.nexgent/materials/<id>/<storedName>`. */
  readonly path: string
  /** Size in bytes of the stored copy. */
  readonly size: number
  /** Lowercase hex SHA-256 of the stored copy (equal to the source at copy time). */
  readonly sha256: string
  /** IANA media type guessed from the extension; `application/octet-stream` when unknown. */
  readonly mediaType: string
  /** Whether the content is treated as text (UTF-8 decodable and not a known binary type). */
  readonly text: boolean
  /** ISO-8601 instant the copy finished. */
  readonly addedAt: string
  /** Session it was added from; absent when added outside any session. */
  readonly sessionId?: string
  readonly status: MaterialStatus
  /** ISO-8601 instant of removal, when `status` is `removed`. */
  readonly removedAt?: string
}

/** The part of a material a session record carries. */
export interface MaterialRef {
  readonly id: string
  readonly originalName: string
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly mediaType: string
}

/** What `MaterialStore.add` takes. */
export interface AddMaterialInput {
  /** Absolute path of the source file; it is copied, never moved or modified. */
  readonly sourcePath: string
  /** Session to attribute the material to. */
  readonly sessionId?: string
}

/** Materials of one project (`ctx.tasking.materials`). */
export interface MaterialStore {
  /**
   * Copy a file into `materials/<id>/` and write its metadata (atomically:
   * a half-copied material is never listed).
   * @throws `workspace/not-found` when the source does not exist or is a directory.
   */
  add(input: AddMaterialInput): Promise<MaterialMetadata>
  /** Every material, oldest first; removed ones only when asked. */
  list(options?: { readonly includeRemoved?: boolean }): Promise<readonly MaterialMetadata[]>
  /** One material, or `undefined`. */
  get(id: string): Promise<MaterialMetadata | undefined>
  /** Mark removed (metadata only; the file stays until the user deletes it in the UI). */
  remove(id: string): Promise<MaterialMetadata>
}

/** Project a metadata file to the reference a session record keeps. Pure. */
export function toMaterialRef(material: MaterialMetadata): MaterialRef {
  return {
    id: material.id,
    originalName: material.originalName,
    path: material.path,
    size: material.size,
    sha256: material.sha256,
    mediaType: material.mediaType,
  }
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

/** Name of the metadata file inside `outputs/<deliverableId>/v<n>/`. */
export const DELIVERABLE_METADATA_FILE = 'deliverable.json'

/** Subdirectory of a version directory that holds the snapshot copies. */
export const DELIVERABLE_FILES_DIR = 'files'

/** One file of a deliverable version. */
export interface DeliverableFile {
  /** Project-relative path of the presented file (where it lives in the workspace). */
  readonly path: string
  readonly size: number
  /** Lowercase hex SHA-256 of the snapshot copy. */
  readonly sha256: string
  readonly mediaType: string
}

/**
 * `.nexgent/outputs/<deliverableId>/v<version>/deliverable.json`. Written
 * once when the version is created and never changed; the snapshot copies
 * live next to it under `files/<path>`.
 */
export interface DeliverableVersion {
  /** Format version; only 1 exists. */
  readonly formatVersion: 1
  /** Lowercase UUID v4; stable across versions. */
  readonly deliverableId: string
  /** 1-based, +1 per `present` of the same deliverable. */
  readonly version: number
  /** Short display name; defaults to the base name of the first path. */
  readonly title: string
  /** The one-line description the model gave to `present`. */
  readonly summary: string
  /** In the order presented; the first is the primary file. */
  readonly files: readonly DeliverableFile[]
  /** ISO-8601 instant the snapshot finished. */
  readonly presentedAt: string
  readonly sessionId: string
  readonly turn: number
  /** The `present` call. */
  readonly toolCallId: string
  /** Step 3: set when a member (child session) presented it; the child's session id. */
  readonly memberId?: string
  /** Step 3: the member's name, for display ("成员成果"). */
  readonly memberName?: string
}

/** The part of a version a `deliverable.presented` record carries. */
export interface DeliverableVersionRef {
  readonly deliverableId: string
  readonly version: number
  readonly title: string
  readonly summary: string
  readonly files: readonly DeliverableFile[]
  /** Step 3: as on {@link DeliverableVersion}. */
  readonly memberName?: string
}

/** What the `present` tool hands to the store. */
export interface PresentInput {
  readonly sessionId: string
  readonly turn: number
  readonly toolCallId: string
  /** Workspace paths as the model gave them (relative or absolute); validated by the store. */
  readonly paths: readonly string[]
  readonly summary: string
  readonly title?: string
  /**
   * The deliverable to add a version to. When absent, a deliverable whose
   * latest version has the same primary (first) path **and was presented by
   * the same session** gets the new version; otherwise a new deliverable is
   * created (step 3: two members presenting one path never append to each
   * other). An explicit id always appends, across sessions too.
   */
  readonly deliverableId?: string
  /** Step 3: the presenting member, copied into the version metadata. */
  readonly member?: { readonly memberId: string; readonly memberName: string }
}

/** One deliverable with its versions, for listing. */
export interface DeliverableSummary {
  readonly deliverableId: string
  readonly title: string
  /** Every version, ascending. */
  readonly versions: readonly DeliverableVersion[]
}

/** How a file differs between two versions. */
export type DeliverableFileChange = 'added' | 'removed' | 'modified' | 'unchanged'

/** One line of a text diff. */
export interface DiffLine {
  readonly op: 'context' | 'add' | 'remove'
  readonly text: string
}

/** A hunk of a line diff (1-based start lines, unified-diff style). */
export interface DiffHunk {
  readonly fromStart: number
  readonly fromLines: number
  readonly toStart: number
  readonly toLines: number
  readonly lines: readonly DiffLine[]
}

/** One file's difference. */
export interface DeliverableFileDiff {
  readonly path: string
  readonly change: DeliverableFileChange
  /** Binary files report only `change`, never hunks. */
  readonly binary: boolean
  readonly hunks?: readonly DiffHunk[]
}

/** The difference between two versions of one deliverable. */
export interface DeliverableDiff {
  readonly deliverableId: string
  readonly from: number
  readonly to: number
  readonly files: readonly DeliverableFileDiff[]
}

/** Deliverables of one project (`ctx.tasking.deliverables`). */
export interface DeliverableStore {
  /**
   * Snapshot the files into a new version directory and write its metadata.
   * Rejects with `workspace/not-found` (missing file), `workspace/outside-root`
   * (outside the project) or `sandbox/denied` (inside `.nexgent/`), with a
   * message the model can act on; nothing is written then.
   */
  present(input: PresentInput): Promise<DeliverableVersion>
  /** Every deliverable, oldest first. */
  list(): Promise<readonly DeliverableSummary[]>
  /** One version, or `undefined`. */
  get(deliverableId: string, version: number): Promise<DeliverableVersion | undefined>
  /** Line diff for text files, change-only for binary files. */
  diff(deliverableId: string, from: number, to: number): Promise<DeliverableDiff>
  /** Absolute path of a snapshot copy, for reveal / open in the host. */
  snapshotPath(deliverableId: string, version: number, path: string): string
}

/** Project a version to the reference a session record keeps. Pure. */
export function toDeliverableVersionRef(version: DeliverableVersion): DeliverableVersionRef {
  return {
    deliverableId: version.deliverableId,
    version: version.version,
    title: version.title,
    summary: version.summary,
    files: version.files,
  }
}

// ---------------------------------------------------------------------------
// Per-turn file changes
// ---------------------------------------------------------------------------

/** One changed path of a turn. */
export interface FileChange {
  /** Project-relative, `/`-separated. */
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
}

/** What the tracker sees after each tool call. */
export interface ToolCallObservation {
  readonly sessionId: string
  readonly turn: number
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  /** The tool's `meta` (file tools report the paths they touched). */
  readonly meta?: unknown
  /** The tool's declared effects; `execute` (a shell or code runner) makes the tracker look for changes it did not report (K1). */
  readonly effects?: readonly ToolEffect[]
}

/**
 * Collects the files a turn changed (`ctx.tasking.files`). The loop calls
 * `beginTurn` after `turn.start`, `observe` after each tool call and
 * `endTurn` right before `turn.end`; the returned list goes into a
 * `turn.files` record. Changes made by `bash` / `pwsh` are found by the
 * before/after comparison, not only from tool `meta`.
 */
export interface TurnFileTracker {
  beginTurn(sessionId: string, turn: number): Promise<void>
  observe(observation: ToolCallObservation): void
  /** Sorted by path. `signal` bounds the final scan (it may stop early and report what it has). */
  endTurn(sessionId: string, turn: number, signal?: AbortSignal): Promise<readonly FileChange[]>
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/** A rating on a 1–5 scale. */
export type FeedbackRating = 1 | 2 | 3 | 4 | 5

/** One feedback entry; kept only in the session (`feedback` record). */
export interface FeedbackEntry {
  /** Lowercase UUID v4. */
  readonly id: string
  readonly deliverableId: string
  /** The version the feedback is about. */
  readonly version: number
  readonly rating?: FeedbackRating
  /** The user's words; also the text of the feedback turn's user message. */
  readonly comment: string
}

/** What the SDK takes to submit feedback. */
export interface SubmitFeedbackInput {
  readonly deliverableId: string
  readonly version: number
  readonly rating?: FeedbackRating
  readonly comment: string
}

/** A feedback entry with where it was recorded. */
export interface FeedbackListing extends FeedbackEntry {
  readonly sessionId: string
  readonly turn: number
  /** The record's `ts`. */
  readonly submittedAt: string
}

/** Read access to feedback across the project's sessions (`ctx.tasking.feedback`). */
export interface FeedbackStore {
  /** Feedback in record order, optionally narrowed. */
  list(filter?: { readonly sessionId?: string; readonly deliverableId?: string }): Promise<readonly FeedbackListing[]>
}

/** Turn a feedback entry into the user message of the turn it opens. Pure; the text is part of the contract. */
export function renderFeedbackPrompt(entry: FeedbackEntry): string {
  const rating = entry.rating === undefined ? '' : ` Rating: ${entry.rating}/5.`
  return `Feedback on deliverable ${entry.deliverableId} version ${entry.version}.${rating}\n\n${entry.comment}`
}

// ---------------------------------------------------------------------------
// Persistent goal
// ---------------------------------------------------------------------------

/** Lifecycle of a goal. */
export type GoalStatus = 'active' | 'completed' | 'abandoned'

/** The session's persistent goal, as projected into `SessionMetadata.goal`. */
export interface Goal {
  /** Lowercase UUID v4. */
  readonly id: string
  readonly text: string
  readonly status: GoalStatus
  /** ISO-8601 instant of the `goal.set`. */
  readonly setAt: string
  /** ISO-8601 instant of the latest change; equals `setAt` until updated. */
  readonly updatedAt: string
  /** Latest note from a `goal.update`. */
  readonly note?: string
}

/** Appends host records through the agent that holds the session lock. */
export type HostRecordSink = (record: HostRecordInput) => Promise<SessionRecord>

/** Goal operations (`ctx.tasking.goals`); state comes from the session projection. */
export interface GoalStore {
  /** The session's current goal (read-only resume; no lock needed). */
  get(sessionId: string): Promise<Goal | undefined>
  /** Write `goal.set` with a new id; replaces the current goal. */
  set(sink: HostRecordSink, text: string): Promise<Goal>
  /** Write `goal.update`. @throws `session/invalid-record` when the session has no goal or `goalId` differs. */
  update(sink: HostRecordSink, sessionId: string, change: { readonly status: GoalStatus; readonly text?: string; readonly note?: string }): Promise<Goal>
}

/** The `ctx.tasking` service: the four stores and the file tracker of one project. */
export interface TaskingService {
  readonly materials: MaterialStore
  readonly deliverables: DeliverableStore
  readonly feedback: FeedbackStore
  readonly goals: GoalStore
  readonly files: TurnFileTracker
}

/** Project-relative path with `/` separators (the form every tasking record uses). Pure. */
export function toPortablePath(relative: string): string {
  return relative.split('\\').join('/')
}
