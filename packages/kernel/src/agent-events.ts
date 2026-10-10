/**
 * The event stream an agent emits while it works. The CLI renders it in the
 * terminal; the desktop app (step 2) forwards it over IPC. Everything that is
 * persisted is also emitted as a `record` event right after the append.
 */
import type { ApprovalDecision, ApprovalRequest } from './contracts/approvals.js'
import type { ErrorInfo } from './contracts/errors.js'
import type { FinishReason, LLMUsage, RefusalInfo, ToolCall, ToolResult } from './contracts/llm.js'
import type { SessionRecord, TurnEndReason } from './contracts/session.js'

interface Base {
  /** Session (= agent) the event belongs to. */
  readonly sessionId: string
}

/** Every event an {@link Agent} emits. */
export type AgentEvent =
  | Base & { readonly type: 'turn.start'; readonly turn: number }
  | Base & { readonly type: 'request.start'; readonly turn: number; readonly step: number; readonly requestId: string; readonly model: string }
  | Base & { readonly type: 'text.delta'; readonly turn: number; readonly step: number; readonly text: string }
  | Base & { readonly type: 'reasoning.delta'; readonly turn: number; readonly step: number; readonly text: string }
  | Base & { readonly type: 'tool-call.start'; readonly turn: number; readonly step: number; readonly index: number; readonly id: string; readonly name: string }
  | Base & {
    readonly type: 'assistant.message'
    readonly turn: number
    readonly step: number
    readonly requestId: string
    readonly content: string
    readonly toolCalls?: readonly ToolCall[]
    readonly usage: LLMUsage
    readonly finishReason: FinishReason
    readonly interrupted?: true
    /** Set with `finishReason: 'refusal'`; the reply's tool calls were not run. */
    readonly refusal?: RefusalInfo
  }
  | Base & { readonly type: 'tool.start'; readonly turn: number; readonly step: number; readonly call: ToolCall }
  | Base & { readonly type: 'approval.request'; readonly turn: number; readonly request: ApprovalRequest }
  | Base & { readonly type: 'approval.decision'; readonly turn: number; readonly decision: ApprovalDecision }
  | Base & {
    readonly type: 'tool.result'
    readonly turn: number
    readonly step: number
    readonly result: ToolResult
    readonly durationMs: number
    readonly error?: ErrorInfo
  }
  | Base & { readonly type: 'error'; readonly turn?: number; readonly error: ErrorInfo; readonly fatal: boolean }
  | Base & { readonly type: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason }
  | Base & { readonly type: 'record'; readonly record: SessionRecord }
  | Base & { readonly type: 'closed' }

/** The `type` vocabulary of {@link AgentEvent}. */
export type AgentEventType = AgentEvent['type']

/** A subscriber; exceptions it throws are swallowed so a bad listener cannot break a turn. */
export type AgentEventListener = (event: AgentEvent) => void

/** Fan-out of agent events to listeners and async iterators. */
export class AgentEventHub {
  private readonly listeners = new Set<AgentEventListener>()
  private closed = false

  /** Add a listener; returns the unsubscribe function. */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Deliver one event to every listener. */
  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // a listener failure must not affect the turn
      }
    }
  }

  /** Stop all iterators (after delivering the final `closed` event). */
  close(): void {
    this.closed = true
    for (const listener of [...this.listeners]) {
      ;(listener as AgentEventListener & { end?: () => void }).end?.()
    }
  }

  /**
   * Iterate events from now until the hub closes (or the consumer breaks).
   * Events are buffered without bound while the consumer is slow.
   */
  iterate(): AsyncIterableIterator<AgentEvent> {
    const queue: AgentEvent[] = []
    let wake: (() => void) | undefined
    let done = this.closed
    const listener = Object.assign((event: AgentEvent) => {
      queue.push(event)
      wake?.()
    }, {
      end: () => {
        done = true
        wake?.()
      },
    })
    const unsubscribe = this.subscribe(listener)
    const iterator: AsyncIterableIterator<AgentEvent> = {
      next: async () => {
        while (queue.length === 0 && !done) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        const event = queue.shift()
        if (event !== undefined) return { done: false, value: event }
        unsubscribe()
        return { done: true, value: undefined }
      },
      return: async () => {
        done = true
        queue.length = 0
        unsubscribe()
        return { done: true, value: undefined }
      },
      [Symbol.asyncIterator]: () => iterator,
    }
    return iterator
  }
}
