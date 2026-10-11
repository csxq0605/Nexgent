/**
 * SEAM: the in-process step-2 runtime the acceptance script drives until
 * `@nexgent/sdk` (W4, round 3) exists. It composes what the CLI composes
 * (apps/cli/src/runtime.ts `bootApp`: kernel default profile, `@nexgent/llm`
 * against an explicit `env`, `@nexgent/session`, `@nexgent/workspace`) plus
 * the step-2 plugins `@nexgent/context`, `@nexgent/tasking` and
 * `@nexgent/skill`. When the SDK lands, replace this file with SDK calls.
 *
 * Packages load from their built `dist/` by file URL (scripts/ is not a
 * workspace package).
 */
import { access, mkdir } from 'node:fs/promises'

const PACKAGES = ['kernel', 'llm', 'session', 'workspace', 'context', 'tasking', 'skill', 'cli']

function entry(name) {
  return name === 'cli' ? new URL('../../apps/cli/dist/index.js', import.meta.url) : new URL(`../../packages/${name}/dist/index.js`, import.meta.url)
}

/**
 * Load the built packages.
 * @returns `{ ok: true, pkgs }` (keyed by short name) or `{ ok: false, reason }`.
 */
export async function loadStep2Packages() {
  const pkgs = {}
  for (const name of PACKAGES) {
    try {
      await access(entry(name))
      pkgs[name] = await import(entry(name).href)
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
 * Boot one application over a project root.
 * @param pkgs - from {@link loadStep2Packages}.
 * @param options - `root` (project root; created and initialised like
 *   `nexgent run` does: `.nexgent/` layout and a default `config.json`), `env`
 *   (API base URL, key, `NEXGENT_HOME`; never `process.env`), `context`
 *   (`@nexgent/context` plugin config), `approvals` (the host's responder).
 *   `realModel` (default false) lifts the loopback-only base URL guard.
 * @returns `{ app, ctx, tasking, skills }`.
 */
export async function bootStep2(pkgs, { root, env, context = {}, approvals, realModel = false }) {
  const { kernel, llm, session, workspace } = pkgs
  // The scripted layers must never reach the real API: refuse anything but a loopback base URL.
  if (!realModel && !isLoopbackUrl(env.NEXGENT_API_BASE_URL)) {
    throw new Error(`bootStep2: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  }
  // Initialise the project the way the product does (layout plus default config.json).
  await mkdir(root, { recursive: true })
  await pkgs.cli.initProjectLayout(root)
  const llmPlugin = {
    ...llm.LLMPlugin,
    apply(ctx, config = {}) {
      ctx.provide('llm', new llm.AnthropicProvider({ credentials: ctx.credentials, ledger: ctx.ledger, ...llm.providerOptionsFromConfig(config), env }))
    },
  }
  const credentials = {
    name: kernel.KERNEL_PLUGIN_NAMES.credentials,
    provide: 'credentials',
    apply(ctx) {
      ctx.provide('credentials', new kernel.LocalCredentials({ env, home: kernel.nexgentHome(env) }))
    },
  }
  const app = await kernel.createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      [kernel.KERNEL_PLUGIN_NAMES.credentials]: credentials,
      '@nexgent/llm': llmPlugin,
      '@nexgent/session': session.SessionPlugin,
      '@nexgent/workspace': workspace.WorkspacePlugin,
    },
  })
  try {
    await app.ctx.plugin(pkgs.context.ContextPlugin, context)
    await app.ctx.plugin(pkgs.tasking.TaskingPlugin)
    await app.ctx.plugin(pkgs.skill.SkillPlugin)
    if (approvals !== undefined) app.ctx.approvals.setResponder(approvals)
    app.agents.setProjectGrantWriter(grant => kernel.appendProjectGrant(app.ctx.workspace.layout.configFile, grant))
    return { app, ctx: app.ctx, tasking: app.ctx.get('tasking'), skills: app.ctx.get('skills') }
  } catch (error) {
    await app.dispose().catch(() => undefined)
    throw error
  }
}

/**
 * Run one turn and collect its events.
 * @param agent - an open agent.
 * @param input - `agent.run` input.
 * @param options - `onEvent(event, agent)` sees every event as it happens
 *   (it may call `agent.cancel`).
 * @returns `{ result, events }`; `result` is undefined and `error` set when `run` rejected.
 */
export async function runTurn(agent, input, { onEvent } = {}) {
  const events = []
  const unsubscribe = agent.subscribe((event) => {
    events.push(event)
    onEvent?.(event, agent)
  })
  try {
    const result = await agent.run(input)
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
  if (event.type === 'turn.start' || event.type === 'turn.end') return JSON.stringify({ type: event.type, turn: event.turn, ...(event.reason === undefined ? {} : { reason: event.reason }) })
  return undefined
}
