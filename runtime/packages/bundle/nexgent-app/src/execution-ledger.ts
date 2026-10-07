/** Application-owned observations of native model requests, including auxiliary calls. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Identifies one native request observation in the application ledger. */
export type ExecutionRequestId = Branded<'NexgentExecutionRequestId'>

/** Native request identity; prompt text, credentials and provider errors are excluded. */
export interface ExecutionRequestStart {
  readonly format: 1
  readonly type: 'request-start'
  readonly id: ExecutionRequestId
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly purpose?: GenerateOptions['purpose']
  readonly startedAt: number
}

/** Settlement of one observed stream; missing usage is never a zero-cost report. */
export interface ExecutionRequestEnd {
  readonly format: 1
  readonly type: 'request-end'
  readonly id: ExecutionRequestId
  readonly endedAt: number
  readonly durationMs: number
  readonly termination: 'exhausted' | 'threw' | 'consumer-closed'
  readonly finishReason?: string
  readonly usageState: 'reported' | 'missing' | 'invalid'
  readonly usage?: TokenUsage
}

/** Append-only application ledger vocabulary, separate from released Session generations. */
export type ExecutionLedgerRecord = ExecutionRequestStart | ExecutionRequestEnd | ExecutionLedgerClose

/** A clean composition shutdown; absence or nonzero failures prevents complete-accounting claims. */
export interface ExecutionLedgerClose {
  readonly format: 1
  readonly type: 'ledger-close'
  readonly writeFailures: number
}

/** Application-owned storage location for request observations. */
export interface ExecutionLedgerConfig {
  readonly directory: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    executionLedger: ExecutionLedger
  }
}

/** Copy only valid provider accounting fields; do not retain mutable chunks or invent totals. */
function usageSnapshot(usage: TokenUsage): TokenUsage | undefined {
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
  const result: Partial<TokenUsage> = {}
  for (const field of fields) {
    const value = usage[field]
    if (value === undefined) {
      if (field === 'inputTokens' || field === 'outputTokens') return undefined
      continue
    }
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    result[field] = value
  }
  return result as TokenUsage
}

/** Observe native streams without changing requests, responses, cancellation or tool permissions. */
export class ExecutionLedger extends Service {
  static inject = ['llm']
  static Config: z<ExecutionLedgerConfig> = z.object({ directory: z.string().required() })

  /** One exclusive file per application composition, including restarts and reloads. */
  readonly file: string
  /** Failed storage operations; any nonzero count invalidates complete-accounting claims. */
  writeFailures: number = 0
  private closed = false
  private readonly fd: number

  constructor(ctx: Context, config: ExecutionLedgerConfig) {
    super(ctx, 'executionLedger')
    if (!isAbsolute(config.directory)) throw new Error('Execution ledger directory must be absolute')
    mkdirSync(config.directory, { recursive: true })
    this.file = join(config.directory, `${randomUUID()}.jsonl`)
    this.fd = openSync(this.file, 'wx', 0o600)
    ctx.effect(() => () => {
      this.append({ format: 1, type: 'ledger-close', writeFailures: this.writeFailures })
      this.closed = true
      closeSync(this.fd)
    })
    ctx.on('llm/stream', (options, next) => this.observe(options, next), { global: true, prepend: true })
  }

  /** Keep recorder failures visible without replacing the model's original outcome. */
  private append(record: ExecutionLedgerRecord): void {
    try {
      if (this.closed) throw new Error('execution ledger is closed')
      appendFileSync(this.fd, `${JSON.stringify(record)}\n`)
      fsyncSync(this.fd)
    } catch (error: unknown) {
      void error
      this.writeFailures++
      this.ctx.logger.warn('Nexgent execution ledger write failed; request accounting is incomplete')
    }
  }

  private async *observe(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const id = randomUUID() as ExecutionRequestId
    const started = performance.now()
    this.append({ format: 1, type: 'request-start', id, provider: options.provider, model: options.model,
      startedAt: Date.now(), ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      ...options.purpose === undefined ? {} : { purpose: options.purpose } })
    let termination: ExecutionRequestEnd['termination'] = 'consumer-closed'
    let finishReason: string | undefined
    let usage: TokenUsage | undefined
    let usageState: ExecutionRequestEnd['usageState'] = 'missing'
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          usage = usageSnapshot(chunk.usage)
          usageState = usage === undefined ? 'invalid' : 'reported'
        }
        if (chunk.type === 'finish') finishReason = chunk.reason.kind
        yield chunk
      }
      termination = 'exhausted'
    } catch (error: unknown) {
      termination = 'threw'
      throw error
    } finally {
      this.append({ format: 1, type: 'request-end', id, endedAt: Date.now(), durationMs: performance.now() - started,
        termination, usageState, ...finishReason === undefined ? {} : { finishReason },
        ...usage === undefined ? {} : { usage } })
    }
  }
}

export default ExecutionLedger
