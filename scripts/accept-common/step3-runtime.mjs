/**
 * SEAM: how the step-3 acceptance script reaches the product — through
 * `@nexgent/sdk` against the scripted model server, with the step-3 plugins
 * the SDK does not load yet mounted as extra profile rows (registry +
 * insert patch). When the SDK loads them itself (W6), drop them here.
 *
 * Packages load from their built `dist/` by file URL (scripts/ is not a
 * workspace package).
 */
import { access } from 'node:fs/promises'
import { isLoopbackUrl } from './step2-runtime.mjs'

const PACKAGES = { sdk: 'packages/sdk', session: 'packages/session', subagent: 'packages/subagent' }

function entry(dir) {
  return new URL(`../../${dir}/dist/index.js`, import.meta.url)
}

/**
 * Load the built packages.
 * @returns `{ ok: true, pkgs }` (`sdk`, `session`, `subagent`) or `{ ok: false, reason }`.
 */
export async function loadStep3Packages() {
  const pkgs = {}
  for (const [name, dir] of Object.entries(PACKAGES)) {
    try {
      await access(entry(dir))
      pkgs[name] = await import(entry(dir).href)
    } catch (error) {
      return { ok: false, reason: `@nexgent/${name} is not built or failed to load (${error instanceof Error ? error.message : String(error)}); run \`pnpm build\`` }
    }
  }
  return { ok: true, pkgs }
}

/**
 * Profile rows the acceptance script adds to every SDK app: `@nexgent/subagent`
 * (the `delegate` tool), loaded after the SDK's step-2 rows so it sees tasking.
 */
export function step3Rows(pkgs) {
  const plugin = pkgs.subagent.SubagentPlugin
  return {
    registry: { [plugin.name]: plugin },
    patches: [{ insert: [{ id: 'subagent', name: plugin.name }] }],
  }
}

/**
 * Create an SDK instance for the scripted layers, with the step-3 rows.
 * @param pkgs - from {@link loadStep3Packages}.
 * @param options - `env` (loopback API base URL, key, `NEXGENT_HOME`; never `process.env`), `home`, `approvals`.
 */
export function createStep3Sdk(pkgs, { env, home, approvals }) {
  if (!isLoopbackUrl(env.NEXGENT_API_BASE_URL)) {
    throw new Error(`createStep3Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  }
  const { registry, patches } = step3Rows(pkgs)
  return pkgs.sdk.createSdk({ appVersion: 'accept-step3', env, home, registry, patches, ...(approvals === undefined ? {} : { approvalResponder: approvals }) })
}
