/**
 * The `ctx.sandbox` implementation: path and command policy per
 * `docs/spec/permissions.md` (mode matrix, roots, `.nexgent/` rules,
 * denied / approval patterns, command blacklist, always-ask table).
 *
 * The contract's {@link SandboxDecision} is binary, so the richer `assess*`
 * methods return a three-way {@link SandboxAssessment} (`allow` / `ask` /
 * `deny`) that tools use to escalate a call to approval. The contract
 * `check*` methods map `ask` to a denial (fail closed) for callers that
 * cannot run the approval flow.
 */
import { realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type {
  ApprovalRisk,
  ApprovalScope,
  CommandPolicy,
  CommandRequest,
  Sandbox,
  SandboxDecision,
  SandboxDenyCode,
  SandboxMode,
  SandboxPolicy,
} from '@nexgent/kernel'
import { nexgentHome } from '@nexgent/kernel'
import { commandAskScopes, commandScript, isReadOnlyCommand, matchCommandRules, programName, type CommandMatch } from './command-policy.js'
import { matchGlob } from './glob.js'
import {
  HOST_FLAVOR,
  MAX_PATH_LENGTH,
  comparablePath,
  isWithin,
  relativeWithin,
  resolveReal,
  windowsPathIssue,
  type PathFlavor,
} from './paths.js'
import { SESSION_TEMP_PREFIX } from './workspace.js'

/** Default command deadline (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** Upper bound for a command deadline (ms); larger requests are clamped. */
export const MAX_COMMAND_TIMEOUT_MS = 600_000

/** Clamp a requested timeout to `[1, MAX_COMMAND_TIMEOUT_MS]`, defaulting when absent. */
export function clampTimeout(requested: number | undefined, fallback = DEFAULT_COMMAND_TIMEOUT_MS): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(Math.floor(requested), MAX_COMMAND_TIMEOUT_MS)
}

/**
 * Read-and-write denied below the project root (`.nexgent/` host-only
 * directories). ADR 0018: the project handbook, self-evaluations and the
 * learning queue of a project whose data is still in `.nexgent/`.
 */
export const DENIED_PATTERNS: readonly string[] = [
  '.nexgent/sessions/**', '.nexgent/ledgers/**', '.nexgent/capabilities/**', '.nexgent/snapshots/**', '.nexgent/improvements/**', '.nexgent/improvers/**',
  '.nexgent/handbook/**', '.nexgent/evaluations/**', '.nexgent/learning/**',
]
/** Write-denied below the project root, at any depth. */
export const WRITE_DENIED_PATTERNS: readonly string[] = [
  '.nexgent',
  '.nexgent/materials/**',
  '.nexgent/outputs/**',
  '.nexgent/skills/**',
  '.nexgent/config.json',
  '**/.git/**',
  '**/node_modules/**',
  '**/.pnpm-store/**',
]
/**
 * Basename patterns whose read and write need approval (ADR 0022 decision 5:
 * `*.key` dropped, private-key and keystore names added).
 */
export const SENSITIVE_PATTERNS: readonly string[] = [
  '.env', '.env.*', '*.pem', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.p12', '*.pfx', '.npmrc', '.netrc',
]
/** Basenames matching {@link SENSITIVE_PATTERNS} that are templates, not secrets. */
export const SENSITIVE_EXEMPT_PATTERNS: readonly string[] = ['.env.example', '.env.sample', '.env.template', '.env.dist', '*.pub']

/**
 * Credential locations under the user's home directory that no tool and no
 * sandboxed command may read or write, wherever the roots are (ADR 0022
 * decision 1). Home-relative.
 */
export const PROTECTED_HOME_ENTRIES: readonly string[] = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.config/gh', '.azure', '.password-store',
]

/** Absolute protected paths: {@link PROTECTED_HOME_ENTRIES} under `userHome`, plus the Nexgent home. */
export function protectedPaths(userHome: string, nexgentHomeDir: string): string[] {
  return [...PROTECTED_HOME_ENTRIES.map(entry => nodePath.join(userHome, entry)), nexgentHomeDir]
}

