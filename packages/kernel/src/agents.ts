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
import type { ProjectConfig } from './contracts/config.js'
import { NexgentError } from './contracts/errors.js'
import type { SessionLock } from './contracts/session.js'
import type { SandboxMode } from './contracts/workspace.js'
import { SANDBOX_MODES } from './contracts/workspace.js'
import { Agent, type AgentInit, type AgentSettings, type ProjectGrantWriter } from './agent.js'
import { readProjectConfig, type LoadedProjectConfig } from './project-config.js'
import { DEFAULT_PERSONA, DEFAULT_PERSONA_SUFFIX } from './system-prompt.js'
import { TOOL_SCOPE, type ToolScope } from './tools.js'
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
}

/** Options of {@link AgentsService.resume}. */
export interface ResumeAgentOptions {
  /** Sandbox override; else the session header's mode. */
  readonly sandboxMode?: SandboxMode
  /** Model override; else the session header's model. */
  readonly model?: string
  readonly projectConfig?: LoadedProjectConfig
}

/** The `ctx.agents` service. */
export class AgentsService extends Service {
  static readonly inject = ['llm', 'session', 'ledger', 'workspace', 'tools', 'approvals']

  static readonly Config: Schema<AgentsConfig> = Schema.object({
    model: Schema.string().description('Default model id.'),
    thinking: Schema.union(['off', 'on'] as const).default('off').description('Reasoning mode; execution uses off.'),
    maxTokens: Schema.natural().description('Output token cap per request.'),
    systemPrompt: Schema.object({
      persona: Schema.string().default(DEFAULT_PERSONA),
      suffix: Schema.string().default(DEFAULT_PERSONA_SUFFIX),
    }).default({ persona: DEFAULT_PERSONA, suffix: DEFAULT_PERSONA_SUFFIX }),
    modelTimeoutMs: Schema.natural().default(180_000),
    streamIdleTimeoutMs: Schema.natural().default(180_000),
    maxSteps: Schema.natural().min(1).default(64),
    checkpointEvery: Schema.natural().default(0)
      .description('Kernel-side checkpoint threshold; 0 (default) leaves the data-formats.md policy to the session store.'),
    toolAbortGraceMs: Schema.natural().default(5_000),
  }) as Schema<AgentsConfig>

  private readonly home: Context
  private readonly config: AgentsConfig
  private readonly live = new Map<string, Agent>()
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

  private settings(): AgentSettings {
    const c = this.config
    return {
      thinking: c.thinking,
      ...(c.maxTokens === undefined ? {} : { maxTokens: c.maxTokens }),
      systemPrompt: { persona: c.systemPrompt.persona, suffix: c.systemPrompt.suffix },
      modelTimeoutMs: c.modelTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs,
      maxSteps: c.maxSteps,
      checkpointEvery: c.checkpointEvery,
      toolAbortGraceMs: c.toolAbortGraceMs,
    }
  }

  private async projectConfig(override: LoadedProjectConfig | undefined): Promise<LoadedProjectConfig> {
    if (override !== undefined) return override
    return readProjectConfig(this.home.workspace.layout.configFile)
  }

  private async scope(sessionId: string): Promise<{ ctx: Context; fiber: Fiber }> {
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
    return { ctx: agentCtx, fiber }
  }

  private assertMode(mode: SandboxMode): SandboxMode {
    if (!SANDBOX_MODES.includes(mode)) throw new NexgentError('config/invalid', `invalid sandbox mode "${String(mode)}"`)
    return mode
  }

  private build(args: {
    sessionId: string
    lock: SessionLock
    scope: { ctx: Context; fiber: Fiber }
    model: string
    thinking: 'off' | 'on'
    sandboxMode: SandboxMode
    projectConfig: ProjectConfig
    history: AgentInit['history']
    lastTurn: number
    lastSeq: number
    lastCheckpointSeq: number
    grants: AgentInit['sessionGrants']
  }): Agent {
    return this.newAgent({
      sessionId: args.sessionId,
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
      sandboxMode: args.sandboxMode,
      settings: this.settings(),
      projectConfig: args.projectConfig,
      history: args.history,
      lastTurn: args.lastTurn,
      lastSeq: args.lastSeq,
      lastCheckpointSeq: args.lastCheckpointSeq,
      sessionGrants: args.grants,
      projectGrantWriter: () => this.grantWriter,
      onClose: agent => {
        if (this.live.get(agent.sessionId) === agent) this.live.delete(agent.sessionId)
      },
    })
  }

  private newAgent(init: AgentInit): Agent {
    const agent = new Agent(init)
    this.live.set(agent.sessionId, agent)
    return agent
  }

  /** Create a session (`session.start`) and an agent on it. */
  async create(options: CreateAgentOptions = {}): Promise<Agent> {
    const loaded = await this.projectConfig(options.projectConfig)
    const sessionId = options.sessionId ?? randomUUID()
    const model = options.model ?? loaded.input.model ?? this.config.model ?? this.home.llm.info.defaultModel
    const sandboxMode = this.assertMode(options.sandboxMode ?? loaded.config.sandboxMode)
    const thinking = loaded.input.thinking ?? this.config.thinking
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
        sandboxMode,
        projectConfig: loaded.config,
        history: [],
        lastTurn: 0,
        lastSeq: 1,
        lastCheckpointSeq: 0,
        grants: [],
      })
    } catch (error) {
      await this.home.session.release(lock).catch(() => undefined)
      throw error
    }
  }

  /**
   * Lock and resume a session. When the previous process died inside a
   * turn, this writes `turn.end { kind: 'interrupted' }` (unless the store
   * already closed it) before returning the agent.
   */
  async resume(sessionId: string, options: ResumeAgentOptions = {}): Promise<Agent> {
    if (this.live.has(sessionId)) throw new NexgentError('session/locked', `session ${sessionId} is already open in this process`)
    const loaded = await this.projectConfig(options.projectConfig)
    const session = this.home.session
    const lock = await session.lock(sessionId)
    try {
      let state = await session.resume(sessionId)
      if (state.metadata.openTurn !== undefined) {
        await session.append(sessionId, { type: 'turn.end', turn: state.metadata.openTurn, reason: { kind: 'interrupted' } })
        state = await session.resume(sessionId)
      }
      const checkpoint = await session.latestCheckpoint(sessionId)
      const scope = await this.scope(sessionId)
      return this.build({
        sessionId,
        lock,
        scope,
        model: options.model ?? state.metadata.model,
        thinking: loaded.input.thinking ?? this.config.thinking,
        sandboxMode: this.assertMode(options.sandboxMode ?? state.metadata.sandboxMode),
        projectConfig: loaded.config,
        history: state.messages,
        lastTurn: state.metadata.lastTurn,
        lastSeq: state.metadata.lastSeq,
        lastCheckpointSeq: checkpoint?.seq ?? 0,
        grants: state.metadata.grants,
      })
    } catch (error) {
      await session.release(lock).catch(() => undefined)
      throw error
    }
  }

  /** Cancel running turns (cause `shutdown`) and close every agent. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map(agent => agent.close()))
    this.live.clear()
  }
}
