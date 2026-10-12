/**
 * The capability bundle manifest (`.nexgent/capabilities/<version>/manifest.json`)
 * and its content address. A manifest lists every component of a bundle with
 * its type, name, directory and the SHA-256 and size of each file; the
 * bundle's version is the SHA-256 of the normalized manifest, so the same
 * components always yield the same version and any change to a file yields a
 * new one. Provenance (which session or candidate produced a bundle) is not
 * part of the manifest: it lives in candidate and activation records, so two
 * candidates with identical content share one version.
 *
 * The shapes here are this package's first-round proposal; the step 4
 * contract (`packages/kernel/src/contracts/`) is the authority once it lands.
 */
import { createHash } from 'node:crypto'

/** Manifest format written by this package. */
export const MANIFEST_FORMAT = 1

/** Name of the manifest file inside a bundle directory. */
export const MANIFEST_FILE = 'manifest.json'

/** The empty bundle: step 3 behaviour, never stored on disk. */
export const BASELINE_VERSION = 'baseline'

/**
 * Component types (plan 4.4's four classes): tools are PTC function modules
 * or plugin packs; skills are SKILL.md directories; context policy; and
 * collaboration forms (presets, team templates, workflow graphs).
 */
export const CAPABILITY_COMPONENT_TYPES = [
  'function-module',
  'plugin',
  'skill',
  'context-policy',
  'preset',
  'team-template',
  'architecture',
] as const

/** One of {@link CAPABILITY_COMPONENT_TYPES}. */
export type CapabilityComponentType = (typeof CAPABILITY_COMPONENT_TYPES)[number]

/** Upper bounds a manifest must respect; checked on write and on load. */
export const BUNDLE_LIMITS = {
  maxComponents: 256,
  maxFilesPerComponent: 256,
  maxFiles: 1024,
  /** Total bytes of every file of a bundle. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** UTF-8 length of one relative path. */
  maxPathLength: 240,
} as const

/** One file of a component, relative to the component directory. */
export interface CapabilityFileEntry {
  /** POSIX relative path inside the component directory. */
  readonly path: string
  /** Lowercase hex SHA-256 of the file bytes. */
  readonly sha256: string
  /** Size in bytes. */
  readonly size: number
}

/** One component of a bundle. */
export interface CapabilityComponent {
  readonly type: CapabilityComponentType
  /** Unique per type within a bundle; `[a-z0-9][a-z0-9_-]*`, at most 64 characters. */
  readonly name: string
  /** POSIX directory relative to the bundle root, always `<type>/<name>`. */
  readonly path: string
  /** Every file of the component, sorted by path. */
  readonly files: readonly CapabilityFileEntry[]
}

/** `manifest.json`. */
export interface CapabilityManifest {
  readonly format: typeof MANIFEST_FORMAT
  /** Sorted by type, then name. */
  readonly components: readonly CapabilityComponent[]
}

/** Error raised for a manifest that breaks the format. */
export class CapabilityManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityManifestError'
  }
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/

/** Whether `value` is a stored bundle version (a lowercase SHA-256 hex digest). */
export function isBundleVersion(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/** Whether `value` is a version an activation may point at: a bundle version or {@link BASELINE_VERSION}. */
export function isCapabilityVersion(value: unknown): value is string {
  return value === BASELINE_VERSION || isBundleVersion(value)
}

/** Lowercase hex SHA-256 of bytes or a UTF-8 string. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Check a component-relative file path: POSIX separators, no empty, `.` or
 * `..` segments, no absolute or drive paths, no characters Windows cannot
 * store, and not a case-insensitive duplicate (checked by the caller).
 */
export function checkRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new CapabilityManifestError('a file path must be a non-empty string')
  if (Buffer.byteLength(path, 'utf8') > BUNDLE_LIMITS.maxPathLength) throw new CapabilityManifestError(`file path too long: ${path}`)
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new CapabilityManifestError(`file path must be relative and use "/": ${path}`)
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(path)) throw new CapabilityManifestError(`file path has a character Windows cannot store: ${path}`)
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new CapabilityManifestError(`file path has an empty, "." or ".." segment: ${path}`)
    if (segment.endsWith('.') || segment.endsWith(' ')) throw new CapabilityManifestError(`file path segment ends with "." or space: ${path}`)
  }
  return path
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter(key => !keys.includes(key))
  if (extra.length > 0) throw new CapabilityManifestError(`${what} has unknown fields: ${extra.join(', ')}`)
}