/** System directories a tool never writes to, even when a session allows a directory outside the project. */
export function systemWriteDenied(flavor: PathFlavor = HOST_FLAVOR): string[] {
  return flavor === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/dev', '/proc', '/sys', '/System', '/Library', '/private/etc', '/private/var/db', '/Applications']
}

/** Grant names for directories allowed outside the project (`ToolApprovalAsk.grantTool`). */
export const OUTSIDE_READ_GRANT = 'fs.read'
export const OUTSIDE_WRITE_GRANT = 'fs.write'

/** A three-way policy answer. `path` is the resolved real path the operation must use. */
export type SandboxAssessment =
  | { readonly kind: 'allow'; readonly path: string }
  | {
    readonly kind: 'ask'
    readonly path: string
    readonly risk: ApprovalRisk
    readonly options: readonly ApprovalScope[]
    /** Pattern a session / project grant stores (project-relative path or command prefix). */
    readonly pattern?: string
    /** Why approval is needed. */
    readonly reason: string
    /** Command rule hits, for command assessments. */
    readonly matches?: readonly CommandMatch[]
    /** Store and match grants under this name instead of the tool's (outside-project directories). */
    readonly grantTool?: string
  }
  | { readonly kind: 'deny'; readonly path: string; readonly code: Exclude<SandboxDenyCode, 'approval-required'>; readonly reason: string }

/** The resolved policy plus the workspace-only facts the contract cannot express. */
export interface LocalSandboxPolicy extends SandboxPolicy {
  /** Real project root. */
  readonly projectRoot: string
  /** Glob patterns (project-relative) that are write-denied. */
  readonly writeDeniedPatterns: readonly string[]
  /** Basename globs that need approval to read or write. */
  readonly sensitivePatterns: readonly string[]
  /** Real directory under which `nexgent-<sessionId>/` temp dirs live. */
  readonly tempBase: string
  /** Real paths no tool reads or writes outside full-access ({@link protectedPaths}), unless inside an explicit root below them. */
  readonly protectedPaths: readonly string[]
  /** Extra real write roots (`extraWriteRoots`). */
  readonly extraWriteRoots: readonly string[]
  /**
   * The session whose temp dir (`<tempBase>/nexgent-<sessionId>/`) is readable
   * and writable; absent admits no temp dir. Set per call with
   * {@link LocalSandbox.forSession}.
   */
  readonly tempSessionId?: string
}

/** Construction options for {@link createSandbox}. */
export interface SandboxOptions {
  /** Absolute project root (resolved to its real path). */
  readonly root: string
  /** Mode in force; default `workspace-write`. */
  readonly mode?: SandboxMode
  /** Extra absolute read roots (`config.json.extraReadRoots`). */
  readonly extraReadRoots?: readonly string[]
  /** Extra absolute write roots (`config.json.extraWriteRoots`); also readable. */
  readonly extraWriteRoots?: readonly string[]
  /** Nexgent home (default `$NEXGENT_HOME` or `~/.nexgent`); always protected. */
  readonly nexgentHome?: string
  /** The user's home directory for {@link PROTECTED_HOME_ENTRIES}; default `os.homedir()`. */
  readonly userHome?: string
  /** Base of session temp dirs; default `os.tmpdir()`. */
  readonly tempBase?: string
  /** Command policy overrides. */
  readonly commands?: Partial<CommandPolicy>
}

function rootOf(path: string): string {
  return nodePath.parse(path).root
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return nodePath.resolve(path)
  }
}

