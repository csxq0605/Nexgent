// Adapted from deepseek-harness@46a7f68b packages/core/agent/src/index.ts and packages/core/agent-default-model/src/index.ts (MIT)
/**
 * `ctx.agents`: create an agent on a new session or resume one by id.
 *
 * Each agent gets its own Cordis fiber under this service, extended with a
 * tool scope, so tools and restrictions registered through `agent.ctx` are
 * private to it and vanish when it closes. Disposing the service (app
 * shutdown) cancels running turns with cause `shutdown` and closes every
 * agent.
 */
import { randomUUID } from 'node:crypto'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  childSandboxMode,
  COLLABORATION_LIMITS,
  MAIN_MEMBER_ID,
  MEMBER_DENIED_TOOLS,
  MEMBER_NAME_PATTERN,
  type AgentAttribution,
  type AgentPreset,
  type BudgetShare,
  type ChildAgentOptions,
  type MemberIdentity,
  type ResumeChildOptions,
} from './contracts/collaboration.js'
import { BASELINE_VERSION, type CapabilityVersion } from './contracts/capabilities.js'
import type { ProjectConfig } from './contracts/config.js'
import { NexgentError } from './contracts/errors.js'
import { COMPARISON_ARMS, IMPROVEMENT_DIAGNOSIS_TOOLS, IMPROVEMENT_PHASES } from './contracts/improvement.js'
import { IMPROVER_SCOPES, IMPROVER_VERSION_PATTERN, META_DIAGNOSIS_TOOLS, META_PROPOSE_TOOLS } from './contracts/improver.js'
import { EFFORT_LEVELS, type Effort, type ThinkingMode } from './contracts/llm.js'
import type { CommandSandboxStatus, SessionImprovement, SessionLock } from './contracts/session.js'
import type { SandboxMode } from './contracts/workspace.js'
import { SANDBOX_MODES } from './contracts/workspace.js'
import { Agent, DEFAULT_MAX_OUTPUT_CONTINUATIONS, DEFAULT_MAX_STEPS, type AgentInit, type AgentSettings, type ProjectGrantWriter } from './agent.js'
import { readProjectSettings, type LoadedProjectConfig } from './project-config.js'
import { DEFAULT_PERSONA, DEFAULT_PERSONA_SUFFIX } from './system-prompt.js'
import type { AttachedComponent, CapabilityHost, ImprovementRun, MemberWorkdir } from './capability-hooks.js'
import { TaskTree } from './task-tree.js'
import { TOOL_SCOPE, type ToolRegistryService, type ToolScope } from './tools.js'
import type { ApprovalBrokerService } from './approvals.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@nexgent/kernel`: agent creation and resume. */
    agents: AgentsService
  }
}

/** Config of the `agents` profile row. */
export interface AgentsConfig {
  /** Default model id; below `.nexgent/config.json` `model` and above the provider default. */
  model?: string
  /** Reasoning mode; `.nexgent/config.json` `thinking` overrides it. */
  thinking: 'off' | 'on'
  /** Effort level (ADR 0002); `.nexgent/config.json` `effort` overrides it. */
  effort: Effort
  /** Output token cap per request. */
  maxTokens?: number
  /** Persona text (PR #4 `system-prompt` row). */
  systemPrompt: { persona: string; suffix: string }
  /** Whole-request model deadline in ms; 0 disables. */
  modelTimeoutMs: number
  /** Max stream silence in ms; 0 disables. */
  streamIdleTimeoutMs: number
  /** Max model calls per turn; past it the turn ends with cancel cause `step-limit` (ADR 0021). */
  maxSteps: number
  /** Max consecutive paused replies (`pause_turn`) continued automatically. */
  maxPauseContinuations: number
  /** Max consecutive replies cut by the output cap continued automatically (ADR 0021). */
  maxOutputContinuations: number
  /**
   * Kernel-side checkpoint at `turn.end` once N records accumulated; 0
   * (default) because `@nexgent/session` applies the spec policy inside
   * `append`. Set it only for a store that does not.
   */
  checkpointEvery: number
  /** Grace for a cancelled tool handler to settle, in ms. */
  toolAbortGraceMs: number
}

