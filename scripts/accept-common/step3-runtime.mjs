/**
 * SEAM: how the step-3 acceptance script reaches the product — through
 * `@nexgent/sdk` against the scripted model server, with the step-3 plugins
 * the SDK does not load yet mounted as extra profile rows (registry +
 * insert patch). When the SDK loads them itself (W6), drop them here (keep
 * the test web row).
 *
 * Packages load from their built `dist/` by file URL (scripts/ is not a
 * workspace package).
 */
import { access } from 'node:fs/promises'
import { isLoopbackUrl } from './step2-runtime.mjs'

const PACKAGES = {
  sdk: 'packages/sdk',
  session: 'packages/session',
  subagent: 'packages/subagent',
  team: 'packages/team',
  workflow: 'packages/workflow',
  ptc: 'packages/ptc',
  spreadsheet: 'packages/tool-spreadsheet',
  web: 'packages/web',
}

/**
 * The one loopback address the test `web_fetch` row may reach (H19): the scenario's page
 * server listens here. The shipped `@nexgent/web` allows no loopback at all.
 */
export const TEST_WEB_ADDRESS = '127.0.0.2'

function entry(dir) {
  return new URL(`../../${dir}/dist/index.js`, import.meta.url)
}

/**
 * Load the built packages.
 * @returns `{ ok: true, pkgs }` (`sdk`, `session`, `subagent`, `team`, `workflow`, `ptc`, `spreadsheet`, `web`) or `{ ok: false, reason }`.
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
 */
function testWebPlugin(pkgs) {
  const allowAddress = address => address === TEST_WEB_ADDRESS || pkgs.web.isPublicAddress(address)
  return {
    // The shipped row's name, so a host that loads @nexgent/web itself skips it for this one.
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
 * Profile rows the acceptance script adds to every SDK app, after the SDK's step-2 rows:
 * `@nexgent/subagent` (`delegate`), `@nexgent/team` (the six lead tools), `@nexgent/workflow` (`workflow`), `@nexgent/ptc`
 * (`run_code`), `@nexgent/tool-spreadsheet` and `@nexgent/web` — or, with `web: 'test'`,
 * the test `web_fetch` row instead of the shipped one.
 */
export function step3Rows(pkgs, { web = 'shipped' } = {}) {
  const plugins = [
    ['subagent', pkgs.subagent.SubagentPlugin],
    ['team', pkgs.team.TeamPlugin],
    ['workflow', pkgs.workflow.WorkflowPlugin],
    ['ptc', pkgs.ptc.PtcPlugin],
    ['spreadsheet', pkgs.spreadsheet.SpreadsheetPlugin],
    ['web', web === 'test' ? testWebPlugin(pkgs) : pkgs.web.WebPlugin],
  ]
  return {
    registry: Object.fromEntries(plugins.map(([, plugin]) => [plugin.name, plugin])),
    patches: [{ insert: plugins.map(([id, plugin]) => ({ id, name: plugin.name })) }],
  }
}

/**
 * Create an SDK instance for the scripted layers, with the step-3 rows.
 * @param pkgs - from {@link loadStep3Packages}.
 * @param options - `env` (loopback API base URL, key, `NEXGENT_HOME`; never `process.env`), `home`, `approvals`,
 *   `web` (`'shipped'` default, or `'test'`: see {@link step3Rows}).
 */
export function createStep3Sdk(pkgs, { env, home, approvals, web }) {
  if (!isLoopbackUrl(env.NEXGENT_API_BASE_URL)) {
    throw new Error(`createStep3Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  }
  const { registry, patches } = step3Rows(pkgs, { web })
  return pkgs.sdk.createSdk({ appVersion: 'accept-step3', env, home, registry, patches, ...(approvals === undefined ? {} : { approvalResponder: approvals }) })
}