/** Create a sandbox; roots are resolved to real paths first. */
export async function createSandbox(options: SandboxOptions): Promise<LocalSandbox> {
  const mode = options.mode ?? 'workspace-write'
  const projectRoot = await realOrSelf(options.root)
  const extraWrite = await Promise.all((options.extraWriteRoots ?? []).map(realOrSelf))
  const extra = [...await Promise.all((options.extraReadRoots ?? []).map(realOrSelf)), ...extraWrite]
  const guarded = await Promise.all(protectedPaths(options.userHome ?? homedir(), options.nexgentHome ?? nexgentHome()).map(realOrSelf))
  const tempBase = await realOrSelf(options.tempBase ?? tmpdir())
  const commands: CommandPolicy = {
    deny: options.commands?.deny ?? [],
    timeoutMs: clampTimeout(options.commands?.timeoutMs),
    network: options.commands?.network ?? true,
    ...(options.commands?.allow === undefined ? {} : { allow: options.commands.allow }),
  }
  return new LocalSandbox({
    mode,
    projectRoot,
    readRoots: mode === 'full-access' ? [rootOf(projectRoot)] : [projectRoot, ...extra],
    writeRoots: mode === 'read-only' ? [] : mode === 'full-access' ? [rootOf(projectRoot)] : [projectRoot, ...extraWrite],
    deniedPatterns: DENIED_PATTERNS,
    writeDeniedPatterns: WRITE_DENIED_PATTERNS,
    sensitivePatterns: SENSITIVE_PATTERNS,
    tempBase,
    protectedPaths: guarded,
    extraWriteRoots: extraWrite,
    commands,
  }, extra)
}

function withoutTempSession(policy: LocalSandboxPolicy): LocalSandboxPolicy {
  const { tempSessionId: _omit, ...rest } = policy
  return rest
}

/** The local sandbox. Construct with {@link createSandbox}. */
export class LocalSandbox implements Sandbox {
  private readonly derived = new Map<SandboxMode, LocalSandbox>()
  private readonly sessions = new Map<string, LocalSandbox>()

  constructor(
    readonly policy: LocalSandboxPolicy,
    private readonly extraReadRoots: readonly string[] = [],
    private readonly flavor: PathFlavor = HOST_FLAVOR,
  ) {}

  /** The same sandbox under another mode (cached), for a call whose `ToolContext.sandboxMode` differs. */
  withMode(mode: SandboxMode): LocalSandbox {
    if (mode === this.policy.mode) return this
    let sandbox = this.derived.get(mode)
    if (sandbox === undefined) {
      const root = this.policy.projectRoot
      sandbox = new LocalSandbox({
        ...this.policy,
        mode,
        readRoots: mode === 'full-access' ? [rootOf(root)] : [root, ...this.extraReadRoots],
        writeRoots: mode === 'read-only' ? [] : mode === 'full-access' ? [rootOf(root)] : [root, ...this.policy.extraWriteRoots],
      }, this.extraReadRoots, this.flavor)
      this.derived.set(mode, sandbox)
    }
    return sandbox
  }

  /**
   * The same sandbox with more read roots (directories outside the project
   * the user allowed for this call or session, ADR 0022 decision 2). Protected
   * locations stay denied.
   */
  withReadRoots(roots: readonly string[]): LocalSandbox {
    const extra = roots.filter(root => !this.extraReadRoots.includes(root) && root !== this.policy.projectRoot)
    if (extra.length === 0) return this
    return new LocalSandbox({ ...this.policy, readRoots: [...this.policy.readRoots, ...extra] }, [...this.extraReadRoots, ...extra], this.flavor)
  }

  /**
   * The same sandbox admitting only `sessionId`'s temp dir (cached). Other
   * `nexgent-*` directories under the temp base stay outside the roots.
   */
  forSession(sessionId: string | undefined): LocalSandbox {
    if (sessionId === this.policy.tempSessionId) return this
    if (sessionId === undefined) return new LocalSandbox(withoutTempSession(this.policy), this.extraReadRoots, this.flavor)
    let sandbox = this.sessions.get(sessionId)
    if (sandbox === undefined) {
      sandbox = new LocalSandbox({ ...this.policy, tempSessionId: sessionId }, this.extraReadRoots, this.flavor)
      this.sessions.set(sessionId, sandbox)
    }
    return sandbox
  }

  async checkRead(path: string): Promise<SandboxDecision> {
    return toDecision(await this.assessRead(path))
  }

  async checkWrite(path: string): Promise<SandboxDecision> {
    return toDecision(await this.assessWrite(path))
  }

