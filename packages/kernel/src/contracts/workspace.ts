/**
 * The workspace contract: where a project lives, where Nexgent keeps its
 * data inside it, and the sandbox and process services that gate what tools
 * may touch and run.
 *
 * Policy semantics (what each mode allows, how approvals interact) are
 * normative in `docs/spec/permissions.md`; this file fixes the shapes.
 */
import type { ToolApprovalAsk } from './approvals.js'
import * as nodePath from 'node:path'

/** Name of the data directory inside a project root. */
export const NEXGENT_DIR = '.nexgent'

/** Subdirectories of `.nexgent/`, created on first use by the workspace service. */
export const NEXGENT_SUBDIRS = ['sessions', 'materials', 'outputs', 'capabilities', 'ledgers'] as const

/** One of {@link NEXGENT_SUBDIRS}. */
export type NexgentSubdir = (typeof NEXGENT_SUBDIRS)[number]

/** Name of the project config file inside `.nexgent/`. */
export const PROJECT_CONFIG_FILE = 'config.json'

/** Every absolute path a workspace owns, resolved once. */
export interface WorkspaceLayout {
  /** Absolute, normalized project root. */
  readonly root: string
  /** `<root>/.nexgent`. */
  readonly dataDir: string
  /** `<root>/.nexgent/config.json`. */
  readonly configFile: string
  /** `<root>/.nexgent/sessions`. */
  readonly sessions: string
  /** `<root>/.nexgent/materials`. */
  readonly materials: string
  /** `<root>/.nexgent/outputs`. */
  readonly outputs: string
  /** `<root>/.nexgent/capabilities`. */
  readonly capabilities: string
  /** `<root>/.nexgent/ledgers`. */
  readonly ledgers: string
}

/** The `path` API subset the pure helpers need, so tests can pin a platform. */
export type PathApi = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep' | 'join' | 'normalize'>

/**
 * Compute the {@link WorkspaceLayout} for a root. Pure: no I/O, nothing is
 * created. `root` must be absolute.
 * @throws `TypeError` when `root` is relative.
 */
export function resolveWorkspaceLayout(root: string, api: PathApi = nodePath): WorkspaceLayout {
  if (!api.isAbsolute(root)) throw new TypeError(`workspace root must be absolute: ${root}`)
  const normalizedRoot = api.resolve(root)
  const dataDir = api.join(normalizedRoot, NEXGENT_DIR)
  return {
    root: normalizedRoot,
    dataDir,
    configFile: api.join(dataDir, PROJECT_CONFIG_FILE),
    sessions: api.join(dataDir, 'sessions'),
    materials: api.join(dataDir, 'materials'),
    outputs: api.join(dataDir, 'outputs'),
    capabilities: api.join(dataDir, 'capabilities'),
    ledgers: api.join(dataDir, 'ledgers'),
  }
}

/**
 * Resolve a tool-supplied path against a root: relative paths join the root,
 * absolute paths are normalized as given. Lexical only (`..` collapses,
 * symlinks are not followed); the sandbox does the realpath check.
 */
export function normalizeWorkspacePath(root: string, input: string, api: PathApi = nodePath): string {
  return api.isAbsolute(input) ? api.normalize(input) : api.resolve(root, input)
}

/**
 * Whether `target` is `root` or lexically inside it. Case-sensitive; callers
 * on Windows compare already-normalized (realpath) strings.
 */
export function isInsideRoot(root: string, target: string, api: PathApi = nodePath): boolean {
  const rel = api.relative(api.resolve(root), api.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel))
}

/** The `ctx.workspace` service: one project directory. */
export interface Workspace {
  /** Absolute project root. */
  readonly root: string
  /** Resolved data paths. */
  readonly layout: WorkspaceLayout
  /** Resolve a path for a tool: see {@link normalizeWorkspacePath}. */
  resolve(input: string): string
  /** Path relative to the root, for display and records. */
  relative(absolute: string): string
  /** `<root>/.nexgent/sessions/<id>`. */
  sessionDir(sessionId: string): string
  /** Create `.nexgent/` and every subdir if missing. Idempotent. */
  ensureLayout(): Promise<void>
}

