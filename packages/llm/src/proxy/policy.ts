// Adapted from deepseek-harness@46a7f68b packages/util/http-proxy/src/policy.ts (MIT)
/**
 * Proxy policy resolution: pure and transport-free. Turns `HTTP(S)_PROXY` /
 * `ALL_PROXY` / `NO_PROXY` (either casing, lowercase first) into one
 * {@link ProxyPolicy} and answers which proxy, if any, a URL goes through.
 * Loopback hosts are never proxied.
 */

/** Read-only view of an environment. `process.env` satisfies it. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>

/** Loopback entries merged into every policy's bypass list. */
export const LOOPBACK_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]']

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])

/** One resolved outbound proxy policy. Plain data. */
export interface ProxyPolicy {
  /** Proxy for `http:` origins; absent for a direct connection. */
  readonly httpProxy?: string
  /** Proxy for `https:` origins; absent for a direct connection. */
  readonly httpsProxy?: string
  /** Bypass list, already merged with {@link LOOPBACK_NO_PROXY}. */
  readonly noProxy: string
}

/** A policy that proxies nothing. */
export const DIRECT_POLICY: ProxyPolicy = Object.freeze({ noProxy: '' })

/** Why one candidate value was not used. Carries no credential. */
export interface ProxyDiagnostic {
  readonly kind: 'socks' | 'invalid'
  /** The variable that supplied the rejected value. */
  readonly origin: string
  readonly message: string
}

/** A resolved policy plus the rejected candidates. */
export interface ProxyResolution {
  readonly policy: ProxyPolicy
  readonly diagnostics: readonly ProxyDiagnostic[]
}

type Candidate =
  | { readonly kind: 'accepted'; readonly value: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'absent' }

function readEnv(env: ProxyEnv, lower: string): { value: string; name: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return { value, name }
  }
  return undefined
}

function accept(candidate: { value: string; name: string } | undefined, diagnostics: ProxyDiagnostic[]): Candidate {
  if (candidate === undefined) return { kind: 'absent' }
  const parsed = URL.parse(candidate.value)
  if (parsed === null) {
    diagnostics.push({ kind: 'invalid', origin: candidate.name, message: `${candidate.name} is not a valid URL; connecting directly` })
    return { kind: 'rejected' }
  }
  if (SOCKS_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'socks',
      origin: candidate.name,
      message: `${candidate.name} names a SOCKS proxy, which is not supported; connecting directly for that scheme`,
    })
    return { kind: 'rejected' }
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} uses the unsupported ${parsed.protocol}// scheme; connecting directly for that scheme`,
    })
    return { kind: 'rejected' }
  }
  return { kind: 'accepted', value: candidate.value }
}

function resolveScheme(own: Candidate, ...fallbacks: (string | undefined)[]): string | undefined {
  if (own.kind === 'accepted') return own.value
  if (own.kind === 'rejected') return undefined
  return fallbacks.find(value => value !== undefined)
}

function withLoopback(noProxy: string | undefined): string {
  const entries = (noProxy ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map(entry => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter(entry => !present.has(entry))].join(',')
}

function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

/**
 * Whether a host names this machine (`localhost`, `127.0.0.0/8`, `::1`, the
 * unspecified address, or an IPv4-mapped loopback).
 * @param hostname - a URL hostname, bracketed or not.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host)
}

/**
 * Whether a bypass list exempts a URL. An entry matches its host and every
 * subdomain; a leading `.` or `*.` means the same; `:port` narrows; `*`
 * bypasses everything. CIDR is not supported.
 * @param noProxy - the effective bypass list.
 * @param url - the request URL.
 */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/**
 * Resolve the proxy policy from an environment. A scheme's own variable wins,
 * then `ALL_PROXY`, then (HTTPS only) the HTTP proxy; a rejected value keeps
 * its scheme direct instead of falling through.
 * @param env - the environment to read, usually `process.env`.
 */
export function resolveProxyPolicy(env: ProxyEnv): ProxyResolution {
  const diagnostics: ProxyDiagnostic[] = []
  const all = accept(readEnv(env, 'all_proxy'), diagnostics)
  const allValue = all.kind === 'accepted' ? all.value : undefined
  const envHttp = accept(readEnv(env, 'http_proxy'), diagnostics)
  const envHttps = accept(readEnv(env, 'https_proxy'), diagnostics)
  const httpProxy = resolveScheme(envHttp, allValue)
  const httpsProxy = resolveScheme(envHttps, allValue, httpProxy)
  if (httpProxy === undefined && httpsProxy === undefined) return { policy: DIRECT_POLICY, diagnostics }
  return {
    policy: {
      ...httpProxy === undefined ? {} : { httpProxy },
      ...httpsProxy === undefined ? {} : { httpsProxy },
      noProxy: withLoopback(readEnv(env, 'no_proxy')?.value),
    },
    diagnostics,
  }
}

/**
 * The proxy one URL goes through under a policy, or `undefined` for direct.
 * @param policy - the active policy.
 * @param url - the request URL.
 */
export function proxyForUrl(policy: ProxyPolicy, url: URL): string | undefined {
  const proxy = url.protocol === 'https:' ? policy.httpsProxy : url.protocol === 'http:' ? policy.httpProxy : undefined
  if (proxy === undefined) return undefined
  if (isLoopbackHost(url.hostname)) return undefined
  return bypassesProxy(policy.noProxy, url) ? undefined : proxy
}