  async checkCommand(request: CommandRequest): Promise<SandboxDecision> {
    return toDecision(await this.assessCommand(request))
  }

  /** Project-relative `/` path (lower-cased on Windows) when inside the project. */
  relative(path: string): string | undefined {
    return relativeWithin(this.policy.projectRoot, path, this.flavor)
  }

  private inTemp(real: string): boolean {
    const session = this.policy.tempSessionId
    if (session === undefined) return false
    const rel = relativeWithin(this.policy.tempBase, real, this.flavor)
    if (rel === undefined) return false
    const own = `${SESSION_TEMP_PREFIX}${session}`
    return rel.split('/')[0] === (this.flavor === 'win32' ? own.toLowerCase() : own)
  }

  /** Whether a path's basename names a secret ({@link SENSITIVE_PATTERNS} minus {@link SENSITIVE_EXEMPT_PATTERNS}). */
  sensitive(real: string): boolean {
    const base = comparablePath(real, this.flavor).split(/[\\/]/).pop() ?? ''
    const win = this.flavor === 'win32'
    return this.policy.sensitivePatterns.some(pattern => matchGlob(pattern, base, win))
      && !SENSITIVE_EXEMPT_PATTERNS.some(pattern => matchGlob(pattern, base, win))
  }

  /**
   * The protected location containing `real`, unless an explicit root below
   * that location contains it (the data dir's `materials/` and `outputs/`).
   */
  private protectedBy(real: string, roots: readonly string[]): string | undefined {
    const guard = this.policy.protectedPaths.find(path => isWithin(path, real, this.flavor))
    if (guard === undefined) return undefined
    const explicit = roots.some(root => isWithin(guard, root, this.flavor) && root !== guard && isWithin(root, real, this.flavor))
    return explicit ? undefined : guard
  }

  /**
   * Outside the roots: ask (ADR 0022 decision 2) once or for the session,
   * with the containing directory as the grant pattern under a shared grant
   * name, so a session grant covers every file tool.
   */
  private async askOutside(real: string, write: boolean): Promise<SandboxAssessment> {
    let dir = nodePath.dirname(real)
    try {
      if ((await stat(real)).isDirectory()) dir = real
    } catch {
      // A new file: its directory.
    }
    const slash = dir.replaceAll('\\', '/').replace(/\/$/, '')
    return {
      kind: 'ask',
      path: real,
      risk: 'medium',
      options: ['once', 'session'],
      pattern: `${slash}/**`,
      reason: `${write ? 'writing' : 'reading'} outside the project, in ${dir}`,
      grantTool: write ? OUTSIDE_WRITE_GRANT : OUTSIDE_READ_GRANT,
    }
  }

  /** Lexical checks shared by read and write; returns a denial or the resolved real path. */
  private async resolve(path: string, write: boolean): Promise<SandboxAssessment | { kind: 'resolved'; lexical: string; real: string }> {
    const lexical = nodePath.resolve(path)
    const outside: SandboxDenyCode = write ? 'outside-write-roots' : 'outside-read-roots'
    if (lexical.length > MAX_PATH_LENGTH) {
      return { kind: 'deny', path: lexical, code: outside, reason: `path longer than ${MAX_PATH_LENGTH} characters` }
    }
    if (this.flavor === 'win32') {
      const issue = windowsPathIssue(lexical, [this.policy.projectRoot, ...this.extraReadRoots])
      if (issue !== undefined) return { kind: 'deny', path: lexical, code: outside, reason: issue }
    }
    let real: string
    try {
      real = await resolveReal(lexical)
    } catch (error) {
      return { kind: 'deny', path: lexical, code: 'symlink-escape', reason: `cannot resolve path: ${(error as Error).message}` }
    }
    if (real.length > MAX_PATH_LENGTH) {
      return { kind: 'deny', path: real, code: outside, reason: `path longer than ${MAX_PATH_LENGTH} characters` }
    }
    return { kind: 'resolved', lexical, real }
  }

