// Adapted from deepseek-harness@46a7f68b packages/util/timeout/src/index.ts (MIT)
/**
 * Timeout arithmetic and signal fusion. A deadline only notifies through an
 * `AbortSignal`; the owner of the work stops it and classifies the reason
 * with {@link timeoutOf}.
 */

/** Abort reason carrying the owner's code and the elapsed budget. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Largest delay Node schedules without clamping it to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A fused signal plus the cleanup that clears its timer. */
export interface Deadline {
  /** Aborts on upstream cancellation or on timeout (reason {@link TimeoutReason}). */
  readonly signal: AbortSignal
  /** Clear the timer; idempotent. */
  dispose(): void
}

/**
 * Fuse an upstream signal with a timer. `timeoutMs` absent or `<= 0` arms no
 * timer and forwards the upstream signal.
 * @param upstream - caller cancellation.
 * @param timeoutMs - budget in ms.
 * @param code - classification code stamped on the timeout reason.
 */
export function deadline(upstream: AbortSignal | undefined, timeoutMs: number | undefined, code: string): Deadline {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return { signal: upstream ?? new AbortController().signal, dispose() {} }
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeout must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const timer = new AbortController()
  const id = setTimeout(() => timer.abort(new TimeoutReason(code, timeoutMs)), timeoutMs)
  return {
    // AbortSignal.any adopts the reason of whichever source aborts first.
    signal: upstream === undefined ? timer.signal : AbortSignal.any([upstream, timer.signal]),
    dispose: () => clearTimeout(id),
  }
}

/**
 * The {@link TimeoutReason} a signal was aborted with, when the timeout (with
 * this code, if given) won the race; `undefined` for an ordinary cancel.
 */
export function timeoutOf(signal: AbortSignal, code?: string): TimeoutReason | undefined {
  if (!signal.aborted) return undefined
  const reason: unknown = signal.reason
  if (!(reason instanceof TimeoutReason)) return undefined
  return code === undefined || reason.code === code ? reason : undefined
}

/** A promise that resolves (never rejects) once `signal` aborts. */
export function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
