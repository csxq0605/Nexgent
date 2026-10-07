/**
 * `@nexgent/kernel` — the Nexgent runtime kernel.
 *
 * Step 0 scope: prove the Cordis dependency choice. This module creates the
 * root Cordis `Context` for a Nexgent application and ships one example
 * plugin (`Greeter`) whose config is validated with schemastery and which
 * registers a service on `ctx`. Step 1 of the plan replaces the example with
 * the real `ctx.agents` / `ctx.tools` / `ctx.session` services.
 */
import { Context } from '@deepseek-ai/cordis'

export { Context, Service, ValidationError } from '@deepseek-ai/cordis'
export type { Fiber, Plugin } from '@deepseek-ai/cordis'
export { Greeter } from './greeter.js'
export type { GreeterConfig } from './greeter.js'
export * from './contracts/index.js'

/** A running Nexgent application: a root Cordis context plus its disposer. */
export interface NexgentApp {
  /** The root dependency container every plugin and service hangs off. */
  readonly ctx: Context
  /** Unload every plugin and service started under the root context. */
  dispose(): Promise<void>
}

/** Options accepted by {@link createApp}. Empty for now; step 1 adds profile loading. */
export interface CreateAppOptions {}

/**
 * Create a Nexgent application context.
 *
 * Plugins are started with `app.ctx.plugin(plugin, config)`; the config is
 * validated against the plugin's `Config` schema before it runs.
 */
export function createApp(_options: CreateAppOptions = {}): NexgentApp {
  const ctx = new Context()
  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}
