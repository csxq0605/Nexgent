/**
 * The CLI's {@link ApprovalResponder} (`permissions.md` §CLI 与桌面应用共用的审批交互).
 *
 * - Interactive (stdin and the prompt stream are both TTYs): print summary,
 *   detail and risk, then `[a]llow once / [s]ession / [p]roject / [d]eny`
 *   (only the scopes the request offers), and wait up to 300 s; no answer is
 *   a deny with `decidedBy: 'timeout'`.
 * - Not interactive (CI, redirected stdin): deny at once with
 *   `decidedBy: 'headless'`, never blocking.
 * - The turn's abort signal closes a pending prompt with `decidedBy: 'cancel'`.
 *
 * Requests are asked one at a time; concurrent requests queue.
 */
import type { ApprovalDecision, ApprovalRequest, ApprovalResponder, ApprovalScope } from '@nexgent/kernel'
import type { TextSink } from './render.js'

/** How long the TTY prompt waits (`approvalTimeoutMs`). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

/** The stream the answers are read from (stdin in production). */
export interface AnswerSource {
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  on(event: 'end', listener: () => void): unknown
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown
  off(event: 'end', listener: () => void): unknown
  resume(): unknown
  pause(): unknown
  readonly isTTY?: boolean
}

/** Options of {@link createApprovalResponder}. */
export interface ApprovalResponderOptions {
  readonly input: AnswerSource
  /** Where the prompt goes (stderr in production, so `--json` stdout stays clean). */
  readonly output: TextSink & { readonly isTTY?: boolean }
  /** Override TTY detection; default `input.isTTY && output.isTTY`. */
  readonly interactive?: boolean
  /** Wait per request; default {@link DEFAULT_APPROVAL_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Called before a prompt is printed (e.g. `renderer.breakLine`). */
  readonly beforePrompt?: () => void
  /** Clock, for `expiresAt`; default `Date.now`. */
  readonly now?: () => number
}

/** A parsed answer. */
export type ApprovalAnswer =
  | { readonly decision: 'allow'; readonly scope: ApprovalScope }
  | { readonly decision: 'deny' }

const ANSWERS: Readonly<Record<string, ApprovalAnswer>> = {
  a: { decision: 'allow', scope: 'once' },
  allow: { decision: 'allow', scope: 'once' },
  once: { decision: 'allow', scope: 'once' },
  s: { decision: 'allow', scope: 'session' },
  session: { decision: 'allow', scope: 'session' },
  p: { decision: 'allow', scope: 'project' },
  project: { decision: 'allow', scope: 'project' },
  d: { decision: 'deny' },
  deny: { decision: 'deny' },
  n: { decision: 'deny' },
  no: { decision: 'deny' },
}

/**
 * Parse one typed line. `undefined` for anything unrecognized, empty, or a
 * scope the request does not offer (the prompt then asks again).
 */
export function parseApprovalAnswer(line: string, options: readonly ApprovalScope[]): ApprovalAnswer | undefined {
  const answer = ANSWERS[line.trim().toLowerCase()]
  if (answer === undefined) return undefined
  if (answer.decision === 'allow' && !options.includes(answer.scope)) return undefined
  return answer
}

/** The choice line for a request's offered scopes. */
export function approvalChoices(options: readonly ApprovalScope[]): string {
  const labels: Record<ApprovalScope, string> = { once: '[a]llow once', session: '[s]ession', project: '[p]roject' }
  return [...(['once', 'session', 'project'] as const).filter(scope => options.includes(scope)).map(scope => labels[scope]), '[d]eny'].join(' / ')
}

