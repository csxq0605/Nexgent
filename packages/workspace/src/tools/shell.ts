/**
 * Shell tools: `bash` (`bash -c <command>`, Linux / macOS) and `pwsh`
 * (`pwsh -NoProfile -NonInteractive -Command <command>`, Windows). One-shot
 * processes without shell state, run through the {@link ProcessRunner}
 * (deadline, cancellation, tree kill, env scrub, output cap, redaction).
 */
import { NexgentError, type ProcessResult, type ProcessRunner, type ToolContext } from '@nexgent/kernel'
import { commandSegments } from '../command-policy.js'
import { clampTimeout, DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../sandbox.js'
import { ensureSessionTempDir } from '../workspace.js'
import {
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
  program: 'pwsh',
  argv: script => ['-NoProfile', '-NonInteractive', '-Command', script],
}

/** Extra dependencies of the shell tools. */
export interface ShellToolDeps extends ToolDeps {
  readonly processes: ProcessRunner
  /** Base for session temp dirs (default `os.tmpdir()`). */
  readonly tempBase?: string
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

/** Build the `bash` or `pwsh` tool. */
export function shellTool(flavor: ShellFlavor, deps: ShellToolDeps): WorkspaceTool {
  const { name } = flavor
  const request = (args: Record<string, unknown>, context: ToolContext) => {
    const script = stringField(args, 'command', true)
    const cwd = context.workspace.resolve(stringField(args, 'cwd') ?? '.')
    return { script, cwd, request: { command: flavor.program, args: flavor.argv(script), cwd } }
  }
  return {
    definition: {
      name,
      description: name === 'bash'
        ? 'Run a command with `bash -c` in the project directory (or cwd). Each call is a fresh process; no shell state persists. Output is capped (tail kept).'
        : 'Run a command with `pwsh -NoProfile -NonInteractive -Command` in the project directory (or cwd). Each call is a fresh process; no shell state persists. Output is capped (tail kept).',
      inputSchema: objectSchema({
        command: { type: 'string', description: 'Script to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to the project root (default ".").' },
        timeoutMs: {
          type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS,
          description: `Deadline in ms (default ${DEFAULT_COMMAND_TIMEOUT_MS}, max ${MAX_COMMAND_TIMEOUT_MS}); the whole process tree is killed on expiry.`,
        },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
      }, ['command']),
      effects: ['execute', 'write', 'network'],
      approval: 'never',
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
      const timeoutMs = clampTimeout(numberField(args, 'timeoutMs'), deps.sandbox.policy.commands.timeoutMs)
      const assessment = await sandboxFor(deps, context).assessCommand(req)
      const hit = assessment.kind === 'ask' ? assessment.matches?.[0] : undefined
      const cwd = await enforce(assessment, context, {
        summary: script,
        detail: `cwd: ${assessment.path}`,
        ...(hit === undefined ? {} : { subject: { kind: 'command', value: hit.segment } }),
      }, script)
      const temp = await ensureSessionTempDir(context.sessionId, deps.tempBase)
      const result = await deps.processes.run({
        command: flavor.program,
        args: flavor.argv(script),
        cwd,
        env: { TMP: temp, TEMP: temp, TMPDIR: temp, ...env },
        timeoutMs,
        signal: context.signal,
      })
      const terminated = result.timedOut ? 'timeout' : result.aborted ? 'cancel' : undefined
      return {
        content: deps.redactor.redact(formatProcessResult(result, timeoutMs)),
        isError: terminated !== undefined,
        meta: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          durationMs: result.durationMs,
          ...(terminated === undefined ? {} : { terminated }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
        },
      }
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

/** The platform's shell tool(s): `pwsh` on Windows, `bash` elsewhere. */
export function shellTools(deps: ShellToolDeps, platform: NodeJS.Platform = process.platform): WorkspaceTool[] {
  return platform === 'win32' ? [pwshTool(deps)] : [bashTool(deps)]
}
