/**
 * Messages between the host and a PTC program process: newline-delimited
 * JSON, host → program on the program's stdin, program → host on its stdout.
 * The program's own `console` / `process.stdout` / `process.stderr` writes
 * are wrapped into `log` messages by the bootstrap, so stdout carries only
 * frames. Model code runs in that process and can write anything, so the
 * host validates every frame ({@link parseProgramMessage}) and treats a line
 * that is not a valid frame as plain output.
 */
import type { JsonValue } from '@nexgent/kernel'

/** Host → program, first line: what to run. */
export interface BootMessage {
  readonly t: 'boot'
  /** Async function body written by the model. */
  readonly code: string
  /** Host function names, bound as parameters of the program body. */
  readonly functions: readonly string[]
  /** JSON values bound as parameters of the program body (e.g. `args`). */
  readonly globals: Readonly<Record<string, JsonValue>>
  /**
   * Trusted source evaluated once before the program, with the host
   * functions in scope; it returns an object whose members are bound as
   * further parameters (the workflow's `parallel` / `pipeline`).
   */
  readonly prelude?: string
}

/** Host → program: the answer to one {@link CallMessage}. */
export type ReplyMessage =
  | { readonly t: 'reply'; readonly id: number; readonly ok: true; readonly value?: JsonValue }
  | { readonly t: 'reply'; readonly id: number; readonly ok: false; readonly error: string }

/** Every message the host sends. */
export type HostMessage = BootMessage | ReplyMessage

/** Program → host: one host function call. */
export interface CallMessage {
  readonly t: 'call'
  /** Program-issued correlation id; answered once. */
  readonly id: number
  readonly fn: string
  readonly args: readonly JsonValue[]
}

/** Program → host: captured output. */
export interface LogMessage {
  readonly t: 'log'
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

/** Program → host: the program settled. */
export type DoneMessage =
  | { readonly t: 'done'; readonly ok: true; readonly value?: JsonValue }
  | { readonly t: 'done'; readonly ok: false; readonly error: { readonly name: string; readonly message: string; readonly stack?: string } }

/** Every message the program sends. */
export type ProgramMessage = CallMessage | LogMessage | DoneMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse and validate one stdout line; `undefined` when it is not a frame. */
export function parseProgramMessage(line: string): ProgramMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  switch (value.t) {
    case 'call':
      if (!Number.isSafeInteger(value.id) || typeof value.fn !== 'string' || !Array.isArray(value.args)) return undefined
      return { t: 'call', id: value.id as number, fn: value.fn, args: value.args as JsonValue[] }
    case 'log':
      if ((value.stream !== 'stdout' && value.stream !== 'stderr') || typeof value.text !== 'string') return undefined
      return { t: 'log', stream: value.stream, text: value.text }
    case 'done': {
      if (value.ok === true) return value.value === undefined ? { t: 'done', ok: true } : { t: 'done', ok: true, value: value.value as JsonValue }
      if (value.ok !== false || !isRecord(value.error)) return undefined
      const error = value.error
      return {
        t: 'done',
        ok: false,
        error: {
          name: typeof error.name === 'string' ? error.name : 'Error',
          message: typeof error.message === 'string' ? error.message : String(error.message),
          ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
        },
      }
    }
    default:
      return undefined
  }
}
