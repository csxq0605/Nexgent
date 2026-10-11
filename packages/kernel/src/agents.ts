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
import type { ProjectConfig } from './contracts/config.js'
import { NexgentError } from './contracts/errors.js'
import { EFFORT_LEVELS, type Effort } from './contracts/llm.js'
import type { SessionLock } from './contracts/session.js'
import type { SandboxMode } from './contracts/workspace.js'
import { SANDBOX_MODES } from './contracts/workspace.js'
import { Agent, type AgentInit, type AgentSettings, type ProjectGrantWriter } from './agent.js'
import { readProjectConfig, type LoadedProjectConfig } from './project-config.js'
import { DEFAULT_PERSONA, DEFAULT_PERSONA_SUFFIX } from './system-prompt.js'
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
  /** Max model calls per turn. */
  maxSteps: number
  /** Max consecutive paused replies (`pause_turn`) continued automatically. */
  maxPauseContinuations: number
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

/** Rejection of a member request that breaks the collaboration rules. */
function denied(message: string, details?: Record<string, unknown>): NexgentError {
  return new NexgentError('tool/denied', message, details === undefined ? {} : { details })
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
    maxSteps: Schema.natural().min(1).default(64),
    maxPauseContinuations: Schema.natural().default(8).description('Consecutive pause_turn replies continued automatically before the turn ends with an error.'),
    checkpointEvery: Schema.natural().default(0)
      .description('Kernel-side checkpoint threshold; 0 (default) leaves the data-formats.md policy to the session store.'),
    toolAbortGraceMs: Schema.natural().default(5_000),
  }) as Schema<AgentsConfig>

  private readonly home: Context
  private readonly config: AgentsConfig
  private readonly live = new Map<string, Agent>()
  private readonly entries = new Map<Agent, AgentEntry>()
  private grantWriter: ProjectGrantWriter | undefined

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

  private settings(preset?: AgentPreset): AgentSettings {
    const c = this.config
    return {
      thinking: c.thinking,
      effort: c.effort,
      ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }),
      systemPrompt: { persona: preset?.persona ?? c.systemPrompt.persona, suffix: c.systemPrompt.suffix },
      modelTimeoutMs: c.modelTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs,
      maxSteps: preset?.maxSteps ?? c.maxSteps,
      maxPauseContinuations: c.maxPauseContinuations,
      checkpointEvery: c.checkpointEvery,
      toolAbortGraceMs: c.toolAbortGraceMs,
    }
  }

  private async projectConfig(override: LoadedProjectConfig | undefined): Promise<LoadedProjectConfig> {
    if (override !== undefined) return override
    return readProjectConfig(this.home.workspace.layout.configFile)
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
    projectConfig: ProjectConfig
    history: AgentInit['history']
    lastTurn: number
    lastSeq: number
    lastCheckpointSeq: number
    grants: AgentInit['sessionGrants']
    tree: TaskTree
    settings: AgentSettings
    member?: { identity: MemberIdentity; parent: AgentEntry; budget: BudgetShare | undefined }
  }): Agent {
    const { member } = args
    const children = new Set<Agent>()
    const attribution: AgentAttribution = member === undefined
      ? { taskId: args.tree.taskId, memberId: MAIN_MEMBER_ID, executionForm: 'direct' }
      : { taskId: args.tree.taskId, memberId: args.sessionId, executionForm: member.identity.executionForm }
    const agent = new Agent({
      sessionId: args.sessionId,
      // Optional step-2 services, looked up per turn without an inject requirement.
      services: () => ({ context: this.home.get('context'), tasking: this.home.get('tasking') }),
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
      settings: args.settings,
      projectConfig: args.projectConfig,
      history: args.history,
      lastTurn: args.lastTurn,
      lastSeq: args.lastSeq,
      lastCheckpointSeq: args.lastCheckpointSeq,
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
      onClose: closed => {
        if (this.live.get(closed.sessionId) === closed) this.live.delete(closed.sessionId)
        this.entries.delete(closed)
        member?.parent.children.delete(closed)
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
    return agent
  }

  /** Create a session (`session.start`) and an agent on it; with `child`, a member under an open root agent. */
  async create(options: CreateAgentOptions = {}): Promise<Agent> {
    if (options.child !== undefined) return this.createChild(options, options.child)
    const loaded = await this.projectConfig(options.projectConfig)
    const sessionId = options.sessionId ?? randomUUID()
    const model = options.model ?? loaded.input.model ?? this.config.model ?? this.home.llm.info.defaultModel
    const sandboxMode = this.assertMode(options.sandboxMode ?? loaded.config.sandboxMode)
    const thinking = loaded.input.thinking ?? this.config.thinking
    const effort = loaded.input.effort ?? this.config.effort
    await this.home.workspace.ensureLayout()
    const lock = await this.home.session.create({
      sessionId,
      projectRoot: this.home.workspace.root,
      model,
      sandboxMode,
      ...(options.title === undefined ? {} : { title: options.title }),
    })
    try {
      const scope = await this.scope(sessionId)
      return this.build({
        sessionId,
        lock,
        scope,
        model,
        thinking,
        effort,
        sandboxMode,
        projectConfig: loaded.config,
        history: [],
        lastTurn: 0,
        lastSeq: 1,
        lastCheckpointSeq: 0,
        grants: [],
        tree: new TaskTree(sessionId, loaded.config.costCaps.perTask, [...loaded.config.approvals]),
        settings: this.settings(),
      })
    } catch (error) {
      await this.home.session.release(lock).catch(() => undefined)
      throw error
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
    const lock = await this.home.session.create({
      sessionId,
      projectRoot: this.home.workspace.root,
      model,
      sandboxMode,
      parentSessionId: parent.agent.sessionId,
      member: identity,
      ...(options.title === undefined ? {} : { title: options.title }),
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
      try {
        this.scopeMember(scope.ctx, parent.scope, preset)
      } catch (error) {
        await scope.fiber.dispose()
        throw error
      }
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
        settings: this.settings(preset),
        member: { identity, parent, budget: child.budget },
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
    const session = this.home.session
    const lock = await session.lock(sessionId)
    try {
      let state = await session.resume(sessionId)
      const { member, parentSessionId } = state.metadata
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
      const checkpoint = await session.latestCheckpoint(sessionId)
      const scope = await this.scope(sessionId)
      if (parent !== undefined) {
        try {
          this.scopeMember(scope.ctx, parent.scope, preset)
        } catch (error) {
          await scope.fiber.dispose()
          throw error
        }
      }
      const projectConfig = parent?.projectConfig ?? loaded!.config
      return this.build({
        sessionId,
        lock,
        scope,
        model: options.model ?? preset?.model ?? state.metadata.model,
        thinking: parent === undefined ? loaded!.input.thinking ?? this.config.thinking : preset?.thinking ?? parent.thinking,
        effort: parent === undefined ? loaded!.input.effort ?? this.config.effort : preset?.effort ?? parent.effort,
        sandboxMode,
        projectConfig,
        history: state.messages,
        lastTurn: state.metadata.lastTurn,
        lastSeq: state.metadata.lastSeq,
        lastCheckpointSeq: checkpoint?.seq ?? 0,
        grants: state.metadata.grants,
        tree: parent?.tree ?? new TaskTree(sessionId, projectConfig.costCaps.perTask, [...projectConfig.approvals]),
        settings: this.settings(preset),
        ...(parent === undefined || member === undefined ? {} : { member: { identity: member, parent, budget: options.child?.budget } }),
      })
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
