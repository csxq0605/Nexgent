/**
 * The OS-level sandbox for commands (ADR 0022 decision 1): bubblewrap on
 * Linux, seatbelt on macOS, through `@anthropic-ai/sandbox-runtime`
 * (Apache-2.0, pinned). Nothing else in Nexgent knows how the platform
 * sandbox works; the shell tool asks {@link OsSandbox.wrap} for the argv to
 * run and gets `unavailable` (never an exception) where there is no sandbox.
 *
 * ## How the library's global state is handled
 *
 * `SandboxManager` is a process-wide singleton: one `initialize()` starts a
 * local filtering proxy (and on Linux two `socat` bridges) and installs one
 * config. Nexgent sessions of different projects share one process (desktop
 * app, SDK), so no per-project policy may live in that global config.
 * Instead:
 *
 * - the global config is initialised once, lazily, with the *minimum*: no
 *   network section (so a command that is allowed to use the network is not
 *   put into a network namespace and not forced through the proxy: it keeps
 *   the host network, which also makes `ssh`, `git://`, raw TCP work) and no
 *   filesystem rules;
 * - everything that depends on the project or the session is passed per
 *   call as `customConfig` of `wrapWithSandbox` (the library lets the
 *   per-call `filesystem` and `network` replace the global ones): writable
 *   roots, write and read denies, and `network: { allowedDomains: [] }` for a
 *   command that must have no network (empty allow list = no network, in a
 *   fresh network namespace);
 * - a wrap call reads its config once, so concurrent commands of different
 *   projects cannot see each other's roots. No re-initialisation per command.
 *
 * The singleton is reference counted across {@link OsSandbox} instances:
 * `reset()` runs when the last instance is disposed. A library bug or an
 * environment that refuses user namespaces shows up in {@link OsSandbox.probe}
 * (it runs one real wrapped command) and yields `kind: 'none'` with the reason.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Whether commands run in an OS sandbox on this host. */
export type OsSandboxStatus =
  | { readonly kind: 'active'; readonly platform: 'linux' | 'macos' }
  | { readonly kind: 'none'; readonly reason: string }

/** What one command is allowed. Paths are absolute. */
export interface OsSandboxPolicy {
  /** Directories the command may write (project root, session temp dir, session-approved directories). Empty = read-only. */
  readonly writeRoots: readonly string[]
  /** Paths below a write root that stay read-only (see {@link defaultWriteDenies}). */
  readonly denyWrite: readonly string[]
  /** Paths the command can neither read nor write (`<NEXGENT_HOME>`, credential directories). */
  readonly denyRead: readonly string[]
  /** Paths inside {@link denyRead} that stay readable. */
  readonly allowRead?: readonly string[]
  /** Whether the command may use the network. */
  readonly network: boolean
  /** Unique id of this invocation, used to attribute violations (a tool call id). */
  readonly commandId: string
  /** The shell the script is run with inside the sandbox (default: library default, `/bin/bash`). */
  readonly shell?: string
}

/** The result of {@link OsSandbox.wrap}. */
export type OsSandboxWrap =
  | { readonly kind: 'wrapped'; readonly program: string; readonly args: string[] }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The slice of `SandboxManager` this module uses (tests inject a fake). */
export interface SandboxManagerLike {
  checkDependencies(): { errors: string[]; warnings: string[] }
  initialize(config: unknown, askCallback?: unknown, enableLogMonitor?: boolean): Promise<void>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    options?: { commandId?: string; commandText?: string },
  ): Promise<string>
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  cleanupAfterCommand(): void
  reset(): Promise<void>
}

/** Options of {@link createOsSandbox}. */
export interface OsSandboxOptions {
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Replaces the real library (tests). A manager given here is private to the instance. */
  readonly manager?: SandboxManagerLike
  /** Skip the real trial command of {@link OsSandbox.probe} (tests with a fake manager). */
  readonly skipTrial?: boolean
}

/** One sandbox per host process role; cheap to create, initialises lazily. */
export interface OsSandbox {
  /** Whether wrapping works here. Runs the dependency check and one trial command, once; never throws. */
  probe(): Promise<OsSandboxStatus>
  /** The argv that runs `script` under `policy`; `unavailable` when there is no sandbox. Never throws. */
  wrap(script: string, policy: OsSandboxPolicy, signal?: AbortSignal): Promise<OsSandboxWrap>
  /** Append the sandbox's account of blocked operations (macOS / Linux monitor) and a generic hint to `stderr`, when the command failed. */
  annotate(commandId: string, stderr: string, exitCode: number | null): string
  /** Release per-command resources (mount points bubblewrap left behind). */
  release(commandId: string): void
  /** Release this instance's share of the library; the last instance resets it. */
  dispose(): Promise<void>
}

