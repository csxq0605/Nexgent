/**
 * SEAM: how the step-2 acceptance script reaches the product — through
 * `@nexgent/sdk` (the in-process API the CLI and the desktop app share),
 * against the scripted model server. When the SDK's surface changes, adapt
 * here.
 *
 * Packages load from their built `dist/` by file URL (scripts/ is not a
 * workspace package).
 */
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PACKAGES = { sdk: 'packages/sdk', session: 'packages/session' }

/** The `nexgent` launcher (for `nexgent export`). */
export const CLI_BIN = fileURLToPath(new URL('../../apps/cli/bin/nexgent.mjs', import.meta.url))

function entry(dir) {
  return new URL(`../../${dir}/dist/index.js`, import.meta.url)
}

/**
 * Load the built packages.
 * @returns `{ ok: true, pkgs }` (`sdk`, `session`) or `{ ok: false, reason }`.
 */
export async function loadStep2Packages() {
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

/** Whether `url` is an http(s) URL on a loopback host. */
export function isLoopbackUrl(url) {
  try {
    const { hostname, protocol } = new URL(String(url))
    return (protocol === 'http:' || protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)
  } catch {
    return false
  }
}

/**
 * Create an SDK instance for the scripted layers.
 * @param pkgs - from {@link loadStep2Packages}.
 * @param options - `env` (API base URL, key, `NEXGENT_HOME`, compaction
 *   threshold; never `process.env`), `home`, `approvals` (host responder),
 *   `realModel` (default false: refuse any base URL that is not loopback, so
 *   the scripted layers can never reach the real API).
 */
export function createStep2Sdk(pkgs, { env, home, approvals, realModel = false }) {
  if (!realModel && !isLoopbackUrl(env.NEXGENT_API_BASE_URL)) {
    throw new Error(`createStep2Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  }
  return pkgs.sdk.createSdk({ appVersion: 'accept-step2', env, home, ...(approvals === undefined ? {} : { approvalResponder: approvals }) })
}

/**
 * Run one turn through the SDK and collect its raw agent events.
 * @param sdk - an SDK instance.
 * @param input - `startTurn` input (`{ projectId, sessionId, text, materialIds? }`
 *   or `{ source: 'feedback', projectId, sessionId, feedback }`).
 * @param options - `onEvent(event)` sees every agent event of the project as it happens.
 * @returns `{ result, error, events }`.
 */
export async function runTurn(sdk, input, { onEvent } = {}) {
  const events = []
  const unsubscribe = sdk.onAgentEvent((event) => {
    if (event.projectId !== input.projectId) return
    events.push(event)
    onEvent?.(event)
  })
  try {
    const started = await sdk.startTurn(input)
    const result = await started.done
    return { result, events }
  } catch (error) {
    return { result: undefined, error, events }
  } finally {
    unsubscribe()
  }
}

/** A JSON line for an agent event, in the CLI's `--json` shape where it matters (`tool.start`). */
export function eventLine(event) {
  if (event.type === 'tool.start') return JSON.stringify({ type: 'tool.start', callId: event.call.id, name: event.call.name, arguments: event.call.arguments })
  if (event.type === 'text.delta') return JSON.stringify({ type: 'text.delta', text: event.text })
  // Reasoning text stays out of the output; its arrival is what the real layer's kill waits for.
  if (event.type === 'reasoning.delta') return JSON.stringify({ type: 'reasoning.delta', length: event.text.length })
  if (event.type === 'request.start') return JSON.stringify({ type: 'request.start', requestId: event.requestId })
  if (event.type === 'turn.start' || event.type === 'turn.end') return JSON.stringify({ type: event.type, turn: event.turn, ...(event.reason === undefined ? {} : { reason: event.reason }) })
  return undefined
}
