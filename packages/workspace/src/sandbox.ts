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
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
import { commandScript, matchCommandRules, programName, type CommandMatch } from './command-policy.js'
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

/** Read-and-write denied below the project root (`.nexgent/` host-only directories). */
export const DENIED_PATTERNS: readonly string[] = ['.nexgent/sessions/**', '.nexgent/ledgers/**', '.nexgent/capabilities/**']
/** Write-denied below the project root, at any depth. */
export const WRITE_DENIED_PATTERNS: readonly string[] = [
  '.nexgent',
  '.nexgent/materials/**',
  '.nexgent/config.json',
  '**/.git/**',
  '**/node_modules/**',
  '**/.pnpm-store/**',
]
/** Basename patterns whose read and write need approval. */
export const SENSITIVE_PATTERNS: readonly string[] = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '.npmrc', '.netrc']

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
  }
  | { readonly kind: 'deny'; readonly path: string; readonly code: SandboxDenyCode; readonly reason: string }

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
}

/** Construction options for {@link createSandbox}. */
export interface SandboxOptions {
  /** Absolute project root (resolved to its real path). */
  readonly root: string
  /** Mode in force; default `workspace-write`. */
  readonly mode?: SandboxMode
  /** Extra absolute read roots (`config.json.extraReadRoots`). */
  readonly extraReadRoots?: readonly string[]
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
  const extra = await Promise.all((options.extraReadRoots ?? []).map(realOrSelf))
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
    writeRoots: mode === 'read-only' ? [] : mode === 'full-access' ? [rootOf(projectRoot)] : [projectRoot],
    deniedPatterns: DENIED_PATTERNS,
    writeDeniedPatterns: WRITE_DENIED_PATTERNS,
    sensitivePatterns: SENSITIVE_PATTERNS,
    tempBase,
    commands,
  }, extra)
}

/** The local sandbox. Construct with {@link createSandbox}. */
export class LocalSandbox implements Sandbox {
  private readonly derived = new Map<SandboxMode, LocalSandbox>()

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
        writeRoots: mode === 'read-only' ? [] : mode === 'full-access' ? [rootOf(root)] : [root],
      }, this.extraReadRoots, this.flavor)
      this.derived.set(mode, sandbox)
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
    const rel = relativeWithin(this.policy.tempBase, real, this.flavor)
    return rel !== undefined && rel.split('/')[0]!.startsWith(SESSION_TEMP_PREFIX)
  }

  private sensitive(real: string): boolean {
    const base = comparablePath(real, this.flavor).split(/[\\/]/).pop() ?? ''
    return this.policy.sensitivePatterns.some(pattern => matchGlob(pattern, base, this.flavor === 'win32'))
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
      const inRoots = roots.some(root => isWithin(root, real, this.flavor)) || this.inTemp(real)
      if (!inRoots) return this.escapeOrOutside(lexical, real, roots, false)
      const rel = this.relative(real)
      if (rel !== undefined) {
        const denied = this.policy.deniedPatterns.find(pattern => matchGlob(pattern, rel))
          ?? (rel.startsWith('.nexgent/') && !/^\.nexgent\/(materials|outputs)(\/|$)|^\.nexgent\/config\.json$/.test(rel) ? '.nexgent/**' : undefined)
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
    if (!isWithin(root, real, this.flavor) && !this.inTemp(real)) return this.escapeOrOutside(lexical, real, [root], true)
    const rel = this.relative(real)
    if (rel !== undefined) {
      if (rel === '' || rel === '.') {
        return { kind: 'deny', path: real, code: 'denied-pattern', reason: 'the project directory itself cannot be replaced' }
      }
      const denied = this.policy.deniedPatterns.find(pattern => matchGlob(pattern, rel))
        ?? this.policy.writeDeniedPatterns.find(pattern => matchGlob(pattern, rel))
        ?? (rel.startsWith('.nexgent/') && !/^\.nexgent\/outputs\//.test(rel) ? '.nexgent/**' : undefined)
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
    if (mode === 'read-only') {
      return { kind: 'deny', path: cwd, code: 'read-only-mode', reason: 'commands do not run in read-only mode' }
    }
    if (cwdResolved.kind !== 'resolved') return cwdResolved
    if (mode === 'workspace-write' && !isWithin(projectRoot, cwd, this.flavor)) {
      return { kind: 'deny', path: cwd, code: 'outside-write-roots', reason: `working directory ${cwd} is outside the project` }
    }
    const script = commandScript(request.command, request.args)
    const hits = matchCommandRules(script, { root: projectRoot, cwd, flavor: this.flavor })
      .filter(hit => hit.alwaysAsk || mode === 'workspace-write')
    if (hits.length === 0) return { kind: 'allow', path: cwd }
    const high = hits.some(hit => hit.alwaysAsk)
    const patterns = new Set(hits.map(hit => hit.pattern))
    const pattern = !high && patterns.size === 1 ? hits[0]!.pattern : undefined
    return {
      kind: 'ask',
      path: cwd,
      risk: high ? 'high' : 'medium',
      options: high || pattern === undefined ? ['once'] : ['once', 'session', 'project'],
      ...(pattern === undefined ? {} : { pattern }),
      reason: [...new Set(hits.map(hit => hit.description))].join('; '),
      matches: hits,
    }
  }
}

/** Map a three-way assessment onto the contract's binary decision (ask → denied, fail closed). */
export function toDecision(assessment: SandboxAssessment): SandboxDecision {
  switch (assessment.kind) {
    case 'allow':
      return { allowed: true }
    case 'deny':
      return { allowed: false, code: assessment.code, reason: assessment.reason }
    case 'ask':
      return {
        allowed: false,
        code: assessment.matches === undefined ? 'denied-pattern' : 'command-denied',
        reason: `approval required: ${assessment.reason}`,
      }
  }
}
