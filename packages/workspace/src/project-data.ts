/**
 * K1 (ADR 0017 decision 4): open a project's data. Writes the project's
 * identity file on first open, keeps the user data directory's index of
 * where the project was last opened, gives a copied `.nexgent/` its own id,
 * and migrates old in-project data once (`data-formats.md` §迁移): copy,
 * verify every file by size and hash, then switch. The old data is never
 * deleted here; a failed or interrupted migration leaves the project on its
 * old `.nexgent/` and is retried on the next open.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  defaultProjectId,
  layoutOf,
  locateProjectData,
  MIGRATION_NOTICE_FILE,
  NEXGENT_DIR,
  PROJECT_CONFIG_FILE,
  PROJECT_DATA_SUBDIRS,
  PROJECT_GITIGNORE_FILE,
  PROJECT_IDENTITY_FILE,
  projectGitignoreText,
  readJsonFile,
  resolveProjectDataLayout,
  toErrorInfo,
  writeJsonFile,
  type ApprovalGrant,
  type MigrationEntry,
  type MigrationRecord,
  type ProjectDataIndex,
  type ProjectDataOptions,
  type ProjectDataPlace,
  type ProjectIdentity,
  type WorkspaceLayout,
} from '@nexgent/kernel'

/** What {@link prepareProjectData} did. */
export interface PreparedProjectData {
  readonly place: ProjectDataPlace
  readonly layout: WorkspaceLayout
  /** Set when this open migrated (or tried to migrate) old data. */
  readonly migration?: MigrationRecord
}

/** Options of {@link prepareProjectData}. */
export interface PrepareProjectDataOptions extends ProjectDataOptions {
  /** Clock for records (tests). */
  readonly now?: () => Date
}

/**
 * Prepare a project's data for this process (see the module comment) and
 * return the layout to use. Never throws for a failed migration: the
 * project then keeps its old `.nexgent/` and the record says why.
 */
export async function prepareProjectData(root: string, options: PrepareProjectDataOptions = {}): Promise<PreparedProjectData> {
  const now = options.now ?? (() => new Date())
  let place = locateProjectData(root, options)
  place = await ensureIdentity(place, options, now)
  let migration: MigrationRecord | undefined
  if (place.location === 'project' && place.hasOldData) {
    migration = await migrateProjectData(place, now)
    place = locateProjectData(root, options)
  }
  if (place.location === 'user-data') {
    const index: ProjectDataIndex = { formatVersion: 1, projectId: place.projectId, root: place.root, lastOpenedAt: now().toISOString() }
    await writeJsonFile(resolveProjectDataLayout(place.home, place.projectId).indexFile, index)
  }
  return { place, layout: layoutOf(place), ...(migration === undefined ? {} : { migration }) }
}

/**
 * Write `.nexgent/project.json` when missing (and `.nexgent/.gitignore`),
 * and give a copied `.nexgent/` a new id when the user data directory says
 * the same id belongs to another existing project (data-formats.md
 * §用户数据目录).
 */
async function ensureIdentity(place: ProjectDataPlace, options: ProjectDataOptions, now: () => Date): Promise<ProjectDataPlace> {
  const dir = nodePath.join(place.root, NEXGENT_DIR)
  let identity = place.identity
  if (identity !== undefined) {
    const index = await readJsonFile(resolveProjectDataLayout(place.home, identity.projectId).indexFile) as ProjectDataIndex | undefined
    const other = index?.root
    if (typeof other === 'string' && other !== place.root && await sameIdentity(other, identity.projectId)) {
      identity = { ...identity, projectId: defaultProjectId(place.root, options.platform) }
      await writeJsonFile(nodePath.join(dir, PROJECT_IDENTITY_FILE), identity, { mode: 0o644 })
      return locateProjectData(place.root, options)
    }
    return place
  }
  identity = { formatVersion: 1, projectId: place.projectId, createdAt: now().toISOString(), name: nodePath.basename(place.root).slice(0, 200) || 'project' } satisfies ProjectIdentity
  await mkdir(dir, { recursive: true })
  await writeJsonFile(nodePath.join(dir, PROJECT_IDENTITY_FILE), identity, { mode: 0o644 })
  const gitignore = nodePath.join(dir, PROJECT_GITIGNORE_FILE)
  if (!(await exists(gitignore))) await writeFile(gitignore, projectGitignoreText(), { mode: 0o644 })
  return locateProjectData(place.root, options)
}

async function sameIdentity(root: string, projectId: string): Promise<boolean> {
  const value = await readJsonFile(nodePath.join(root, NEXGENT_DIR, PROJECT_IDENTITY_FILE)).catch(() => undefined) as Partial<ProjectIdentity> | undefined
  return value?.projectId === projectId
}

/**
 * Copy a project's old `.nexgent/` data into the user data directory
 * (data-formats.md §迁移). Skipped (no record) while a session of the
 * project is locked by a live process. Returns the record it wrote.
 */
