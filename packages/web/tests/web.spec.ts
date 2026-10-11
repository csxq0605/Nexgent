import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, STEP3_MIGRATED_TOOLS, type Context, type NexgentApp, type Plugin } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyContentType,
  exceedsConversionDepth,
  fetchPage,
  isPublicAddress,
  parseCharset,
  PAGE_CHARS,
  sniffHtmlCharset,
  validateUrl,
  WebFetchError,
  webFetchTool,
  WebPlugin,
  type Requester,
  type Resolver,
  type WebResponse,
} from '../src/index.js'

const PUBLIC = '93.184.216.34'

/** Resolver: `127.0.0.1` / `internal.example` to loopback, `rebind.example` to a mix, everything else to a public address. */
const resolver: Resolver = async host => {
  if (host === 'internal.example') return [{ address: '10.0.0.5', family: 4 }]
  if (host === 'metadata.example') return [{ address: '169.254.169.254', family: 4 }]
  if (host === 'v6local.example') return [{ address: 'fd00::1', family: 6 }]
  if (host === 'rebind.example') return [{ address: PUBLIC, family: 4 }, { address: '127.0.0.1', family: 4 }]
  return [{ address: PUBLIC, family: 4 }]
}

interface FakeReply {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
}

/** A requester answering from a table by URL; records each request and the address it was pinned to. */
function fakeRequester(replies: Record<string, FakeReply>) {
  const calls: { url: string; address: string }[] = []
  const requester: Requester = async (url, address) => {
    calls.push({ url: url.toString(), address: address.address })
    const reply = replies[url.toString()] ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'missing' }
    const body = typeof reply.body === 'string' ? new TextEncoder().encode(reply.body) : reply.body ?? new Uint8Array()
    const response: WebResponse = {
      status: reply.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...reply.headers },
      body: (async function* () {
        for (let i = 0; i < body.byteLength; i += 8192) yield body.subarray(i, i + 8192)
      })(),
      close: () => {},
    }
    return response
  }
  return { calls, requester }
}

const signal = () => new AbortController().signal

async function failure(promise: Promise<unknown>): Promise<WebFetchError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WebFetchError) return error
    throw error
  }
  throw new Error('expected a WebFetchError')
}

describe('address and URL policy', () => {
  it('accepts only public unicast addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '[2001:4860:4860::8888]']) expect(isPublicAddress(address), address).toBe(true)
    for (const address of [
      '127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
      '::1', '[::1]', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1',
      'not-an-ip', '',
    ]) expect(isPublicAddress(address), address).toBe(false)
  })

  it('validates URLs: http(s) only, no credentials, bounded length; odd IPv4 spellings normalise to the address', () => {
    expect(validateUrl('https://example.com/a?b=1').hostname).toBe('example.com')
    expect(validateUrl('http://0x7f.1/').hostname).toBe('127.0.0.1')
    expect(validateUrl('http://2130706433/').hostname).toBe('127.0.0.1')
    expect(() => validateUrl('file:///etc/passwd')).toThrow('only http and https')
    expect(() => validateUrl('ftp://example.com/')).toThrow('only http and https')
    expect(() => validateUrl('not a url')).toThrow('not a valid URL')
    expect(() => validateUrl('http://user:pw@example.com/')).toThrow('credentials')
    expect(() => validateUrl(`https://example.com/${'a'.repeat(2100)}`)).toThrow('longer than')
  })

  it('classifies content types and charsets', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/csv')).toBe('text')
    expect(classifyContentType('application/ld+json')).toBe('text')
    expect(classifyContentType('application/pdf')).toBeUndefined()
    expect(classifyContentType(undefined)).toBeUndefined()
    expect(parseCharset('text/html; charset="GBK"')).toBe('gbk')
    expect(sniffHtmlCharset(new TextEncoder().encode('<html><head><meta charset="gb2312">'))).toBe('gb2312')
    expect(sniffHtmlCharset(new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'))).toBe('shift_jis')
  })
})

