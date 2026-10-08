/**
 * The HTTP seam the provider sends through. Direct requests use the global
 * `fetch`; requests that the {@link ProxyPolicy} routes through a proxy use a
 * small node:http tunnel (absolute-URI form for `http:` targets, `CONNECT` +
 * TLS for `https:` targets), because the global `fetch` cannot take a
 * per-request proxy without the `undici` package.
 *
 * When the process was started with `NODE_USE_ENV_PROXY=1` (Node >= 22.21),
 * Node's own `fetch` already tunnels through the environment proxy, so the
 * built-in tunnel steps aside to avoid proxying twice.
 */
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import tls from 'node:tls'
import { proxyForUrl, type ProxyEnv, type ProxyPolicy } from './policy.js'
import { sanitizeUrl } from '../redact.js'

/** One outgoing request. */
export interface TransportRequest {
  readonly url: URL
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** Aborting it must cancel the connection and error the response body. */
  readonly signal: AbortSignal
}

/**
 * Send a request and resolve with the response once headers arrive; the body
 * streams. Rejects on network failure (`error.cause.code` keeps the errno
 * code where there is one).
 */
export type Transport = (request: TransportRequest) => Promise<Response>

/** A {@link Transport} backed by the global `fetch`. */
export const fetchTransport: Transport = request => fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body,
  signal: request.signal,
})

/** TLS options for the tunnel (tests pin a private CA here). */
export interface TunnelTlsOptions {
  /** Extra trusted CA certificates (PEM). Defaults to Node's bundle. */
  readonly ca?: string | readonly string[]
}

/** A proxy refused or failed the tunnel. The message names the proxy without credentials. */
export class ProxyTunnelError extends Error {
  /** Status line code the proxy answered `CONNECT` with. */
  readonly proxyStatus: number | undefined
  constructor(message: string, proxyStatus?: number) {
    super(message)
    this.name = 'ProxyTunnelError'
    this.proxyStatus = proxyStatus
  }
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (proxy.username === '') return {}
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
}

function toResponse(res: http.IncomingMessage): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const status = res.statusCode ?? 502
  const nullBody = status === 204 || status === 205 || status === 304
  if (nullBody) res.resume()
  const body = nullBody ? null : Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, statusText: res.statusMessage ?? '', headers })
}

function defaultPort(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/** Open a raw TCP/TLS connection to the proxy itself and ask it for a `CONNECT` tunnel. */
function connectTunnel(proxy: URL, target: URL, signal: AbortSignal, tlsOptions: TunnelTlsOptions): Promise<import('node:net').Socket> {
  const authority = `${target.hostname}:${defaultPort(target)}`
  const request = (proxy.protocol === 'https:' ? https : http).request({
    host: proxy.hostname.replace(/^\[|\]$/g, ''),
    port: defaultPort(proxy),
    method: 'CONNECT',
    path: authority,
    headers: { host: authority, ...proxyAuthorization(proxy) },
    signal,
    agent: false,
    ...tlsOptions.ca === undefined ? {} : { ca: tlsOptions.ca as string | string[] },
  })
  return new Promise((resolve, reject) => {
    request.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new ProxyTunnelError(`proxy ${sanitizeUrl(proxy.href)} refused CONNECT with status ${res.statusCode ?? 'unknown'}`, res.statusCode))
        return
      }
      resolve(socket)
    })
    request.once('error', reject)
    request.end()
  })
}

/**
 * A {@link Transport} that tunnels every request through one proxy.
 * @param proxyUrl - `http://` or `https://` proxy URL, optionally with `user:pass@`.
 * @param tlsOptions - TLS trust for the target (and an `https:` proxy).
 */
export function createProxyTransport(proxyUrl: string, tlsOptions: TunnelTlsOptions = {}): Transport {
  const proxy = new URL(proxyUrl)
  return async request => {
    const { url, signal } = request
    const headers = { ...request.headers, 'content-length': String(Buffer.byteLength(request.body)) }
    if (url.protocol === 'http:') {
      return await new Promise<Response>((resolve, reject) => {
        const req = (proxy.protocol === 'https:' ? https : http).request({
          host: proxy.hostname.replace(/^\[|\]$/g, ''),
          port: defaultPort(proxy),
          method: request.method,
          path: url.href,
          headers: { ...headers, host: url.host, ...proxyAuthorization(proxy) },
          signal,
          agent: false,
          ...tlsOptions.ca === undefined ? {} : { ca: tlsOptions.ca as string | string[] },
        }, res => resolve(toResponse(res)))
        req.once('error', reject)
        req.end(request.body)
      })
    }
    const socket = await connectTunnel(proxy, url, signal, tlsOptions)
    return await new Promise<Response>((resolve, reject) => {
      const secure = tls.connect({
        socket,
        servername: url.hostname,
        ...tlsOptions.ca === undefined ? {} : { ca: tlsOptions.ca as string | string[] },
      })
      const req = http.request({
        host: url.hostname,
        port: defaultPort(url),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        signal,
        createConnection: () => secure,
      }, res => resolve(toResponse(res)))
      req.once('error', error => {
        secure.destroy()
        reject(error)
      })
      req.end(request.body)
    })
  }
}

/** Options for {@link createTransport}. */
export interface CreateTransportOptions {
  /** The policy to apply per URL. */
  readonly policy: ProxyPolicy
  /** Environment consulted for `NODE_USE_ENV_PROXY`. */
  readonly env?: ProxyEnv
  /** Transport for direct requests; defaults to {@link fetchTransport}. */
  readonly direct?: Transport
  /** TLS trust for tunnelled requests. */
  readonly tls?: TunnelTlsOptions
}

/**
 * The default transport: per request, route through the policy's proxy when
 * one applies, otherwise go direct.
 */
export function createTransport(options: CreateTransportOptions): Transport {
  const direct = options.direct ?? fetchTransport
  const nodeHandlesProxy = options.env?.['NODE_USE_ENV_PROXY'] === '1'
  const tunnels = new Map<string, Transport>()
  return request => {
    const proxy = nodeHandlesProxy ? undefined : proxyForUrl(options.policy, request.url)
    if (proxy === undefined) return direct(request)
    let tunnel = tunnels.get(proxy)
    if (tunnel === undefined) {
      tunnel = createProxyTransport(proxy, options.tls)
      tunnels.set(proxy, tunnel)
    }
    return tunnel(request)
  }
}
