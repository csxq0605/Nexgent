/**
 * The tagged error family every Nexgent contract throws and records.
 *
 * One class, one `code` discriminant: callers switch on `error.code`, never
 * on message text. Codes are namespaced by contract (`llm/…`, `tool/…`,
 * `session/…`) so a code read from a record identifies the failing subsystem
 * without a stack trace.
 */

/** Every error code a contract implementation may raise. */
export type NexgentErrorCode =
  // llm
  | 'llm/request-failed'
  | 'llm/timeout'
  | 'llm/aborted'
  | 'llm/invalid-response'
  // tools
  | 'tool/not-found'
  | 'tool/invalid-input'
  | 'tool/denied'
  | 'tool/failed'
  | 'tool/timeout'
  | 'tool/aborted'
  // session
  | 'session/not-found'
  | 'session/exists'
  | 'session/locked'
  | 'session/corrupt'
  | 'session/invalid-record'
  // ledger
  | 'ledger/write-failed'
  | 'ledger/invalid-record'
  // workspace / sandbox / processes
  | 'workspace/not-found'
  | 'workspace/outside-root'
  | 'sandbox/denied'
  | 'process/timeout'
  | 'process/failed'
  // credentials / config
  | 'credentials/missing'
  | 'config/invalid'
  | 'config/profile-patch'
  // catch-all for programmer errors and wrapped unknowns
  | 'internal'

/** Constructor options for {@link NexgentError}. */
export interface NexgentErrorOptions {
  /** The underlying error, kept for diagnostics (`Error.cause`). */
  readonly cause?: unknown
  /** Structured, JSON-safe detail for logs and tests; never a secret or prompt body. */
  readonly details?: Readonly<Record<string, unknown>>
}

/** Base error of every contract: a message plus a machine-readable `code`. */
export class NexgentError extends Error {
  /** The discriminant callers switch on. */
  readonly code: NexgentErrorCode
  /** Structured detail attached at the throw site. */
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(code: NexgentErrorCode, message: string, options: NexgentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NexgentError'
    this.code = code
    this.details = options.details
  }
}

/**
 * Type guard for {@link NexgentError}, optionally narrowed to one code.
 * @param error - any thrown value.
 * @param code - when given, only errors with exactly this code match.
 */
export function isNexgentError(error: unknown, code?: NexgentErrorCode): error is NexgentError {
  return error instanceof NexgentError && (code === undefined || error.code === code)
}

/**
 * The JSON-safe projection of an error that records may carry. It has no
 * stack and no cause chain; `code` is a {@link NexgentErrorCode} for Nexgent
 * errors and `'internal'` for anything else.
 */
export interface ErrorInfo {
  /** `error.name`, e.g. `NexgentError`, `TypeError`. */
  readonly name: string
  /** The machine-readable code. */
  readonly code: NexgentErrorCode
  /** The human-readable message. */
  readonly message: string
}

/**
 * Flatten any thrown value into an {@link ErrorInfo}.
 * @param error - any thrown value, including non-`Error` throws.
 */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof NexgentError) {
    return { name: error.name, code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { name: error.name, code: 'internal', message: error.message }
  }
  return { name: 'Error', code: 'internal', message: String(error) }
}