  private escapeOrOutside(lexical: string, real: string, roots: readonly string[], write: boolean): SandboxAssessment {
    const lexicallyInside = roots.some(root => isWithin(root, lexical, this.flavor))
    return lexicallyInside
      ? { kind: 'deny', path: real, code: 'symlink-escape', reason: `${lexical} resolves through a symbolic link to ${real}, outside the allowed roots` }
      : { kind: 'deny', path: real, code: write ? 'outside-write-roots' : 'outside-read-roots', reason: `${real} is outside the allowed ${write ? 'write' : 'read'} roots` }
  }

  /** Assess a read of an absolute path. */
  async assessRead(path: string): Promise<SandboxAssessment> {
    const resolved = await this.resolve(path, false)
    if (resolved.kind !== 'resolved') return resolved
    const { lexical, real } = resolved
    const { mode } = this.policy
    if (mode !== 'full-access') {
      const roots = [this.policy.projectRoot, ...this.extraReadRoots]
      const guard = this.protectedBy(real, roots)
      if (guard !== undefined) {
        return { kind: 'deny', path: real, code: 'denied-pattern', reason: `${real} is a protected location (${guard}); no tool reads it` }
      }
      const inRoots = roots.some(root => isWithin(root, real, this.flavor)) || this.inTemp(real)
      if (!inRoots) {
        const escape = this.escapeOrOutside(lexical, real, roots, false)
        return escape.kind === 'deny' && escape.code === 'symlink-escape' ? escape : this.askOutside(real, false)
      }
      const rel = this.relative(real)
      if (rel !== undefined) {
        const denied = this.policy.deniedPatterns.find(pattern => matchGlob(pattern, rel))
          ?? (rel.startsWith('.nexgent/') && !/^\.nexgent\/(materials|outputs|skills)(\/|$)|^\.nexgent\/config\.json$/.test(rel) ? '.nexgent/**' : undefined)
        if (denied !== undefined) {
          return { kind: 'deny', path: real, code: 'denied-pattern', reason: `${rel} is reserved for the host (${denied})` }
        }
      }
      if (this.sensitive(real)) return this.askSensitive(real, 'low', 'reading a sensitive file')
    }
    return { kind: 'allow', path: real }
  }

  /** Assess a create / modify / delete of an absolute path. */
  async assessWrite(path: string): Promise<SandboxAssessment> {
    const resolved = await this.resolve(path, true)
    if (resolved.kind !== 'resolved') return resolved
    const { lexical, real } = resolved
    const { mode } = this.policy
    if (mode === 'full-access') return { kind: 'allow', path: real }
    if (mode === 'read-only') {
      return { kind: 'deny', path: real, code: 'read-only-mode', reason: `writes are disabled in read-only mode (${real})` }
    }
    const root = this.policy.projectRoot
    const writeRoots = [root, ...this.policy.extraWriteRoots]
    const guard = this.protectedBy(real, writeRoots)
      ?? systemWriteDenied(this.flavor).find(dir => isWithin(dir, real, this.flavor))
    if (guard !== undefined) {
      return { kind: 'deny', path: real, code: 'denied-pattern', reason: `${real} is a protected location (${guard}); no tool writes it` }
    }
    if (!writeRoots.some(dir => isWithin(dir, real, this.flavor)) && !this.inTemp(real)) {
      const escape = this.escapeOrOutside(lexical, real, writeRoots, true)
      return escape.kind === 'deny' && escape.code === 'symlink-escape' ? escape : this.askOutside(real, true)
    }
    const rel = this.relative(real)
    if (rel !== undefined) {
      if (rel === '' || rel === '.') {
        return { kind: 'deny', path: real, code: 'denied-pattern', reason: 'the project directory itself cannot be replaced' }
      }
      const denied = this.policy.deniedPatterns.find(pattern => matchGlob(pattern, rel))
        ?? this.policy.writeDeniedPatterns.find(pattern => matchGlob(pattern, rel))
        ?? (rel.startsWith('.nexgent/') ? '.nexgent/**' : undefined)
      if (denied !== undefined) {
        return { kind: 'deny', path: real, code: 'denied-pattern', reason: `${rel} is write-protected (${denied})` }
      }
    }
    if (this.sensitive(real)) return this.askSensitive(real, 'medium', 'writing a sensitive file')
    return { kind: 'allow', path: real }
  }