/** The full prompt text (without the trailing choice line's newline). */
export function formatApprovalPrompt(request: ApprovalRequest, timeoutMs: number): string {
  const lines = [`nexgent: approval needed [${request.risk} risk] ${request.tool}`, `  ${request.summary}`]
  if (request.detail !== undefined && request.detail !== '') {
    for (const line of request.detail.split(/\r?\n/)) lines.push(`  ${line}`)
  }
  if (request.pattern !== undefined && (request.options.includes('session') || request.options.includes('project'))) {
    lines.push(`  a session / project grant would cover: ${request.pattern}`)
  }
  lines.push(`${approvalChoices(request.options)} (${Math.ceil(timeoutMs / 1000)} s)? `)
  return lines.join('\n')
}

function deny(request: ApprovalRequest, decidedBy: ApprovalDecision['decidedBy']): ApprovalDecision {
  return { id: request.id, decision: 'deny', scope: 'once', decidedBy }
}

/** The decision a non-interactive CLI returns for every request. */
export function headlessDecision(request: ApprovalRequest): ApprovalDecision {
  return deny(request, 'headless')
}

type LineResult = { kind: 'line'; line: string } | { kind: 'timeout' } | { kind: 'cancel' } | { kind: 'eof' }

/** Create the CLI responder; register it with `ctx.approvals.setResponder`. */
export function createApprovalResponder(options: ApprovalResponderOptions): ApprovalResponder {
  const { input, output } = options
  const interactive = options.interactive ?? (input.isTTY === true && output.isTTY === true)
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const now = options.now ?? Date.now
  /** Typed text not yet consumed (after a newline we already used). */
  let pending = ''
  let ended = false
  let queue: Promise<unknown> = Promise.resolve()

  const readLine = (signal: AbortSignal, waitMs: number): Promise<LineResult> => new Promise((resolve) => {
    const take = (): boolean => {
      const index = pending.indexOf('\n')
      if (index < 0) return false
      const line = pending.slice(0, index).replace(/\r$/, '')
      pending = pending.slice(index + 1)
      finish({ kind: 'line', line })
      return true
    }
    const onData = (chunk: string | Buffer): void => {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      take()
    }
    const onEnd = (): void => {
      ended = true
      finish({ kind: 'eof' })
    }
    const onAbort = (): void => finish({ kind: 'cancel' })
    const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, waitMs))
    let done = false
    function finish(result: LineResult): void {
      if (done) return
      done = true
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
      // Let the process exit while nobody is being asked.
      input.pause()
      resolve(result)
    }
    if (signal.aborted) return finish({ kind: 'cancel' })
    if (take()) return
    if (ended) return finish({ kind: 'eof' })
    input.on('data', onData)
    input.on('end', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    input.resume()
  })

  const ask = async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> => {
    if (signal.aborted) return deny(request, 'cancel')
    const expires = request.expiresAt === undefined ? Number.NaN : Date.parse(request.expiresAt)
    const deadline = Math.min(now() + timeoutMs, Number.isNaN(expires) ? Infinity : expires)
    options.beforePrompt?.()
    output.write(formatApprovalPrompt(request, deadline - now()))
    for (;;) {
      const result = await readLine(signal, deadline - now())
      switch (result.kind) {
        case 'cancel':
          output.write('\nnexgent: approval cancelled with the turn\n')
          return deny(request, 'cancel')
        case 'timeout':
          output.write(`\nnexgent: no answer within ${Math.ceil(timeoutMs / 1000)} s; denied\n`)
          return deny(request, 'timeout')
        case 'eof':
          output.write('\nnexgent: input closed; denied\n')
          return deny(request, 'headless')
        case 'line': {
          const answer = parseApprovalAnswer(result.line, request.options)
          if (answer === undefined) {
            output.write(`please answer ${approvalChoices(request.options)}: `)
            continue
          }
          return answer.decision === 'allow'
            ? { id: request.id, decision: 'allow', scope: answer.scope, decidedBy: 'user' }
            : deny(request, 'user')
        }
      }
    }
  }

  return (request, signal) => {
    if (!interactive) return Promise.resolve(headlessDecision(request))
    const run = queue.then(() => ask(request, signal))
    queue = run.catch(() => undefined)
    return run
  }
}
