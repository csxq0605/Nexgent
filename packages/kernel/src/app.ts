// Adapted from deepseek-harness@46a7f68b packages/boot/app-boot/src/index.ts (MIT)
/**
 * `createApp`: build the root Cordis context from a profile, patches and a
 * host plugin registry.
 */
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { applyProfilePatches, type AppProfile, type AppProfilePatchEntry } from './contracts/config.js'
import { AgentsService } from './agents.js'
import { ApprovalBrokerService } from './approvals.js'
import { CredentialsService } from './credentials.js'
import { bootProfile, defaultProfile, type LoadedRow, type PluginRegistry } from './profile.js'
import { ToolRegistryService } from './tools.js'

/** Row names of the plugins the kernel itself provides. */
export const KERNEL_PLUGIN_NAMES = {
  credentials: '@nexgent/kernel/credentials',
  tools: '@nexgent/kernel/tools',
  approvals: '@nexgent/kernel/approvals',
  agents: '@nexgent/kernel/agents',
} as const

/** The kernel's own plugins, always resolvable by profile rows (a host registry entry of the same name wins). */
export const KERNEL_PLUGINS: Readonly<Record<string, Plugin>> = {
  [KERNEL_PLUGIN_NAMES.credentials]: CredentialsService,
  [KERNEL_PLUGIN_NAMES.tools]: ToolRegistryService,
  [KERNEL_PLUGIN_NAMES.approvals]: ApprovalBrokerService,
  [KERNEL_PLUGIN_NAMES.agents]: AgentsService,
}

/** Options accepted by {@link createApp}. */
export interface CreateAppOptions {
  /** Profile rows; default the shipped product profile ({@link defaultProfile}). */
  readonly profile?: AppProfile
  /** Patch entries applied in order (e.g. from {@link loadPatchFile}). */
  readonly patches?: readonly AppProfilePatchEntry[]
  /** Host plugins by row name (`@nexgent/llm`, `@nexgent/session`, `@nexgent/workspace`, test fakes). */
  readonly registry?: PluginRegistry
}

/** A running Nexgent application. */
export interface NexgentApp {
  /** The root dependency container. */
  readonly ctx: Context
  /** The profile after patches, as loaded. */
  readonly profile: AppProfile
  /** Loaded rows with their fibers, in load order. */
  readonly rows: readonly LoadedRow[]
  /** Shortcut for `ctx.agents`. */
  readonly agents: AgentsService
  /** Close every agent and unload every plugin. */
  dispose(): Promise<void>
}

/**
 * Boot an application: apply patches to the profile, then load every enabled
 * row in order through the registry, validating each config with the
 * plugin's schema, and wait until all are active.
 * @throws `config/profile-patch` for a bad patch; `config/invalid` for an
 *   unknown plugin, a rejected config, a start failure or a missing service.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NexgentApp> {
  const profile = applyProfilePatches(options.profile ?? defaultProfile(), options.patches ?? [])
  const ctx = new Context()
  let rows: LoadedRow[]
  try {
    rows = await bootProfile(ctx, profile, options.registry, KERNEL_PLUGINS)
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
  return {
    ctx,
    profile,
    rows,
    get agents() {
      return ctx.agents
    },
    dispose: async () => {
      // Unload in reverse load order so agents close while their services still exist.
      for (const { fiber } of [...rows].reverse()) await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}
