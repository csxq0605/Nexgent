/**
 * SEAM: the only place the acceptance scripts load `@nexgent/test-support`
 * (scripted model server, cross-process harness, record readers, summary
 * builder). The package's API is still settling; when it changes, adapt
 * here and nowhere else.
 *
 * Loaded from the built `dist/` by file URL because `scripts/` is not a
 * workspace package and cannot resolve `@nexgent/*` by name.
 */
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Repository root (scripts/accept-common/../..). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The built test-support entry. */
export const TEST_SUPPORT_ENTRY = new URL('../../packages/test-support/dist/index.js', import.meta.url)

/** The `nexgent` launcher and the build output it needs. */
export const CLI_BIN = fileURLToPath(new URL('../../apps/cli/bin/nexgent.mjs', import.meta.url))
export const CLI_DIST_MAIN = fileURLToPath(new URL('../../apps/cli/dist/main.js', import.meta.url))

/** Exports the step-1 script uses. */
export const REQUIRED_EXPORTS = [
  'scriptedModelServer',
  'spawnNode',
  'killAllSpawned',
  'readSessionRecords',
  'readLedgerRecords',
  'acceptanceSummary',
]

/**
 * Load the harness.
 * @returns `{ ok: true, harness }` or `{ ok: false, reason }` (not built, or an export missing).
 */
export async function loadHarness() {
  try {
    await access(CLI_DIST_MAIN)
  } catch {
    return { ok: false, reason: 'apps/cli is not built (run `pnpm build`)' }
  }
  let harness
  try {
    harness = await import(TEST_SUPPORT_ENTRY.href)
  } catch (error) {
    return { ok: false, reason: `@nexgent/test-support is not built or failed to load (${error instanceof Error ? error.message : String(error)}); run \`pnpm build\`` }
  }
  const missing = REQUIRED_EXPORTS.filter(name => typeof harness[name] !== 'function')
  if (missing.length > 0) return { ok: false, reason: `@nexgent/test-support lacks ${missing.join(', ')}` }
  return { ok: true, harness }
}

/**
 * Start the scripted Claude Messages API server, or report that the scripted
 * provider is not available yet.
 * @returns `{ ok: true, server }` or `{ ok: false, reason }`.
 */
export async function startScriptedServer(harness, script) {
  try {
    return { ok: true, server: await harness.scriptedModelServer({ script }) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not implemented/i.test(message)) return { ok: false, reason: `scripted model server not implemented yet: ${message}` }
    throw error
  }
}
