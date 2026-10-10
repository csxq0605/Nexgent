import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendProjectGrant,
  approvalSubject,
  Context,
  credentialFilePath,
  CredentialsService,
  decideToolPolicy,
  deadline,
  derivePattern,
  globMatch,
  grantMatches,
  JsonStore,
  LocalCredentials,
  NEXGENT_API_KEY,
  parseProjectConfig,
  readJsonFile,
  readProjectConfig,
  renderSystemPrompt,
  repairHistory,
  saveCredential,
  timeoutOf,
  validateJsonSchema,
  writeFileAtomic,
  writeJsonFile,
  type ToolDefinition,
} from '../src/index.js'

const posix = process.platform !== 'win32'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexgent-prim-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('credentials', () => {
  const writeFile = (content: unknown, mode = 0o600) => {
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify(content), { mode })
    if (posix) chmodSync(join(dir, 'credentials.json'), mode)
  }

  it('prefers the environment, then the credential file; empty counts as unset', async () => {
    writeFile({ version: 1, credentials: { [NEXGENT_API_KEY]: 'from-file' } })
    const env: NodeJS.ProcessEnv = { [NEXGENT_API_KEY]: 'from-env' }
    const credentials = new LocalCredentials({ env, home: dir })
    expect(await credentials.get(NEXGENT_API_KEY)).toBe('from-env')
    expect(await credentials.describe(NEXGENT_API_KEY)).toEqual({ configured: true, source: 'env' })
    env[NEXGENT_API_KEY] = ''
    expect(await credentials.get(NEXGENT_API_KEY)).toBe('from-file')
    expect(await credentials.describe(NEXGENT_API_KEY)).toEqual({ configured: true, source: 'file' })
    expect(await credentials.describe('OTHER')).toEqual({ configured: false })
  })

  it('does not cache: an edited file is read on the next call', async () => {
    const credentials = new LocalCredentials({ env: {}, home: dir })
    expect(await credentials.get(NEXGENT_API_KEY)).toBeUndefined()
    writeFile({ version: 1, credentials: { [NEXGENT_API_KEY]: 'v1' } })
    expect(await credentials.get(NEXGENT_API_KEY)).toBe('v1')
    writeFile({ version: 1, credentials: { [NEXGENT_API_KEY]: 'v2' } })
    expect(await credentials.get(NEXGENT_API_KEY)).toBe('v2')
  })

  it('resolves NEXGENT_HOME before ~/.nexgent', () => {
    expect(credentialFilePath({ env: { NEXGENT_HOME: dir } })).toBe(join(dir, 'credentials.json'))
    expect(credentialFilePath({ env: {} })).toMatch(/\.nexgent[\\/]credentials\.json$/)
  })

  it.skipIf(!posix)('refuses a credential file readable by others, with a fix-it hint', async () => {
    writeFile({ version: 1, credentials: { [NEXGENT_API_KEY]: 'secret' } }, 0o644)
    const credentials = new LocalCredentials({ env: {}, home: dir })
    await expect(credentials.get(NEXGENT_API_KEY)).rejects.toMatchObject({
      code: 'credentials/missing',
      message: expect.stringContaining('chmod 600'),
      details: { reason: 'insecure-permissions', mode: '0644' },
    })
    // the environment still wins without touching the file
    expect(await new LocalCredentials({ env: { [NEXGENT_API_KEY]: 'env' }, home: dir }).get(NEXGENT_API_KEY)).toBe('env')
  })

  it('ignores POSIX modes on Windows', async () => {
    writeFile({ version: 1, credentials: { [NEXGENT_API_KEY]: 'secret' } }, 0o644)
    expect(await new LocalCredentials({ env: {}, home: dir, platform: 'win32' }).get(NEXGENT_API_KEY)).toBe('secret')
  })

  it('rejects malformed files', async () => {
    writeFile({ version: 2, credentials: {} })
    await expect(new LocalCredentials({ env: {}, home: dir }).get('x')).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('saves a credential with mode 0600 and keeps other entries', async () => {
    const home = join(dir, 'home')
    await saveCredential('A', '1', { home })
    await saveCredential(NEXGENT_API_KEY, 'k', { home })
    const file = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'))
    expect(file).toEqual({ version: 1, credentials: { A: '1', [NEXGENT_API_KEY]: 'k' } })
    if (posix) expect(statSync(join(home, 'credentials.json')).mode & 0o777).toBe(0o600)
    expect(await new LocalCredentials({ env: {}, home }).get(NEXGENT_API_KEY)).toBe('k')
  })

  it('is provided as ctx.credentials by its plugin', async () => {
    writeFile({ version: 1, credentials: { TOKEN_X: 'x' } })
    const ctx = new Context()
    await ctx.plugin(CredentialsService, { home: dir })
    expect(await ctx.credentials.get('TOKEN_X')).toBe('x')
    await ctx.fiber.dispose()
  })
})

describe('atomic write and JSON storage', () => {
  it('replaces files atomically without leaving temp files', async () => {
    const file = join(dir, 'nested', 'a.json')
    await writeFileAtomic(file, 'one')
    await writeFileAtomic(file, 'two', { mode: 0o644 })
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(readdirSync(join(dir, 'nested'))).toEqual(['a.json'])
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it('reads and writes JSON documents and refuses non-JSON values', async () => {
    const file = join(dir, 'doc.json')
    expect(await readJsonFile(file)).toBeUndefined()
    await writeJsonFile(file, { a: [1, 'x'] })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": [\n    1,\n    "x"\n  ]\n}\n')
    expect(await readJsonFile(file)).toEqual({ a: [1, 'x'] })
    await expect(writeJsonFile(file, { a: undefined })).rejects.toThrow(TypeError)
    writeFileSync(file, '{oops')
    await expect(readJsonFile(file)).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('keeps one document per key', async () => {
    const store = new JsonStore(join(dir, 'store'))
    expect(await store.keys()).toEqual([])
    await store.set('b', 2)
    await store.set('a', { x: true })
    expect(await store.keys()).toEqual(['a', 'b'])
    expect(await store.get('a')).toEqual({ x: true })
    expect(await store.delete('b')).toBe(true)
    expect(await store.delete('b')).toBe(false)
    expect(() => store.get('../escape')).toThrow(TypeError)
  })
})

describe('project config', () => {
  it('fills defaults, validates fields and reports unknown ones', async () => {
    expect((await readProjectConfig(join(dir, 'missing.json'))).config.sandboxMode).toBe('workspace-write')
    const loaded = parseProjectConfig({ model: 'm', costCaps: { perTask: { maxRequests: 2 } }, extraReadRoots: ['/data'] })
    expect(loaded.config).toMatchObject({ model: 'm', thinking: 'off', effort: 'medium', costCaps: { perTask: { maxRequests: 2 } } })
    expect(parseProjectConfig({ effort: 'xhigh' }).input).toEqual({ effort: 'xhigh' })
    expect(loaded.input).toEqual({ model: 'm', costCaps: { perTask: { maxRequests: 2 } } })
    expect(loaded.extraReadRoots).toEqual(['/data'])
    for (const bad of [{ modle: 'x' }, { version: 2 }, { thinking: 'maybe' }, { effort: 'extreme' }, { effort: 2 }, { costCaps: { perTask: { windowDays: 3 } } }, { approvals: [{ tool: 1 }] }, []]) {
      expect(() => parseProjectConfig(bad)).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    }
  })

  it('appends a project grant and keeps other fields', async () => {
    const file = join(dir, '.nexgent', 'config.json')
    mkdirSync(join(dir, '.nexgent'))
    writeFileSync(file, JSON.stringify({ model: 'keep' }))
    await appendProjectGrant(file, { tool: 'bash', pattern: 'pnpm install', grantedAt: '2026-10-07T08:00:00Z' })
    const loaded = await readProjectConfig(file)
    expect(loaded.config.model).toBe('keep')
    expect(loaded.config.approvals).toEqual([{ tool: 'bash', pattern: 'pnpm install', grantedAt: '2026-10-07T08:00:00Z' }])
  })
})

describe('approval policy', () => {
  const def = (approval: ToolDefinition['approval'], effects: ToolDefinition['effects']): ToolDefinition =>
    ({ name: 't', description: '', inputSchema: {}, effects, approval })

  it('follows the permissions.md mode table', () => {
    expect(decideToolPolicy(def('never', ['read']), 'read-only').kind).toBe('run')
    expect(decideToolPolicy(def('never', ['write']), 'read-only').kind).toBe('deny')
    expect(decideToolPolicy(def('ask', ['write']), 'workspace-write')).toMatchObject({ kind: 'ask', risk: 'low' })
    expect(decideToolPolicy(def('ask', ['execute']), 'workspace-write')).toMatchObject({ kind: 'ask', risk: 'medium' })
    expect(decideToolPolicy(def('ask', ['execute']), 'full-access').kind).toBe('run')
    expect(decideToolPolicy(def('always', ['execute']), 'full-access')).toEqual({ kind: 'ask', risk: 'high', options: ['once'] })
  })

  it('derives patterns and matches grants by prefix and glob', () => {
    const command = approvalSubject({ command: 'pnpm install left-pad' })
    expect(derivePattern(command)).toBe('pnpm install')
    expect(grantMatches({ tool: 'bash', pattern: 'pnpm install', grantedAt: '' }, 'bash', command)).toBe(true)
    expect(grantMatches({ tool: 'bash', pattern: 'pnpm i', grantedAt: '' }, 'bash', command)).toBe(false)
    expect(grantMatches({ tool: 'bash', grantedAt: '' }, 'bash', command)).toBe(true)
    expect(grantMatches({ tool: 'pwsh', grantedAt: '' }, 'bash', command)).toBe(false)
    const path = approvalSubject({ path: 'src\\deep\\a.ts' })
    expect(path).toEqual({ kind: 'path', value: 'src/deep/a.ts' })
    expect(grantMatches({ tool: 'fs', pattern: 'src/**/*.ts', grantedAt: '' }, 'fs', path)).toBe(true)
    expect(grantMatches({ tool: 'fs', pattern: 'src/*.ts', grantedAt: '' }, 'fs', path)).toBe(false)
    expect(globMatch('.env.*', '.env.local')).toBe(true)
    expect(globMatch('**/x', 'x')).toBe(true)
  })
})

describe('system prompt, schema check, timeouts, history repair', () => {
  it('renders persona, environment facts and tools deterministically', () => {
    const input = {
      template: { persona: 'You are Nexgent using {{model}}.', suffix: 'Your project working directory is {{cwd}}.' },
      model: 'claude-sonnet-5-5',
      cwd: '/p',
      sandboxMode: 'full-access' as const,
      platform: 'win32' as const,
      tools: [{ name: 'pwsh', description: 'Run PowerShell.\nMore.', inputSchema: {}, effects: ['execute' as const], approval: 'ask' as const }],
    }
    const text = renderSystemPrompt(input)
    expect(text.startsWith('You are Nexgent using claude-sonnet-5-5.')).toBe(true)
    expect(text).toContain('PowerShell')
    expect(text).toContain('WARNING')
    expect(text).toContain('- pwsh: Run PowerShell.')
    expect(text.endsWith('Your project working directory is /p.')).toBe(true)
    expect(renderSystemPrompt(input)).toBe(text)
  })

  it('checks the common JSON Schema keywords', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1 }, s: { enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false }
    expect(validateJsonSchema({ n: 1, s: 'a' }, schema)).toBeUndefined()
    expect(validateJsonSchema({}, schema)).toMatch(/required/)
    expect(validateJsonSchema({ n: 0 }, schema)).toMatch(/>= 1/)
    expect(validateJsonSchema({ n: 1, s: 'c' }, schema)).toMatch(/one of/)
    expect(validateJsonSchema({ n: 1, x: 1 }, schema)).toMatch(/unknown property/)
    expect(validateJsonSchema([1, 'x'], { type: 'array', items: { type: 'number' } })).toMatch(/\[1\]/)
  })

  it('classifies deadline expiry', async () => {
    const d = deadline(undefined, 10, 'X')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(timeoutOf(d.signal, 'X')?.timeoutMs).toBe(10)
    expect(timeoutOf(d.signal, 'Y')).toBeUndefined()
    const upstream = new AbortController()
    const e = deadline(upstream.signal, 1000, 'X')
    upstream.abort()
    expect(timeoutOf(e.signal)).toBeUndefined()
    e.dispose()
    expect(deadline(undefined, 0, 'X').signal.aborted).toBe(false)
  })

  it('answers dangling tool calls in requests only', () => {
    const providerContent = [{ type: 'thinking', thinking: 't', signature: 'sig' }, { type: 'tool_use', id: 'a' }]
    const repaired = repairHistory([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: '{}' }, { id: 'b', name: 't', arguments: '{}' }], providerContent },
      { role: 'tool', toolCallId: 'a', name: 't', content: 'ok', isError: false },
      { role: 'user', content: 'next' },
    ])
    expect(repaired.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(repaired[3]).toMatchObject({ toolCallId: 'b', isError: true })
    // assistant entries pass through untouched, provider blocks included
    expect(repaired[1]).toMatchObject({ role: 'assistant', providerContent })
  })
})
