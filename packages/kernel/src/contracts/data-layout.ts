/**
 * ADR 0017 decision 4: where Nexgent keeps its data. Sessions, ledgers,
 * snapshots, material copies, deliverable snapshots, capability and
 * improvement records and the "always allow in this project" grants live in
 * the user data directory `<NEXGENT_HOME>/projects/<projectId>/`; the
 * project's own `.nexgent/` keeps only what colleagues may share
 * (`project.json`, the grant-free `config.json`, project skills, presets and
 * saved workflow graphs). ADR 0018 adds the user-level learning directories
 * (handbook, practice set; skills are refined by C2).
 *
 * Pure: shapes and path arithmetic only. The workspace service moves the
 * data (K1); a project whose migration is not done keeps reading its old
 * `.nexgent/` (see {@link resolveDataLocation}).
 *
 * Normative text: `docs/spec/data-formats.md` §目录布局, §用户数据目录,
 * §迁移.
 */
import * as nodePath from 'node:path'
import type { ApprovalGrant } from './approvals.js'
import type { ErrorInfo } from './errors.js'
import { USER_PROJECT_ID_PATTERN } from './improvement.js'
import type { PathApi } from './workspace.js'

// ---------------------------------------------------------------------------
// Project identity (.nexgent/project.json)
// ---------------------------------------------------------------------------

/** `project.json` inside the project's `.nexgent/`. */
export const PROJECT_IDENTITY_FILE = 'project.json'

/**
 * `.nexgent/project.json`: the project's stable id, shared with colleagues
 * (it holds no paths, grants or secrets). Written once, when Nexgent first
 * opens the project; never rewritten except `name`.
 */
export interface ProjectIdentity {
  readonly formatVersion: 1
  /**
   * {@link USER_PROJECT_ID_PATTERN}: at creation the SHA-256 of the root's
   * realpath, as ADR 0012 derives it, so user-level records written before
   * the file existed still match; fixed from then on, so moving or renaming
   * the folder keeps the id (and its data).
   */
  readonly projectId: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  /** Display name; default the folder name. At most 200 characters. */
  readonly name?: string
}

/** Whether `value` is a valid {@link ProjectIdentity.projectId}. */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && USER_PROJECT_ID_PATTERN.test(value)
}

// ---------------------------------------------------------------------------
// What stays in the project
// ---------------------------------------------------------------------------

/**
 * Entries of the project's `.nexgent/` that may be committed and shared.
 * Everything else under `.nexgent/` is old data awaiting migration.
 */
export const SHARED_PROJECT_ENTRIES = ['project.json', 'config.json', 'skills', 'presets', 'architectures'] as const

/** The `.gitignore` Nexgent writes into `.nexgent/`. */
export const PROJECT_GITIGNORE_FILE = '.gitignore'

/**
 * The text of `.nexgent/.gitignore` (ADR 0017 decision 4): ignore everything
 * except the shared entries. Written while old data still sits in the
 * project (before migration, or when the user keeps it); harmless after.
 */
