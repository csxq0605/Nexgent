/**
 * Plain factories and the Cordis plugin for `@nexgent/workspace`.
 */
import { NexgentError, SANDBOX_MODES, type ApprovalGrant, type Context, type SandboxMode, type ToolRegistry } from '@nexgent/kernel'
import { loadProjectConfig, type LoadedProjectConfig, type SystemSandboxSetting } from './config.js'
import { createOsSandbox, type OsSandbox, type OsSandboxStatus } from './os-sandbox.js'
import { BackgroundShells, LocalProcessRunner, type ProcessRunnerOptions } from './process.js'
import { Redactor } from './redact.js'
import { createSandbox, OUTSIDE_WRITE_GRANT, type LocalSandbox } from './sandbox.js'
import type { WorkspaceTool } from './tools/common.js'
import { readFileTool, strReplaceTool, writeFileTool } from './tools/fs.js'
import { listFilesTool, searchTextTool } from './tools/search.js'
import { shellTools, type ShellSandboxDeps } from './tools/shell.js'
import { openWorkspace, type LocalWorkspace } from './workspace.js'

/** Options for {@link createWorkspaceServices} and the plugin config. */
export interface WorkspaceServicesOptions {
  /** Project directory (absolute, or relative to `process.cwd()`); default `process.cwd()`. */
  readonly root?: string
  /** Create the directory and `.nexgent/` layout when missing (default `true`). */
  readonly create?: boolean
  /** Sandbox mode override (CLI `--sandbox`); else `config.json.sandboxMode`, else `workspace-write`. */
  readonly sandboxMode?: SandboxMode
  /** Per-stream output cap for commands (default 64 KiB). */
  readonly maxOutputBytes?: number
  /** Tree-kill grace period (default 5000 ms). */
  readonly graceMs?: number
  /** Extra literal secret values to redact (e.g. the loaded API key). */
  readonly secrets?: readonly string[]
  /** Base for session temp dirs (default `os.tmpdir()`). */
  readonly tempBase?: string
  /** Shell tools for this platform (default `process.platform`). */
  readonly platform?: NodeJS.Platform
  /** Nexgent home that holds the project's data (default `$NEXGENT_HOME` or `~/.nexgent`). */
  readonly home?: string
  /** Override `commands.systemSandbox` (ADR 0022); else the project config, else `auto`. */
  readonly systemSandbox?: SystemSandboxSetting
  /** The OS sandbox to use (tests inject one); default one shared per process. */
  readonly osSandbox?: OsSandbox
}

/** Everything the package provides, wired together. */
export interface WorkspaceServices {
  readonly workspace: LocalWorkspace
  readonly config: LoadedProjectConfig
  readonly sandbox: LocalSandbox
  /** Background commands of every session (ADR 0022 decision 6). */
  readonly background: BackgroundShells
  /** Whether commands run in an OS sandbox here; resolves once the trial command ran. */
  commandSandbox(): Promise<{ kind: 'active'; platform: string } | { kind: 'none'; reason: string } | { kind: 'off' }>
  /** End background commands and release the OS sandbox. */
  dispose(): Promise<void>
  readonly processes: LocalProcessRunner
  readonly redactor: Redactor
  /** File, search and shell tools (each with `preflight`). */
  readonly tools: readonly WorkspaceTool[]
}

