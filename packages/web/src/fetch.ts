/**
 * One public-page fetch: URL policy, address-checked and pinned
 * connections, redirects (every hop re-checked), content-type and charset
 * handling, and a byte cap. Presentation (Markdown, paging) is the tool's.
 *
 * URL and content-type rules follow deepseek-harness@46a7f68b
 * packages/web/web-fetch-http/src/policy.ts; unlike it, cross-origin
 * redirects are followed, each hop through the same address check.
 */
import {
  BlockedAddressError,
  isPublicAddress,
  pinnedRequester,
  resolveAllowed,
  systemResolver,
  type Requester,
  type Resolver,
} from './network.js'

/** Why a fetch failed; the tool maps each to an error code. */
export type WebFailure =
  | 'invalid-url'
  | 'credentials'
  | 'blocked-address'
  | 'redirects'
  | 'http-status'
  | 'content-type'
  | 'too-large'
  | 'timeout'
  | 'network'

/** A failed fetch. */
export class WebFetchError extends Error {
  override readonly name = 'WebFetchError'
  constructor(readonly reason: WebFailure, message: string, readonly status?: number) {
    super(message)
  }
}

/** Limits of one fetch. */
export interface FetchLimits {
  /** Body bytes read at most (after decompression); a larger body is cut and marked truncated. */
  readonly maxBytes: number
  /** Redirect hops followed at most. */
  readonly maxRedirects: number
  /** Deadline for the whole fetch, connection to last byte. */
  readonly timeoutMs: number
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = { maxBytes: 5_000_000, maxRedirects: 5, timeoutMs: 30_000 }

/** Longest URL accepted. */
export const MAX_URL_LENGTH = 2_048

/** Replaceable parts (tests). */
export interface FetchDeps {
  readonly resolver?: Resolver
  readonly requester?: Requester
  /** Address policy; default {@link isPublicAddress}. */
  readonly allowAddress?: (address: string) => boolean
  readonly userAgent?: string
}

export const DEFAULT_USER_AGENT = 'Nexgent (public page reader)'

/** What a fetch returns. */
export interface FetchedPage {
  /** Final URL after redirects. */
  readonly url: string
  readonly status: number
  readonly kind: 'html' | 'text'
  /** Media type without parameters. */
  readonly mediaType: string
  readonly content: string
  /** The body was cut at `maxBytes`. */
  readonly truncated: boolean
}

/** Parse and check a URL: http(s) only, no embedded credentials, bounded length. */
export function validateUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new WebFetchError('invalid-url', `the URL is longer than ${MAX_URL_LENGTH} characters`)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WebFetchError('invalid-url', `not a valid URL: ${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebFetchError('invalid-url', `only http and https URLs can be fetched, not ${url.protocol}`)
  if (url.username !== '' || url.password !== '') throw new WebFetchError('credentials', 'URLs with embedded credentials are not fetched')
  return url
}

/** `text/html` / XHTML → html; other `text/*`, JSON and XML → text; anything else (binary) → `undefined`. */
export function classifyContentType(contentType: string | undefined): 'html' | 'text' | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** The `charset` parameter of a `Content-Type`, lower-cased. */
export function parseCharset(contentType: string | undefined): string | undefined {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase()
}

/** A `<meta charset>` / `http-equiv` declaration in the first bytes of an HTML page. */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i.exec(head)
  return match?.[1]?.toLowerCase()
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Fetch one page.
 * @throws {@link WebFetchError}; an abort of `signal` rethrows its reason.
 */
export async function fetchPage(input: string, signal: AbortSignal, limits: FetchLimits = DEFAULT_FETCH_LIMITS, deps: FetchDeps = {}): Promise<FetchedPage> {
  const resolver = deps.resolver ?? systemResolver
  const requester = deps.requester ?? pinnedRequester
  const allow = deps.allowAddress ?? isPublicAddress
  const deadline = AbortSignal.timeout(limits.timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  const headers = {
    'user-agent': deps.userAgent ?? DEFAULT_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  }
  const fail = (error: unknown): never => {
    if (signal.aborted) throw signal.reason
    if (deadline.aborted) throw new WebFetchError('timeout', `no complete response within ${limits.timeoutMs} ms`)
    if (error instanceof WebFetchError) throw error
    if (error instanceof BlockedAddressError) throw new WebFetchError('blocked-address', error.message)
    const code = (error as NodeJS.ErrnoException).code
    throw new WebFetchError('network', `cannot fetch: ${code ?? (error as Error).message}`)
  }

  let url = validateUrl(input)
  for (let hop = 0; ; hop++) {
    let response
    try {
      const [address] = await resolveAllowed(url.hostname, combined, resolver, allow)
      response = await requester(url, address!, headers, combined)
    } catch (error) {
      return fail(error)
    }
    try {
      if (isRedirect(response.status)) {
        const location = response.headers['location']
        if (location === undefined) throw new WebFetchError('network', `HTTP ${response.status} without a Location header`, response.status)
        if (hop >= limits.maxRedirects) throw new WebFetchError('redirects', `more than ${limits.maxRedirects} redirects`, response.status)
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new WebFetchError('network', `invalid redirect target ${JSON.stringify(location)}`, response.status)
        }
        url = validateUrl(next.toString())
        continue
      }
      if (response.status < 200 || response.status > 299) {
        throw new WebFetchError('http-status', `the server answered HTTP ${response.status}`, response.status)
      }
      const contentType = response.headers['content-type']
      const kind = classifyContentType(contentType)
      if (kind === undefined) {
        throw new WebFetchError('content-type', `${contentType ?? 'a response without Content-Type'} is not a web page or text; web_fetch reads HTML, text and JSON`)
      }
      const declared = Number(response.headers['content-length'])
      if (response.headers['content-encoding'] === undefined && Number.isFinite(declared) && declared > limits.maxBytes) {
        throw new WebFetchError('too-large', `the page is ${declared} bytes; web_fetch reads at most ${limits.maxBytes}`)
      }
      const chunks: Uint8Array[] = []
      let total = 0
      let truncated = false
      for await (const chunk of response.body) {
        const room = limits.maxBytes - total
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room))
          total += room
          truncated = true
          break
        }
        chunks.push(chunk)
        total += chunk.byteLength
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const charset = parseCharset(contentType) ?? (kind === 'html' ? sniffHtmlCharset(bytes) : undefined)
      let decoder: TextDecoder
      try {
        decoder = new TextDecoder(charset ?? 'utf-8')
      } catch {
        decoder = new TextDecoder('utf-8')
      }
      return {
        url: url.toString(),
        status: response.status,
        kind,
        mediaType: (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase(),
        content: decoder.decode(bytes),
        truncated,
      }
    } catch (error) {
      return fail(error)
    } finally {
      response.close()
    }
  }
}