/** `.nexgent/`, `.git/hooks` and `.git/config` of a project: read-only for commands (ADR 0022 decision 1). */
export function defaultWriteDenies(projectRoot: string): string[] {
  return [join(projectRoot, '.nexgent'), join(projectRoot, '.git', 'hooks'), join(projectRoot, '.git', 'config')]
}

/** A started (or failed) manager: `failure` is the reason it cannot be used. */
interface Backend { readonly manager: SandboxManagerLike; readonly failure: string | undefined }

// Shared, reference-counted library state for the real SandboxManager.
let shared: { backend: Promise<Backend>; refs: number } | undefined

function reasonFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadManager(): Promise<SandboxManagerLike> {
  const module = await import('@anthropic-ai/sandbox-runtime')
  return module.SandboxManager as unknown as SandboxManagerLike
}

/** The minimal global config: no network section (host network by default), no filesystem rules. */
const GLOBAL_CONFIG = { network: {}, filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] } }

/** An executable on `PATH`, or undefined. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const path = join(dir, name)
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      // not here
    }
  }
  return undefined
}

/**
 * Linux: the library keeps `socat` bridges running for the life of the
 * process. Killed hard, the process would leave them behind, so the bridges
 * start through `setpriv --pdeathsig KILL` and die with it. Returns the
 * wrapper's path, or undefined where `setpriv` or `socat` is missing (the
 * library's plain `socat` then). One wrapper per process: the library keeps
 * the path across `reset()`, so it lives until the process exits.
 */
let socatWrapper: { readonly path: string } | undefined | null = null
function deathLinkedSocat(): { readonly path: string } | undefined {
  if (socatWrapper !== null) return socatWrapper
  socatWrapper = makeSocatWrapper()
  return socatWrapper
}

function makeSocatWrapper(): { readonly path: string } | undefined {
  const setpriv = onPath('setpriv')
  const socat = onPath('socat')
  if (setpriv === undefined || socat === undefined) return undefined
  try {
    const dir = mkdtempSync(join(tmpdir(), 'nexgent-socat-'))
    const path = join(dir, 'socat')
    const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
    writeFileSync(path, `#!/bin/sh\nexec ${quote(setpriv)} --pdeathsig KILL -- ${quote(socat)} "$@"\n`, { mode: 0o755 })
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    return { path }
  } catch {
    return undefined
  }
}

function existing(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    try {
      if (existsSync(path)) out.push(realpathSync(path))
    } catch {
      // a path that cannot be resolved cannot be bound either
    }
  }
  return [...new Set(out)]
}

function customConfigFor(policy: OsSandboxPolicy): unknown {
  return {
    filesystem: {
      denyRead: existing(policy.denyRead),
      allowRead: existing(policy.allowRead ?? []),
      allowWrite: existing(policy.writeRoots),
      denyWrite: existing(policy.denyWrite),
    },
    // Absent network section = the host network (global config has none). An empty allow list = no network.
    ...(policy.network ? {} : { network: { allowedDomains: [], deniedDomains: [] } }),
  }
}

const VIOLATION_HINT =
  'The command failed inside the OS sandbox: it may write only to the project, the session temp directory and directories ' +
  'approved for this session, and cannot read or write the Nexgent home and credential directories. If it genuinely needs more, ' +
  'rerun it with sandbox:false (the user is asked to approve).'

/** Build an OS sandbox. Cheap: nothing is loaded or started until {@link OsSandbox.probe} or {@link OsSandbox.wrap}. */
/**
 * The library hands every wrapped command `TMPDIR=/tmp/claude` (or
 * `$CLAUDE_CODE_TMPDIR`) and allows writing there, but never creates it: on a
 * fresh machine `mkdtemp(os.tmpdir())` inside a command then fails with ENOENT.
 */
function ensureSandboxTmpdir(): void {
  const dir = process.env['CLAUDE_CODE_TMPDIR'] ?? process.env['CLAUDE_TMPDIR'] ?? '/tmp/claude'
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Not fatal: commands that never write temp files still run.
  }
}

