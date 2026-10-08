/**
 * Renders the {@link CliEvent} stream of one run.
 *
 * Text mode: stdout carries only the assistant's text, streamed as it
 * arrives; progress (session, tool calls and results, approvals, turn status,
 * the closing summary) goes to stderr, so `nexgent run ... > answer.txt`
 * captures just the answer.
 *
 * JSON mode (`--json`): stdout carries one bounded JSON object per line, one
 * per event, closed by an unbounded `final` line; stderr keeps human
 * diagnostics only (warnings, errors).
 */
import type { LLMUsage, TaskOutcomeStatus, UsageCount } from '@nexgent/kernel'
import type { CliEvent } from './events.js'
import { boundJsonLine } from './json-lines.js'

/** Anything with a string `write`. */
export interface TextSink {
  write(chunk: string): unknown
}

/** Output mode. */
export type RenderMode = 'text' | 'json'

/** What the run ended with, for the closing line. */
export interface RunSummary {
  readonly sessionId: string
  readonly status: TaskOutcomeStatus
  readonly exitCode: number
  readonly totalUsage: LLMUsage
  readonly requestCount: number
  readonly toolCallCount: number
  /** Assistant text of the last turn. */
  readonly finalText: string
}

/** A renderer bound to two sinks. */
export interface Renderer {
  /** Render one event. */
  render(event: CliEvent): void
  /** Terminate an open stdout text line (call before printing a prompt). */
  breakLine(): void
  /** Write the closing summary (text) or the `final` line (JSON). */
  finish(summary: RunSummary): void
  /** Report a failure that happened outside the event stream (JSON mode adds an `error` line). */
  fail(error: { readonly code: string; readonly message: string }): void
}

/** Max characters of tool arguments and results shown on one text line. */
export const TEXT_PREVIEW_CHARS = 160

/** Collapse whitespace and cut to `max` characters with a `...` marker. */
export function preview(text: string, max: number = TEXT_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`
}

function count(value: UsageCount): string {
  return value === 'unknown' ? '?' : String(value)
}

/** One-line usage text, `?` for unknown counts. */
export function formatUsage(usage: LLMUsage): string {
  return `tokens in ${count(usage.inputTokens)} / out ${count(usage.outputTokens)}`
}

/** Create a renderer. */
export function createRenderer(mode: RenderMode, stdout: TextSink, stderr: TextSink): Renderer {
  return mode === 'json' ? jsonRenderer(stdout, stderr) : textRenderer(stdout, stderr)
}

function fullAccessWarning(stderr: TextSink, event: CliEvent): void {
  if (event.type === 'session' && event.sandboxMode === 'full-access') {
    stderr.write('nexgent: warning: full-access sandbox: tools may read, write and run anything you can\n')
  }
}

function jsonRenderer(stdout: TextSink, stderr: TextSink): Renderer {
  return {
    render(event) {
      fullAccessWarning(stderr, event)
      stdout.write(`${boundJsonLine(event as unknown as Record<string, unknown>)}\n`)
    },
    breakLine() {},
    finish(summary) {
      // The answer is the lossless terminal contract, so it is not bounded.
      stdout.write(`${JSON.stringify({
        type: 'final',
        sessionId: summary.sessionId,
        status: summary.status,
        exitCode: summary.exitCode,
        text: summary.finalText,
        totalUsage: summary.totalUsage,
        requestCount: summary.requestCount,
        toolCallCount: summary.toolCallCount,
      })}\n`)
    },
    fail(error) {
      stdout.write(`${boundJsonLine({ type: 'error', error: { code: error.code, message: error.message } })}\n`)
    },
  }
}

function textRenderer(stdout: TextSink, stderr: TextSink): Renderer {
  /** Whether stdout has text without a trailing newline. */
  let openText = false
  /** Whether a reasoning section is open on stderr. */
  let reasoning = false
  let projectRoot: string | undefined

  const breakLine = (): void => {
    if (openText) {
      stdout.write('\n')
      openText = false
    }
    if (reasoning) {
      stderr.write('\n')
      reasoning = false
    }
  }
  const note = (line: string): void => {
    breakLine()
    stderr.write(`${line}\n`)
  }

  return {
    breakLine,
    render(event) {
      switch (event.type) {
        case 'session':
          projectRoot = event.projectRoot
          note(`nexgent: ${event.resumed ? 'resumed' : 'new'} session ${event.sessionId} (model ${event.model}, sandbox ${event.sandboxMode})`)
          fullAccessWarning(stderr, event)
          return
        case 'text.delta':
          if (event.text === '') return
          if (reasoning) {
            stderr.write('\n')
            reasoning = false
          }
          stdout.write(event.text)
          openText = !event.text.endsWith('\n')
          return
        case 'reasoning.delta':
          if (event.text === '') return
          if (!reasoning) {
            if (openText) {
              stdout.write('\n')
              openText = false
            }
            stderr.write('thinking: ')
            reasoning = true
          }
          stderr.write(event.text)
          return
        case 'tool.start':
          note(`> ${event.name} ${preview(event.arguments)}`)
          return
        case 'tool.end':
          note(`  ${event.isError ? 'error' : 'ok'} ${event.durationMs} ms: ${preview(event.content) || '(no output)'}`)
          return
        case 'approval.decision': {
          const { decision } = event
          const how = decision.decision === 'allow' ? `allowed (${decision.scope})` : `denied (${decision.decidedBy})`
          note(`  approval: ${how}`)
          return
        }
        case 'turn.end': {
          const { reason } = event
          if (reason.kind === 'completed') breakLine()
          else if (reason.kind === 'cancelled') note(`nexgent: turn ${event.turn} cancelled (${reason.cause})`)
          else if (reason.kind === 'error') note(`nexgent: turn ${event.turn} failed: ${reason.error.code}: ${reason.error.message}`)
          else if (reason.kind === 'max-tokens') note(`nexgent: turn ${event.turn} stopped at the output token limit`)
          else note(`nexgent: turn ${event.turn} was interrupted`)
          return
        }
        case 'run.error':
          note(`nexgent: ${event.fatal ? 'fatal ' : ''}error: ${event.error.code}: ${event.error.message}`)
          return
        default:
          // turn.start, step.start, tool-call.*, usage, approval.request: no text output
          // (the approval prompt is printed by the responder).
          return
      }
    },
    finish(summary) {
      note(`nexgent: ${summary.status}; session ${summary.sessionId}; requests ${summary.requestCount}; tool calls ${summary.toolCallCount}; ${formatUsage(summary.totalUsage)}`)
      if (summary.status !== 'completed' && projectRoot !== undefined) {
        note(`nexgent: continue with: nexgent resume ${summary.sessionId} --project ${JSON.stringify(projectRoot)}`)
      }
    },
    fail() {},
  }
}
