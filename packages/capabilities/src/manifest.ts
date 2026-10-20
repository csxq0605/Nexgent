/**
 * Manifest helpers on top of the step 4 contract (`capabilities.ts`): the
 * contract fixes the shape, ordering and canonical text; this module adds
 * hashing (the contract is pure and hash-free) and the checks a writer on a
 * real file system needs beyond the contract's structural ones (characters
 * Windows cannot store, case-insensitive collisions, a path that is both a
 * file and a directory).
 */
import { createHash } from 'node:crypto'
import {
  assertCapabilityManifest,
  BASELINE_VERSION,
  canonicalManifestText,
  CAPABILITY_VERSION_PATTERN,
  COMPONENT_FILE_PATTERN,
  componentDir,
  NexgentError,
  normalizeManifest,
  SHA256_PATTERN,
  type CapabilityComponent,
  type CapabilityManifest,
} from '@nexgent/kernel'

/** Lowercase hex SHA-256 of bytes or a UTF-8 string. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Whether `value` is a stored bundle version (not `baseline`). */
export function isBundleVersion(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

/** Whether `value` is a capability version: a bundle version or `baseline`. */
export function isCapabilityVersion(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_VERSION_PATTERN.test(value)
}

/** The version of a manifest: SHA-256 of {@link canonicalManifestText}. */
export function manifestVersion(manifest: CapabilityManifest): string {
  return sha256(canonicalManifestText(manifest))
}

/**
 * Check one component-relative file path: the contract pattern plus what a
 * Windows file system cannot store (reserved characters, a segment ending in
 * `.` or space).
 * @throws `config/invalid`.
 */
export function checkComponentPath(path: string): string {
  if (typeof path !== 'string' || !COMPONENT_FILE_PATTERN.test(path)) {
    throw new NexgentError('config/invalid', `capability file path must be relative, "/"-separated, without "." or ".." segments: ${JSON.stringify(path)}`)
  }
  if (/[\u0000-\u001f<>"|?*]/.test(path) || path.split('/').some(segment => segment.endsWith('.') || segment.endsWith(' '))) {
    throw new NexgentError('config/invalid', `capability file path has a name Windows cannot store: ${JSON.stringify(path)}`)
  }
  return path
}

function checkComponentFiles(component: CapabilityComponent): void {
  const where = componentDir(component.kind, component.name)
  const folded = new Map<string, string>()
  for (const file of component.files) {
    checkComponentPath(file.path)
    const key = file.path.toLowerCase()
    const clash = folded.get(key)
    if (clash !== undefined) throw new NexgentError('config/invalid', `${where}: "${clash}" and "${file.path}" collide on a case-insensitive file system`)
    folded.set(key, file.path)
  }
  for (const key of folded.keys()) {
    for (const other of folded.keys()) {
      if (other.startsWith(`${key}/`)) throw new NexgentError('config/invalid', `${where}: "${folded.get(key)}" is both a file and a directory`)
    }
  }
}

/**
 * Validate an untrusted manifest (contract structure plus file-system
 * checks) and return it normalized.
 * @throws `config/invalid` naming the first problem.
 */
export function checkManifest(value: unknown): CapabilityManifest {
  assertCapabilityManifest(value)
  const manifest = normalizeManifest(value)
  for (const component of manifest.components) checkComponentFiles(component)
  return manifest
}

/** The empty manifest of {@link BASELINE_VERSION}. */
export const EMPTY_MANIFEST: CapabilityManifest = Object.freeze({ formatVersion: 1, components: Object.freeze([]) }) as CapabilityManifest

export { BASELINE_VERSION }
