/**
 * Boot one project's Cordis application: the kernel's default profile plus
 * the step-2 rows (`@nexgent/context`, `@nexgent/skill`, `@nexgent/tasking`)
 * and the step-3 rows (`@nexgent/tool-spreadsheet`, `@nexgent/web`,
 * `@nexgent/ptc`, `@nexgent/subagent`, `@nexgent/workflow`)
 * and the step-4 row (`@nexgent/capabilities`) and the step-5 row
 * (`@nexgent/evolve`), the coordinator's `@nexgent/threads` row when the SDK
 * runs threads, with the host plugins the CLI used to wire itself (llm, session,
 * workspace) and the SDK's `env` handed to the llm provider and the
 * credentials service, so tests and the acceptance scripts stay hermetic.
 */
import { join } from 'node:path'
import {
  createApp,
  KERNEL_PLUGIN_NAMES,
  LocalCredentials,
  USER_SKILLS_DIR,
  type Agent,
  isProfileInsert,
  type AppProfilePatchEntry,
  type AppProfileRow,
  type Context,
  type JsonObject,
  type NexgentApp,
  type Plugin,
  type SessionStore,
  type ThreadHost,
} from '@nexgent/kernel'
import { CapabilitiesPlugin } from '@nexgent/capabilities'
import { ContextPlugin } from '@nexgent/context'
import { EvolvePlugin } from '@nexgent/evolve'
import { AnthropicProvider, LLMPlugin, providerOptionsFromConfig, type LLMPluginConfig } from '@nexgent/llm'
import { PtcPlugin } from '@nexgent/ptc'
import { SessionPlugin } from '@nexgent/session'
import { SkillPlugin } from '@nexgent/skill'
import { SubagentPlugin } from '@nexgent/subagent'
import { TaskingPlugin } from '@nexgent/tasking'
import { SpreadsheetPlugin } from '@nexgent/tool-spreadsheet'
import { WebPlugin } from '@nexgent/web'
import { recoverWorkflows, WorkflowPlugin } from '@nexgent/workflow'
import { WorkspacePlugin } from '@nexgent/workspace'
import { THREADS_PLUGIN_NAME, threadsPlugin } from './threads.js'
import { TRIAL_ENTRY, TRIAL_ENV_KEYS } from './trial-entry.js'

/** Environment variable that lowers the compaction threshold (read by `@nexgent/context`). */
export const COMPACTION_THRESHOLD_ENV = 'NEXGENT_COMPACTION_THRESHOLD'

/**
 * The step-2 rows appended to the default profile, in load order.
 * @param home - Nexgent home; the user skill root is `<home>/skills` (absent: the skill plugin's own default).
 */
export function step2ProfileRows(env: Readonly<Record<string, string | undefined>>, home?: string): AppProfileRow[] {
  const threshold = env[COMPACTION_THRESHOLD_ENV]
  const parsed = threshold === undefined || threshold.trim() === '' ? undefined : Number(threshold)
  const context: JsonObject = parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? { compaction: { thresholdTokens: parsed } }
    : {}
  return [
    { id: 'context', name: ContextPlugin.name, config: context },
    { id: 'skill', name: SkillPlugin.name, ...(home === undefined ? {} : { config: { userDir: join(home, USER_SKILLS_DIR) } }) },
    { id: 'tasking', name: TaskingPlugin.name },
  ]
}

/**
 * The step-3 rows, after the step-2 ones: the migrated tools, then the
 * collaboration tools (`delegate`, `workflow`, `organize`).
 */
export function step3ProfileRows(): AppProfileRow[] {
  return [
    { id: 'spreadsheet', name: SpreadsheetPlugin.name },
    { id: 'web', name: WebPlugin.name },
    { id: 'ptc', name: PtcPlugin.name },
    { id: 'subagent', name: SubagentPlugin.name },
    { id: 'workflow', name: WorkflowPlugin.name },
  ]
}

/**
 * The step-4 row, last: `@nexgent/capabilities` provides `ctx.capabilityHost`
 * (the adopted version and per-session components the kernel loads) and the
 * three capability tools, so tasks the CLI and the desktop run use the
 * project's adopted capability version.
 */
export function step4ProfileRows(): AppProfileRow[] {
  return [{ id: 'capabilities', name: CapabilitiesPlugin.name }]
}