function normalizeFile(value: unknown, where: string): CapabilityFileEntry {
  if (!isObject(value)) throw new CapabilityManifestError(`${where}: a file entry must be an object`)
  exactKeys(value, ['path', 'sha256', 'size'], where)
  const path = checkRelativePath(value.path as string)
  if (!isBundleVersion(value.sha256)) throw new CapabilityManifestError(`${where}: sha256 must be a lowercase hex digest`)
  const size = value.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new CapabilityManifestError(`${where}: size must be a non-negative integer`)
  return { path, sha256: value.sha256, size }
}

function normalizeComponent(value: unknown, index: number): CapabilityComponent {
  const where = `component ${index}`
  if (!isObject(value)) throw new CapabilityManifestError(`${where} must be an object`)
  exactKeys(value, ['type', 'name', 'path', 'files'], where)
  const type = value.type
  if (typeof type !== 'string' || !(CAPABILITY_COMPONENT_TYPES as readonly string[]).includes(type)) {
    throw new CapabilityManifestError(`${where}: unknown component type ${JSON.stringify(type)}`)
  }
  const name = value.name
  if (typeof name !== 'string' || !NAME.test(name)) throw new CapabilityManifestError(`${where}: name must match ${NAME.source}`)
  const path = `${type}/${name}`
  if (value.path !== path) throw new CapabilityManifestError(`${where}: path must be "${path}"`)
  if (!Array.isArray(value.files) || value.files.length === 0) throw new CapabilityManifestError(`${where}: files must be a non-empty array`)
  if (value.files.length > BUNDLE_LIMITS.maxFilesPerComponent) throw new CapabilityManifestError(`${where}: more than ${BUNDLE_LIMITS.maxFilesPerComponent} files`)
  const files = value.files.map((file, fileIndex) => normalizeFile(file, `${where} (${path}) file ${fileIndex}`))
    .sort((left, right) => compare(left.path, right.path))
  const seen = new Map<string, string>()
  for (const file of files) {
    const folded = file.path.toLowerCase()
    const clash = seen.get(folded)
    if (clash !== undefined) throw new CapabilityManifestError(`${path}: files "${clash}" and "${file.path}" collide on a case-insensitive file system`)
    seen.set(folded, file.path)
  }
  for (const file of files) {
    // A file may not also be a directory of another file ("a" and "a/b").
    if (files.some(other => other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`))) {
      throw new CapabilityManifestError(`${path}: "${file.path}" is both a file and a directory`)
    }
  }
  return { type: type as CapabilityComponentType, name, path, files }
}

/**
 * Validate an untrusted manifest and return its normalized form (components
 * sorted by type then name, files by path, keys in a fixed order).
 * @throws {@link CapabilityManifestError} on any violation.
 */
export function normalizeManifest(value: unknown): CapabilityManifest {
  if (!isObject(value)) throw new CapabilityManifestError('a manifest must be an object')
  exactKeys(value, ['format', 'components'], 'manifest')
  if (value.format !== MANIFEST_FORMAT) throw new CapabilityManifestError(`unsupported manifest format ${JSON.stringify(value.format)}`)
  if (!Array.isArray(value.components)) throw new CapabilityManifestError('manifest components must be an array')
  if (value.components.length > BUNDLE_LIMITS.maxComponents) throw new CapabilityManifestError(`more than ${BUNDLE_LIMITS.maxComponents} components`)
  const components = value.components.map(normalizeComponent)
    .sort((left, right) => compare(left.type, right.type) || compare(left.name, right.name))
  for (let index = 1; index < components.length; index++) {
    const previous = components[index - 1]!
    const current = components[index]!
    if (previous.type === current.type && previous.name === current.name) {
      throw new CapabilityManifestError(`duplicate component ${current.path}`)
    }
  }
  let files = 0
  let bytes = 0
  for (const component of components) {
    files += component.files.length
    for (const file of component.files) bytes += file.size
  }
  if (files > BUNDLE_LIMITS.maxFiles) throw new CapabilityManifestError(`more than ${BUNDLE_LIMITS.maxFiles} files`)
  if (bytes > BUNDLE_LIMITS.maxTotalBytes) throw new CapabilityManifestError(`bundle larger than ${BUNDLE_LIMITS.maxTotalBytes} bytes`)
  return { format: MANIFEST_FORMAT, components }
}

/** The exact bytes hashed and stored for a normalized manifest (no trailing newline). */
export function serializeManifest(manifest: CapabilityManifest): string {
  return JSON.stringify({
    format: manifest.format,
    components: manifest.components.map(component => ({
      type: component.type,
      name: component.name,
      path: component.path,
      files: component.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size })),
    })),
  })
}

/** The content address of a manifest: SHA-256 of its normalized serialization. */
export function manifestVersion(manifest: unknown): string {
  return sha256(serializeManifest(normalizeManifest(manifest)))
}
