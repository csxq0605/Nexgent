import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { proxyForUrl, resolveProxyPolicy } from '../src/index.js'
import { loadSseFixture, readFixture, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js'
import { collect, makeProvider, makeRequest, TEST_KEY } from './helpers/stream.js'

interface TestProxy {
  readonly url: string
  readonly seen: string[]
  readonly authorizations: (string | undefined)[]
  close(): Promise<void>
}

/** A forward proxy that sends every request (and every CONNECT) to `targetPort` on loopback. */
async function startProxy(targetPort: number, options: { refuseConnect?: number } = {}): Promise<TestProxy> {
  const seen: string[] = []
  const authorizations: (string | undefined)[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    authorizations.push(req.headers['proxy-authorization'])
    const target = new URL(req.url ?? '/')
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: target.pathname, headers }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  server.on('connect', (req: http.IncomingMessage, client: Socket) => {
    seen.push(`CONNECT ${req.url}`)
    authorizations.push(req.headers['proxy-authorization'])
    if (options.refuseConnect !== undefined) {
      client.end(`HTTP/1.1 ${options.refuseConnect} Refused\r\n\r\n`)
      return
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    authorizations,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

let fake: FakeOpenAI | undefined
let proxy: TestProxy | undefined
afterEach(async () => {
  await proxy?.close()
  await fake?.close()
  proxy = undefined
  fake = undefined
})

describe('resolveProxyPolicy / proxyForUrl', () => {
  it('reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY (lowercase first) and always bypasses loopback', () => {
    const { policy, diagnostics } = resolveProxyPolicy({
      HTTPS_PROXY: 'http://proxy.corp:8080', http_proxy: 'http://p2:3128', NO_PROXY: 'internal.corp,.svc:8443',
    })
    expect(diagnostics).toEqual([])
    expect(policy.httpsProxy).toBe('http://proxy.corp:8080')
    expect(policy.httpProxy).toBe('http://p2:3128')
    expect(proxyForUrl(policy, new URL('https://token-plan-cn.xiaomimimo.com/v1'))).toBe('http://proxy.corp:8080')
    expect(proxyForUrl(policy, new URL('https://api.internal.corp/v1'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('https://a.svc:8443/'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('https://a.svc/'))).toBe('http://proxy.corp:8080')
    expect(proxyForUrl(policy, new URL('http://127.0.0.1:9/v1'))).toBeUndefined()
    expect(proxyForUrl(policy, new URL('http://localhost:9/v1'))).toBeUndefined()
  })

  it('falls back HTTPS → HTTP proxy, rejects SOCKS with a diagnostic, and is direct when unset', () => {
    expect(resolveProxyPolicy({ HTTP_PROXY: 'http://p:1' }).policy.httpsProxy).toBe('http://p:1')
    const socks = resolveProxyPolicy({ HTTPS_PROXY: 'socks5://p:1', HTTP_PROXY: 'http://p:1' })
    expect(socks.policy.httpsProxy).toBeUndefined()
    expect(socks.diagnostics).toEqual([expect.objectContaining({ kind: 'socks', origin: 'HTTPS_PROXY' })])
    expect(resolveProxyPolicy({}).policy).toEqual({ noProxy: '' })
  })
})

describe('provider through a proxy', () => {
  it('sends http:// endpoints through HTTP_PROXY in absolute-URI form, with proxy auth', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    proxy = await startProxy(fake.port)
    const proxyUrl = proxy.url.replace('http://', 'http://alice:s3cret@')
    const { provider, ledger } = makeProvider('http://fake-upstream.test/v1', { proxy: 'env', env: { HTTP_PROXY: proxyUrl } })
    const events = await collect(provider.complete(makeRequest()))
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' })
    expect(proxy.seen).toEqual(['POST http://fake-upstream.test/v1/chat/completions'])
    expect(proxy.authorizations).toEqual([`Basic ${Buffer.from('alice:s3cret').toString('base64')}`])
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(ledger.records.map(record => record.type)).toEqual(['llm.request.start', 'llm.request.end'])
  })

  it('tunnels https:// endpoints through CONNECT + TLS', async () => {
    const tlsMaterial = { key: readFixture('tls/fake-upstream.key.pem'), cert: readFixture('tls/fake-upstream.cert.pem') }
    fake = await startFakeOpenAI([{ sse: loadSseFixture('tool-call') }], tlsMaterial)
    proxy = await startProxy(fake.port)
    const { provider } = makeProvider('https://fake-upstream.test/v1', {
      proxy: { httpsProxy: proxy.url, noProxy: '' },
      proxyTls: { ca: tlsMaterial.cert },
    })
    const events = await collect(provider.complete(makeRequest()))
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'tool-calls' })
    expect(proxy.seen).toEqual(['CONNECT fake-upstream.test:443'])
    expect(fake.requests).toHaveLength(1)
  })

  it('a refused CONNECT is a request failure that names the proxy without its credentials', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    proxy = await startProxy(fake.port, { refuseConnect: 407 })
    const { provider, ledger } = makeProvider('https://fake-upstream.test/v1', {
      proxy: { httpsProxy: proxy.url.replace('http://', 'http://bob:pa55word@'), noProxy: '' },
    })
    const events = await collect(provider.complete(makeRequest()))
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    if (last?.type !== 'error') return
    expect(last.error.code).toBe('llm/request-failed')
    expect(last.error.details).toMatchObject({ proxyStatus: 407 })
    expect(last).not.toHaveProperty('httpStatus')
    expect(JSON.stringify(events)).not.toContain('pa55word')
    expect(ledger.records[1]).toMatchObject({ status: 'error', errorCode: 'llm/request-failed' })
  })

  it('NO_PROXY and loopback endpoints connect directly', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    proxy = await startProxy(fake.port)
    const { provider } = makeProvider(fake.baseUrl, { proxy: 'env', env: { HTTP_PROXY: proxy.url } })
    await collect(provider.complete(makeRequest()))
    expect(proxy.seen).toEqual([])
    expect(fake.requests).toHaveLength(1)
  })
})
