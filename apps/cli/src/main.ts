/**
 * `nexgent` command-line entry point: parse, prepare the project, open a
 * session through the runtime seam, run one turn, render it, write the task
 * outcome, and map everything to an exit code (see `exit-codes.ts`).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isNexgentError } from '@nexgent/kernel'
import { createApprovalResponder, type AnswerSource } from './approval.js'
import { commandUsage, parseCliArgs, RESUME_DEFAULT_TASK, usage, type Invocation } from './args.js'
import { requireApiKey, type CredentialProbe } from './credentials.js'
import { CliError, EXIT, type ExitCode } from './exit-codes.js'
import { initProjectLayout } from './layout.js'
import { TaskTally } from './outcome.js'
import { createRenderer, type Renderer, type TextSink } from './render.js'
import { loadRuntime, RUNTIME_NOT_WIRED_CODE, RUNTIME_NOT_WIRED_MESSAGE, type CliRuntime } from './runtime.js'
import { installSignalHandlers, InterruptController, type SignalSource } from './signals.js'

/** Process-facing effects, injectable for tests. */
export interface CliIo {
  readonly stdout: TextSink & { readonly isTTY?: boolean }
  readonly stderr: TextSink & { readonly isTTY?: boolean }
  readonly stdin: AnswerSource
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Absent: no signal handlers are installed (tests drive {@link InterruptController} directly). */
  readonly signals?: SignalSource
  /** Hard exit (second Ctrl+C). */
  exit(code: ExitCode): void
}

/** Replaceable collaborators. */
export interface CliDeps {
  /** Default: `runtime.ts` `loadRuntime`. */
  readonly loadRuntime?: () => Promise<CliRuntime | undefined>
  /** Default: the real env and home directory. */
  readonly credentials?: CredentialProbe
  /** Approval prompt wait; default 300 s. */
  readonly approvalTimeoutMs?: number
}

/** The real process. */
export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    signals: process,
    exit: code => process.exit(code),
  }
}

/** Read the package version from `dist/../package.json`. */
export function packageVersion(): string {
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version: string }
  return pkg.version
}

/** Exit code for a thrown value. */
export function exitCodeForError(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode
  if (isNexgentError(error)) {
    const family = error.code.split('/')[0]
    if (['session', 'workspace', 'credentials', 'config', 'sandbox'].includes(family ?? '')) return EXIT.ENVIRONMENT
    if (error.code === 'internal') return EXIT.INTERNAL
    return EXIT.TASK_FAILED
  }
  return EXIT.INTERNAL
}

/** One-line message for a thrown value (`code: message` for Nexgent errors). */
export function errorMessage(error: unknown): string {
  if (isNexgentError(error)) return `${error.code}: ${error.message}`
  if (error instanceof CliError) return error.message
  if (error instanceof Error) return `internal error: ${error.message}`
  return `internal error: ${String(error)}`
}

/**
 * Run the CLI and resolve with the process exit code.
 * @param argv - arguments after the node binary and script.
 */
export async function main(argv: readonly string[], io: CliIo = processIo(), deps: CliDeps = {}): Promise<number> {
  let renderer: Renderer | undefined
  try {
    if (argv.length === 0) {
      io.stderr.write(`${usage()}\n`)
      return EXIT.USAGE
    }
    const invocation = parseCliArgs(argv)
    switch (invocation.command) {
      case 'help':
        io.stdout.write(`${invocation.topic === undefined ? usage() : commandUsage(invocation.topic)}\n`)
        return EXIT.OK
      case 'version':
        io.stdout.write(`${packageVersion()}\n`)
        return EXIT.OK
      case 'app':
        io.stderr.write('nexgent app: the desktop app arrives in step 2; use `nexgent run` for now\n')
        return EXIT.USAGE
      case 'run':
      case 'resume':
        renderer = createRenderer(invocation.json ? 'json' : 'text', io.stdout, io.stderr)
        return await runTask(invocation, renderer, io, deps)
    }
  } catch (error) {
    const message = errorMessage(error)
    io.stderr.write(`nexgent: ${message}\n`)
    if (io.env.NEXGENT_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
      io.stderr.write(`${error.stack}\n`)
    }
    renderer?.fail({ code: isNexgentError(error) || error instanceof CliError ? error.code : 'internal', message })
    return exitCodeForError(error)
  }
}

async function runTask(
  invocation: Extract<Invocation, { command: 'run' | 'resume' }>,
  renderer: Renderer,
  io: CliIo,
  deps: CliDeps,
): Promise<ExitCode> {
  const { layout } = await initProjectLayout(invocation.project, io.cwd)
  await requireApiKey(deps.credentials)
  const runtime = await (deps.loadRuntime ?? loadRuntime)()
  if (runtime === undefined) throw new CliError(EXIT.USAGE, RUNTIME_NOT_WIRED_MESSAGE, { code: RUNTIME_NOT_WIRED_CODE })

  const approvals = createApprovalResponder({
    input: io.stdin,
    output: io.stderr,
    beforePrompt: () => renderer.breakLine(),
    ...(deps.approvalTimeoutMs === undefined ? {} : { timeoutMs: deps.approvalTimeoutMs }),
  })
  const session = await runtime.open({
    layout,
    approvals,
    env: io.env,
    ...(invocation.command === 'resume' ? { resumeSessionId: invocation.sessionId } : {}),
    ...(invocation.command === 'run' && invocation.model !== undefined ? { model: invocation.model } : {}),
    ...(invocation.sandbox === undefined ? {} : { sandboxMode: invocation.sandbox }),
  })

  const tally = new TaskTally()
  const controller = new InterruptController({
    exit: code => io.exit(code),
    notify: (message) => {
      renderer.breakLine()
      io.stderr.write(`${message}\n`)
    },
  })
  const uninstall = io.signals === undefined ? () => {} : installSignalHandlers(io.signals, controller)
  try {
    tally.observe(session.info)
    renderer.render(session.info)
    const task = invocation.task ?? RESUME_DEFAULT_TASK
    let failure: unknown
    const signal = controller.beginTurn()
    try {
      for await (const event of session.runTurn(task, signal)) {
        tally.observe(event)
        renderer.render(event)
      }
    } catch (error) {
      failure = error
    } finally {
      controller.endTurn()
    }
    const outcome = tally.outcome()
    try {
      await session.recordOutcome(outcome)
    } catch (error) {
      renderer.breakLine()
      io.stderr.write(`nexgent: warning: task outcome not recorded: ${errorMessage(error)}\n`)
    }
    if (failure !== undefined) throw failure
    const exitCode = tally.exitCode
    renderer.finish({
      sessionId: outcome.sessionId,
      status: outcome.status,
      exitCode,
      totalUsage: outcome.totalUsage,
      requestCount: outcome.requestCount,
      toolCallCount: outcome.toolCallCount,
      finalText: tally.finalText,
    })
    return exitCode
  } finally {
    uninstall()
    await session.close()
  }
}
