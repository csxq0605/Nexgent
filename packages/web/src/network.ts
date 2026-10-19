/**
 * Which addresses `web_fetch` may connect to, hostname resolution that
 * refuses the whole answer when any address is not public, and an HTTP(S)
 * request pinned to one validated address (the connection never resolves
 * the hostname again, so a DNS answer that changes between the check and
 * the connection cannot reach a private address). The hostname stays in
 * the request for `Host` and TLS SNI.
 */
import { lookup } from 'node:dns/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** One resolved address. */
export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** IPv4 ranges that are not public unicast (RFC 6890 special-purpose registry). */
const NON_PUBLIC_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]

/** IPv6 is public only inside global unicast 2000::/3, minus these. */
const NON_PUBLIC_V6: readonly [string, number][] = [
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 destination this check cannot see)
  ['3fff::', 20], // documentation
]

const blockedV4 = new BlockList()
for (const [network, prefix] of NON_PUBLIC_V4) blockedV4.addSubnet(network, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const blockedV6 = new BlockList()
for (const [network, prefix] of NON_PUBLIC_V6) blockedV6.addSubnet(network, prefix, 'ipv6')

/** `[::1]` → `::1`. */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Whether an address is public unicast. IPv4: everything outside the
 * special-purpose ranges. IPv6: only global unicast (2000::/3) outside its
 * special ranges, so loopback, unique-local, link-local, multicast,
 * IPv4-mapped / -compatible and NAT64 addresses are all refused.
 */
export function isPublicAddress(input: string): boolean {
  const address = stripBrackets(input)
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6')
  return false
}

/** A destination refused by the address policy. */
export class BlockedAddressError extends Error {
  override readonly name = 'BlockedAddressError'
}

/** Resolver signature (replaceable in tests). */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

/** The system resolver: every address, in the resolver's order. */
export const systemResolver: Resolver = async hostname => {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map(answer => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }))
}

/**
 * Resolve a hostname (or take an IP literal as is) and refuse the whole
 * answer when any address fails `allowed`.
 * @throws {@link BlockedAddressError}.
 */
export async function resolveAllowed(
  hostname: string,
  signal: AbortSignal,
  resolver: Resolver,
  allowed: (address: string) => boolean,
): Promise<ResolvedAddress[]> {
  const host = stripBrackets(hostname)
  const literal = isIP(host)
  const answers = literal !== 0
    ? [{ address: host, family: literal as 4 | 6 }]
    : await raceAbort(resolver(host), signal)
  if (answers.length === 0) throw new Error(`${hostname} resolved to no addresses`)
  for (const answer of answers) {
    if (!allowed(answer.address)) {
      throw new BlockedAddressError(literal !== 0
        ? `${hostname} is not a public internet address`
        : `${hostname} resolves to ${answer.address}, which is not a public internet address`)
    }
  }
  return [...answers]
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** A response as `web_fetch` consumes it. */
export interface WebResponse {
  readonly status: number
  /** Lower-case header names; repeated headers joined with `, `. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** The body, already decompressed when the server compressed it. */
  readonly body: AsyncIterable<Uint8Array>
  /** Release the connection (safe to call more than once). */
  close(): void
}

/** Send one GET to `url`, connecting only to `address`. */
export type Requester = (url: URL, address: ResolvedAddress, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<WebResponse>

/** The production requester: `node:http` / `node:https` with a lookup that returns the validated address. */
export const pinnedRequester: Requester = (url, address, headers, signal) => new Promise((resolve, reject) => {
  const transport = url.protocol === 'https:' ? https : http
  const request = transport.request(url, {
    method: 'GET',
    headers,
    signal,
    agent: false,
    lookup: (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: address.address, family: address.family }])
      } else {
        callback(null, address.address, address.family)
      }
    },
  }, response => {
    const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase()
    const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
      : encoding === 'deflate' ? createInflate()
        : encoding === 'br' ? createBrotliDecompress()
          : undefined
    const body: Readable = decoder === undefined ? response : response.pipe(decoder)
    if (decoder !== undefined) response.on('error', error => decoder.destroy(error))
    const headerMap: Record<string, string | undefined> = {}
    for (const [name, value] of Object.entries(response.headers)) headerMap[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    resolve({
      status: response.statusCode ?? 0,
      headers: headerMap,
      body,
      close: () => {
        body.destroy()
        response.destroy()
        request.destroy()
      },
    })
  })
  request.on('error', reject)
  request.end()
})
