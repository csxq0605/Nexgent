/**
 * K1 (ADR 0017 decision 4): find where a project's data lives. Sessions,
 * ledgers, snapshots, material copies, deliverables, capability and
 * improvement records live in `<NEXGENT_HOME>/projects/<projectId>/`; a
 * project whose old `.nexgent/` data has not been migrated yet keeps using
 * it (`resolveDataLocation`). Synchronous and read-only, so every entry
 * point (SDK, CLI, improvement and trial processes) resolves the same
 * layout without a running workspace service; the workspace service writes
 * the identity file and migrates (`@nexgent/workspace` `prepareProjectData`).
 *
 * Normative text: `docs/spec/data-formats.md` §用户数据目录, §迁移.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import * as nodePath from 'node:path'
import {
  isProjectId,
  LOCAL_DATA_MARKER_FILE,
  PROJECT_DATA_SUBDIRS,
  PROJECT_IDENTITY_FILE,
  resolveDataLocation,
  resolveProjectDataLayout,
  type DataLocation,
  type MigrationRecord,
  type ProjectIdentity,
} from './contracts/data-layout.js'
import { NEXGENT_DIR, PROJECT_CONFIG_FILE, resolveWorkspaceLayout, type WorkspaceLayout } from './contracts/workspace.js'
import { nexgentHome } from './credentials.js'

/** `project.json` inside a project data directory (`ProjectDataIndex`). */
const PROJECT_DATA_INDEX_FILE = 'project.json'

/** Options of {@link locateProjectData}. */
export interface ProjectDataOptions {
  /** Nexgent home; default `$NEXGENT_HOME` or `~/.nexgent`. */
  readonly home?: string
  /** Environment for the default home; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Platform of the id derivation; default `process.platform`. */
  readonly platform?: NodeJS.Platform
}

/** Where one project's data is. */
export interface ProjectDataPlace {
  /** Absolute Nexgent home. */
  readonly home: string
  /** Absolute real project root. */
  readonly root: string
  /** From `.nexgent/project.json`, else derived from the root ({@link defaultProjectId}). */
  readonly projectId: string
  /** The identity file, when the project has one. */
  readonly identity?: ProjectIdentity
  /** Whether `.nexgent/` holds data that belongs in the user data directory. */
  readonly hasOldData: boolean
  /** The migration record, when one was written. */
  readonly migration?: MigrationRecord
  readonly location: DataLocation
  /** Set when `.nexgent/local-data` keeps the data in the project (a scratch copy). */
  readonly localData?: true
  /** Absolute directory that holds the data subdirectories. */
  readonly dataDir: string
}

/**
 * ADR 0012 / ADR 0017 decision 4: the id a project gets when its identity
 * file is first written: the lowercase hex SHA-256 of the root's realpath,
 * `\` turned into `/`, lowercased on Windows (the same as `userProjectId`).
 */
