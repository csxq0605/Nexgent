/**
 * Boot one project's Cordis application: the kernel's default profile plus
 * the step-2 rows (`@nexgent/context`, `@nexgent/skill`, `@nexgent/tasking`)
 * and the step-3 rows (`@nexgent/tool-spreadsheet`, `@nexgent/web`,
 * `@nexgent/ptc`, `@nexgent/subagent`, `@nexgent/workflow`, `@nexgent/team`),
 * with the host plugins the CLI used to wire itself (llm, session,
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
} from '@nexgent/kernel'
import { ContextPlugin } from '@nexgent/context'
import { AnthropicProvider, LLMPlugin, providerOptionsFromConfig, type LLMPluginConfig } from '@nexgent/llm'
import { PtcPlugin } from '@nexgent/ptc'
import { SessionPlugin } from '@nexgent/session'
import { SkillPlugin } from '@nexgent/skill'
import { SubagentPlugin } from '@nexgent/subagent'
import { TaskingPlugin } from '@nexgent/tasking'
import { recoverTeam, TeamPlugin } from '@nexgent/team'
import { SpreadsheetPlugin } from '@nexgent/tool-spreadsheet'
import { WebPlugin } from '@nexgent/web'
import { recoverWorkflows, WorkflowPlugin } from '@nexgent/workflow'
import { WorkspacePlugin } from '@nexgent/workspace'

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
 * The step-3 rows, after the step-2 ones (the team's mail provider needs
 * `@nexgent/context`): the migrated tools, then the collaboration tools
 * (`delegate`, `workflow`, the team tools).
 */
export function step3ProfileRows(): AppProfileRow[] {
  return [
    { id: 'spreadsheet', name: SpreadsheetPlugin.name },
    { id: 'web', name: WebPlugin.name },
    { id: 'ptc', name: PtcPlugin.name },
    { id: 'subagent', name: SubagentPlugin.name },
    { id: 'workflow', name: WorkflowPlugin.name },
    { id: 'team', name: TeamPlugin.name },
  ]
}

/**
 * Work a reopened root session needs before its first new turn: closing the
 * member runs and workflows a dead process left open (`data-formats.md`
 * §子会话与成员 恢复). Each step writes host records between turns.
 */
export type SessionRecovery = (agent: Agent, store: SessionStore) => Promise<unknown>

/**
 * The recovery steps the SDK runs, in order, after resuming a root session:
 * `recoverWorkflows` closes the open member runs (`closeInterruptedRuns`,
 * teammates' included), then the open workflows; `recoverTeam` then marks
 * mail the recipient already saw as delivered.
 */
export const ROOT_SESSION_RECOVERIES: readonly SessionRecovery[] = [
  (agent, store) => recoverWorkflows(agent, store),
  (agent, store) => recoverTeam(agent, store),
]

/**
 * The SDK's step-3 rows minus those a caller's patch inserts itself (same id
 * or plugin name): the caller's row wins, so a host that loaded a step-3
 * plugin before the SDK did keeps booting.
 */
function withoutCallerRows(rows: readonly AppProfileRow[], patches: readonly AppProfilePatchEntry[]): AppProfileRow[] {
  const inserted = patches.filter(isProfileInsert).flatMap(patch => patch.insert)
  return rows.filter(row => !inserted.some(other => other.id === row.id || other.name === row.name))
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
    { insert: [...step2ProfileRows(env, options.home), ...withoutCallerRows(step3ProfileRows(), options.patches ?? [])] },
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
      [TeamPlugin.name]: TeamPlugin as Plugin,
      ...options.registry,
    },
  })
}
