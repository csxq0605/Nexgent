import { afterEach, describe, expect, it } from 'vitest'
import { Context, NEXGENT_API_KEY, ValidationError } from '@nexgent/kernel'
import LLMPluginDefault, {
  LLMPlugin,
  OpenAICompatibleProvider,
  packageName,
  providerOptionsFromConfig,
  validateLLMPluginConfig,
} from '../src/index.js'
import { loadSseFixture, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js'
import { memoryCredentials, MemoryLedger } from './helpers/fakes.js'
import { collect, makeProvider, makeRequest, TEST_KEY } from './helpers/stream.js'

let fake: FakeOpenAI | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

describe('@nexgent/llm Cordis plugin', () => {
  it('is the default export and names the package', () => {
    expect(LLMPluginDefault).toBe(LLMPlugin)
    expect(LLMPlugin.name).toBe(packageName)
  })

  it('waits for credentials and ledger, then provides ctx.llm', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const ctx = new Context()
    const ledger = new MemoryLedger()
    ctx.plugin(LLMPlugin, { endpoint: fake.baseUrl, proxy: 'none', timeoutMs: 5000 })
    expect(ctx.get('llm')).toBeUndefined()

    ctx.provide('credentials', memoryCredentials({ [NEXGENT_API_KEY]: TEST_KEY }))
    ctx.provide('ledger', ledger)
    await new Promise(resolve => setTimeout(resolve, 0))
    const llm = ctx.get('llm')
    expect(llm).toBeInstanceOf(OpenAICompatibleProvider)
    if (process.env['NEXGENT_API_BASE_URL'] === undefined) expect(llm?.info.endpoint).toBe(fake.baseUrl)

    const events = await collect(ctx.llm.complete(makeRequest()))
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' })
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
    // Mirror of the `llm` row in packages/kernel/profiles/nexgent.yml.
    const row = {
      provider: 'mimo',
      displayName: 'MiMo',
      endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
      model: 'mimo-v2.6-pro',
      apiKeyCredential: 'NEXGENT_API_KEY',
      thinking: 'off',
      timeoutMs: 180000,
      streamIdleTimeoutMs: 180000,
      maxRetries: 0,
      maxTokens: 4096,
      contextWindow: 128000,
      compat: {
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: false,
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: 'max_tokens',
      },
    } as const
    expect(validateLLMPluginConfig(row)).toEqual([])
    expect(providerOptionsFromConfig(row)).toEqual({
      id: 'mimo',
      endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
      defaultModel: 'mimo-v2.6-pro',
      apiKeyName: 'NEXGENT_API_KEY',
      timeoutMs: 180000,
      streamIdleTimeoutMs: 180000,
      defaultMaxTokens: 4096,
      maxTokensField: 'max_tokens',
    })
    expect(providerOptionsFromConfig({ compat: { thinkingFormat: 'qwen' } }).thinkingParams)
      .toEqual({ off: { enable_thinking: false }, on: { enable_thinking: true } })
  })

  it('applies the configured default output cap when a request sets none', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, { defaultMaxTokens: 4096 })
    await collect(provider.complete(makeRequest()))
    await collect(provider.complete(makeRequest({ maxTokens: 7 })))
    expect(fake.requests.map(request => request.body['max_tokens'])).toEqual([4096, 7])
  })

  it('validates config fields', () => {
    expect(validateLLMPluginConfig(undefined)).toEqual([])
    expect(validateLLMPluginConfig({ model: 'mimo-v2.6-pro', thinkingParams: { off: {}, on: {} } })).toEqual([])
    expect(validateLLMPluginConfig({ timeoutMs: -1, proxy: 'socks', extra: 1 }).map(issue => issue.path?.[0])).toEqual(['extra', 'timeoutMs', 'proxy'])
    expect(validateLLMPluginConfig({ compat: { thinkingFormat: 'magic', foo: 1 } }).map(issue => issue.path?.join('.'))).toEqual(['compat.foo', 'compat.thinkingFormat'])
  })
})