/**
 * The `trial` config of the `@nexgent/capabilities` row (step 4 gate): the
 * entry the plugin starts the gate process with, and the non-secret settings
 * of this SDK's environment the process needs (home, API base URL).
 */
export function trialRowConfig(env: Readonly<Record<string, string | undefined>>, home?: string): JsonObject {
  const extra: Record<string, string> = {}
  for (const key of TRIAL_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value !== '') extra[key] = value
  }
  if (home !== undefined) extra.NEXGENT_HOME = home
  return { trial: { entry: TRIAL_ENTRY, env: extra } }
}

/**
 * The step-5 row, after the step-4 one: `@nexgent/evolve` provides
 * `ctx.improve`, the handle layer-1 learning hangs on (ADR 0018).
 */
export function step5ProfileRows(_env: Readonly<Record<string, string | undefined>>, home?: string): AppProfileRow[] {
  return [{ id: 'evolve', name: EvolvePlugin.name, config: home === undefined ? {} : { home } }]
}

/**
 * Work a reopened root session needs before its first new turn: closing the
 * member runs and workflows a dead process left open (`data-formats.md`
 * §子会话与成员 恢复). Each step writes host records between turns.
 */
export type SessionRecovery = (agent: Agent, store: SessionStore) => Promise<unknown>

/**
 * The recovery steps the SDK runs, in order, after resuming a root session:
 * `recoverWorkflows` closes the open member runs (`closeInterruptedRuns`),
 * then the open workflows.
 */
export const ROOT_SESSION_RECOVERIES: readonly SessionRecovery[] = [
  (agent, store) => recoverWorkflows(agent, store),
]

/**
 * The SDK's step-3, step-4 and step-5 rows minus those a caller's patch inserts itself (same id
 * or plugin name): the caller's row wins, so a host that loaded a step-3
 * plugin before the SDK did keeps booting.
 */
function withoutCallerRows(rows: readonly AppProfileRow[], patches: readonly AppProfilePatchEntry[]): AppProfileRow[] {
  const inserted = patches.filter(isProfileInsert).flatMap(patch => patch.insert)
  return rows.filter(row => !inserted.some(other => other.id === row.id || other.name === row.name))
}

/** The SDK's step-3, step-4 and step-5 rows; without background work the gate has no entry and evolve is left out. */
function sdkRows(env: Readonly<Record<string, string | undefined>>, home: string, background: boolean): AppProfileRow[] {
  return [
    ...step3ProfileRows(),
    // The handbook the capability row hosts is the user's (ADR 0018): it gets the home explicitly, not from the gate's env.
    ...step4ProfileRows().map(row => ({ ...row, config: { ...(background ? trialRowConfig(env, home) : {}), home } })),
    ...(background ? step5ProfileRows(env, home) : []),
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
  /**
   * Whether this app starts background work: the gate after a task that
   * proposed a candidate, and learning (default true). The processes that
   * run on a project copy (gate replays) pass false, so a copy never starts
   * a gate or learns on its own.
   */
  readonly background?: boolean
  /** Coordinator step two: the host's threads; with it the app loads `@nexgent/threads` (`ctx.threads` and the thread tools). */
  readonly threads?: ThreadHost
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
    { id: 'workspace', config: { root: options.root, home: options.home } },
    ...(options.approvalTimeoutMs === undefined ? [] : [{ id: 'approvals', config: { timeoutMs: options.approvalTimeoutMs } }]),
    {
      insert: [
        ...step2ProfileRows(env, options.home),
        ...withoutCallerRows(sdkRows(env, options.home, options.background !== false), options.patches ?? []),
        ...(options.threads === undefined ? [] : [{ id: 'threads', name: THREADS_PLUGIN_NAME }]),
      ],
    },
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
      [SpreadsheetPlugin.name]: SpreadsheetPlugin as Plugin,
      [WebPlugin.name]: WebPlugin as Plugin,
      [PtcPlugin.name]: PtcPlugin as Plugin,
      [SubagentPlugin.name]: SubagentPlugin as Plugin,
      [WorkflowPlugin.name]: WorkflowPlugin as Plugin,
      [CapabilitiesPlugin.name]: CapabilitiesPlugin as Plugin,
      [EvolvePlugin.name]: EvolvePlugin as Plugin,
      ...(options.threads === undefined ? {} : { [THREADS_PLUGIN_NAME]: threadsPlugin(options.threads) as Plugin }),
      ...options.registry,
    },
  })
}
