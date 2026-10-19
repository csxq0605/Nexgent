/**
 * Plain factories and the Cordis plugin for `@nexgent/workspace`.
 */
import { NexgentError, SANDBOX_MODES, type Context, type SandboxMode, type ToolRegistry } from '@nexgent/kernel'
import { loadProjectConfig, type LoadedProjectConfig } from './config.js'
import { LocalProcessRunner, type ProcessRunnerOptions } from './process.js'
import { Redactor } from './redact.js'
import { createSandbox, type LocalSandbox } from './sandbox.js'
import type { WorkspaceTool } from './tools/common.js'
import { readFileTool, strReplaceTool, writeFileTool } from './tools/fs.js'
import { listFilesTool, searchTextTool } from './tools/search.js'
import { shellTools } from './tools/shell.js'
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
}

/** Everything the package provides, wired together. */
export interface WorkspaceServices {
  readonly workspace: LocalWorkspace
  readonly config: LoadedProjectConfig
  readonly sandbox: LocalSandbox
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
  const workspace = await openWorkspace(options.root ?? process.cwd(), { create, ensureLayout: create })
  const config = await loadProjectConfig(workspace.layout)
  const sandbox = await createSandbox({
    root: workspace.root,
    mode: options.sandboxMode ?? config.sandboxMode,
    extraReadRoots: config.extraReadRoots,
    ...(options.tempBase === undefined ? {} : { tempBase: options.tempBase }),
  })
  const redactor = new Redactor(options.secrets ?? [])
  const runnerOptions: ProcessRunnerOptions = {
    redactor,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  }
  const processes = new LocalProcessRunner(runnerOptions)
  const deps = { sandbox, redactor, processes, ...(options.tempBase === undefined ? {} : { tempBase: options.tempBase }) }
  const tools = createWorkspaceTools(deps, options.platform)
  return { workspace, config, sandbox, processes, redactor, tools }
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
  ctx.inject(['tools'], scope => {
    const registry = scope.tools as ToolRegistry
    for (const tool of services.tools) {
      scope.effect(() => registry.register(tool), `tools.register(${tool.definition.name})`)
    }
  })
}

/** The plugin as an object, for `ctx.plugin(WorkspacePlugin, config)`. */
export const WorkspacePlugin = { name, apply }