export function projectGitignoreText(): string {
  const lines = ['# Written by Nexgent: only shareable project files are tracked.', '# Conversations, ledgers and snapshots live in <NEXGENT_HOME>/projects/<projectId>/.', '*', `!${PROJECT_GITIGNORE_FILE}`]
  for (const entry of SHARED_PROJECT_ENTRIES) {
    if (entry.endsWith('.json')) lines.push(`!${entry}`)
    else lines.push(`!${entry}/`, `!${entry}/**`)
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// User data directory
// ---------------------------------------------------------------------------

/** `<NEXGENT_HOME>/projects/`: one directory per project id. */
export const USER_PROJECTS_DIR = 'projects'

/** `<NEXGENT_HOME>/handbook/` (ADR 0018 decision 4): the user-level handbook. */
export const USER_HANDBOOK_DIR = 'handbook'

/** `<NEXGENT_HOME>/practice/` (ADR 0018 decision 3): the practice set. */
export const USER_PRACTICE_DIR = 'practice'

/** Every path of the Nexgent home a host writes, resolved once. */
export interface UserDataLayout {
  /** Absolute Nexgent home (`NEXGENT_HOME`, default `~/.nexgent`). */
  readonly home: string
  /** `config.json` (ADR 0012): user settings. */
  readonly configFile: string
  /** `credentials.json`. */
  readonly credentialsFile: string
  /** `recent-projects.json`. */
  readonly recentProjectsFile: string
  /** `projects/`. */
  readonly projects: string
  /** `improvers/` (ADR 0012). */
  readonly improvers: string
  /** `improvements/` (ADR 0012 user meta queue; retired by ADR 0018, kept readable). */
  readonly improvements: string
  /** `skills/` (user skills; C2 refines the library layout). */
  readonly skills: string
  /** `handbook/`: `ops.jsonl` and its lock. */
  readonly handbook: string
  /** `practice/`: `cases/<caseId>.json`. */
  readonly practice: string
}

/**
 * Compute the {@link UserDataLayout} of a Nexgent home. Pure; `home` must be
 * absolute.
 * @throws `TypeError` when `home` is relative.
 */
export function resolveUserDataLayout(home: string, api: PathApi = nodePath): UserDataLayout {
  if (!api.isAbsolute(home)) throw new TypeError(`Nexgent home must be absolute: ${home}`)
  const root = api.resolve(home)
  return {
    home: root,
    configFile: api.join(root, 'config.json'),
    credentialsFile: api.join(root, 'credentials.json'),
    recentProjectsFile: api.join(root, 'recent-projects.json'),
    projects: api.join(root, USER_PROJECTS_DIR),
    improvers: api.join(root, 'improvers'),
    improvements: api.join(root, 'improvements'),
    skills: api.join(root, 'skills'),
    handbook: api.join(root, USER_HANDBOOK_DIR),
    practice: api.join(root, USER_PRACTICE_DIR),
  }
}

/** Subdirectories of a project data directory that hold data moved out of `.nexgent/` (and copied by migration). */
export const PROJECT_DATA_SUBDIRS = ['sessions', 'ledgers', 'snapshots', 'materials', 'outputs', 'capabilities', 'improvements', 'improvers'] as const

/** One of {@link PROJECT_DATA_SUBDIRS}. */
export type ProjectDataSubdir = (typeof PROJECT_DATA_SUBDIRS)[number]

/** Every path of one project's data directory, resolved once. */
export interface ProjectDataLayout {
  readonly projectId: string
  /** `<home>/projects/<projectId>`. */
  readonly dataDir: string
  readonly sessions: string
  readonly ledgers: string
  readonly snapshots: string
  readonly materials: string
  readonly outputs: string
  readonly capabilities: string
  readonly improvements: string
  /** Step 6 project-level improver history (read-only since ADR 0012), copied by migration. */
  readonly improvers: string
  /** `handbook/`: project-level handbook entries (`ops.jsonl`). */
  readonly handbook: string
  /** `evaluations/<taskId>.json`: self-evaluations (ADR 0018 decision 2). */
  readonly evaluations: string
  /** `grants.json`: "always allow in this project" grants ({@link ProjectGrantsFile}). */
  readonly grantsFile: string
  /** `migration.json`: {@link MigrationRecord}, when the project was migrated. */
  readonly migrationFile: string
  /** `project.json`: the last known root and identity ({@link ProjectDataIndex}). */
  readonly indexFile: string
}

/**
 * Compute the {@link ProjectDataLayout} of a project. Pure.
 * @throws `TypeError` when `home` is relative or `projectId` is not 64 hex.
 */
export function resolveProjectDataLayout(home: string, projectId: string, api: PathApi = nodePath): ProjectDataLayout {
  if (!isProjectId(projectId)) throw new TypeError(`not a project id: ${projectId}`)
  const dataDir = api.join(resolveUserDataLayout(home, api).projects, projectId)
  const sub = (name: string) => api.join(dataDir, name)
  return {
    projectId,
    dataDir,
    sessions: sub('sessions'),
    ledgers: sub('ledgers'),
    snapshots: sub('snapshots'),
    materials: sub('materials'),
    outputs: sub('outputs'),
    capabilities: sub('capabilities'),
    improvements: sub('improvements'),
    improvers: sub('improvers'),
    handbook: sub('handbook'),
    evaluations: sub('evaluations'),
    grantsFile: sub('grants.json'),
    migrationFile: sub('migration.json'),
    indexFile: sub('project.json'),
  }
}

/**
 * `<home>/projects/<projectId>/project.json`: where the project was last
 * opened, so the user data directory can be listed and cleaned up without
 * the project. Rewritten on every open.
 */
export interface ProjectDataIndex {
  readonly formatVersion: 1
  readonly projectId: string
  /** Absolute root when last opened. */
  readonly root: string
  /** ISO-8601 UTC. */
  readonly lastOpenedAt: string
}

/**
 * `<home>/projects/<projectId>/grants.json`: the `project`-scope approval
 * grants (ADR 0017 decision 4; before, `config.json.approvals`). Never in
 * the project, so cloning a project never brings someone else's grants.
 */
export interface ProjectGrantsFile {
  readonly formatVersion: 1
  readonly approvals: readonly ApprovalGrant[]
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** Left in the old `.nexgent/` once its data was copied and verified. */
export const MIGRATION_NOTICE_FILE = 'MOVED.txt'

/** Where a migration stands. */
export type MigrationStatus = 'copying' | 'done' | 'failed'

/** Every {@link MigrationStatus}. */
export const MIGRATION_STATUSES: readonly MigrationStatus[] = ['copying', 'done', 'failed']

/** One moved subdirectory. */
export interface MigrationEntry {
  readonly name: ProjectDataSubdir
  /** Files copied. */
  readonly files: number
  readonly bytes: number
}

/**
 * `<home>/projects/<projectId>/migration.json` (ADR 0017 decision 4): the
 * one-time copy of an old project's `.nexgent/` data. The old data is never
 * deleted by the migration (deleting it needs the user's consent), so
 * `oldDataKept` is always `true` when written; a later user-approved
 * cleanup sets `oldDataRemovedAt`.
 */
export interface MigrationRecord {
  readonly formatVersion: 1
  readonly projectId: string
  /** Absolute old `.nexgent/` directory. */
  readonly from: string
  readonly status: MigrationStatus
  readonly startedAt: string
  /** When the copy was verified (`done`) or gave up (`failed`). */
  readonly finishedAt?: string
  readonly entries: readonly MigrationEntry[]
  /** `config.json.approvals` entries moved to `grants.json`. */
  readonly grantsMoved: number
  readonly oldDataKept: true
  /** ISO-8601 UTC when the user approved deleting the old data and it was removed. */
  readonly oldDataRemovedAt?: string
  readonly error?: ErrorInfo
}

/** Where a project's data is read from and written to. */
export type DataLocation = 'user-data' | 'project'

/**
 * ADR 0017 decision 4 (pure): a project with old data under `.nexgent/`
 * keeps using it until a migration is `done`; a failed or interrupted
 * migration never strands the user. A project without old data uses the
 * user data directory from the start.
 */
export function resolveDataLocation(hasOldData: boolean, migration?: Pick<MigrationRecord, 'status'>): DataLocation {
  if (migration?.status === 'done') return 'user-data'
  return hasOldData ? 'project' : 'user-data'
}
