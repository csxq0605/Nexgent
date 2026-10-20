/**
 * SEAM: how the step-3 acceptance script reaches the product — through
 * `@nexgent/sdk` against the scripted model server. The SDK loads the
 * step-3 plugins itself (spreadsheet, web, ptc, subagent, workflow)
 * and runs the recovery steps when a root session reopens; the only row
 * this script adds is a test `web_fetch` (H19), on request.
 *
 * Packages load from their built `dist/` by file URL (scripts/ is not a
 * workspace package).
 */
import { access } from 'node:fs/promises'
import { isLoopbackUrl } from './step2-runtime.mjs'

const PACKAGES = {
  sdk: 'packages/sdk',
  session: 'packages/session',
  web: 'packages/web',
}

/**
 * The one loopback address the test `web_fetch` row may reach (H19): the scenario's page
 * server listens here. The shipped `@nexgent/web` allows no loopback at all. It must differ
 * from 127.0.0.1, which stays refused: macOS answers only on 127.0.0.1 out of 127.0.0.0/8, so
 * there the IPv6 loopback stands in.
 */
export const TEST_WEB_ADDRESS = process.platform === 'darwin' ? '::1' : '127.0.0.2'

/** {@link TEST_WEB_ADDRESS} as a URL host (an IPv6 literal goes in brackets). */
export const TEST_WEB_HOST = TEST_WEB_ADDRESS.includes(':') ? `[${TEST_WEB_ADDRESS}]` : TEST_WEB_ADDRESS

function entry(dir) {
  return new URL(`../../${dir}/dist/index.js`, import.meta.url)
}

/**
 * Load the built packages.
 * @returns `{ ok: true, pkgs }` (`sdk`, `session`, `web`) or `{ ok: false, reason }`.
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
 * A `web_fetch` row for the scripted layers only: the shipped tool with one extra allowed
 * address ({@link TEST_WEB_ADDRESS}); every other loopback and private address stays refused.
 * It carries the shipped row's id and name, so the SDK leaves its own web row out.
 */
function testWebPlugin(pkgs) {
  const allowAddress = address => address === TEST_WEB_ADDRESS || pkgs.web.isPublicAddress(address)
  return {
    name: pkgs.web.WebPlugin.name,
    apply(ctx) {
      ctx.inject(['tools'], (scope) => {
        const tool = pkgs.web.webFetchTool({ allowAddress })
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      })
    },
  }
}

/**
 * Extra profile rows: none by default; with `web: 'test'` the test `web_fetch` row in place
 * of the SDK's shipped one.
 */
export function step3Rows(pkgs, { web = 'shipped' } = {}) {
  if (web !== 'test') return { registry: {}, patches: [] }
  const plugin = testWebPlugin(pkgs)
  return { registry: { [plugin.name]: plugin }, patches: [{ insert: [{ id: 'web', name: plugin.name }] }] }
}

/**
 * Create an SDK instance for the scripted layers.
 * @param pkgs - from {@link loadStep3Packages}.
 * @param options - `env` (loopback API base URL, key, `NEXGENT_HOME`; never `process.env`), `home`, `approvals`,
 *   `web` (`'shipped'` default, or `'test'`: see {@link step3Rows}); `realModel` (the real layer only:
 *   allow a non-loopback API).
 */
export function createStep3Sdk(pkgs, { env, home, approvals, web, realModel = false }) {
  if (!realModel && !isLoopbackUrl(env.NEXGENT_API_BASE_URL)) {
    throw new Error(`createStep3Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  }
  const { registry, patches } = step3Rows(pkgs, { web })
  return pkgs.sdk.createSdk({ appVersion: 'accept-step3', env, home, registry, patches, ...(approvals === undefined ? {} : { approvalResponder: approvals }) })
}
