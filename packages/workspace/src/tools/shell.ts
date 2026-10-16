/**
 * Shell tools: `bash` (`bash -c <command>`, Linux / macOS) and `pwsh`
 * (`pwsh -NoProfile -NonInteractive -Command <command>`, Windows; Windows
 * PowerShell 5.1 when PowerShell 7 is missing). One-shot processes without
 * shell state, run through the {@link ProcessRunner} (deadline, cancellation,
 * tree kill, env scrub, redaction). Beyond that (ADR 0022):
 *
 * - commands run inside the OS sandbox when {@link ShellToolDeps.os} says so
 *   (`sandbox: false` asks to run outside it, which needs approval);
 * - `run_in_background` returns at once with an id; `shell_output` reads new
 *   output and `shell_kill` ends the process; a session's background
 *   processes die with it;
 * - the text returned to the model is capped (head and tail kept) and the
 *   complete output is written to a file in the session temp dir.
 */
import { join } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import { NexgentError, type ProcessResult, type ProcessRunner, type ToolContext } from '@nexgent/kernel'
import { commandSegments, isReadOnlyCommand } from '../command-policy.js'
import { capText, MODEL_OUTPUT_CHARS, OMITTED_MARKER_PATTERN } from '../output.js'
import { defaultWriteDenies, type OsSandbox } from '../os-sandbox.js'
import { BackgroundShells, type LocalProcessSpec } from '../process.js'
import { clampTimeout, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../sandbox.js'
import { currentPowerShell, takePowerShellNotice } from '../shell-check.js'
import { ensureSessionTempDir } from '../workspace.js'
import {
  booleanField,
  enforce,
  guardPreflight,
  inputObject,
  numberField,
  objectSchema,
  preflightFrom,
  sandboxFor,
  stringField,
  type PolicySubject,
  type ToolDeps,
  type WorkspaceTool,
} from './common.js'

/** Which shell a tool drives. */
export interface ShellFlavor {
  /** Tool name. */
  readonly name: 'bash' | 'pwsh'
  /** Executable. */
  readonly program: string
  /** argv for a script. */
  argv(script: string): string[]
}

/** `bash -c <script>` (not a login shell). */
export const BASH: ShellFlavor = { name: 'bash', program: 'bash', argv: script => ['-c', script] }
/** `pwsh -NoProfile -NonInteractive -Command <script>`. */
export const PWSH: ShellFlavor = {
  name: 'pwsh',
  // `pwsh`, or `powershell` (Windows PowerShell 5.1) when PowerShell 7 is not installed.
  get program(): string {
    return currentPowerShell().program
  },
  argv: script => ['-NoProfile', '-NonInteractive', '-Command', script],
}

/**
 * What the policy layer decides about the OS sandbox for one call; computed
 * from the session, its mode and the project config by {@link ShellSandboxDeps.inputs}.
 */
export interface ShellSandboxInputs {
  /** `false` for `full-access`, `commands.systemSandbox: 'off'`, or any case where commands run unsandboxed. */
  readonly enabled: boolean
  /** `commands.systemSandbox: 'required'`: without a working sandbox the command is not run. */
  readonly required?: boolean
  /** Project root (realpath); writable unless {@link readOnly}. */
  readonly projectRoot: string
  /** `read-only` / plan mode: only the session temp dir is writable. */
  readonly readOnly: boolean
  /** Session-approved extra write directories (`extraWriteRoots`, "allow this directory for this session"). */
  readonly extraWriteRoots: readonly string[]
  /** Paths commands can neither read nor write: `protectedPaths(home, nexgentHome)`. */
  readonly denyRead: readonly string[]
  /** Paths inside {@link denyRead} that stay readable (the project's materials and outputs in the user data directory). */
  readonly allowRead?: readonly string[]
  /** More write-protected paths besides {@link defaultWriteDenies}. */
  readonly extraDenyWrite?: readonly string[]
  /** `commands.network`. */
  readonly network: boolean
}

/** The OS sandbox and the policy inputs, wired by the host. */
export interface ShellSandboxDeps {
  readonly sandbox: OsSandbox
  /** Called for every command. */
  inputs(context: ToolContext): ShellSandboxInputs
  /**
   * A call with `sandbox: false` while the sandbox applies. Return `true` only
   * after the user approved this exact command. Absent = such calls are refused.
   */
  approveUnsandboxed?(context: ToolContext, request: { readonly command: string; readonly cwd: string }): Promise<boolean>
}

/** Extra dependencies of the shell tools. */
export interface ShellToolDeps extends ToolDeps {
  readonly processes: ProcessRunner
  /** Base for session temp dirs (default `os.tmpdir()`). */
  readonly tempBase?: string
  /** OS sandbox for commands; absent = commands run under the command policy only. */
  readonly os?: ShellSandboxDeps
  /** Registry of background processes; default one per `deps` object ({@link backgroundShellsFor}). */
  readonly background?: BackgroundShells
}

const registries = new WeakMap<object, BackgroundShells>()

/**
 * The background-process registry of a set of shell dependencies. Hook for
 * the host: call `backgroundShellsFor(deps).disposeSession(sessionId)` when a
 * session closes (and `.disposeAll()` on shutdown).
 */
export function backgroundShellsFor(deps: ShellToolDeps): BackgroundShells {
  if (deps.background !== undefined) return deps.background
  let registry = registries.get(deps)
  if (registry === undefined) {
    registry = new BackgroundShells({ redactor: deps.redactor })
    registries.set(deps, registry)
  }
  return registry
}

/** Whether a `bash` / `pwsh` call asks to run outside the OS sandbox (`sandbox: false`). The host asks for approval. */
export function requestsUnsandboxed(input: unknown): boolean {
  return (input as { sandbox?: unknown } | null)?.sandbox === false
}

function readEnv(args: Record<string, unknown>): Record<string, string> {
  const env = args.env
  if (env === undefined) return {}
  if (env === null || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some(value => typeof value !== 'string')) {
    throw new NexgentError('tool/invalid-input', '"env" must be an object of strings')
  }
  return env as Record<string, string>
}

/** Render a process result for the model. */
export function formatProcessResult(result: ProcessResult, timeoutMs: number): string {
  const parts: string[] = []
  if (result.stdout !== '') parts.push(result.stdout.replace(/\n$/, ''))
  if (result.stderr !== '') parts.push(`[stderr]\n${result.stderr.replace(/\n$/, '')}`)
  if (result.timedOut) parts.push(`[terminated: timeout after ${timeoutMs} ms; process tree killed]`)
  else if (result.aborted) parts.push('[terminated: cancelled; process tree killed]')
  else parts.push(`[exit code: ${result.exitCode ?? `signal ${result.signal ?? 'unknown'}`}]`)
  return parts.join('\n')
}

const OUTPUT_SENTENCE = `Output is capped to about ${MODEL_OUTPUT_CHARS} characters (head and tail kept; the complete output is saved to a file whose path is shown).`
const BACKGROUND_SENTENCE = 'Set run_in_background for long-running processes (servers, watchers): it returns an id at once; read new output with shell_output and stop it with shell_kill.'
const SANDBOX_SENTENCE = 'Commands run in a system sandbox (writes only to the project and temp dirs); set sandbox:false to rerun outside it when something legitimately needs more, which asks the user.'

/** Split the capped text of both streams so that together they stay within `cap`. */
export function capStreams(stdout: string, stderr: string, cap: number = MODEL_OUTPUT_CHARS): { stdout: string; stderr: string; truncated: boolean } {
  const dropped = OMITTED_MARKER_PATTERN.test(stdout) || OMITTED_MARKER_PATTERN.test(stderr)
    || /\[nexgent: output truncated, dropped \d+ bytes\]/.test(stdout + stderr)
  if (stdout.length + stderr.length <= cap) return { stdout, stderr, truncated: dropped }
  const stderrCap = Math.min(stderr.length, Math.max(Math.floor(cap / 3), cap - stdout.length))
  return { stdout: capText(stdout, cap - stderrCap).text, stderr: capText(stderr, stderrCap).text, truncated: true }
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/** Build the `bash` or `pwsh` tool. */
export function shellTool(flavor: ShellFlavor, deps: ShellToolDeps): WorkspaceTool {
  const { name } = flavor
  const request = (args: Record<string, unknown>, context: ToolContext) => {
    const script = stringField(args, 'command', true)
    const cwd = context.workspace.resolve(stringField(args, 'cwd') ?? '.')
    return { script, cwd, request: { command: flavor.program, args: flavor.argv(script), cwd } }
  }
  const edition = name === 'pwsh' ? currentPowerShell() : undefined
  const base = name === 'bash'
    ? 'Run a command with `bash -c` in the project directory (or cwd) to run programs, scripts and tests.'
    : `Run a command with \`${edition?.edition === 'windows-powershell' ? 'powershell' : 'pwsh'} -NoProfile -NonInteractive -Command\` in the project directory (or cwd) to run programs, scripts and tests.${edition?.notice === undefined ? '' : ` ${edition.notice}`}`
  return {
    definition: {
      name,
      description: `${base} Prefer write_file / str_replace for editing files you work on. Each call is a fresh process; no shell state persists. ${OUTPUT_SENTENCE} ${BACKGROUND_SENTENCE} ${SANDBOX_SENTENCE}`,
      inputSchema: objectSchema({
        command: { type: 'string', description: 'Script to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to the project root (default ".").' },
        timeoutMs: {
          type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS,
          description: `Deadline in ms (default ${DEFAULT_COMMAND_TIMEOUT_MS}, max ${MAX_COMMAND_TIMEOUT_MS}); the whole process tree is killed on expiry. With run_in_background there is no deadline unless given.`,
        },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
        run_in_background: { type: 'boolean', description: 'Start the command and return an id immediately; use shell_output / shell_kill.' },
        sandbox: { type: 'boolean', description: 'Pass false to rerun this command outside the system sandbox (needs user approval). Default: sandboxed.' },
      }, ['command']),
      effects: ['execute', 'write', 'network'],
      approval: 'never',
      // ADR 0022 decision 4: a read-only command is a read call (it runs in read-only and plan mode).
      readOnlyCall: input => {
        const command = (input as { command?: unknown } | null)?.command
        return typeof command === 'string' && isReadOnlyCommand(command, name === 'pwsh' ? 'win32' : 'linux')
      },
    },
    preflight: (input, context, grants) => guardPreflight(async () => {
      const { script, request: req } = request(inputObject(input), context)
      const assessment = await sandboxFor(deps, context).assessCommand(req)
      const subjects: PolicySubject[] = assessment.kind === 'ask' && assessment.matches !== undefined
        ? assessment.matches.map(hit => ({ kind: 'command', value: hit.segment }))
        : commandSegments(script).map(tokens => ({ kind: 'command', value: tokens.join(' ') }))
      return preflightFrom(assessment, {
        tool: name, mode: context.sandboxMode, summary: script, detail: `cwd: ${assessment.path}`,
        subjects, command: script, ...(grants === undefined ? {} : { grants }),
      })
    }),
    handler: async (input, context) => {
      const args = inputObject(input)
      const { script, request: req } = request(args, context)
      const env = readEnv(args)
      const background = booleanField(args, 'run_in_background') === true
      const unsandboxed = args.sandbox === undefined ? false : !(booleanField(args, 'sandbox') as boolean)
      const explicitTimeout = numberField(args, 'timeoutMs')
      const timeoutMs = clampTimeout(explicitTimeout, deps.sandbox.policy.commands.timeoutMs)
      const assessment = await sandboxFor(deps, context).assessCommand(req)
      const hits = assessment.kind === 'ask' ? assessment.matches ?? [] : []
      const cwd = await enforce(assessment, context, {
        summary: script,
        detail: `cwd: ${assessment.path}`,
        // Every flagged command must be covered by a grant (one per line).
        ...(hits.length === 0 ? {} : { subject: { kind: 'command', value: [...new Set(hits.map(hit => hit.segment))].join('\n') } }),
      }, script)
      const temp = await ensureSessionTempDir(context.sessionId, deps.tempBase)

      // The OS sandbox (ADR 0022 decision 1).
      let command = flavor.program
      let argv = flavor.argv(script)
      let sandboxNote: string | undefined
      let sandboxed = false
      const commandId = `${context.sessionId}:${context.callId}:${Math.random().toString(36).slice(2, 8)}`
      const os = deps.os
      const inputs = os?.inputs(context)
      if (os !== undefined && inputs?.enabled === true && flavor.name === 'bash') {
        if (unsandboxed) {
          const approved = os.approveUnsandboxed === undefined ? false : await os.approveUnsandboxed(context, { command: script, cwd })
          if (!approved) throw new NexgentError('approval/denied', `not approved: run outside the system sandbox: ${script}`)
          sandboxNote = 'ran outside the system sandbox (approved)'
        } else {
          const wrapped = await os.sandbox.wrap(script, {
            writeRoots: inputs.readOnly ? [temp] : [inputs.projectRoot, temp, ...inputs.extraWriteRoots],
            denyWrite: inputs.readOnly ? [] : [...defaultWriteDenies(inputs.projectRoot), ...(inputs.extraDenyWrite ?? [])],
            denyRead: inputs.denyRead,
            ...(inputs.allowRead === undefined ? {} : { allowRead: inputs.allowRead }),
            network: inputs.network,
            commandId,
          }, context.signal)
          if (wrapped.kind === 'wrapped') {
            command = wrapped.program
            argv = wrapped.args
            sandboxed = true
          } else if (inputs.required === true) {
            throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: commands.systemSandbox is "required" but no system sandbox is available (${wrapped.reason})`, {
              details: { mode: context.sandboxMode, command: script, code: 'SYSTEM_SANDBOX_REQUIRED' },
            })
          }
        }
      }
      const processEnv = { TMP: temp, TEMP: temp, TMPDIR: temp, ...env }
      const tag = `${context.callId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'call'

      if (background) {
        const registry = backgroundShellsFor(deps)
        const logPath = join(temp, `shell-${tag}-${Date.now().toString(36)}.log`)
        const started = registry.start({
          sessionId: context.sessionId, command, args: argv, cwd, env: processEnv, label: script, logPath,
          ...(explicitTimeout === undefined ? {} : { timeoutMs }),
          ...(sandboxed ? { onExit: () => os?.sandbox.release(commandId) } : {}),
        })
        return {
          content: deps.redactor.redact(
            `Started background process ${started.id}${sandboxed ? ' (system sandbox)' : ''}. Read new output with shell_output {"id":"${started.id}"}; stop it with shell_kill {"id":"${started.id}"}.\nFull output: ${logPath}`,
          ),
          isError: false,
          meta: { background: true, id: started.id, sandboxed, logPath },
        }
      }

      const files = { stdout: join(temp, `shell-${tag}.stdout.log`), stderr: join(temp, `shell-${tag}.stderr.log`) }
      const spec: LocalProcessSpec = {
        command, args: argv, cwd, env: processEnv, timeoutMs, signal: context.signal, outputFiles: files,
      }
      let result: ProcessResult
      try {
        result = await deps.processes.run(spec)
      } catch (error) {
        if (sandboxed) os?.sandbox.release(commandId)
        throw error
      }
      const capped = capStreams(result.stdout, result.stderr)
      const stderr = sandboxed && os !== undefined ? os.sandbox.annotate(commandId, capped.stderr, result.exitCode) : capped.stderr
      if (sandboxed) os?.sandbox.release(commandId)
      const [haveOut, haveErr] = await Promise.all([nonEmpty(files.stdout), nonEmpty(files.stderr)])
      let fullNote = ''
      if (capped.truncated && (haveOut || haveErr)) {
        const paths = [haveOut ? `stdout: ${files.stdout}` : '', haveErr ? `stderr: ${files.stderr}` : ''].filter(Boolean).join(', ')
        fullNote = `\n[full output saved: ${paths}]`
      } else {
        await Promise.all([rm(files.stdout, { force: true }), rm(files.stderr, { force: true })])
      }
      const terminated = result.timedOut ? 'timeout' : result.aborted ? 'cancel' : undefined
      const notice = name === 'pwsh' ? takePowerShellNotice() : undefined
      const text = formatProcessResult({ ...result, stdout: capped.stdout, stderr }, timeoutMs)
      return {
        content: deps.redactor.redact(`${notice === undefined ? '' : `[notice] ${notice}\n`}${text}${fullNote}${sandboxNote === undefined ? '' : `\n[${sandboxNote}]`}`),
        isError: terminated !== undefined,
        meta: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          durationMs: result.durationMs,
          sandboxed,
          ...(capped.truncated ? { truncated: true } : {}),
          ...(terminated === undefined ? {} : { terminated }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
        },
      }
    },
  }
}

function describeStatus(status: { running: boolean; exitCode: number | null; signal?: string; killed: boolean; durationMs: number }): string {
  const seconds = Math.round(status.durationMs / 100) / 10
  if (status.running) return `[status: running, ${seconds}s]`
  if (status.killed) return `[status: killed after ${seconds}s${status.exitCode === null ? '' : `, exit code ${status.exitCode}`}]`
  return status.exitCode === null ? `[status: ended by signal ${status.signal ?? 'unknown'} after ${seconds}s]` : `[status: exited with code ${status.exitCode} after ${seconds}s]`
}

const ALWAYS_ALLOW = async () => ({ action: 'allow' as const })

/** `shell_output`: new output of a background process since the last read, plus its status. */
export function shellOutputTool(deps: ShellToolDeps): WorkspaceTool {
  return {
    definition: {
      name: 'shell_output',
      description: 'Read the output a background process (started with run_in_background) produced since the last read, and whether it is still running or its exit code.',
      inputSchema: objectSchema({ id: { type: 'string', description: 'The id returned when the process was started.' } }, ['id']),
      effects: ['read'],
      approval: 'never',
    },
    preflight: ALWAYS_ALLOW,
    handler: async (input, context) => {
      const id = stringField(inputObject(input), 'id', true)
      const read = backgroundShellsFor(deps).read(context.sessionId, id)
      if (read === undefined) throw new NexgentError('tool/invalid-input', `no background process "${id}" in this session`)
      const output = deps.redactor.redact(read.output)
      return {
        content: `${output === '' ? '' : `${output.replace(/\n$/, '')}\n`}${describeStatus(read)}\n[full output: ${read.logPath}]`,
        isError: false,
        meta: { id, running: read.running, exitCode: read.exitCode },
      }
    },
  }
}

/** `shell_kill`: end a background process and its whole tree. */
export function shellKillTool(deps: ShellToolDeps): WorkspaceTool {
  return {
    definition: {
      name: 'shell_kill',
      description: 'Stop a background process (and everything it started) by id.',
      inputSchema: objectSchema({ id: { type: 'string', description: 'The id returned when the process was started.' } }, ['id']),
      effects: ['execute'],
      approval: 'never',
    },
    preflight: ALWAYS_ALLOW,
    handler: async (input, context) => {
      const id = stringField(inputObject(input), 'id', true)
      const status = await backgroundShellsFor(deps).kill(context.sessionId, id)
      if (status === undefined) throw new NexgentError('tool/invalid-input', `no background process "${id}" in this session`)
      return { content: `${describeStatus(status)}\n[full output: ${status.logPath}]`, isError: false, meta: { id, running: status.running, exitCode: status.exitCode } }
    },
  }
}

/** The `bash` tool. */
export function bashTool(deps: ShellToolDeps): WorkspaceTool {
  return shellTool(BASH, deps)
}

/** The `pwsh` tool. */
export function pwshTool(deps: ShellToolDeps): WorkspaceTool {
  return shellTool(PWSH, deps)
}

/** The platform's shell tool (`pwsh` on Windows, `bash` elsewhere) plus `shell_output` and `shell_kill`. */
export function shellTools(deps: ShellToolDeps, platform: NodeJS.Platform = process.platform): WorkspaceTool[] {
  return [platform === 'win32' ? pwshTool(deps) : bashTool(deps), shellOutputTool(deps), shellKillTool(deps)]
}