describe('fetchPage (fake transport)', () => {
  it('reads a page, converting nothing itself, pinned to the checked address', async () => {
    const { calls, requester } = fakeRequester({ 'https://source.example/doc': { body: '<p>facts</p>' } })
    const page = await fetchPage('https://source.example/doc', signal(), undefined, { resolver, requester })
    expect(page).toEqual({ url: 'https://source.example/doc', status: 200, kind: 'html', mediaType: 'text/html', content: '<p>facts</p>', truncated: false })
    expect(calls).toEqual([{ url: 'https://source.example/doc', address: PUBLIC }])
  })

  it('refuses private, loopback, link-local and metadata destinations before any request (literal or resolved)', async () => {
    const { calls, requester } = fakeRequester({})
    for (const url of [
      'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://0x7f000001/',
      'http://internal.example/', 'http://metadata.example/', 'http://v6local.example/', 'http://rebind.example/',
    ]) {
      const error = await failure(fetchPage(url, signal(), undefined, { resolver, requester }))
      expect(error.reason, url).toBe('blocked-address')
    }
    expect(calls).toEqual([])
  })

  it('follows redirects but checks every hop: a redirect to a private address or with credentials is refused', async () => {
    const { calls, requester } = fakeRequester({
      'https://source.example/doc': { status: 302, headers: { location: 'http://127.0.0.1/config' } },
      'https://source.example/inner': { status: 301, headers: { location: 'http://internal.example/admin' } },
      'https://source.example/cred': { status: 307, headers: { location: 'http://user:pw@other.example/' } },
      'https://source.example/moved': { status: 308, headers: { location: '/new' } },
      'https://source.example/new': { status: 302, headers: { location: 'https://www.other.example/final' } },
      'https://www.other.example/final': { body: 'done', headers: { 'content-type': 'text/plain' } },
    })
    expect((await failure(fetchPage('https://source.example/doc', signal(), undefined, { resolver, requester }))).reason).toBe('blocked-address')
    expect((await failure(fetchPage('https://source.example/inner', signal(), undefined, { resolver, requester }))).reason).toBe('blocked-address')
    expect((await failure(fetchPage('https://source.example/cred', signal(), undefined, { resolver, requester }))).reason).toBe('credentials')
    expect(calls.map(call => call.url)).toEqual(['https://source.example/doc', 'https://source.example/inner', 'https://source.example/cred'])
    const page = await fetchPage('https://source.example/moved', signal(), undefined, { resolver, requester })
    expect(page).toMatchObject({ url: 'https://www.other.example/final', content: 'done', kind: 'text' })
  })

  it('stops after the redirect limit', async () => {
    const replies: Record<string, FakeReply> = {}
    for (let i = 0; i < 10; i++) replies[`https://loop.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } }
    const { requester } = fakeRequester(replies)
    const error = await failure(fetchPage('https://loop.example/0', signal(), { maxBytes: 1000, maxRedirects: 3, timeoutMs: 5000 }, { resolver, requester }))
    expect(error.reason).toBe('redirects')
  })

  it('refuses binary content, error statuses and declared oversize; cuts a stream that grows past the limit', async () => {
    const big = 'x'.repeat(2_000)
    const { requester } = fakeRequester({
      'https://source.example/file.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF' },
      'https://source.example/gone': { status: 404, body: 'not here' },
      'https://source.example/declared': { headers: { 'content-type': 'text/plain', 'content-length': '5000' }, body: big },
      'https://source.example/streamed': { headers: { 'content-type': 'text/plain' }, body: big },
    })
    const limits = { maxBytes: 1_000, maxRedirects: 5, timeoutMs: 5_000 }
    expect((await failure(fetchPage('https://source.example/file.pdf', signal(), limits, { resolver, requester }))).reason).toBe('content-type')
    const gone = await failure(fetchPage('https://source.example/gone', signal(), limits, { resolver, requester }))
    expect([gone.reason, gone.status]).toEqual(['http-status', 404])
    expect((await failure(fetchPage('https://source.example/declared', signal(), limits, { resolver, requester }))).reason).toBe('too-large')
    const streamed = await fetchPage('https://source.example/streamed', signal(), limits, { resolver, requester })
    expect([streamed.content.length, streamed.truncated]).toEqual([1_000, true])
  })

  it('decodes the declared or sniffed charset', async () => {
    const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]) // 中文
    const { requester } = fakeRequester({
      'https://cn.example/header': { headers: { 'content-type': 'text/plain; charset=gbk' }, body: gbk },
      'https://cn.example/meta': { headers: { 'content-type': 'text/html' }, body: Uint8Array.from([...new TextEncoder().encode('<meta charset="gbk"><p>'), ...gbk]) },
    })
    expect((await fetchPage('https://cn.example/header', signal(), undefined, { resolver, requester })).content).toBe('中文')
    expect((await fetchPage('https://cn.example/meta', signal(), undefined, { resolver, requester })).content).toContain('<p>中文')
  })

  it('makes no request when already cancelled', async () => {
    const { calls, requester } = fakeRequester({ 'https://source.example/doc': { body: 'facts' } })
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(fetchPage('https://source.example/doc', controller.signal, undefined, { resolver, requester })).rejects.toThrow('stopped')
    expect(calls).toEqual([])
  })
})

describe('web_fetch tool', () => {
  it('matches the frozen contract (name, effects, approval)', () => {
    const { definition } = webFetchTool()
    expect(STEP3_MIGRATED_TOOLS).toContainEqual({ name: definition.name, effects: definition.effects, approval: definition.approval })
  })

  const context = () => ({ signal: signal() }) as never

  it('returns Markdown without scripts or hidden text, with a title, and pages long text', async () => {
    const body = '<html><head><title>Primary &amp; source</title><style>p{}</style></head><body><script>do not expose script</script>'
      + '<h1>Heading</h1><p>facts <a href="https://x.example/">link</a></p><div hidden>hidden text</div>'
      + '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'
      + `<p>${'y'.repeat(PAGE_CHARS + 5_000)}</p></body></html>`
    const { requester } = fakeRequester({ 'https://source.example/doc': { body } })
    const tool = webFetchTool({ resolver, requester })
    const first = await tool.handler({ url: 'https://source.example/doc' }, context())
    expect(first.content).toContain('URL: https://source.example/doc (HTTP 200, text/html)\nTitle: Primary & source\nExternal web content follows.')
    expect(first.content.split('Primary & source')).toHaveLength(2)
    expect(first.content).toContain('# Heading')
    expect(first.content).toContain('facts [link](https://x.example/)')
    expect(first.content).toContain('| a   | b   |\n| --- | --- |\n| 1   | 2   |')
    expect(first.content).not.toContain('do not expose script')
    expect(first.content).not.toContain('hidden text')
    const meta = first.meta as { nextStart: number; length: number }
    expect(meta.nextStart).toBe(PAGE_CHARS)
    expect(first.content).toContain(`call web_fetch again with start: ${PAGE_CHARS} for the rest`)
    const second = await tool.handler({ url: 'https://source.example/doc', start: meta.nextStart }, context())
    expect(second.meta).toMatchObject({ start: PAGE_CHARS, end: meta.length })
    expect(second.meta).not.toHaveProperty('nextStart')
    await expect(tool.handler({ url: 'https://source.example/doc', start: meta.length + 10 }, context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('maps refusals and failures to error codes with a reason', async () => {
    const { requester } = fakeRequester({ 'https://source.example/file.pdf': { headers: { 'content-type': 'application/pdf' } } })
    const tool = webFetchTool({ resolver, requester })
    await expect(tool.handler({ url: 'http://169.254.169.254/' }, context())).rejects.toMatchObject({ code: 'tool/denied', details: { reason: 'blocked-address' } })
    await expect(tool.handler({ url: 'http://u:p@source.example/' }, context())).rejects.toMatchObject({ code: 'tool/denied', details: { reason: 'credentials' } })
    await expect(tool.handler({ url: 'file:///etc/passwd' }, context())).rejects.toMatchObject({ code: 'tool/invalid-input', details: { reason: 'invalid-url' } })
    await expect(tool.handler({ url: 'https://source.example/file.pdf' }, context())).rejects.toMatchObject({ code: 'tool/failed', details: { reason: 'content-type' } })
    await expect(tool.handler({ url: 'https://source.example/missing' }, context())).rejects.toMatchObject({ code: 'tool/failed', details: { reason: 'http-status', status: 404 } })
    expect(tool.definition).toMatchObject({ name: 'web_fetch', effects: ['network'], approval: 'never' })
  })

  it('does not convert pages nested too deeply', () => {
    expect(exceedsConversionDepth('<div>'.repeat(600))).toBe(true)
    expect(exceedsConversionDepth('<div><br><img src=x><p>a</p></div>')).toBe(false)
  })
})

describe('real sockets (loopback allowed only for this test)', () => {
  let server: Server | undefined
  afterEach(async () => {
    await new Promise<void>(resolve => (server === undefined ? resolve() : server.close(() => resolve())))
    server = undefined
  })

  it('connects to the pinned address with the original Host header, follows a redirect and decompresses', async () => {
    const hosts: string[] = []
    server = createServer((request, response) => {
      hosts.push(String(request.headers.host))
      if (request.url === '/start') {
        response.writeHead(302, { location: '/page' }).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      response.end(gzipSync('<h2>Compressed</h2><p>ok</p>'))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const deps = { resolver: (async () => [{ address: '127.0.0.1', family: 4 as const }]) satisfies Resolver, allowAddress: () => true }
    const page = await fetchPage(`http://site.test:${port}/start`, signal(), undefined, deps)
    expect(page).toMatchObject({ url: `http://site.test:${port}/page`, status: 200, content: '<h2>Compressed</h2><p>ok</p>' })
    expect(hosts).toEqual([`site.test:${port}`, `site.test:${port}`])
    // The production policy refuses the same server.
    expect((await failure(fetchPage(`http://127.0.0.1:${port}/start`, signal()))).reason).toBe('blocked-address')
  })

  it('times out a server that never answers', async () => {
    server = createServer(() => {})
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const error = await failure(fetchPage(`http://127.0.0.1:${port}/`, signal(), { maxBytes: 1000, maxRedirects: 0, timeoutMs: 200 }, { allowAddress: () => true }))
    expect(error.reason).toBe('timeout')
    server.closeAllConnections()
  })
})

describe('in the agent loop (scripted model)', () => {
  let app: NexgentApp | undefined
  let root: string | undefined
  afterEach(async () => {
    await app?.dispose()
    app = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('registers web_fetch; it runs in read-only sessions and a refused address becomes an error result', async () => {
    root = await mkdtemp(join(tmpdir(), 'nexgent-web-'))
    const llm = scriptedProvider([])
    app = await createApp({
      registry: {
        '@nexgent/workspace': WorkspacePlugin as Plugin,
        '@nexgent/session': SessionPlugin as Plugin,
        '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
        [WebPlugin.name]: WebPlugin as Plugin,
      },
      patches: [
        { id: 'workspace', config: { root } },
        { insert: [{ id: 'web', name: WebPlugin.name }] },
      ],
    })
    llm.push({ toolCalls: [{ name: 'web_fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } }] }, { content: 'Refused.' })
    const agent = await app.agents.create({ sandboxMode: 'read-only' })
    const result = await agent.run({ text: 'Read the metadata.' })
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(llm.requests[0]!.tools?.map(tool => tool.name)).toContain('web_fetch')
    const [toolResult] = llm.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(toolResult).toMatchObject({ name: 'web_fetch', isError: true })
    expect(toolResult!.content).toContain('not a public internet address')
  })
})
