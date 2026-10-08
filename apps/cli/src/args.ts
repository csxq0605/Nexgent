/**
 * Command-line parsing for `nexgent`, on `node:util` `parseArgs`.
 *
 * Shape (normative for scripts and the PowerShell launcher):
 *
 * ```text
 * nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]
 * nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]
 * nexgent app --project <dir>
 * nexgent --version | --help | <command> --help
 * ```
 *
 * Parsing is pure: no I/O, no defaults that depend on the disk. Errors are
 * {@link CliError}s with exit code {@link EXIT.USAGE}.
 */
import { parseArgs } from 'node:util'
import { SANDBOX_MODES, type SandboxMode } from '@nexgent/kernel'
import { CliError, EXIT } from './exit-codes.js'

/** Subcommands, in help order. */
export const COMMANDS = ['run', 'resume', 'app'] as const

/** One of {@link COMMANDS}. */
export type Command = (typeof COMMANDS)[number]

/** `nexgent run`: start a new session and run one task. */
export interface RunInvocation {
  readonly command: 'run'
  /** Project directory as given (resolved against the cwd later). */
  readonly project: string
  readonly task: string
  /** `--sandbox`; absent means config, then the default. */
  readonly sandbox?: SandboxMode
  /** `--model`; absent means config, then the default. */
  readonly model?: string
  /** Emit JSON lines on stdout instead of text. */
  readonly json: boolean
}

/** `nexgent resume`: reopen a session and run one more task in it. */
export interface ResumeInvocation {
  readonly command: 'resume'
  readonly sessionId: string
  readonly project: string
  /** Absent means {@link RESUME_DEFAULT_TASK}. */
  readonly task?: string
  /** `--sandbox`; absent keeps the mode recorded in the session header. */
  readonly sandbox?: SandboxMode
  readonly json: boolean
}

/** `nexgent app`: the desktop app entry (step 2 placeholder). */
export interface AppInvocation {
  readonly command: 'app'
  readonly project: string
}

/** `--help`, globally or for one command. */
export interface HelpInvocation {
  readonly command: 'help'
  readonly topic?: Command
}

/** `--version`. */
export interface VersionInvocation {
  readonly command: 'version'
}

/** Everything {@link parseCliArgs} can return. */
export type Invocation = RunInvocation | ResumeInvocation | AppInvocation | HelpInvocation | VersionInvocation

/** The task `resume` sends when `--task` is omitted. */
export const RESUME_DEFAULT_TASK = 'Continue the previous task from where it stopped.'

/** Session ids Nexgent generates: lowercase UUID v4 (`data-formats.md` §目录布局). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Whether a string is a session id Nexgent could have generated. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value)
}

const OPTIONS = {
  project: { type: 'string' },
  task: { type: 'string' },
  sandbox: { type: 'string' },
  model: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

type OptionName = keyof typeof OPTIONS

/** Which options each command accepts (`help` is accepted everywhere). */
const ACCEPTED: Readonly<Record<Command, readonly OptionName[]>> = {
  run: ['project', 'task', 'sandbox', 'model', 'json'],
  resume: ['project', 'task', 'sandbox', 'json'],
  app: ['project'],
}

function usageError(message: string): CliError {
  return new CliError(EXIT.USAGE, `${message} (see \`nexgent --help\`)`)
}

function parseSandbox(value: string | undefined): SandboxMode | undefined {
  if (value === undefined) return undefined
  if ((SANDBOX_MODES as readonly string[]).includes(value)) return value as SandboxMode
  throw usageError(`--sandbox must be one of ${SANDBOX_MODES.join(', ')}, got "${value}"`)
}

function requireText(name: string, value: string | undefined): string {
  if (value === undefined) throw usageError(`--${name} is required`)
  if (value.trim() === '') throw usageError(`--${name} must not be empty`)
  return value
}

function optionalText(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.trim() === '') throw usageError(`--${name} must not be empty`)
  return value
}

/**
 * Parse argv (without the node binary and script) into an {@link Invocation}.
 * @throws {@link CliError} with exit code 2 on any usage error.
 */
