/**
 * The recent-projects list: `<home>/recent-projects.json`, newest first, at
 * most {@link RECENT_PROJECTS_LIMIT} entries. A missing or unreadable file
 * counts as empty (the list is a convenience, never a source of truth); it
 * is rewritten atomically on every change.
 */
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '@nexgent/kernel'

/** File name under the Nexgent home. */
export const RECENT_PROJECTS_FILE = 'recent-projects.json'

/** Entries kept. */
export const RECENT_PROJECTS_LIMIT = 20

/** One stored entry. */
export interface RecentProjectEntry {
  readonly root: string
  readonly lastOpenedAt: string
}

interface RecentProjectsFile {
  readonly version: 1
  readonly projects: readonly RecentProjectEntry[]
}

function parse(value: unknown): RecentProjectEntry[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const projects = (value as { projects?: unknown }).projects
  if (!Array.isArray(projects)) return []
  return projects.filter((entry): entry is RecentProjectEntry =>
    entry !== null && typeof entry === 'object'
    && typeof (entry as RecentProjectEntry).root === 'string'
    && typeof (entry as RecentProjectEntry).lastOpenedAt === 'string')
}

/** The list at `<home>/recent-projects.json`. Writes are serialized per instance. */
export class RecentProjects {
  readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(home: string) {
    this.file = join(home, RECENT_PROJECTS_FILE)
  }

  async list(): Promise<readonly RecentProjectEntry[]> {
    await this.queue.catch(() => undefined)
    return parse(await readJsonFile(this.file).catch(() => undefined))
  }

  /** Move (or add) `root` to the front with the given time. */
  touch(root: string, at: string): Promise<void> {
    return this.update(entries => [{ root, lastOpenedAt: at }, ...entries.filter(entry => entry.root !== root)])
  }

  /** Drop `root`. */
  forget(root: string): Promise<void> {
    return this.update(entries => entries.filter(entry => entry.root !== root))
  }

  private update(change: (entries: RecentProjectEntry[]) => RecentProjectEntry[]): Promise<void> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const current = parse(await readJsonFile(this.file).catch(() => undefined))
      const file: RecentProjectsFile = { version: 1, projects: change(current).slice(0, RECENT_PROJECTS_LIMIT) }
      await writeJsonFile(this.file, file, { mode: 0o600, dirMode: 0o700 })
    })
    this.queue = next
    return next
  }
}
