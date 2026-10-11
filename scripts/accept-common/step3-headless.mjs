/**
 * The headless scenario of accept-step3. Round 1 collects only what exists
 * on trunk today: the repository inventory for H23. Later rounds add the
 * scripted multi-session scenario (delegation, team, workflow, PTC,
 * spreadsheet, web, skills) on top of the per-session routing of
 * `scriptedModelServer` (`routes` + `routeKey`).
 */
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { REPO_ROOT } from './harness.mjs'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'reference'])

/** Every file under `root`, repo-relative with `/`, skipping VCS, dependencies, build output and the DSH submodule. */
async function walk(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, join(dir, entry.name), out)
    } else {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return out
}

/**
 * The repository's files: `git ls-files` when the root is a checkout, else a
 * directory walk (a source archive). Both use `/` separators.
 * @returns `{ source, files }`.
 */
export async function repoInventory(root = REPO_ROOT) {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (git.status === 0 && git.stdout.length > 0) {
    return { source: 'git ls-files', files: git.stdout.split('\0').filter(Boolean) }
  }
  return { source: 'directory walk', files: await walk(root) }
}

/**
 * Run the headless scenario and return its observations.
 * @param harness - the loaded test-support module (unused until the multi-session scenario lands).
 * @param work - the layer's work directory.
 */
export async function runHeadlessScenario(harness, work, { log = () => {}, root = REPO_ROOT } = {}) {
  void harness
  void work
  const repo = await repoInventory(root)
  log(`repository inventory: ${repo.files.length} files (${repo.source})`)
  return { repo }
}
