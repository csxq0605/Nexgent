/**
 * `nexgent` command-line entry point: parse, prepare the project, open a
 * session through the runtime seam, run one turn, render it, write the task
 * outcome, and map everything to an exit code (see `exit-codes.ts`).
 */
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isNexgentError, NexgentError } from '@nexgent/kernel'
import { createSdk } from '@nexgent/sdk'
import { launchDesktop, type AppLaunchOptions } from './app-launch.js'
import { createApprovalResponder, type AnswerSource } from './approval.js'
import { commandUsage, parseCliArgs, RESUME_DEFAULT_TASK, usage, type Invocation } from './args.js'
import { requireApiKey, type CredentialProbe } from './credentials.js'
import { CliError, EXIT, type ExitCode } from './exit-codes.js'
import { initProjectLayout } from './layout.js'
import { TaskTally } from './outcome.js'
import { createRenderer, type Renderer, type TextSink } from './render.js'
import { loadRuntime, type CliRuntime } from './runtime.js'
import { installSignalHandlers, InterruptController, type SignalSource } from './signals.js'
import { packageVersion } from './version.js'

export { packageVersion }

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
  readonly loadRuntime?: () => Promise<CliRuntime>
  /** Default: `{ env: io.env }` (home from `NEXGENT_HOME`, then `~/.nexgent`). */
  readonly credentials?: CredentialProbe
  /** Approval prompt wait; default 300 s. */
  readonly approvalTimeoutMs?: number
  /** Default: `app-launch.ts` `launchDesktop`. */
  readonly launchDesktop?: (options: AppLaunchOptions) => Promise<unknown>
  /** How long a run waits for its background learning before exiting; default {@link LEARNING_WAIT_MS}. */
  readonly learningWaitMs?: number
}

/** Rework D3: the longest a run waits after its turn for background learning (10 minutes). */
export const LEARNING_WAIT_MS = 600_000

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
      case 'app': {
        // The desktop app opens (and initializes) the project itself; only check it is a directory.
        const project = invocation.project === undefined ? undefined : await existingDirectory(path.resolve(io.cwd, invocation.project))
        await (deps.launchDesktop ?? launchDesktop)({ env: io.env, ...(project === undefined ? {} : { project }) })
        io.stderr.write(`nexgent: desktop app started${project === undefined ? '' : ` on ${project}`}\n`)
        return EXIT.OK
      }
      case 'export':
        renderer = createRenderer(invocation.json ? 'json' : 'text', io.stdout, io.stderr)
        return await runExport(invocation, io)
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
  const { layout } = await initProjectLayout(invocation.project, io.cwd, io.env)
  await requireApiKey(deps.credentials ?? { env: io.env })
  const runtime = await (deps.loadRuntime ?? loadRuntime)()

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
    ...(invocation.command === 'run' && invocation.plan === true ? { plan: true } : {}),
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
    // Rework D3: background learning from this run stops with the process; wait for it (bounded, Ctrl+C skips).
    if (session.learning?.busy() === true) {
      io.stderr.write('nexgent: learning from this run (Ctrl+C to skip; it continues the next time)\n')
      const waited = await session.learning.wait(controller.beginWait(), deps.learningWaitMs ?? LEARNING_WAIT_MS).catch(() => 'idle' as const)
      controller.endTurn()
      if (waited === 'timeout') io.stderr.write('nexgent: learning is taking long; it continues the next time Nexgent runs in this project\n')
    }
    return exitCode
  } finally {
    uninstall()
    await session.close()
  }
}

async function runExport(invocation: Extract<Invocation, { command: 'export' }>, io: CliIo): Promise<ExitCode> {
  const { layout } = await initProjectLayout(invocation.project, io.cwd, io.env)
  if (!existsSync(path.join(layout.sessions, invocation.sessionId, 'session.jsonl'))) {
    throw new NexgentError('session/not-found', `session ${invocation.sessionId} not found in ${layout.root}`)
  }
  const outDir = path.resolve(io.cwd, invocation.out ?? `nexgent-export-${invocation.sessionId}`)
  const sdk = createSdk({ appVersion: packageVersion(), env: io.env })
  try {
    const { projectId } = await sdk.call('projects.open', { root: layout.root })
    const result = await sdk.call('sessions.export', { projectId, sessionId: invocation.sessionId, outDir })
    if (invocation.json) io.stdout.write(`${JSON.stringify({ type: 'export', sessionId: invocation.sessionId, path: result.path, files: result.files })}\n`)
    else io.stdout.write(`exported session ${invocation.sessionId} to ${result.path}\n${result.files.map(file => `  ${file}`).join('\n')}\n`)
    return EXIT.OK
  } finally {
    await sdk.dispose()
  }
}

async function existingDirectory(dir: string): Promise<string> {
  const isDir = await stat(dir).then(s => s.isDirectory(), () => false)
  if (!isDir) throw new CliError(EXIT.ENVIRONMENT, `project directory not found: ${dir}`)
  return dir
}
