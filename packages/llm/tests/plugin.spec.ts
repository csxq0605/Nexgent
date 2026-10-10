import { afterEach, describe, expect, it } from 'vitest'
import { Context, NEXGENT_API_KEY, ValidationError } from '@nexgent/kernel'
import LLMPluginDefault, {
  AnthropicProvider,
  LLMPlugin,
  packageName,
  providerOptionsFromConfig,
  validateLLMPluginConfig,
} from '../src/index.js'
import { loadSseFixture, startFakeAnthropic, type FakeAnthropic } from './helpers/fake-anthropic.js'
import { memoryCredentials, MemoryLedger } from './helpers/fakes.js'
import { collect, makeProvider, makeRequest, TEST_KEY } from './helpers/stream.js'

let fake: FakeAnthropic | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Mirror of the `llm` row in packages/kernel/profiles/nexgent.yml. */
const PROFILE_ROW = {
  provider: 'anthropic',
  endpoint: 'https://api.anthropic.com',
  model: 'claude-sonnet-5-5',
  apiKeyCredential: 'NEXGENT_API_KEY',
  thinking: 'off',
  effort: 'medium',
  maxTokens: 16000,
  timeoutMs: 180000,
  streamIdleTimeoutMs: 180000,
  maxRetries: 0,
  fallbacks: 'default',
} as const

describe('@nexgent/llm Cordis plugin', () => {
  it('is the default export and names the package', () => {
    expect(LLMPluginDefault).toBe(LLMPlugin)
    expect(LLMPlugin.name).toBe(packageName)
  })

  it('waits for credentials and ledger, then provides ctx.llm', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const ctx = new Context()
    const ledger = new MemoryLedger()
    ctx.plugin(LLMPlugin, { endpoint: fake.baseUrl, timeoutMs: 5000 })
    expect(ctx.get('llm')).toBeUndefined()

    ctx.provide('credentials', memoryCredentials({ [NEXGENT_API_KEY]: TEST_KEY }))
    ctx.provide('ledger', ledger)
    await new Promise(resolve => setTimeout(resolve, 0))
    const llm = ctx.get('llm')
    expect(llm).toBeInstanceOf(AnthropicProvider)
    if (process.env['NEXGENT_API_BASE_URL'] === undefined) expect(llm?.info.endpoint).toBe(fake.baseUrl)

    const events = await collect(ctx.llm.complete(makeRequest()))
    expect(events[events.length - 1]).toMatchObject({ type: 'done', finishReason: 'stop' })
    expect(ledger.records).toHaveLength(2)
    await ctx.fiber.dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })

  it('rejects invalid config through the schema', async () => {
    const ctx = new Context()
    ctx.provide('credentials', memoryCredentials({}))
    ctx.provide('ledger', new MemoryLedger())
    await expect(ctx.plugin(LLMPlugin, { maxRetries: 3 } as never)).rejects.toBeInstanceOf(ValidationError)
    await ctx.fiber.dispose()
  })

  it('accepts the llm row of the kernel default profile and maps it', () => {
    expect(validateLLMPluginConfig(PROFILE_ROW)).toEqual([])
    expect(providerOptionsFromConfig(PROFILE_ROW)).toEqual({
      id: 'anthropic',
      endpoint: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-5-5',
      apiKeyName: 'NEXGENT_API_KEY',
      effort: 'medium',
      maxTokens: 16000,
      timeoutMs: 180000,
      streamIdleTimeoutMs: 180000,
      fallbacks: 'default',
    })
  })

  it('applies the configured default output cap when a request sets none', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, { maxTokens: 4096 })
    await collect(provider.complete(makeRequest()))
    await collect(provider.complete(makeRequest({ maxTokens: 7 })))
    expect(fake.requests.map(request => request.body['max_tokens'])).toEqual([4096, 7])
  })

  it('validates config fields and rejects unknown and legacy keys', () => {
    expect(validateLLMPluginConfig(undefined)).toEqual([])
    expect(validateLLMPluginConfig({ model: 'claude-sonnet-5-5', effort: 'xhigh', fallbacks: 'off' })).toEqual([])
    expect(validateLLMPluginConfig({ timeoutMs: -1, effort: 'ultra', extra: 1, fallbacks: 'maybe' }).map(issue => issue.path?.[0]))
      .toEqual(['extra', 'timeoutMs', 'effort', 'fallbacks'])
    expect(validateLLMPluginConfig({ compat: { thinkingFormat: 'deepseek' }, contextWindow: 1, displayName: 'x' }).map(issue => issue.path?.[0]))
      .toEqual(['compat', 'contextWindow', 'displayName'])
    expect(validateLLMPluginConfig({ thinking: 'maybe' })).toHaveLength(1)
  })
})