/** How much a session may touch. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access'

/** All modes, for config validation. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full-access']

/** Command policy applied by `checkCommand`. */
export interface CommandPolicy {
  /** Program names (argv[0] basename) that may run; absent means any not denied. */
  readonly allow?: readonly string[]
  /** Program names that never run, even in `full-access`. */
  readonly deny: readonly string[]
  /** Default deadline for a command in ms. */
  readonly timeoutMs: number
  /** Whether commands may reach the network; `false` is advisory on platforms without a network sandbox. */
  readonly network: boolean
}

/** The resolved policy a sandbox enforces; derived from mode + workspace + config. */
export interface SandboxPolicy {
  readonly mode: SandboxMode
  /** Absolute directories tools may read; `full-access` sets this to `['/']` (or every drive root). */
  readonly readRoots: readonly string[]
  /** Absolute directories tools may write; empty in `read-only`. */
  readonly writeRoots: readonly string[]
  /** Glob patterns (relative to the workspace root) denied for both read and write, e.g. `.nexgent/**`, `.git/**`. */
  readonly deniedPatterns: readonly string[]
  readonly commands: CommandPolicy
}

/** Why a sandbox denied an operation. */
export type SandboxDenyCode =
  | 'outside-read-roots'
  | 'outside-write-roots'
  | 'denied-pattern'
  | 'symlink-escape'
  | 'read-only-mode'
  | 'command-denied'
  | 'command-not-allowed'
  /** Not denied outright: the call may proceed once a host approves `ask`. */
  | 'approval-required'

/** The answer to a sandbox check. */
export type SandboxDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: Exclude<SandboxDenyCode, 'approval-required'>; readonly reason: string }
  | { readonly allowed: false; readonly code: 'approval-required'; readonly reason: string; readonly ask: ToolApprovalAsk }

/** A command about to run. */
export interface CommandRequest {
  /** Program to run (argv[0]). */
  readonly command: string
  readonly args: readonly string[]
  /** Absolute working directory. */
  readonly cwd: string
}

/** The `ctx.sandbox` service. Checks are async because they follow symlinks. */
export interface Sandbox {
  readonly policy: SandboxPolicy
  /** May a tool read this (absolute) path? */
  checkRead(path: string): Promise<SandboxDecision>
  /** May a tool create, modify or delete this (absolute) path? */
  checkWrite(path: string): Promise<SandboxDecision>
  /** May this command run? */
  checkCommand(request: CommandRequest): Promise<SandboxDecision>
}

/** What to run. */
export interface ProcessSpec extends CommandRequest {
  /** Environment; absent inherits the host's. Secrets are never injected implicitly. */
  readonly env?: Readonly<Record<string, string>>
  /** Deadline in ms; on expiry the whole process tree is killed. */
  readonly timeoutMs: number
  /** External cancellation; same tree-kill as timeout. */
  readonly signal?: AbortSignal
  /** Text written to stdin, then stdin is closed. */
  readonly stdin?: string
  /** Called with each chunk as it arrives, for streaming display. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

/** How a process ended. */
export interface ProcessResult {
  /** Exit code, or `null` when killed by a signal. */
  readonly exitCode: number | null
  /** Terminating signal name, when any. */
  readonly signal?: string
  readonly stdout: string
  readonly stderr: string
  /** Whether `timeoutMs` expired. */
  readonly timedOut: boolean
  /** Whether `signal` (the AbortSignal) fired. */
  readonly aborted: boolean
  readonly durationMs: number
}

/**
 * The `ctx.processes` service. One rule: when `run` resolves, no process it
 * started is still alive (timeout and abort kill the entire tree on both
 * platforms).
 */
export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>
}
