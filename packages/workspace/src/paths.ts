// Adapted from deepseek-harness@46a7f68b packages/fs/fs-sandbox/src/containment.ts (MIT)
/**
 * Path normalization and containment for the sandbox
 * (`docs/spec/permissions.md` §路径策略与写入限制 规范化). Lexical helpers are
 * pure and take an explicit platform so Windows rules are testable anywhere;
 * {@link resolveReal} touches the host filesystem.
 */
import { lstat, readlink, realpath } from 'node:fs/promises'
import * as nodePath from 'node:path'

/** Path flavour for the pure helpers. */
export type PathFlavor = 'posix' | 'win32'

/** The host's flavour. */
export const HOST_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix'

/** Resolved paths longer than this are rejected. */
export const MAX_PATH_LENGTH = 4096

function api(flavor: PathFlavor): typeof nodePath.posix {
  return flavor === 'win32' ? nodePath.win32 : nodePath.posix
}

/** Remove a Win32 verbatim prefix: `\\?\C:\x` → `C:\x`, `\\?\UNC\s\x` → `\\s\x`. */
export function stripVerbatimPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

function trimTrailingSeparator(path: string, flavor: PathFlavor): string {
  const p = api(flavor)
  const rootLength = p.parse(path).root.length
  let end = path.length
  while (end > rootLength && (path[end - 1] === p.sep)) end--
  return path.slice(0, end)
}

/**
 * The spelling used for comparisons: normalized, no trailing separator; on
 * Windows also `/` → `\`, verbatim prefix removed and lower-cased.
 */
export function comparablePath(path: string, flavor: PathFlavor = HOST_FLAVOR): string {
  if (flavor === 'posix') return trimTrailingSeparator(nodePath.posix.normalize(path), flavor)
  const unified = stripVerbatimPrefix(path.replace(/\//g, '\\'))
  return trimTrailingSeparator(nodePath.win32.normalize(unified), flavor).toLowerCase()
}

/** Whether `target` is `root` or below it, after {@link comparablePath}. */
export function isWithin(root: string, target: string, flavor: PathFlavor = HOST_FLAVOR): boolean {
  const r = comparablePath(root, flavor)
  const t = comparablePath(target, flavor)
  if (t === r) return true
  const sep = api(flavor).sep
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * `target` relative to `root` with `/` separators (lower-cased on Windows),
 * or `undefined` when `target` is not within `root`.
 */
export function relativeWithin(root: string, target: string, flavor: PathFlavor = HOST_FLAVOR): string | undefined {
  if (!isWithin(root, target, flavor)) return undefined
  const rel = api(flavor).relative(comparablePath(root, flavor), comparablePath(target, flavor))
  return flavor === 'win32' ? rel.replace(/\\/g, '/') : rel
}

const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Windows-only spellings rejected regardless of roots: reserved device names
 * as any path segment, alternate data streams (`file:stream`) and UNC paths
 * when no root is UNC. Drive and share mismatches fall out of
 * {@link isWithin}. Returns the reason, or `undefined` when acceptable.
 */
export function windowsPathIssue(target: string, roots: readonly string[]): string | undefined {
  const unified = stripVerbatimPrefix(target.replace(/\//g, '\\'))
  const body = /^[a-zA-Z]:/.test(unified) ? unified.slice(2) : unified
  if (body.includes(':')) return 'alternate data streams and stray colons are not allowed'
  for (const segment of body.split('\\')) {
    if (segment === '') continue
    if (DEVICE_NAME.test(segment.replace(/[. ]+$/, ''))) return `"${segment}" is a reserved device name`
  }
  if (unified.startsWith('\\\\')) {
    const anyUncRoot = roots.some(root => stripVerbatimPrefix(root.replace(/\//g, '\\')).startsWith('\\\\'))
    if (!anyUncRoot) return 'UNC paths are allowed only when the project itself is on a UNC share'
  }
  return undefined
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Resolve an absolute host path to its real location: `realpath` of the
 * longest existing ancestor with the missing tail appended literally. A
 * dangling symlink is followed to where a write would land.
 */
export async function resolveReal(path: string, depth = 0): Promise<string> {
  if (depth > 40) throw Object.assign(new Error(`too many symbolic links: ${path}`), { code: 'ELOOP' })
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      const target = await readlink(path)
      return await resolveReal(nodePath.resolve(nodePath.dirname(path), target), depth + 1)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const parent = nodePath.dirname(path)
  if (parent === path) return path
  return nodePath.join(await resolveReal(parent, depth), nodePath.basename(path))
}