export async function migrateProjectData(place: ProjectDataPlace, now: () => Date = () => new Date()): Promise<MigrationRecord | undefined> {
  const from = nodePath.join(place.root, NEXGENT_DIR)
  if (await hasLiveSessionLock(nodePath.join(from, 'sessions'))) return undefined
  const target = resolveProjectDataLayout(place.home, place.projectId)
  const startedAt = now().toISOString()
  const base = { formatVersion: 1 as const, projectId: place.projectId, from, startedAt, oldDataKept: true as const }
  await writeJsonFile(target.migrationFile, { ...base, status: 'copying', entries: [], grantsMoved: 0 } satisfies MigrationRecord)
  try {
    const entries: MigrationEntry[] = []
    for (const name of PROJECT_DATA_SUBDIRS) {
      const source = nodePath.join(from, name)
      if (!(await isDirectory(source))) continue
      const destination = nodePath.join(target.dataDir, name)
      await cp(source, destination, { recursive: true, force: true, errorOnExist: false, filter: path => nodePath.basename(path) !== '.lock' })
      entries.push({ name, ...(await verifyCopy(source, destination)) })
    }
    const grants = await readConfigGrants(nodePath.join(from, PROJECT_CONFIG_FILE))
    if (grants.length > 0) {
      const current = await readJsonFile(target.grantsFile) as { approvals?: ApprovalGrant[] } | undefined
      const known = new Set((current?.approvals ?? []).map(grant => JSON.stringify(grant)))
      const merged = [...(current?.approvals ?? []), ...grants.filter(grant => !known.has(JSON.stringify(grant)))]
      await writeJsonFile(target.grantsFile, { formatVersion: 1, approvals: merged }, { mode: 0o600 })
    }
    const record: MigrationRecord = { ...base, status: 'done', finishedAt: now().toISOString(), entries, grantsMoved: grants.length }
    await writeJsonFile(target.migrationFile, record)
    // After `done`: the notice, the shared-files .gitignore, and the grants leave config.json.
    await writeFile(nodePath.join(from, MIGRATION_NOTICE_FILE), migrationNotice(target.dataDir, record.finishedAt!), 'utf8')
    await writeFile(nodePath.join(from, PROJECT_GITIGNORE_FILE), projectGitignoreText(), { mode: 0o644 })
    if (grants.length > 0) await dropConfigGrants(nodePath.join(from, PROJECT_CONFIG_FILE))
    return record
  } catch (error) {
    const record: MigrationRecord = { ...base, status: 'failed', finishedAt: now().toISOString(), entries: [], grantsMoved: 0, error: toErrorInfo(error) }
    await writeJsonFile(target.migrationFile, record).catch(() => undefined)
    return record
  }
}

/** The text of `MOVED.txt`. */
export function migrationNotice(dataDir: string, at: string): string {
  return [
    'Nexgent moved this project\'s conversations, ledgers, snapshots, materials and deliverables to',
    `  ${dataDir}`,
    `on ${at}. The copies here are kept until you remove them; Nexgent no longer reads or writes them.`,
    'Only project.json, config.json, skills/, presets/ and architectures/ in this folder are used and can be shared.',
    '',
  ].join('\n')
}

/** Compare every file of `source` with its copy by size and SHA-256. */
async function verifyCopy(source: string, destination: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const rel of await listFiles(source)) {
    if (nodePath.basename(rel) === '.lock') continue
    const a = nodePath.join(source, rel)
    const b = nodePath.join(destination, rel)
    const [left, right] = await Promise.all([stat(a), stat(b)])
    if (left.size !== right.size || await sha256(a) !== await sha256(b)) throw new Error(`copy of ${rel} differs from the original`)
    files += 1
    bytes += left.size
  }
  return { files, bytes }
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(nodePath.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : nodePath.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(dir, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

async function hasLiveSessionLock(sessions: string): Promise<boolean> {
  const ids = await readdir(sessions).catch(() => [] as string[])
  for (const id of ids) {
    const raw = await readFile(nodePath.join(sessions, id, '.lock'), 'utf8').catch(() => undefined)
    if (raw === undefined) continue
    try {
      const pid = (JSON.parse(raw) as { pid?: unknown }).pid
      if (typeof pid === 'number' && isProcessAlive(pid)) return true
    } catch {
      // unreadable lock: the session store judges it; migration waits for the next open
      return true
    }
  }
  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readConfigGrants(path: string): Promise<ApprovalGrant[]> {
  const raw = await readJsonFile(path).catch(() => undefined) as { approvals?: unknown } | undefined
  return Array.isArray(raw?.approvals) ? raw.approvals as ApprovalGrant[] : []
}

async function dropConfigGrants(path: string): Promise<void> {
  const raw = await readJsonFile(path) as Record<string, unknown> | undefined
  if (raw === undefined) return
  const { approvals: _moved, ...rest } = raw
  await writeJsonFile(path, rest, { mode: 0o644 })
}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then(info => info.isDirectory(), () => false)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}
