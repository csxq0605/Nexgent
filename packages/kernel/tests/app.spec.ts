import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {
  AgentsService,
  applyProfilePatches,
  createApp,
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_SUFFIX,
  DEFAULT_PROFILE_FILE,
  DEFAULT_PROJECT_CONFIG,
  defaultProfile,
  loadPatchFile,
  loadProfileFile,
  parsePatches,
  parseProfile,
  type Context,
  type JsonObject,
  type Plugin,
} from '../src/index.js'
import { textReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('default product profile', () => {
  // The Claude Platform route of ADR 0002, plus the PR #4 persona
  // (runtime/packages/bundle/nexgent-app/cordis.patch.yml system-prompt row).
  const ROUTE = {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    endpoint: 'https://api.anthropic.com',
    apiKeyEnv: 'NEXGENT_API_KEY',
    thinking: 'off',
    effort: 'medium',
    maxTokens: 16000,
    timeoutMs: 600000,
    streamIdleTimeoutMs: 180000,
    maxRetries: 0,
    fallbacks: 'default',
    personaPrefix: 'You are Nexgent, a general task agent running on the {{model}} model. '
      + 'Complete the user\'s task with the available materials and tools. '
      + 'Choose direct work, delegation or a workflow according to the task. '
      + 'Verify actual deliverables, explain unresolved requirements, and preserve useful work for subsequent turns.',
    personaSuffix: 'Your project working directory is {{cwd}}.',
  }

  it('ships the ADR 0002 Claude route, thinking off, effort medium and the PR #4 persona', () => {
    const profile = defaultProfile()
    expect(profile.map(row => row.id)).toEqual(['credentials', 'workspace', 'session', 'llm', 'tools', 'approvals', 'agents'])
    const llm = profile.find(row => row.id === 'llm')!
    expect(llm.name).toBe('@nexgent/llm')
    expect(llm.config).toEqual({
      provider: ROUTE.provider,
      endpoint: ROUTE.endpoint,
      model: ROUTE.model,
      apiKeyCredential: ROUTE.apiKeyEnv,
      thinking: ROUTE.thinking,
      effort: ROUTE.effort,
      maxTokens: ROUTE.maxTokens,
      timeoutMs: ROUTE.timeoutMs,
      streamIdleTimeoutMs: ROUTE.streamIdleTimeoutMs,
      maxRetries: ROUTE.maxRetries,
      fallbacks: ROUTE.fallbacks,
    })
    const agents = profile.find(row => row.id === 'agents')!
    expect(agents.config).toMatchObject({
      model: ROUTE.model,
      thinking: 'off',
      effort: 'medium',
      maxTokens: ROUTE.maxTokens,
      modelTimeoutMs: ROUTE.timeoutMs,
      streamIdleTimeoutMs: ROUTE.streamIdleTimeoutMs,
      systemPrompt: { persona: ROUTE.personaPrefix, suffix: ROUTE.personaSuffix },
    })
    expect(DEFAULT_PERSONA).toBe(ROUTE.personaPrefix)
    expect(DEFAULT_PERSONA_SUFFIX).toBe(ROUTE.personaSuffix)
    // agrees with the project-config defaults of the contract
    expect(llm.config!.model).toBe(DEFAULT_PROJECT_CONFIG.model)
    expect(llm.config!.endpoint).toBe(DEFAULT_PROJECT_CONFIG.endpoint)
    expect(agents.config!.thinking).toBe(DEFAULT_PROJECT_CONFIG.thinking)
    expect(agents.config!.effort).toBe(DEFAULT_PROJECT_CONFIG.effort)
    expect(llm.config!.thinking).toBe(DEFAULT_PROJECT_CONFIG.thinking)
    expect(llm.config!.effort).toBe(DEFAULT_PROJECT_CONFIG.effort)
    // no secret value in the profile
    expect(JSON.stringify(profile)).not.toMatch(/sk-/)
  })

  it('round-trips through loadProfileFile', async () => {
    expect(await loadProfileFile(DEFAULT_PROFILE_FILE)).toEqual(defaultProfile())
  })
})

describe('profile parsing', () => {
  it('rejects malformed profiles', () => {
    expect(() => parseProfile('a: 1')).toThrow(/sequence/)
    expect(() => parseProfile('- id: a\n  name: x\n- id: a\n  name: y')).toThrow(/duplicate row id/)
    expect(() => parseProfile('- id: a\n  name: x\n  extra: 1')).toThrow(/unknown field/)
    expect(() => parseProfile('- id: a\n  name: x\n  config: !!js foo()')).toThrow()
    expect(() => parseProfile('- id: a\n  name: [x')).toThrow()
  })

  it('parses insert blocks and row patches like cordis.patch.yml', () => {
    const patches = parsePatches([
      '- insert:',
      '    - id: extra',
      '      name: extra-plugin',
      '- id: llm',
      '  config:',
      '    model: other',
      '- id: session',
      '  disabled: true',
    ].join('\n'))
    const profile = applyProfilePatches(defaultProfile(), patches)
    expect(profile.at(-1)).toEqual({ id: 'extra', name: 'extra-plugin' })
    const llm = profile.find(row => row.id === 'llm')!
    expect(llm.config).toMatchObject({ model: 'other', endpoint: 'https://api.anthropic.com', fallbacks: 'default' })
    expect(profile.find(row => row.id === 'session')!.disabled).toBe(true)
    expect(() => parsePatches('- insert: {}')).toThrow(/sequence/)
    expect(() => applyProfilePatches(defaultProfile(), parsePatches('- id: nope\n  disabled: true'))).toThrow(/unknown row id/)
  })

  it('loads patch files from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexgent-patch-'))
    try {
      const file = join(dir, 'cordis.patch.yml')
      writeFileSync(file, '- id: agents\n  config:\n    maxSteps: 3\n')
      expect(await loadPatchFile(file)).toEqual([{ id: 'agents', config: { maxSteps: 3 } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createApp', () => {
  it('loads the YAML profile with host plugins and exposes ctx.agents', async () => {
    harness = await bootHarness({ script: [textReply('hi')] })
    const { app } = harness
    expect(app.ctx.agents instanceof AgentsService).toBe(true)
    expect(typeof app.agents.create).toBe('function')
    expect(app.ctx.get('credentials') === undefined).toBe(false)
    expect(app.ctx.tools.list()).toEqual([])
    expect(app.rows.map(row => row.row.id)).toEqual(['credentials', 'workspace', 'session', 'llm', 'tools', 'approvals', 'agents'])
    const agent = await app.agents.create()
    expect((await agent.run('hello')).text).toBe('hi')
  })

  it('validates row config with the plugin schema', async () => {
    const strict: Plugin = Object.assign((_ctx: Context, _config: unknown) => {}, {
      Config: Schema.object({ level: Schema.natural().required() }),
    })
    await expect(createApp({ profile: [{ id: 'p', name: 'strict', config: { level: 'high' } }], registry: { strict } }))
      .rejects.toMatchObject({ code: 'config/invalid', message: expect.stringContaining('profile row "p"') })
    const app = await createApp({ profile: [{ id: 'p', name: 'strict', config: { level: 2 } }], registry: { strict } })
    await app.dispose()
  })

  it('fails on unknown plugins and on rows whose services never appear', async () => {
    await expect(createApp({ profile: [{ id: 'x', name: '@nexgent/missing' }] })).rejects.toMatchObject({ code: 'config/invalid' })
    // default profile without host plugins: agents can never start
    await expect(createApp({ profile: defaultProfile().filter(row => !row.name.startsWith('@nexgent/') || row.name.startsWith('@nexgent/kernel')) }))
      .rejects.toThrow(/missing services: .*llm/)
  })

  it('applies row order independently of dependency order and skips disabled rows', async () => {
    const order: string[] = []
    const provider: Plugin = { name: 'provider', apply: (ctx: Context) => { order.push('provider'); ctx.provide('thing' as never, { ok: true }) } }
    const consumer: Plugin = { name: 'consumer', inject: ['thing'], apply: () => { order.push('consumer') } }
    const skipped: Plugin = { name: 'skipped', apply: () => { order.push('skipped') } }
    const app = await createApp({
      profile: [
        { id: 'c', name: 'consumer' },
        { id: 's', name: 'skipped', disabled: true },
        { id: 'p', name: 'provider' },
      ],
      registry: new Map([['consumer', consumer], ['provider', provider], ['skipped', skipped]]),
    })
    expect(order).toEqual(['provider', 'consumer'])
    await app.dispose()
  })

  it('passes patched agents config through schema defaults', async () => {
    harness = await bootHarness({ patches: [{ id: 'agents', config: { maxSteps: 1 } as JsonObject }] })
    expect(harness.app.profile.find(row => row.id === 'agents')!.config).toMatchObject({ maxSteps: 1, toolAbortGraceMs: 200, effort: 'medium' })
  })

  it('rejects an unknown effort level in the agents row', async () => {
    await expect(bootHarness({ patches: [{ id: 'agents', config: { effort: 'extreme' } as JsonObject }] }))
      .rejects.toMatchObject({ code: 'config/invalid', message: expect.stringContaining('profile row "agents"') })
  })
})