export function defaultProjectId(root: string, platform: NodeJS.Platform = process.platform): string {
  let path = realRoot(root).replace(/\\/g, '/')
  if (platform === 'win32') path = path.toLowerCase()
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/** `<root>/.nexgent/project.json`, when present and valid. */
export function readProjectIdentitySync(root: string): ProjectIdentity | undefined {
  const value = readJsonSync(nodePath.join(root, NEXGENT_DIR, PROJECT_IDENTITY_FILE))
  if (!isRecord(value) || value.formatVersion !== 1 || !isProjectId(value.projectId) || typeof value.createdAt !== 'string') return undefined
  return value as unknown as ProjectIdentity
}

/**
 * Whether `<root>/.nexgent/` holds old data (data-formats.md §迁移): one of
 * {@link PROJECT_DATA_SUBDIRS} is not empty, or `config.json` has
 * `approvals`. Empty directories (an old `ensureLayout` made them all) do not
 * count.
 */
export function hasOldProjectData(root: string): boolean {
  const dir = nodePath.join(root, NEXGENT_DIR)
  for (const sub of PROJECT_DATA_SUBDIRS) {
    try {
      if (readdirSync(nodePath.join(dir, sub)).length > 0) return true
    } catch {
      // missing: nothing to move
    }
  }
  const config = readJsonSync(nodePath.join(dir, PROJECT_CONFIG_FILE))
  return isRecord(config) && Array.isArray(config.approvals) && config.approvals.length > 0
}

/** Locate a project's data (see the module comment). Read-only. */
export function locateProjectData(root: string, options: ProjectDataOptions = {}): ProjectDataPlace {
  const home = nodePath.resolve(options.home ?? nexgentHome(options.env ?? process.env))
  const real = realRoot(root)
  const identity = readProjectIdentitySync(real)
  const projectId = identity?.projectId ?? defaultProjectId(real, options.platform)
  const layout = resolveProjectDataLayout(home, projectId)
  const migration = readMigration(layout.migrationFile)
  const hasOldData = hasOldProjectData(real)
  const localData = existsSync(nodePath.join(real, NEXGENT_DIR, LOCAL_DATA_MARKER_FILE))
  const location = localData ? 'project' : resolveDataLocation(hasOldData, migration)
  return {
    home,
    root: real,
    projectId,
    ...(identity === undefined ? {} : { identity }),
    hasOldData,
    ...(migration === undefined ? {} : { migration }),
    location,
    ...(localData ? { localData: true as const } : {}),
    dataDir: location === 'user-data' ? layout.dataDir : nodePath.join(real, NEXGENT_DIR),
  }
}

/** The {@link WorkspaceLayout} of a project at its current data location. */
export function resolveProjectLayout(root: string, options: ProjectDataOptions = {}): WorkspaceLayout {
  return layoutOf(locateProjectData(root, options))
}

/** The {@link WorkspaceLayout} of a located project. */
export function layoutOf(place: ProjectDataPlace): WorkspaceLayout {
  return place.location === 'user-data'
    ? resolveWorkspaceLayout(place.root, nodePath, { dataDir: place.dataDir, projectId: place.projectId })
    : { ...resolveWorkspaceLayout(place.root), location: 'project', projectId: place.projectId }
}

/**
 * The layout whose data directory is `dataDir`: `<root>/.nexgent` (data in
 * the project), or `<home>/projects/<projectId>` whose `project.json` index
 * names the root. `undefined` when neither applies.
 */
export function layoutOfDataDir(dataDir: string): WorkspaceLayout | undefined {
  const dir = nodePath.resolve(dataDir)
  if (nodePath.basename(dir) === NEXGENT_DIR) {
    const root = nodePath.dirname(dir)
    return { ...resolveWorkspaceLayout(root), location: 'project' }
  }
  const index = readJsonSync(nodePath.join(dir, PROJECT_DATA_INDEX_FILE))
  if (!isRecord(index) || typeof index.root !== 'string' || !isProjectId(index.projectId)) return undefined
  const home = nodePath.dirname(nodePath.dirname(dir))
  const layout = resolveWorkspaceLayout(index.root, nodePath, { dataDir: dir, projectId: index.projectId })
  return resolveProjectDataLayout(home, index.projectId).dataDir === dir ? layout : undefined
}

/**
 * Turn a recorded data path into an absolute one under the current layout.
 * Records written before K1 name host data project-relative
 * (`.nexgent/materials/<id>/<file>`); after the migration that data lives
 * under `layout.dataDir`. Other relative paths resolve against the root;
 * absolute paths are kept.
 */
export function resolveDataPath(layout: Pick<WorkspaceLayout, 'root' | 'dataDir'>, recorded: string): string {
  if (nodePath.isAbsolute(recorded)) return nodePath.normalize(recorded)
  const parts = recorded.split(/[\\/]+/)
  if (parts[0] === NEXGENT_DIR && (PROJECT_DATA_SUBDIRS as readonly string[]).includes(parts[1] ?? '')) {
    return nodePath.join(layout.dataDir, ...parts.slice(1))
  }
  return nodePath.resolve(layout.root, recorded)
}

function realRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return nodePath.resolve(root)
  }
}

function readMigration(path: string): MigrationRecord | undefined {
  const value = readJsonSync(path)
  return isRecord(value) && value.formatVersion === 1 && typeof value.status === 'string' ? value as unknown as MigrationRecord : undefined
}

function readJsonSync(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