/** Options of {@link AgentsService.create}. */
export interface CreateAgentOptions {
  /** Session id (lowercase uuid v4); generated when absent. */
  readonly sessionId?: string
  readonly title?: string
  /** Model override (e.g. CLI `--model`). */
  readonly model?: string
  /** Sandbox override (CLI `--sandbox`); else `config.json` `sandboxMode`. */
  readonly sandboxMode?: SandboxMode
  /** Use this config instead of reading `.nexgent/config.json`. */
  readonly projectConfig?: LoadedProjectConfig
  /**
   * Start a child session (step 3; `permissions.md` §子会话继承): the parent
   * must be a root agent open in this process. The member runs in the
   * narrowest of the parent's, the preset's and the requested sandbox modes
   * (a wider request fails with `sandbox/denied`), sees the parent's
   * inherited tools minus `MEMBER_DENIED_TOOLS` and the preset's `tools`,
   * and takes the preset's persona, model, effort, thinking and `maxSteps`.
   * `mode: 'fork'` writes the parent's history as `fork.seed`. `sessionId`
   * and `title` apply; `model`, `sandboxMode` and `projectConfig` come from
   * the parent and the child options.
   */
  readonly child?: ChildAgentOptions
  /**
   * Step 5 (`agent-hooks.md` §步骤 5): the improvement job this root session
   * works for. Phase `diagnose` or `propose` opens an improvement session
   * (`session.start.purpose: improvement`): no task snapshots, checks or
   * check-failure signals, no collaboration tools, and in `diagnose` only
   * the `IMPROVEMENT_DIAGNOSIS_TOOLS` and no capability components. Phase
   * `trial` is an ordinary task session the gate runs for the job. Every
   * ledger record carries `improvementId` and `improvementPhase`.
   * Step 6: `meta-diagnose` / `meta-propose` open a meta job's session with
   * only `META_DIAGNOSIS_TOOLS` / `META_PROPOSE_TOOLS` and no components;
   * `improverVersion`, `metaJobId` and `comparisonArm` go into the header
   * and onto every ledger record.
   */
  readonly improvement?: ImprovementRun
  /** Thinking override (an improvement job's `improvement.thinking`); else the project config, then the service default. */
  readonly thinking?: ThinkingMode
  /** ADR 0022 decision 4: start in plan mode (CLI `--plan`); `sandboxMode` applies once the user approves a plan. */
  readonly plan?: boolean
  /** ADR 0022 decision 1: the command sandbox status to record in `session.start`. */
  readonly commandSandbox?: CommandSandboxStatus
}

/** Options of {@link AgentsService.resume}. */
export interface ResumeAgentOptions {
  /** Sandbox override; else the session header's mode. */
  readonly sandboxMode?: SandboxMode
  /** Model override; else the session header's model. */
  readonly model?: string
  readonly projectConfig?: LoadedProjectConfig
  /**
   * Reopen a child under its live parent (step 3), e.g. a teammate in a later
   * Lead turn. Required for a child session; refused for a root session.
   */
  readonly child?: ResumeChildOptions
  /**
   * Step 5: a gate trial session's job (`phase: 'trial'`; the session header
   * does not keep it). An improvement session's job comes from its header.
   */
  readonly improvement?: ImprovementRun
  /** Thinking override; else the project config, then the service default. */
  readonly thinking?: ThinkingMode
  /**
   * Step 3, with `child`: the member's preset again (the session header
   * keeps only its name), so the resumed member gets the same persona, tool
   * scope, effort, thinking and `maxSteps`. Its sandbox is re-checked
   * against the parent's.
   */
  readonly preset?: AgentPreset
}

/** What the service keeps per open agent (not exposed on {@link Agent}). */
interface AgentEntry {
  readonly agent: Agent
  readonly scope: ToolScope
  readonly tree: TaskTree
  readonly thinking: 'off' | 'on'
  readonly effort: Effort
  readonly projectConfig: ProjectConfig
  /** Open members this agent started (root agents only). */
  readonly children: Set<Agent>
}

/** The version a session runs on and what the capability host loaded for it. */
interface CapabilityLoad {
  readonly version: CapabilityVersion
  readonly attached: readonly AttachedComponent[]
  /** `seq` of a `capability.version` record written while loading, if any. */
  readonly lastSeq?: number
}

/** Rejection of a member request that breaks the collaboration rules. */
function denied(message: string, details?: Record<string, unknown>): NexgentError {
  return new NexgentError('tool/denied', message, details === undefined ? {} : { details })
}

/** Every `improve_*` tool name (step 5 diagnosis and step 6 meta tools); ordinary root sessions see none of them. */
const IMPROVE_TOOL_NAMES = [...new Set([...IMPROVEMENT_DIAGNOSIS_TOOLS, ...META_DIAGNOSIS_TOOLS, ...META_PROPOSE_TOOLS].map(tool => tool.name))]

function isMetaPhase(phase: ImprovementRun['phase']): boolean {
  return phase === 'meta-diagnose' || phase === 'meta-propose'
}

/** Diagnose and meta sessions run without capability components (ADR 0006, ADR 0008: no project plugins). */
function loadsNoComponents(run: ImprovementRun | undefined): boolean {
  return run !== undefined && (run.phase === 'diagnose' || isMetaPhase(run.phase))
}

/** Copy only the known fields of a job reference (from the caller or a session header). */
function improvementRun(run: ImprovementRun): ImprovementRun {
  return {
    jobId: run.jobId,
    phase: run.phase,
    ...(run.improverVersion === undefined ? {} : { improverVersion: run.improverVersion }),
    ...(run.improverScope === undefined ? {} : { improverScope: run.improverScope }),
    ...(run.metaJobId === undefined ? {} : { metaJobId: run.metaJobId }),
    ...(run.comparisonArm === undefined ? {} : { comparisonArm: run.comparisonArm }),
  }
}

/** The `ctx.agents` service. */
export class AgentsService extends Service {
  static readonly inject = ['llm', 'session', 'ledger', 'workspace', 'tools', 'approvals']

