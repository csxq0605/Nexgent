/**
 * Process exit codes of the `nexgent` command. Scripts (CI, the PowerShell
 * launcher, `scripts/accept-step1.mjs`) switch on these numbers, so they are
 * part of the CLI's public surface; the README table mirrors this file.
 */

/** Every exit code `nexgent` returns. */
export const EXIT = Object.freeze({
  /** The task (or `--version` / `--help`) completed. */
  OK: 0,
  /** The task ran but did not complete: model or tool error, cost cap, turn timeout, max tokens. */
  TASK_FAILED: 1,
  /** Bad command line, or a command this build does not provide yet (`app`, an unwired runtime). */
  USAGE: 2,
  /** The environment is not usable: project dir missing, no API key, bad config, session missing or locked. */
  ENVIRONMENT: 3,
  /** An unexpected internal error (a bug); rerun with `NEXGENT_DEBUG=1` for the stack. */
  INTERNAL: 4,
  /** The user cancelled the turn with Ctrl+C (128 + SIGINT). */
  CANCELLED: 130,
  /** The process was asked to stop (SIGTERM, 128 + 15) and closed the turn as `shutdown`. */
  TERMINATED: 143,
})

/** One of the {@link EXIT} values. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** An expected failure with a user-facing message and a chosen exit code; printed without a stack. */
export class CliError extends Error {
  /** The process exit code this failure maps to. */
  readonly exitCode: ExitCode
  /** Machine-readable tag for `--json` error lines, e.g. `cli/usage`, `cli/runtime-not-wired`. */
  readonly code: string

  constructor(exitCode: ExitCode, message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CliError'
    this.exitCode = exitCode
    this.code = options?.code ?? (exitCode === EXIT.USAGE ? 'cli/usage' : exitCode === EXIT.ENVIRONMENT ? 'cli/environment' : 'cli/error')
  }
}