export function parseCliArgs(argv: readonly string[]): Invocation {
  const [first, ...rest] = argv
  if (first === undefined) throw usageError('missing command')
  if (first === '-h' || first === '--help') return { command: 'help' }
  if (first === '-v' || first === '--version') return { command: 'version' }
  if (!(COMMANDS as readonly string[]).includes(first)) {
    throw usageError(first.startsWith('-') ? `unknown option "${first}"` : `unknown command "${first}"`)
  }
  const command = first as Command

  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>
  try {
    parsed = parseArgs({ args: [...rest], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw usageError(`nexgent ${command}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const { values, positionals } = parsed
  if (values.help === true) return { command: 'help', topic: command }

  for (const name of Object.keys(values) as OptionName[]) {
    if (name === 'help') continue
    if (!ACCEPTED[command].includes(name)) throw usageError(`nexgent ${command} does not accept --${name}`)
  }

  const project = requireText('project', values.project)
  const sandbox = parseSandbox(values.sandbox)
  const json = values.json === true

  switch (command) {
    case 'run': {
      if (positionals.length > 0) {
        throw usageError(`nexgent run takes no positional arguments, got "${positionals[0]}"; pass the task with --task`)
      }
      const task = requireText('task', values.task)
      const model = optionalText('model', values.model)
      return {
        command, project, task, json,
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(model === undefined ? {} : { model }),
      }
    }
    case 'resume': {
      const [sessionId, extra] = positionals
      if (sessionId === undefined) throw usageError('nexgent resume needs a <sessionId>')
      if (extra !== undefined) throw usageError(`nexgent resume takes one <sessionId>, got extra "${extra}"`)
      if (!isSessionId(sessionId)) throw usageError(`"${sessionId}" is not a session id (lowercase UUID v4)`)
      const task = optionalText('task', values.task)
      return {
        command, sessionId, project, json,
        ...(task === undefined ? {} : { task }),
        ...(sandbox === undefined ? {} : { sandbox }),
      }
    }
    case 'app':
      if (positionals.length > 0) throw usageError(`nexgent app takes no positional arguments, got "${positionals[0]}"`)
      return { command, project }
  }
}

/** Top-level help text. */
export function usage(): string {
  return [
    'Usage: nexgent <command> [options]',
    '',
    'Commands:',
    '  run      start a new session and run one task',
    '  resume   continue a saved session',
    '  app      launch the desktop app (step 2; not available yet)',
    '',
    'Options:',
    '  -v, --version  print the version',
    '  -h, --help     print this help (`nexgent <command> --help` for a command)',
    '',
    'Exit codes: 0 ok, 1 task failed, 2 usage / not available, 3 environment',
    '(project, API key, config, session), 4 internal error, 130 cancelled (Ctrl+C),',
    '143 terminated. Set NEXGENT_DEBUG=1 to print stack traces.',
  ].join('\n')
}

/** Help text of one command. */
export function commandUsage(command: Command): string {
  const sandbox = `  --sandbox <mode>   ${SANDBOX_MODES.join(' | ')}`
  switch (command) {
    case 'run':
      return [
        'Usage: nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]',
        '',
        'Start a new session in <dir> and run one task. The model API key comes from',
        'NEXGENT_API_KEY or ~/.nexgent/credentials.json.',
        '',
        '  --project <dir>    project directory (its .nexgent/ data dir is created if missing)',
        '  --task "<text>"    what to do',
        `${sandbox} (default: config, then workspace-write)`,
        '  --model <id>       model id (default: config, then mimo-v2.6-pro)',
        '  --json             JSON lines on stdout instead of text',
        '',
        'Ctrl+C cancels the running turn; a second Ctrl+C exits.',
      ].join('\n')
    case 'resume':
      return [
        'Usage: nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]',
        '',
        'Reopen a saved session and run one more task in it. A turn the previous',
        'process never finished is closed as interrupted first.',
        '',
        '  --project <dir>    project directory holding .nexgent/sessions/<sessionId>',
        `  --task "<text>"    what to do (default: "${RESUME_DEFAULT_TASK}")`,
        `${sandbox} (default: the mode recorded in the session)`,
        '  --json             JSON lines on stdout instead of text',
      ].join('\n')
    case 'app':
      return [
        'Usage: nexgent app --project <dir>',
        '',
        'Launch the desktop app on a project. Arrives in step 2; this build exits with 2.',
      ].join('\n')
  }
}