  static readonly Config: Schema<AgentsConfig> = Schema.object({
    model: Schema.string().description('Default model id.'),
    thinking: Schema.union(['off', 'on'] as const).default('on').description('Reasoning mode; execution uses on (adaptive thinking, ADR 0003).'),
    effort: Schema.union(EFFORT_LEVELS as readonly Effort[]).default('medium').description('Effort level (output_config.effort).'),
    maxTokens: Schema.natural().description('Output token cap per request.'),
    systemPrompt: Schema.object({
      persona: Schema.string().default(DEFAULT_PERSONA),
      suffix: Schema.string().default(DEFAULT_PERSONA_SUFFIX),
    }).default({ persona: DEFAULT_PERSONA, suffix: DEFAULT_PERSONA_SUFFIX }),
    modelTimeoutMs: Schema.natural().default(180_000),
    streamIdleTimeoutMs: Schema.natural().default(180_000),
    maxSteps: Schema.natural().min(1).default(DEFAULT_MAX_STEPS)
      .description('Model calls per turn before the turn ends with cancel cause step-limit (the user can continue); the project config maxStepsPerTurn and a preset override it.'),
    maxPauseContinuations: Schema.natural().default(8).description('Consecutive pause_turn replies continued automatically before the turn ends with an error.'),
    maxOutputContinuations: Schema.natural().default(DEFAULT_MAX_OUTPUT_CONTINUATIONS)
      .description('Consecutive replies cut by the output cap continued automatically before the turn ends with max-tokens.'),
    checkpointEvery: Schema.natural().default(0)
      .description('Kernel-side checkpoint threshold; 0 (default) leaves the data-formats.md policy to the session store.'),
    toolAbortGraceMs: Schema.natural().default(5_000),
  }) as Schema<AgentsConfig>

  private readonly home: Context
  private readonly config: AgentsConfig
  private readonly live = new Map<string, Agent>()
  private readonly entries = new Map<Agent, AgentEntry>()
  private grantWriter: ProjectGrantWriter | undefined
  private readonly closeListeners = new Set<(sessionId: string) => void>()
  private commandSandboxProbe: (() => Promise<CommandSandboxStatus>) | undefined

  constructor(ctx: Context, config: AgentsConfig) {
    super(ctx, 'agents')
    this.home = ctx
    this.config = config
    ctx.effect(() => () => this.shutdown(), 'agents.shutdown')
  }

  /** Agents currently open in this process. */
  list(): readonly Agent[] {
    return [...this.live.values()]
  }

  /** An open agent by session id. */
  get(sessionId: string): Agent | undefined {
    return this.live.get(sessionId)
  }

  /**
   * Call `listener` with the session id whenever an agent closes (ADR 0022:
   * the workspace ends that session's background commands).
   * @returns the unregister function.
   */
  onClosed(listener: (sessionId: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  /**
   * ADR 0022 decision 1: where a new session's `session.start` learns whether
   * its commands run in an OS sandbox (the workspace plugin registers it).
   * An explicit `CreateAgentOptions.commandSandbox` wins.
   * @returns the unregister function.
   */
  useCommandSandboxProbe(probe: () => Promise<CommandSandboxStatus>): () => void {
    this.commandSandboxProbe = probe
    return () => {
      if (this.commandSandboxProbe === probe) this.commandSandboxProbe = undefined
    }
  }

  /**
   * Register the host hook that persists `project`-scope approval grants
   * (the workspace/CLI writes `.nexgent/config.json`). Without one, approval
   * requests do not offer the `project` scope.
   * @returns the unregister function.
   */
  setProjectGrantWriter(writer: ProjectGrantWriter): () => void {
    this.grantWriter = writer
    return () => {
      if (this.grantWriter === writer) this.grantWriter = undefined
    }
  }

  /** Step 3: open members a root agent started, in start order. */
  membersOf(sessionId: string): readonly Agent[] {
    const agent = this.live.get(sessionId)
    const entry = agent === undefined ? undefined : this.entries.get(agent)
    return entry === undefined ? [] : [...entry.children]
  }

  /** Loop settings: a preset's `maxSteps` wins over the project's `maxStepsPerTurn`, which wins over this row's. */
  private settings(preset: AgentPreset | undefined, project: ProjectConfig): AgentSettings {
    const c = this.config
    return {
      thinking: c.thinking,
      effort: c.effort,
      ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }),
      systemPrompt: { persona: preset?.persona ?? c.systemPrompt.persona, suffix: c.systemPrompt.suffix },
      modelTimeoutMs: c.modelTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs,
      maxSteps: preset?.maxSteps ?? project.maxStepsPerTurn ?? c.maxSteps,
      maxPauseContinuations: c.maxPauseContinuations,
      maxOutputContinuations: c.maxOutputContinuations,
      checkpointEvery: c.checkpointEvery,
      toolAbortGraceMs: c.toolAbortGraceMs,
    }
  }

  private async projectConfig(override: LoadedProjectConfig | undefined): Promise<LoadedProjectConfig> {
    if (override !== undefined) return override
    return readProjectSettings(this.home.workspace.layout)
  }