export function createOsSandbox(options: OsSandboxOptions = {}): OsSandbox {
  const platform = options.platform ?? process.platform
  const injected = options.manager
  let backend: Promise<Backend> | undefined
  let acquired = false
  let status: Promise<OsSandboxStatus> | undefined
  let disposed = false
  const sandboxedIds = new Set<string>()
  let manager: SandboxManagerLike | undefined

  const unsupported = platform !== 'linux' && platform !== 'darwin'
    ? (platform === 'win32'
        ? 'Windows has no system sandbox; commands run under the command policy only'
        : `no system sandbox for platform ${platform}`)
    : undefined

  async function start(manager: SandboxManagerLike, socat?: { readonly path: string }): Promise<Backend> {
    try {
      const check = manager.checkDependencies()
      if (check.errors.length > 0) return { manager, failure: check.errors.join('; ') }
      await manager.initialize(socat === undefined ? GLOBAL_CONFIG : { ...GLOBAL_CONFIG, socatPath: socat.path }, undefined, true)
      ensureSandboxTmpdir()
      return { manager, failure: undefined }
    } catch (error) {
      return { manager, failure: reasonFrom(error) }
    }
  }

  function acquire(): Promise<Backend> {
    if (backend !== undefined) return backend
    if (injected !== undefined) {
      backend = start(injected)
    } else {
      if (shared === undefined) {
        const socat = platform === 'linux' ? deathLinkedSocat() : undefined
        shared = { backend: loadManager().then(manager => start(manager, socat)), refs: 0 }
      }
      shared.refs += 1
      acquired = true
      backend = shared.backend
    }
    return backend
  }

  async function trial(b: Backend): Promise<string | undefined> {
    if (options.skipTrial === true) return undefined
    try {
      const wrapped = await b.manager.wrapWithSandbox('true', undefined, customConfigFor({
        writeRoots: [], denyWrite: [], denyRead: [], network: true, commandId: 'nexgent-probe',
      }), undefined, { commandId: 'nexgent-probe', commandText: 'true' })
      return await new Promise<string | undefined>(resolve => {
        const child = spawn('sh', ['-c', wrapped], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString('utf8') })
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('the trial command timed out') }, 15_000)
        child.once('error', error => { clearTimeout(timer); resolve(reasonFrom(error)) })
        child.once('exit', code => {
          clearTimeout(timer)
          resolve(code === 0 ? undefined : `the trial command failed (exit ${String(code)}): ${stderr.trim().split('\n')[0] ?? ''}`)
        })
      })
    } catch (error) {
      return reasonFrom(error)
    } finally {
      b.manager.cleanupAfterCommand()
    }
  }

  const probe = (): Promise<OsSandboxStatus> => {
    status ??= (async (): Promise<OsSandboxStatus> => {
      if (unsupported !== undefined) return { kind: 'none', reason: unsupported }
      try {
        const b = await acquire()
        manager = b.manager
        const failure = b.failure ?? (await trial(b))
        return failure === undefined
          ? { kind: 'active', platform: platform === 'darwin' ? 'macos' : 'linux' }
          : { kind: 'none', reason: failure }
      } catch (error) {
        return { kind: 'none', reason: reasonFrom(error) }
      }
    })()
    return status
  }

  return {
    probe,
    async wrap(script, policy, signal) {
      if (disposed) return { kind: 'unavailable', reason: 'the sandbox was disposed' }
      const current = await probe()
      if (current.kind === 'none') return { kind: 'unavailable', reason: current.reason }
      try {
        const wrapped = await (await acquire()).manager.wrapWithSandbox(
          script, policy.shell, customConfigFor(policy), signal, { commandId: policy.commandId, commandText: script },
        )
        sandboxedIds.add(policy.commandId)
        return { kind: 'wrapped', program: 'sh', args: ['-c', wrapped] }
      } catch (error) {
        return { kind: 'unavailable', reason: reasonFrom(error) }
      }
    },
    annotate(commandId, stderr, exitCode) {
      if (!sandboxedIds.has(commandId) || manager === undefined) return stderr
      let annotated = stderr
      try {
        annotated = manager.annotateStderrWithSandboxFailures(commandId, stderr)
      } catch {
        // keep the plain stderr
      }
      if (annotated === stderr && exitCode !== null && exitCode !== 0
        && /Read-only file system|Operation not permitted|Permission denied/.test(stderr)) {
        annotated = `${stderr.replace(/\n$/, '')}\n<sandbox_violations>\n${VIOLATION_HINT}\n</sandbox_violations>`
      }
      return annotated
    },
    release(commandId) {
      sandboxedIds.delete(commandId)
      try {
        manager?.cleanupAfterCommand()
      } catch {
        // best effort
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (backend === undefined) return
      if (injected !== undefined) {
        await injected.reset().catch(() => undefined)
      } else if (acquired && shared !== undefined) {
        shared.refs -= 1
        if (shared.refs <= 0) {
          const last = shared
          shared = undefined
          const { manager: real } = await last.backend
          await real.reset().catch(() => undefined)
        }
      }
    },
  }
}
