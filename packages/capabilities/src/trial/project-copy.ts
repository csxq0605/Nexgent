/**
 * A whole-project copy for one arm of an improver comparison (step 6, ADR
 * 0008 decision 4; `data-formats.md` §元改进作业): the arm runs a complete
 * improvement job in it (diagnose, propose, gate), and the gate inside it
 * builds its own replay copies from the copy's history and adopts only in
 * the copy (a nested copy). Nothing is copied back to the real project.
 *
 * The copy holds:
 * - the working tree of the origin (the source job's feedback task snapshot);
 * - the project's `.nexgent/` history as it is now (sessions, snapshots,
 *   ledgers, materials, outputs, improvers, ...), so the arm job can read
 *   its feedback task and the gate finds replayable cases;
 * - a fresh capability activation chain on the origin's capability version;
 * - no improvement jobs or queue (the arm job is the copy's only job);
 * - the config with automatic trials, automatic improvement and meta jobs
 *   off, and the evaluator settings untouched, so the copy's epoch is the
 *   project's (checked).
 *
 * Releasing deletes the copy, or (experiments, `keepCopies`) keeps it when
 * it is no larger than {@link KEEP_COPY_MAX_BYTES}.
 */
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import {
  BASELINE_VERSION,
  CAPABILITY_LIMITS,
  IMPROVEMENTS_DIR,
  NexgentError,
  resolveWorkspaceLayout,
  type CapabilityVersion,
  type KeptCopy,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore } from '../capability-store.js'
import { projectEpoch } from './epoch.js'
import { writeSnapshotTree } from './replay-project.js'
import type { ReplayCase } from './replay-set.js'

/** A kept copy may be at most this large (the snapshot limit); a larger one is deleted instead. */
export const KEEP_COPY_MAX_BYTES = CAPABILITY_LIMITS.maxSnapshotBytes

/** `.nexgent/` entries a copy does not take from the project. */
const NOT_COPIED = new Set([IMPROVEMENTS_DIR, 'capabilities', 'config.json'])

/** What {@link prepareProjectCopy} needs. */
export interface ProjectCopyInput {
  /** The real project (read only). */
  readonly layout: WorkspaceLayout
  /** The origin: the replay case whose snapshot tree becomes the copy's working tree. */
  readonly origin: Pick<ReplayCase, 'tree' | 'caseId'>
  /** The capability version the arm starts on (adopted as revision 1 of the copy's chain). */
  readonly version: CapabilityVersion
  /** Parent directory of the copy (default the OS temporary directory); must be outside the project. */
  readonly tempRoot?: string
  /** Largest copy {@link ProjectCopy.release} keeps (default {@link KEEP_COPY_MAX_BYTES}; tests lower it). */
  readonly keepMaxBytes?: number
}

/** What releasing a copy did. */
export type CopyRelease =
  | { readonly status: 'removed' }
  | { readonly status: 'kept'; readonly copy: KeptCopy }
  /** Asked to keep, but larger than {@link KEEP_COPY_MAX_BYTES}: removed. */
  | { readonly status: 'too-large'; readonly bytes: number }

/** A prepared project copy. */
export interface ProjectCopy {
  readonly root: string
  readonly layout: WorkspaceLayout
  /** The evaluator epoch the copy's gate runs in (equal to the project's). */
  readonly epoch: string
  /** Delete the copy, or keep it (`keep`) when it is small enough. Idempotent after the first call. */
  release(options?: { readonly keep?: boolean }): Promise<CopyRelease>
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
}

/** Bytes of the regular files under `root` (symbolic links not followed). */
export async function directoryBytes(root: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) total += (await lstat(path)).size
    }
  }
  await walk(root)
  return total
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    // A missing or unreadable config means the defaults, as for the real project.
    return {}
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Write the copy.
 * @throws `tool/invalid-input` when `tempRoot` is inside the project; `session/corrupt` when the origin snapshot is unreadable; `improvement/epoch-mismatch` when the copy's evaluator epoch is not the project's.
 */
export async function prepareProjectCopy(input: ProjectCopyInput): Promise<ProjectCopy> {
  const parent = input.tempRoot ?? tmpdir()
  if (inside(input.layout.root, parent)) throw new NexgentError('tool/invalid-input', `a project copy must be outside the project (${parent} is inside ${input.layout.root})`)
  const root = await mkdtemp(join(parent, 'nexgent-arm-'))
  let released: CopyRelease | undefined
  const remove = () => rm(root, { recursive: true, force: true, maxRetries: 3 })
  try {
    await writeSnapshotTree(input.layout, input.origin, root)
    const layout = resolveWorkspaceLayout(root)
    await mkdir(layout.dataDir, { recursive: true })

    // History: everything under .nexgent/ but the jobs, the capability chain and the config; no lock files.
    const entries = await readdir(input.layout.dataDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (NOT_COPIED.has(entry.name) || entry.name.endsWith('.lock')) continue
      await cp(join(input.layout.dataDir, entry.name), join(layout.dataDir, entry.name), {
        recursive: true,
        errorOnExist: false,
        filter: source => !source.endsWith('.lock'),
      })
    }

    // Config: no trial, improvement job or meta job starts on its own; evaluator settings unchanged.
    const config = await readConfig(input.layout.configFile)
    const capabilities = record(config.capabilities)
    const improvement = record(config.improvement)
    const meta = record(improvement.meta)
    const copied: Record<string, unknown> = {
      ...config,
      autoImprove: false,
      capabilities: { ...capabilities, autoTrial: false },
      ...(config.improvement === undefined || improvement.meta === undefined ? {} : { improvement: { ...improvement, meta: { ...meta, enabled: false } } }),
    }
    await writeFile(layout.configFile, `${JSON.stringify(copied, null, 2)}\n`)

    // A fresh capability chain on the origin's version.
    await mkdir(layout.capabilities, { recursive: true })
    if (input.version !== BASELINE_VERSION) {
      await cp(join(input.layout.capabilities, input.version), join(layout.capabilities, input.version), { recursive: true })
      await new CapabilityStore(layout.capabilities).adopt(input.version, { trigger: 'manual', detail: 'project copy for an improver comparison arm' })
    }

    const epoch = await projectEpoch(layout)
    const expected = await projectEpoch(input.layout)
    if (epoch !== expected) throw new NexgentError('improvement/epoch-mismatch', `the copy's evaluator epoch ${epoch.slice(0, 12)} is not the project's ${expected.slice(0, 12)}`)

    return {
      root,
      layout,
      epoch,
      async release(options = {}) {
        if (released !== undefined) return released
        if (options.keep === true) {
          const bytes = await directoryBytes(root)
          if (bytes <= (input.keepMaxBytes ?? KEEP_COPY_MAX_BYTES)) {
            released = { status: 'kept', copy: { root, bytes } }
            return released
          }
          await remove()
          released = { status: 'too-large', bytes }
          return released
        }
        await remove()
        released = { status: 'removed' }
        return released
      },
    }
  } catch (error) {
    await remove()
    throw error
  }
}