  private askSensitive(real: string, risk: ApprovalRisk, reason: string): SandboxAssessment {
    const rel = this.relative(real)
    return {
      kind: 'ask',
      path: real,
      risk,
      options: ['once', 'session', 'project'],
      ...(rel === undefined ? {} : { pattern: rel }),
      reason,
    }
  }

  /** Assess a command; `path` in the answer is the resolved cwd. */
  async assessCommand(request: CommandRequest): Promise<SandboxAssessment> {
    const { mode, commands, projectRoot } = this.policy
    const name = programName(request.command)
    const cwdResolved = await this.resolve(request.cwd, false)
    const cwd = cwdResolved.kind === 'resolved' ? cwdResolved.real : nodePath.resolve(request.cwd)
    if (commands.deny.some(entry => programName(entry) === name)) {
      return { kind: 'deny', path: cwd, code: 'command-denied', reason: `${name} is on the command deny list` }
    }
    if (commands.allow !== undefined && !commands.allow.some(entry => programName(entry) === name)) {
      return { kind: 'deny', path: cwd, code: 'command-not-allowed', reason: `${name} is not on the command allow list` }
    }
    const script = commandScript(request.command, request.args)
    if (mode === 'read-only' && !isReadOnlyCommand(script, this.flavor === 'win32' ? 'win32' : 'linux')) {
      return {
        kind: 'deny',
        path: cwd,
        code: 'read-only-mode',
        reason: 'only read-only commands (ls, cat, rg, git status / diff / log ...) run in read-only and plan mode; ask the user to switch modes for others',
      }
    }
    if (cwdResolved.kind !== 'resolved') return cwdResolved
    if (mode !== 'full-access' && !isWithin(projectRoot, cwd, this.flavor) && !this.policy.extraWriteRoots.some(root => isWithin(root, cwd, this.flavor))) {
      return { kind: 'deny', path: cwd, code: 'outside-write-roots', reason: `working directory ${cwd} is outside the project` }
    }
    const tempSession = this.policy.tempSessionId
    const hits = matchCommandRules(script, {
      root: projectRoot,
      cwd,
      flavor: this.flavor,
      ...(tempSession === undefined ? {} : { tempDir: nodePath.join(this.policy.tempBase, `${SESSION_TEMP_PREFIX}${tempSession}`) }),
      writeRoots: this.policy.extraWriteRoots,
    }).filter(hit => hit.alwaysAsk || mode !== 'full-access')
    if (hits.length === 0) return { kind: 'allow', path: cwd }
    const { options, pattern, risk } = commandAskScopes(hits)
    return {
      kind: 'ask',
      path: cwd,
      risk,
      options,
      ...(pattern === undefined ? {} : { pattern }),
      reason: [...new Set(hits.map(hit => hit.description))].join('; '),
      matches: hits,
    }
  }
}

/** Map a three-way assessment onto the contract's decision: `ask` is `approval-required` carrying what to ask. */
export function toDecision(assessment: SandboxAssessment): SandboxDecision {
  switch (assessment.kind) {
    case 'allow':
      return { allowed: true }
    case 'deny':
      return { allowed: false, code: assessment.code, reason: assessment.reason }
    case 'ask':
      return {
        allowed: false,
        code: 'approval-required',
        reason: `approval required: ${assessment.reason}`,
        ask: {
          summary: assessment.path,
          detail: assessment.reason,
          risk: assessment.risk,
          options: assessment.options,
          ...(assessment.pattern === undefined ? {} : { pattern: assessment.pattern }),
          ...(assessment.grantTool === undefined ? {} : { grantTool: assessment.grantTool }),
          subject: { kind: assessment.matches === undefined ? 'path' : 'command', value: assessment.path },
        },
      }
  }
}
