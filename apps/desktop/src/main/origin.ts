/**
 * Page origins, navigation rules and the `app://nexgent/` file mapping
 * (`permissions.md` §本地 IPC 与访问令牌, 页面来源与导航). Pure functions;
 * `index.ts` wires them into Electron's navigation events and protocol.
 */
import { extname, join, normalize, relative, isAbsolute, sep } from 'node:path'

/** Scheme and host the packaged UI is served from. */
export const APP_SCHEME = 'app'
export const APP_HOST = 'nexgent'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`

/** The origin of a URL, or `undefined` when it does not parse. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    // Custom standard schemes report origin "null" in some runtimes; rebuild it.
    return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`
  } catch {
    return undefined
  }
}

/**
 * The development origin allowed besides `app://nexgent`: only
 * `http://localhost:<port>` or `http://127.0.0.1:<port>`.
 * @returns the origin, or `undefined` when `devUrl` is absent or not such a URL.
 */
export function devOrigin(devUrl: string | undefined): string | undefined {
  if (devUrl === undefined || devUrl === '') return undefined
  try {
    const parsed = new URL(devUrl)
    if (parsed.protocol !== 'http:') return undefined
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return undefined
    if (parsed.port === '') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

/** A predicate over page URLs: `app://nexgent`, plus the dev origin when given. */
export function originChecker(dev: string | undefined): (url: string) => boolean {
  const allowed = new Set([APP_ORIGIN, ...(dev === undefined ? [] : [dev])])
  return (url) => {
    const origin = originOf(url)
    return origin !== undefined && allowed.has(origin)
  }
}

/** What to do with a navigation or `window.open` target. */
export type NavigationVerdict = 'allow' | 'external' | 'deny'

/**
 * In-page navigation (`will-navigate`, `will-redirect`, `will-frame-navigate`):
 * allowed only to the current page's origin, and only when that origin is ours.
 */
export function navigationVerdict(target: string, current: string, isAllowedOrigin: (url: string) => boolean): NavigationVerdict {
  const to = originOf(target)
  if (to !== undefined && to === originOf(current) && isAllowedOrigin(target)) return 'allow'
  return 'deny'
}

/**
 * A link the page asked to open (`setWindowOpenHandler`): never a new
 * window; `http(s)` targets go to the system browser, everything else
 * (`file:`, `javascript:`, `data:`, custom schemes) is refused.
 */
export function openVerdict(target: string): NavigationVerdict {
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? 'external' : 'deny'
  } catch {
    return 'deny'
  }
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** Content type by extension; unknown types are served as opaque bytes. */
export function contentTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Map an `app://nexgent/<path>` URL to a file inside `rendererDir`.
 * @returns the absolute file path, or `undefined` for another host, an
 *   encoded or literal `..`, a backslash, a drive letter or anything that
 *   would leave the directory. `/` maps to `index.html`.
 */
export function resolveAppFile(rendererDir: string, url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return undefined
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return undefined
  const segments = pathname.split('/').filter((segment) => segment !== '')
  if (segments.some((segment) => segment === '..' || segment === '.' || /^[a-zA-Z]:/.test(segment))) return undefined
  const relativePath = segments.length === 0 ? 'index.html' : segments.join(sep)
  const root = normalize(rendererDir)
  const file = join(root, relativePath)
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return file
}

/** The CSP header every `app://` response carries (development relaxes `connect-src` for vite's hot reload). */
export function contentSecurityPolicy(dev: string | undefined): string {
  const connect = dev === undefined ? "'self'" : `'self' ${dev} ${dev.replace(/^http:/, 'ws:')}`
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
