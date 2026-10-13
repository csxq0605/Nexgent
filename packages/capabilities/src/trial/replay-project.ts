/**
 * The throw-away project one trial run works in: the replay case's snapshot
 * tree written out from `.nexgent/snapshots/objects/`, the project's config
 * (with automatic trials off and the remaining trial budget as the per-task
 * cap), the materials the case's messages attached, and the arm's capability
 * bundle adopted as revision 1 of a fresh activation chain. Nothing in it is
 * ever copied back to the real project.
 */
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BASELINE_VERSION,
  NEXGENT_DIR,
  NexgentError,
  resolveWorkspaceLayout,
  SNAPSHOTS_DIR,
  type CapabilityVersion,
  type CostCap,
  type SnapshotTree,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'
import { CapabilityStore } from '../capability-store.js'
import type { ReplayCase } from './replay-set.js'

/** What {@link prepareReplayProject} needs. */
export interface ReplayProjectInput {
  /** The real project's layout (read only). */
  readonly layout: WorkspaceLayout
  readonly replay: ReplayCase
  /** Bundle the run uses. */
  readonly version: CapabilityVersion
  /** Per-task cap of the run: what is left of the trial budget. */
  readonly budget: CostCap
  /** Parent directory of the copy (default the OS temporary directory). */
  readonly tempRoot?: string
}

/** A prepared copy. */
export interface ReplayProject {
  readonly root: string
  /** Paths and SHA-256 of the files written from the snapshot (to tell the run's changes apart). */
  readonly files: ReadonlyMap<string, string>
  dispose(): Promise<void>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write a replay case's snapshot tree into `root` from the project's
 * `.nexgent/snapshots/objects/`, checking every object against its hash.
 * @returns paths and SHA-256 of the files written.
 * @throws `session/corrupt` when the tree or an object is missing or does not match.
 */
export async function writeSnapshotTree(layout: WorkspaceLayout, replay: Pick<ReplayCase, 'tree' | 'caseId'>, root: string): Promise<Map<string, string>> {
  const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
  let tree: SnapshotTree
  try {
    const value: unknown = JSON.parse(await readFile(join(snapshots, 'trees', `${replay.tree}.json`), 'utf8'))
    if (validateCapabilityFile('snapshotTree', value).length > 0) throw new Error('schema')
    tree = value as SnapshotTree
  } catch (error) {
    throw new NexgentError('session/corrupt', `snapshot tree ${replay.tree} of task ${replay.caseId} is unreadable`, { cause: error })
  }
  const files = new Map<string, string>()
  for (const file of tree.files) {
    const bytes = await readFile(join(snapshots, 'objects', file.sha256)).catch((error: unknown) => {
      throw new NexgentError('session/corrupt', `snapshot object ${file.sha256} (${file.path}) is missing`, { cause: error })
    })
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new NexgentError('session/corrupt', `snapshot object ${file.sha256} (${file.path}) does not match its hash`)
    const target = join(root, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    if (file.executable === true && process.platform !== 'win32') await chmod(target, 0o755)
    files.set(file.path, file.sha256)
  }
  return files
}

/**
 * Write the copy.
 * @throws `session/corrupt` when the snapshot tree or an object is missing or does not match its hash.
 */
export async function prepareReplayProject(input: ReplayProjectInput): Promise<ReplayProject> {
  const root = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'nexgent-replay-'))
  const dispose = () => rm(root, { recursive: true, force: true, maxRetries: 3 })
  try {
    const files = await writeSnapshotTree(input.layout, input.replay, root)

    const layout = resolveWorkspaceLayout(root)
    await mkdir(join(root, NEXGENT_DIR), { recursive: true })
    let config: Record<string, unknown> = {}
    try {
      const value: unknown = JSON.parse(await readFile(input.layout.configFile, 'utf8'))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) config = value as Record<string, unknown>
    } catch {
      // A missing or unreadable config means the defaults, as for the real project.
    }
    const caps = (config.costCaps ?? {}) as { perTask?: CostCap; perProject?: CostCap }
    const perTask: CostCap = {
      ...(caps.perTask ?? {}),
      ...(input.budget.maxTokens === undefined ? {} : { maxTokens: Math.min(input.budget.maxTokens, caps.perTask?.maxTokens ?? Number.MAX_SAFE_INTEGER) }),
      ...(input.budget.maxRequests === undefined ? {} : { maxRequests: Math.min(input.budget.maxRequests, caps.perTask?.maxRequests ?? Number.MAX_SAFE_INTEGER) }),
    }
    const capabilities = (config.capabilities ?? {}) as Record<string, unknown>
    // A replay never starts trials or improvement jobs of its own.
    config = { ...config, costCaps: { ...caps, perTask }, autoImprove: false, capabilities: { ...capabilities, autoTrial: false } }
    await writeFile(layout.configFile, `${JSON.stringify(config, null, 2)}\n`)

    const materials = new Set(input.replay.messages.flatMap(message => message.materialIds ?? []))
    for (const id of materials) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue
      await cp(join(input.layout.materials, id), join(layout.materials, id), { recursive: true, errorOnExist: false }).catch(() => undefined)
    }

    if (input.version !== BASELINE_VERSION) {
      await cp(join(input.layout.capabilities, input.version), join(layout.capabilities, input.version), { recursive: true })
      const store = new CapabilityStore(layout.capabilities)
      await store.adopt(input.version, { trigger: 'manual', detail: 'replay copy for a gate trial' })
    }
    return { root, files, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