  private async scope(sessionId: string): Promise<{ ctx: Context; fiber: Fiber; scope: ToolScope }> {
    const scope: ToolScope = { id: sessionId }
    let agentCtx: Context | undefined
    const fiber = this.home.extend({ [TOOL_SCOPE]: scope }).plugin({
      name: `agent:${sessionId}`,
      apply: (ctx: Context) => {
        agentCtx = ctx
      },
    })
    await fiber
    if (agentCtx === undefined) throw new NexgentError('internal', 'agent scope failed to start')
    return { ctx: agentCtx, fiber, scope }
  }

  /**
   * Narrow a member's tool scope: the parent's restrictions (live), then
   * `MEMBER_DENIED_TOOLS`, then the preset's `tools` (`permissions.md`
   * §子会话继承). Effects of the member's fiber.
   */
  private scopeMember(ctx: Context, parent: ToolScope, preset: AgentPreset | undefined): void {
    const tools = ctx.tools as ToolRegistryService
    if (typeof tools.inherit === 'function') tools.inherit(parent)
    tools.restrict({ deny: [...MEMBER_DENIED_TOOLS] })
    if (preset?.tools !== undefined) tools.restrict(preset.tools)
  }

  /**
   * Narrow a root session's tool scope by what it is for (step 5,
   * `permissions.md` §改进会话与改进预算): a diagnose session sees only the
   * diagnosis tools, a propose session no collaboration or `improve_*`
   * tools, and every other root session no `improve_*` tools. Effects of the
   * agent's fiber.
   */
  private scopeRoot(ctx: Context, run: ImprovementRun | undefined): void {
    const tools = ctx.tools as ToolRegistryService
    if (run?.phase === 'diagnose') {
      tools.restrict({ allow: IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name) })
    } else if (run?.phase === 'meta-diagnose') {
      tools.restrict({ allow: META_DIAGNOSIS_TOOLS.map(tool => tool.name) })
    } else if (run?.phase === 'meta-propose') {
      tools.restrict({ allow: META_PROPOSE_TOOLS.map(tool => tool.name) })
    } else if (run?.phase === 'propose') {
      tools.restrict({ deny: MEMBER_DENIED_TOOLS.filter(name => !name.startsWith('capability_')) })
    } else {
      tools.restrict({ deny: IMPROVE_TOOL_NAMES })
    }
  }

  private assertImprovement(run: ImprovementRun | undefined): ImprovementRun | undefined {
    if (run === undefined) return undefined
    if (typeof run.jobId !== 'string' || run.jobId === '' || !IMPROVEMENT_PHASES.includes(run.phase)) {
      throw new NexgentError('tool/invalid-input', `improvement must be { jobId, phase: ${IMPROVEMENT_PHASES.join(' | ')} }`)
    }
    if (run.improverVersion !== undefined && (typeof run.improverVersion !== 'string' || !IMPROVER_VERSION_PATTERN.test(run.improverVersion))) {
      throw new NexgentError('tool/invalid-input', 'improvement.improverVersion must be v0 or a 64-hex improver version')
    }
    if (run.improverScope !== undefined && !IMPROVER_SCOPES.includes(run.improverScope)) {
      throw new NexgentError('tool/invalid-input', `improvement.improverScope must be one of ${IMPROVER_SCOPES.join(' | ')}`)
    }
    if ((run.metaJobId === undefined) !== (run.comparisonArm === undefined)) {
      throw new NexgentError('tool/invalid-input', 'improvement.metaJobId and improvement.comparisonArm go together')
    }
    if (run.metaJobId !== undefined) {
      if (typeof run.metaJobId !== 'string' || run.metaJobId === '' || !COMPARISON_ARMS.includes(run.comparisonArm!)) {
        throw new NexgentError('tool/invalid-input', `improvement.metaJobId must be a job id and comparisonArm one of ${COMPARISON_ARMS.join(' | ')}`)
      }
      if (isMetaPhase(run.phase)) throw new NexgentError('tool/invalid-input', 'a meta phase is not part of a comparison arm')
    }
    return improvementRun(run)
  }

  /** The open root agent a member is started (or resumed) under. */
  private parentEntry(parentSessionId: string): AgentEntry {
    const parent = this.live.get(parentSessionId)
    const entry = parent === undefined ? undefined : this.entries.get(parent)
    if (parent === undefined || entry === undefined || parent.isClosed) {
      throw new NexgentError('session/not-found', `parent session ${parentSessionId} is not open in this process`)
    }
    if (parent.parentSessionId !== undefined) {
      throw denied(`session ${parentSessionId} is a member; members cannot start members (depth 1)`, { parentSessionId })
    }
    return entry
  }

  private assertMember(member: MemberIdentity): MemberIdentity {
    if (typeof member?.name !== 'string' || !MEMBER_NAME_PATTERN.test(member.name)) {
      throw new NexgentError('tool/invalid-input', `member name must match ${String(MEMBER_NAME_PATTERN)}`)
    }
    if (member.executionForm !== 'delegated' && member.executionForm !== 'team' && member.executionForm !== 'workflow') {
      throw new NexgentError('tool/invalid-input', `member executionForm must be delegated, team or workflow, got ${String(member.executionForm)}`)
    }
    return member
  }

  private assertMode(mode: SandboxMode): SandboxMode {
    if (!SANDBOX_MODES.includes(mode)) throw new NexgentError('config/invalid', `invalid sandbox mode "${String(mode)}"`)
    return mode
  }

  private build(args: {
    sessionId: string
    lock: SessionLock
    scope: { ctx: Context; fiber: Fiber; scope: ToolScope }
    model: string
    thinking: 'off' | 'on'
    effort: Effort
    sandboxMode: SandboxMode
    plan?: boolean
    projectConfig: ProjectConfig
    history: AgentInit['history']
    lastTurn: number
    lastSeq: number
    lastCheckpointSeq: number
    lastUsage?: AgentInit['lastUsage']
    grants: AgentInit['sessionGrants']
    tree: TaskTree
    settings: AgentSettings
    member?: { identity: MemberIdentity; parent: AgentEntry; budget: BudgetShare | undefined }
    capabilities?: CapabilityLoad
    improvement?: ImprovementRun
    workdir?: MemberWorkdir
  }): Agent {
    const { member } = args
    const children = new Set<Agent>()
    const attribution: AgentAttribution = member === undefined
      ? { taskId: args.tree.taskId, memberId: MAIN_MEMBER_ID, executionForm: 'direct' }
      : { taskId: args.tree.taskId, memberId: args.sessionId, executionForm: member.identity.executionForm }
    const agent = new Agent({
      sessionId: args.sessionId,
      // Optional step-2 services, looked up per turn without an inject requirement.
      services: () => ({
        context: this.home.get('context'),
        tasking: this.home.get('tasking'),
        capabilityHost: this.home.get('capabilityHost'),
        taskRecorder: this.home.get('taskRecorder'),
        improve: this.home.get('improve'),
        workdirs: this.home.get('workdirs'),
        organizer: this.home.get('organizer'),
      }),
      lock: args.lock,
      ctx: args.scope.ctx,
      fiber: args.scope.fiber,
      llm: this.home.llm,
      session: this.home.session,
      ledger: this.home.ledger,
      workspace: this.home.workspace,
      approvals: this.home.approvals as ApprovalBrokerService,
      tools: args.scope.ctx.tools,
      model: args.model,
      thinking: args.thinking,
      effort: args.effort,
      sandboxMode: args.sandboxMode,
      ...(args.plan === true ? { plan: true } : {}),
      settings: args.settings,
      projectConfig: args.projectConfig,
      history: args.history,
      lastTurn: args.lastTurn,
      lastSeq: args.lastSeq,
      lastCheckpointSeq: args.lastCheckpointSeq,
      ...(args.lastUsage === undefined ? {} : { lastUsage: args.lastUsage }),
      sessionGrants: args.grants,
      projectGrantWriter: () => this.grantWriter,
      tree: args.tree,
      attribution,
      ...(member === undefined
        ? {}
        : {
          member: member.identity,
          parentSessionId: member.parent.agent.sessionId,
          ...(member.budget === undefined ? {} : { budget: member.budget }),
        }),
      children: () => [...children],
      ...(args.capabilities === undefined ? {} : { capabilityVersion: args.capabilities.version, attached: args.capabilities.attached }),
      ...(args.improvement === undefined ? {} : { improvement: args.improvement }),
      ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
      onClose: closed => {
        if (this.live.get(closed.sessionId) === closed) this.live.delete(closed.sessionId)
        this.entries.delete(closed)
        member?.parent.children.delete(closed)
        for (const listener of this.closeListeners) {
          try {
            listener(closed.sessionId)
          } catch {
            // A listener's failure does not stop the close.
          }
        }
      },
    })
    this.live.set(agent.sessionId, agent)
    this.entries.set(agent, {
      agent,
      scope: args.scope.scope,
      tree: args.tree,
      thinking: args.thinking,
      effort: args.effort,
      projectConfig: args.projectConfig,
      children,
    })
    member?.parent.children.add(agent)
    if (member !== undefined) args.tree.addMember(agent.sessionId, member.identity.name, member.identity.executionForm)
    return agent
  }

  /** The capability host, when `@nexgent/capabilities` is installed (step 4). */
  private capabilityHost(): CapabilityHost | undefined {
    return this.home.get('capabilityHost')
  }

  /**
   * Load `version` into a new agent scope (step 4, `agent-hooks.md` §步骤 4).
   * A failed load writes `capability.version { reason: 'load-failure' }` and
   * the session runs on `baseline`.
   */
  private async loadCapabilities(
    host: CapabilityHost,
    input: { sessionId: string; scope: Context; version: CapabilityVersion; resumed: boolean; member?: MemberIdentity; parentSessionId?: string },
  ): Promise<CapabilityLoad> {
    const attach = (version: CapabilityVersion) => host.attach({
      ctx: input.scope,
      sessionId: input.sessionId,
      version,
      resumed: input.resumed,
      ...(input.member === undefined ? {} : { member: input.member }),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    })
    try {
      return { version: input.version, attached: (await attach(input.version)).components }
    } catch (error) {
      if (input.version === BASELINE_VERSION) throw error
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      const written = await this.home.session.append(input.sessionId, {
        type: 'capability.version',
        version: BASELINE_VERSION,
        previous: input.version,
        reason: 'load-failure',
        ...(detail === '' ? {} : { detail }),
      })
      return { version: BASELINE_VERSION, attached: (await attach(BASELINE_VERSION)).components, lastSeq: written.seq }
    }
  }

  /** A resumed member runs on its root's version; a different recorded one is switched with `capability.version { reason: 'unavailable' }`. */
  private async followRoot(sessionId: string, recorded: CapabilityVersion | undefined, rootVersion: CapabilityVersion): Promise<{ version: CapabilityVersion; lastSeq?: number }> {
    const previous = recorded ?? BASELINE_VERSION
    if (previous === rootVersion) return { version: rootVersion }
    const written = await this.home.session.append(sessionId, {
      type: 'capability.version',
      version: rootVersion,
      previous,
      reason: 'unavailable',
      detail: 'the member follows its root session\'s version',
    })
    return { version: rootVersion, lastSeq: written.seq }
  }

  /**
   * On resume (step 4): keep the recorded version when it still verifies
   * (a session from before step 4 counts as `baseline`); otherwise switch to
   * the adopted version and write `capability.version { reason: 'unavailable' }`.
   */
  private async resumeVersion(host: CapabilityHost, sessionId: string, recorded: CapabilityVersion | undefined): Promise<{ version: CapabilityVersion; lastSeq?: number }> {
    const previous = recorded ?? BASELINE_VERSION
    const check = await host.verify(previous)
    if (check.ok) return { version: previous }
    const version = await host.current()
    const written = await this.home.session.append(sessionId, {
      type: 'capability.version',
      version,
      previous,
      reason: 'unavailable',
      ...(check.detail === '' ? {} : { detail: check.detail.slice(0, 500) }),
    })
    return { version, lastSeq: written.seq }
  }

  /** Create a session (`session.start`) and an agent on it; with `child`, a member under an open root agent. */
  async create(options: CreateAgentOptions = {}): Promise<Agent> {
    if (options.child !== undefined) {
      if (options.improvement !== undefined) throw new NexgentError('tool/invalid-input', 'a member session cannot belong to an improvement job')
      return this.createChild(options, options.child)
    }
    const improvement = this.assertImprovement(options.improvement)
    const session: SessionImprovement | undefined = improvement === undefined || improvement.phase === 'trial'
      ? undefined
      : { ...improvement, phase: improvement.phase }
    const loaded = await this.projectConfig(options.projectConfig)
    const sessionId = options.sessionId ?? randomUUID()
    const model = options.model ?? loaded.input.model ?? this.config.model ?? this.home.llm.info.defaultModel
    const sandboxMode = this.assertMode(options.sandboxMode ?? loaded.config.sandboxMode)
    const thinking = options.thinking ?? loaded.input.thinking ?? this.config.thinking
    const effort = loaded.input.effort ?? this.config.effort
    await this.home.workspace.ensureLayout()
    // Step 4: a new root session runs on the adopted version as of now; a diagnose or meta session loads no components.
    const host = loadsNoComponents(improvement) ? undefined : this.capabilityHost()
    const version = host === undefined ? undefined : await host.current()
    const commandSandbox = options.commandSandbox ?? await this.commandSandboxProbe?.()
    const lock = await this.home.session.create({
      sessionId,
      projectRoot: this.home.workspace.root,
      model,
      sandboxMode,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(version === undefined ? {} : { capabilityVersion: version }),
      ...(session === undefined ? {} : { purpose: 'improvement' as const, improvement: session }),
      ...(options.plan === true ? { plan: true } : {}),
      ...(commandSandbox === undefined ? {} : { commandSandbox }),
    })
    try {
      const scope = await this.scope(sessionId)
      let capabilities: CapabilityLoad | undefined
      try {
        this.scopeRoot(scope.ctx, improvement)
        capabilities = host === undefined || version === undefined
          ? undefined
          : await this.loadCapabilities(host, { sessionId, scope: scope.ctx, version, resumed: false })
      } catch (error) {
        await scope.fiber.dispose()
        throw error
      }
      return this.build({
        sessionId,
        lock,
        scope,
        model,
        thinking,
        effort,
        sandboxMode,
        ...(options.plan === true ? { plan: true } : {}),
        projectConfig: loaded.config,
        history: [],
        lastTurn: 0,
        lastSeq: capabilities?.lastSeq ?? 1,
        lastCheckpointSeq: 0,
        grants: [],
        tree: new TaskTree(sessionId, loaded.config.costCaps.perTask, [...loaded.config.approvals]),
        settings: this.settings(undefined, loaded.config),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(improvement === undefined ? {} : { improvement }),
      })
    } catch (error) {
      await this.home.session.release(lock).catch(() => undefined)
      throw error
    }
  }

  /**
   * Rework K4 D4: the member's own copy of the project, when the tasking
   * host can make one. Any failure leaves the member in the project
   * directory, as before.
   */
  private async openWorkdir(sessionId: string, sandboxMode: SandboxMode): Promise<MemberWorkdir | undefined> {
    const workdirs = this.home.get('workdirs')
    if (workdirs === undefined || sandboxMode === 'read-only') return undefined
    try {
      return await workdirs.open({ sessionId, sandboxMode })
    } catch {
      return undefined
    }
  }

  private async createChild(options: CreateAgentOptions, child: ChildAgentOptions): Promise<Agent> {
    const parent = this.parentEntry(child.parentSessionId)
    const preset = child.preset
    const identity = this.assertMember({
      ...child.member,
      ...(child.member?.preset === undefined && preset !== undefined ? { preset: preset.name } : {}),
    })
    const sandboxMode = childSandboxMode(parent.agent.sandboxMode, preset?.sandboxMode, child.sandboxMode)
    const tree = parent.tree
    if (tree.members >= COLLABORATION_LIMITS.maxMembersPerTask) {
      throw denied(`a task may start at most ${COLLABORATION_LIMITS.maxMembersPerTask} members`, { limit: COLLABORATION_LIMITS.maxMembersPerTask })
    }
    const mode = child.mode ?? 'fresh'
    if (mode !== 'fresh' && mode !== 'fork') throw new NexgentError('tool/invalid-input', `delegation mode must be fresh or fork, got ${String(mode)}`)
    // The parent's history is read before anything is written, so a fork never sees a later turn.
    const seed = mode === 'fork' ? parent.agent.forkSeed() : undefined
    const sessionId = options.sessionId ?? randomUUID()
    const model = preset?.model ?? parent.agent.model
    // Step 4: members run on their root's version.
    const host = this.capabilityHost()
    const version = host === undefined ? undefined : parent.agent.capabilityVersion
    const lock = await this.home.session.create({
      sessionId,
      projectRoot: this.home.workspace.root,
      model,
      sandboxMode,
      parentSessionId: parent.agent.sessionId,
      member: identity,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(version === undefined ? {} : { capabilityVersion: version }),
    })
    try {
      let lastSeq = 1
      if (seed !== undefined) {
        const written = await this.home.session.append(sessionId, {
          type: 'fork.seed',
          fromSessionId: parent.agent.sessionId,
          throughSeq: seed.throughSeq,
          messages: [...seed.messages],
        })
        lastSeq = written.seq
      }
      const scope = await this.scope(sessionId)
      let capabilities: CapabilityLoad | undefined
      try {
        this.scopeMember(scope.ctx, parent.scope, preset)
        capabilities = host === undefined || version === undefined
          ? undefined
          : await this.loadCapabilities(host, { sessionId, scope: scope.ctx, version, resumed: false, member: identity, parentSessionId: parent.agent.sessionId })
      } catch (error) {
        await scope.fiber.dispose()
        throw error
      }
      if (capabilities?.lastSeq !== undefined) lastSeq = capabilities.lastSeq
      const workdir = await this.openWorkdir(sessionId, sandboxMode)
      tree.members += 1
      tree.use(identity.executionForm)
      return this.build({
        sessionId,
        lock,
        scope,
        model,
        thinking: preset?.thinking ?? parent.thinking,
        effort: preset?.effort ?? parent.effort,
        sandboxMode,
        projectConfig: parent.projectConfig,
        history: seed?.messages ?? [],
        lastTurn: 0,
        lastSeq,
        lastCheckpointSeq: 0,
        grants: [],
        tree,
        settings: this.settings(preset, parent.projectConfig),
        member: { identity, parent, budget: child.budget },
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(workdir === undefined ? {} : { workdir }),
      })
    } catch (error) {
      await this.home.session.release(lock).catch(() => undefined)
      throw error
    }
  }

  /**
   * Lock and resume a session. When the previous process died inside a
   * turn, this writes `turn.end { kind: 'interrupted' }` (unless the store
   * already closed it) before returning the agent. A child session is
   * resumed only with `child`, under its live parent.
   */
  async resume(sessionId: string, options: ResumeAgentOptions = {}): Promise<Agent> {
    if (this.live.has(sessionId)) throw new NexgentError('session/locked', `session ${sessionId} is already open in this process`)
    const parent = options.child === undefined ? undefined : this.parentEntry(options.child.parentSessionId)
    const loaded = parent === undefined ? await this.projectConfig(options.projectConfig) : undefined
    // The command sandbox is ready before the session runs anything, as for a new session (ADR 0022).
    await this.commandSandboxProbe?.().catch(() => undefined)
    const session = this.home.session
    const lock = await session.lock(sessionId)
    try {
      let state = await session.resume(sessionId)
      const { member, parentSessionId } = state.metadata
      // Step 5: an improvement session's job is in its header; a trial session's comes from the caller.
      const recordedJob = state.metadata.improvement
      if (recordedJob !== undefined && options.improvement !== undefined) {
        throw new NexgentError('tool/invalid-input', `session ${sessionId} is an improvement session; its job comes from its header`)
      }
      if (parent !== undefined && options.improvement !== undefined) {
        throw new NexgentError('tool/invalid-input', 'a member session cannot belong to an improvement job')
      }
      const improvement = recordedJob !== undefined
        ? improvementRun(recordedJob)
        : this.assertImprovement(options.improvement)
      if (recordedJob === undefined && improvement !== undefined && improvement.phase !== 'trial') {
        throw new NexgentError('tool/invalid-input', `session ${sessionId} is not an improvement session; only phase trial can be given on resume`)
      }
      if (parent === undefined && parentSessionId !== undefined) {
        throw denied(`session ${sessionId} is a member of ${parentSessionId}; resume it with child options under its open parent`, { parentSessionId })
      }
      if (parent !== undefined && (member === undefined || parentSessionId !== parent.agent.sessionId)) {
        throw denied(`session ${sessionId} is not a member of ${parent.agent.sessionId}`, { parentSessionId: parentSessionId ?? null })
      }
      const preset = parent === undefined ? undefined : options.preset
      // Re-check the narrowing: the parent may have been reopened in a narrower mode.
      const sandboxMode = parent === undefined
        ? this.assertMode(options.sandboxMode ?? state.metadata.sandboxMode)
        : childSandboxMode(parent.agent.sandboxMode, state.metadata.sandboxMode, preset?.sandboxMode, options.sandboxMode)
      if (state.metadata.openTurn !== undefined) {
        await session.append(sessionId, { type: 'turn.end', turn: state.metadata.openTurn, reason: { kind: 'interrupted' } })
        state = await session.resume(sessionId)
      }
      // Step 4: keep the recorded version when it still loads; a member follows its root; a diagnose or meta session loads none.
      const host = loadsNoComponents(improvement) ? undefined : this.capabilityHost()
      let switched: { version: CapabilityVersion; lastSeq?: number } | undefined
      if (host !== undefined) {
        const recorded = state.metadata.capabilityVersion
        const rootVersion = parent?.agent.capabilityVersion
        switched = parent === undefined || rootVersion === undefined
          ? await this.resumeVersion(host, sessionId, recorded)
          : await this.followRoot(sessionId, recorded, rootVersion)
      }
      const checkpoint = await session.latestCheckpoint(sessionId)
      const scope = await this.scope(sessionId)
      let capabilities: CapabilityLoad | undefined
      try {
        if (parent !== undefined) this.scopeMember(scope.ctx, parent.scope, preset)
        else this.scopeRoot(scope.ctx, improvement)
        if (host !== undefined && switched !== undefined) {
          const loadedCaps = await this.loadCapabilities(host, {
            sessionId,
            scope: scope.ctx,
            version: switched.version,
            resumed: true,
            ...(member === undefined ? {} : { member }),
            ...(parentSessionId === undefined ? {} : { parentSessionId }),
          })
          const seq = Math.max(state.metadata.lastSeq, switched.lastSeq ?? 0, loadedCaps.lastSeq ?? 0)
          capabilities = { ...loadedCaps, lastSeq: seq }
        }
      } catch (error) {
        await scope.fiber.dispose()
        throw error
      }
      const projectConfig = parent?.projectConfig ?? loaded!.config
      const workdir = parent === undefined ? undefined : await this.openWorkdir(sessionId, sandboxMode)
      const agent = await this.build({
        sessionId,
        lock,
        scope,
        model: options.model ?? preset?.model ?? state.metadata.model,
        thinking: parent === undefined ? options.thinking ?? loaded!.input.thinking ?? this.config.thinking : preset?.thinking ?? parent.thinking,
        effort: parent === undefined ? loaded!.input.effort ?? this.config.effort : preset?.effort ?? parent.effort,
        sandboxMode,
        ...(state.metadata.plan === true && parent === undefined ? { plan: true } : {}),
        projectConfig,
        history: state.messages,
        lastTurn: state.metadata.lastTurn,
        lastSeq: capabilities?.lastSeq ?? state.metadata.lastSeq,
        lastCheckpointSeq: checkpoint?.seq ?? 0,
        ...(state.metadata.lastUsage === undefined ? {} : { lastUsage: state.metadata.lastUsage }),
        grants: state.metadata.grants,
        tree: parent?.tree ?? new TaskTree(sessionId, projectConfig.costCaps.perTask, [...projectConfig.approvals]),
        settings: this.settings(preset, projectConfig),
        ...(parent === undefined || member === undefined ? {} : { member: { identity: member, parent, budget: options.child?.budget } }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(improvement === undefined ? {} : { improvement }),
        ...(workdir === undefined ? {} : { workdir }),
      })
      // A reopened member works in this tree too: its form counts in the root's `formsUsed`.
      if (parent !== undefined && member !== undefined) parent.tree.use(member.executionForm)
      return agent
    } catch (error) {
      await session.release(lock).catch(() => undefined)
      throw error
    }
  }

  /** Cancel running turns (cause `shutdown`) and close every agent; root agents close their members (cause `parent`). */
  async shutdown(): Promise<void> {
    const agents = [...this.live.values()]
    await Promise.allSettled(agents.filter(agent => agent.parentSessionId === undefined).map(agent => agent.close()))
    await Promise.allSettled(agents.map(agent => agent.close()))
    this.live.clear()
    this.entries.clear()
  }
}