/** Open the project, load its config, and build sandbox, runner and tools. */
export async function createWorkspaceServices(options: WorkspaceServicesOptions): Promise<WorkspaceServices> {
  const create = options.create ?? true
  if (options.sandboxMode !== undefined && !SANDBOX_MODES.includes(options.sandboxMode)) {
    throw new NexgentError('config/invalid', `invalid sandbox mode: ${String(options.sandboxMode)}`, { details: { field: 'sandboxMode' } })
  }
  const workspace = await openWorkspace(options.root ?? process.cwd(), { create, ensureLayout: create, ...(options.home === undefined ? {} : { home: options.home }) })
  const config = await loadProjectConfig(workspace.layout)
  const sandbox = await createSandbox({
    root: workspace.root,
    mode: options.sandboxMode ?? config.sandboxMode,
    // Material copies and deliverables stay readable after they moved out of the project (K1).
    extraReadRoots: workspace.layout.location === 'user-data' ? [...config.extraReadRoots, workspace.layout.materials, workspace.layout.outputs] : config.extraReadRoots,
    extraWriteRoots: config.extraWriteRoots,
    commands: { network: config.commands.network },
    ...(options.home === undefined ? {} : { nexgentHome: options.home }),
    ...(options.tempBase === undefined ? {} : { tempBase: options.tempBase }),
  })
  const redactor = new Redactor(options.secrets ?? [])
  const runnerOptions: ProcessRunnerOptions = {
    redactor,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  }
  const processes = new LocalProcessRunner(runnerOptions)
  const background = new BackgroundShells(runnerOptions)
  const setting = options.systemSandbox ?? config.commands.systemSandbox
  const osSandbox = setting === 'off' ? undefined : options.osSandbox ?? createOsSandbox()
  const os: ShellSandboxDeps | undefined = osSandbox === undefined ? undefined : {
    sandbox: osSandbox,
    inputs: context => ({
      enabled: context.sandboxMode !== 'full-access',
      required: setting === 'required',
      projectRoot: sandbox.policy.projectRoot,
      readOnly: context.sandboxMode === 'read-only',
      // Directories outside the project the user allowed writing to, for the session or the project (ADR 0022 decision 2).
      extraWriteRoots: [...sandbox.policy.extraWriteRoots, ...grantedWriteDirs(context.grants?.() ?? [])],
      denyRead: sandbox.policy.protectedPaths,
      // The project's materials and outputs live in the user data directory; commands may read them (not write).
      ...(workspace.layout.location === 'user-data' ? { allowRead: [workspace.layout.materials, workspace.layout.outputs] } : {}),
      extraDenyWrite: sandbox.policy.protectedPaths,
      network: config.commands.network,
    }),
    // Running outside the sandbox is asked every time: high risk, once only.
    approveUnsandboxed: (context, { command, cwd }) => context.requestApproval({
      summary: command,
      detail: `run outside the system sandbox (cwd: ${cwd}); the command can then read and write anything you can`,
      risk: 'high',
      options: ['once'],
      subject: { kind: 'command', value: command },
    }),
  }
  const deps = { sandbox, redactor, processes, background, ...(os === undefined ? {} : { os }), ...(options.tempBase === undefined ? {} : { tempBase: options.tempBase }) }
  const tools = createWorkspaceTools(deps, options.platform)
  let status: Promise<OsSandboxStatus> | undefined
  return {
    workspace, config, sandbox, processes, redactor, tools, background,
    commandSandbox: async () => {
      if (osSandbox === undefined) return { kind: 'off' }
      status ??= osSandbox.probe()
      const found = await status
      return found.kind === 'active' ? { kind: 'active', platform: found.platform } : { kind: 'none', reason: found.reason }
    },
    dispose: async () => {
      background.disposeAll()
      await osSandbox?.dispose()
    },
  }
}

/** Directories from `fs.write` grants (`<dir>/**` patterns). */
function grantedWriteDirs(grants: readonly ApprovalGrant[]): string[] {
  return grants
    .filter(grant => grant.tool === OUTSIDE_WRITE_GRANT && grant.pattern !== undefined && grant.pattern.endsWith('/**'))
    .map(grant => grant.pattern!.slice(0, -3))
}

/** Build the tool set over existing services. */
export function createWorkspaceTools(
  deps: Parameters<typeof shellTools>[0],
  platform: NodeJS.Platform = process.platform,
): WorkspaceTool[] {
  return [
    readFileTool(deps),
    writeFileTool(deps),
    strReplaceTool(deps),
    listFilesTool(deps),
    searchTextTool(deps),
    ...shellTools(deps, platform),
  ]
}

/** Cordis plugin name. */
export const name = '@nexgent/workspace'

/** Plugin config: see {@link WorkspaceServicesOptions}. */
export type Config = WorkspaceServicesOptions

/**
 * Cordis plugin: provides `ctx.workspace`, `ctx.sandbox`, `ctx.processes`
 * and, whenever `ctx.tools` is available, registers the tools through the
 * `ToolRegistry` contract (unregistered when either side is disposed).
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const services = await createWorkspaceServices(config ?? {})
  ctx.provide('workspace', services.workspace)
  ctx.provide('sandbox', services.sandbox)
  ctx.provide('processes', services.processes)
  ctx.effect(() => () => void services.dispose(), 'workspace.dispose')
  // A closed session's background commands end with it (ADR 0022 decision 6).
  ctx.inject(['agents'], scope => {
    const agents = scope.agents as {
      onClosed?: (listener: (sessionId: string) => void) => () => void
      useCommandSandboxProbe?: (probe: WorkspaceServices['commandSandbox']) => () => void
    }
    if (agents.onClosed !== undefined) scope.effect(() => agents.onClosed!(sessionId => services.background.disposeSession(sessionId)), 'workspace.background')
    // Each new session records whether its commands run in an OS sandbox (ADR 0022 decision 1).
    // The probe starts now, so the first new session does not wait for it.
    if (agents.useCommandSandboxProbe !== undefined) {
      void services.commandSandbox().catch(() => undefined)
      scope.effect(() => agents.useCommandSandboxProbe!(() => services.commandSandbox()), 'workspace.commandSandbox')
    }
  })
  ctx.inject(['tools'], scope => {
    const registry = scope.tools as ToolRegistry
    for (const tool of services.tools) {
      scope.effect(() => registry.register(tool), `tools.register(${tool.definition.name})`)
    }
  })
}

/** The plugin as an object, for `ctx.plugin(WorkspacePlugin, config)`. */
export const WorkspacePlugin = { name, apply }
