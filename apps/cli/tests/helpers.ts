import { PassThrough } from 'node:stream'
import { UNKNOWN_USAGE, type LLMUsage } from '@nexgent/kernel'
import type { CliEvent, CliIo, CliRuntime, RuntimeOpenOptions, RuntimeSession, SessionOpenEvent, TaskOutcomeInput } from '../src/index.js'

/** A sink that records everything written. */
export class Capture {
  text = ''
  isTTY = false
  write(chunk: string): boolean {
    this.text += chunk
    return true
  }
}

export const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

export const USAGE: LLMUsage = { inputTokens: 812, outputTokens: 37, totalTokens: 849, cacheReadTokens: 0, reasoningTokens: 0 }

export function sessionEvent(overrides: Partial<SessionOpenEvent> = {}): SessionOpenEvent {
  return { type: 'session', sessionId: SID, projectRoot: '/proj', model: 'mimo-v2.6-pro', sandboxMode: 'workspace-write', resumed: false, ...overrides }
}

/** A complete write-file turn: one tool call, then a final answer. */
export function writeFileTurn(turn = 1): CliEvent[] {
  const call = { id: 'call_1', name: 'write_file', arguments: '{"path":"hello.txt","content":"Hello"}' }
  return [
    { type: 'turn.start', turn },
    { type: 'step.start', turn, step: 1, requestId: 'r1' },
    { type: 'tool-call.start', index: 0, id: call.id, name: call.name },
    { type: 'tool-call.delta', index: 0, argumentsDelta: call.arguments },
    { type: 'tool-call.end', index: 0, call },
    { type: 'usage', usage: USAGE },
    { type: 'tool.start', callId: call.id, name: call.name, arguments: call.arguments },
    { type: 'tool.end', callId: call.id, name: call.name, isError: false, content: 'wrote 5 bytes to hello.txt', durationMs: 4 },
    { type: 'step.start', turn, step: 2, requestId: 'r2' },
    { type: 'text.delta', text: 'Created ' },
    { type: 'text.delta', text: 'hello.txt.' },
    { type: 'turn.end', turn, reason: { kind: 'completed' } },
  ]
}

export { UNKNOWN_USAGE }

/** A fake runtime replaying scripted events; waits on the abort signal when told to hang. */
export class FakeRuntime implements CliRuntime {
  opened: RuntimeOpenOptions[] = []
  outcomes: TaskOutcomeInput[] = []
  closed = 0
  tasks: string[] = []

  constructor(
    private readonly events: CliEvent[],
    private readonly options: { hangAfter?: number; info?: Partial<SessionOpenEvent>; openError?: unknown } = {},
  ) {}

  async open(options: RuntimeOpenOptions): Promise<RuntimeSession> {
    if (this.options.openError !== undefined) throw this.options.openError
    this.opened.push(options)
    const self = this
    return {
      info: sessionEvent({ resumed: options.resumeSessionId !== undefined, ...this.options.info }),
      async *runTurn(task: string, signal: AbortSignal) {
        self.tasks.push(task)
        const hangAfter = self.options.hangAfter ?? Infinity
        for (const [index, event] of self.events.entries()) {
          if (index === hangAfter) {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
            yield { type: 'turn.end', turn: 1, reason: { kind: 'cancelled', cause: signal.reason as 'user' } } satisfies CliEvent
            return
          }
          yield event
        }
      },
      async recordOutcome(outcome) {
        self.outcomes.push(outcome)
      },
      async close() {
        self.closed += 1
      },
    }
  }
}

/** A test io: captured streams, a non-TTY stdin, a manual signal source. */
export function testIo(cwd: string, env: Record<string, string> = { NEXGENT_API_KEY: 'k' }) {
  const stdout = new Capture()
  const stderr = new Capture()
  const listeners = new Map<string, Set<() => void>>()
  const exits: number[] = []
  const io: CliIo = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    env,
    cwd,
    signals: {
      platform: process.platform,
      on(signal, listener) {
        const set = listeners.get(signal) ?? new Set()
        set.add(listener)
        listeners.set(signal, set)
      },
      off(signal, listener) {
        listeners.get(signal)?.delete(listener)
      },
    },
    exit: code => { exits.push(code) },
  }
  const raise = (signal: string): void => {
    for (const listener of listeners.get(signal) ?? []) listener()
  }
  const listenerCount = (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return { io, stdout, stderr, exits, raise, listenerCount }
}
