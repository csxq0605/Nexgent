/**
 * Boot one project's Cordis application: the kernel's default profile plus
 * the step-2 rows (`@nexgent/context`, `@nexgent/skill`, `@nexgent/tasking`),
 * with the host plugins the CLI used to wire itself (llm, session,
 * workspace) and the SDK's `env` handed to the llm provider and the
 * credentials service, so tests and the acceptance scripts stay hermetic.
 */
import {
  createApp,
  KERNEL_PLUGIN_NAMES,
  LocalCredentials,
  type AppProfilePatchEntry,
  type AppProfileRow,
  type Context,
  type JsonObject,
  type NexgentApp,
  type Plugin,
} from '@nexgent/kernel'
import { ContextPlugin } from '@nexgent/context'
import { AnthropicProvider, LLMPlugin, providerOptionsFromConfig, type LLMPluginConfig } from '@nexgent/llm'
import { SessionPlugin } from '@nexgent/session'
import { SkillPlugin } from '@nexgent/skill'
import { TaskingPlugin } from '@nexgent/tasking'
import { WorkspacePlugin } from '@nexgent/workspace'

/** Environment variable that lowers the compaction threshold (read by `@nexgent/context`). */
export const COMPACTION_THRESHOLD_ENV = 'NEXGENT_COMPACTION_THRESHOLD'

/** The step-2 rows appended to the default profile, in load order. */
export function step2ProfileRows(env: Readonly<Record<string, string | undefined>>): AppProfileRow[] {
  const threshold = env[COMPACTION_THRESHOLD_ENV]
  const parsed = threshold === undefined || threshold.trim() === '' ? undefined : Number(threshold)
  const context: JsonObject = parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? { compaction: { thresholdTokens: parsed } }
    : {}
  return [
    { id: 'context', name: ContextPlugin.name, config: context },
    { id: 'skill', name: SkillPlugin.name },
    { id: 'tasking', name: TaskingPlugin.name },
  ]
}

/** What {@link bootProjectApp} needs. */
export interface BootOptions {
  /** Project root (absolute). */
  readonly root: string
  /** Nexgent home (credentials file). */
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Approval answer deadline in ms (absent: wait until answered or cancelled). */
  readonly approvalTimeoutMs?: number
  /** Extra patches applied after the SDK's own (tests, acceptance scripts). */
  readonly patches?: readonly AppProfilePatchEntry[]
  /** Plugins by row name; an entry replaces the SDK's (tests swap the llm row for a scripted model). */
  readonly registry?: Readonly<Record<string, Plugin>>
}

/** Boot the application of one project. */
export async function bootProjectApp(options: BootOptions): Promise<NexgentApp> {
  const env = options.env
  const llm = {
    ...LLMPlugin,
    apply(ctx: Context, config: LLMPluginConfig = {}): void {
      ctx.provide('llm', new AnthropicProvider({
        credentials: ctx.credentials,
        ledger: ctx.ledger,
        ...providerOptionsFromConfig(config),
        env,
      }))
    },
  }
  const credentials = {
    name: KERNEL_PLUGIN_NAMES.credentials,
    provide: 'credentials',
    apply(ctx: Context): void {
      ctx.provide('credentials', new LocalCredentials({ env: env as NodeJS.ProcessEnv, home: options.home }))
    },
  }
  const patches: AppProfilePatchEntry[] = [
    { id: 'workspace', config: { root: options.root } },
    ...(options.approvalTimeoutMs === undefined ? [] : [{ id: 'approvals', config: { timeoutMs: options.approvalTimeoutMs } }]),
    { insert: step2ProfileRows(env) },
    ...(options.patches ?? []),
  ]
  return createApp({
    patches,
    registry: {
      [KERNEL_PLUGIN_NAMES.credentials]: credentials,
      '@nexgent/llm': llm,
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
      [ContextPlugin.name]: ContextPlugin as Plugin,
      [SkillPlugin.name]: SkillPlugin as Plugin,
      [TaskingPlugin.name]: TaskingPlugin as Plugin,
      ...options.registry,
    },
  })
}
