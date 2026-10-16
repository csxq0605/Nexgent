/**
 * Where a project's data lives (ADR 0017, K1): `<NEXGENT_HOME>/projects/<projectId>/`,
 * not `<root>/.nexgent/`. The scripts resolve it through the product's own
 * `resolveProjectLayout`, so they follow whatever the product does.
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'

let kernelPromise
async function kernel() {
  kernelPromise ??= (async () => {
    const url = new URL('../../packages/kernel/dist/index.js', import.meta.url)
    await access(url)
    return import(url.href)
  })()
  return kernelPromise
}

/** The resolved `WorkspaceLayout` of `root` under `home` (async: loads the built kernel once). */
export async function layoutFor(root, home) {
  return (await kernel()).resolveProjectLayout(root, { home })
}

/** The data directory of `root` under `home`. */
export async function dataDirFor(root, home) {
  return (await layoutFor(root, home)).dataDir
}

/** Directories to scan for secrets: the shareable `.nexgent/` and the data directory. */
export async function secretScanDirs(root, home) {
  const dataDir = await dataDirFor(root, home)
  return [...new Set([join(root, '.nexgent'), dataDir])]
}

/** Scan `.nexgent/` and the data dir with `scan(dir, key, root)`; returns the merged hits. */
export async function scanSecrets(scan, root, home, key) {
  const hits = []
  for (const dir of await secretScanDirs(root, home)) hits.push(...await scan(dir, key, root))
  return hits
}

/** One session's records from the data dir (the test-support reader, pointed at the right file). */
export async function readSessionRecordsAt(h, root, home, sessionId) {
  const layout = await layoutFor(root, home)
  return h.readJsonlFile(join(layout.sessions, sessionId, 'session.jsonl'))
}

/** Every ledger record of the project from the data dir, month files ascending. */
export async function readLedgerRecordsAt(h, root, home) {
  const { readdir } = await import('node:fs/promises')
  const layout = await layoutFor(root, home)
  const months = (await readdir(layout.ledgers, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)).map(entry => entry.name).sort()
  const files = []
  for (const month of months) {
    const result = await h.readJsonlFile(join(layout.ledgers, month, 'requests.jsonl'))
    if (result.exists) files.push(result)
  }
  return { records: files.flatMap(file => file.records), files }
}

/** Whether `<root>/.nexgent` holds none of the per-project data (sessions, ledgers, outputs, materials, snapshots...). */
export async function strayDataIn(root) {
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(join(root, '.nexgent')).catch(() => [])
  return names.filter(name => ['sessions', 'ledgers', 'outputs', 'materials', 'snapshots', 'tasks', 'capabilities', 'improvements', 'grants.json'].includes(name))
}

// ---- sync lookup for helpers that only get a project root --------------------------------
// A run registers (root -> home) when it opens a project; helpers like `sessionsOf(root)` then
// find the data dir without every call site carrying `home`. A root nobody registered falls
// back to its own `.nexgent/` (the old place).

const homes = new Map()
let kernelSync
try {
  kernelSync = await import(new URL('../../packages/kernel/dist/index.js', import.meta.url).href)
} catch {
  kernelSync = undefined
}

/** Remember which NEXGENT_HOME `root` is opened under. Returns `root`. */
export function registerHome(root, home) {
  if (typeof root === 'string' && typeof home === 'string') homes.set(root, home)
  return root
}

/** The home `root` was registered under (undefined: the process's NEXGENT_HOME). */
export function homeOf(root) {
  return homes.get(root)
}

/** The data directory of `root` under its registered home (`<root>/.nexgent` when none). */
export function dataDirSync(root, home = homes.get(root)) {
  if (home === undefined || kernelSync === undefined) return join(root, '.nexgent')
  return kernelSync.resolveProjectLayout(root, { home }).dataDir
}

/** Absolute path of a recorded logical path (`.nexgent/materials/<id>/<name>`) in the data dir. */
export async function resolveRecorded(root, home, recorded) {
  return (await kernel()).resolveDataPath(await layoutFor(root, home), recorded)
}
