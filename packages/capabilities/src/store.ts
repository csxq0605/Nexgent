/**
 * Content-addressed, immutable bundle storage under
 * `.nexgent/capabilities/<version>/`:
 *
 * ```text
 * <version>/
 * ├── manifest.json            normalized manifest; <version> = its SHA-256
 * └── <type>/<name>/<file>     component files, exactly as listed
 * ```
 *
 * A bundle is assembled in a private staging directory, every file and the
 * manifest are fsynced, and the directory is renamed to its version in one
 * step, so readers never see a partial bundle. A version that already exists
 * is never replaced: the writer verifies the existing copy instead. Loading
 * re-hashes every file against the manifest, re-derives the version from the
 * manifest and rejects any entry the manifest does not list; any mismatch is
 * a {@link CapabilityIntegrityError}, which callers treat as a load
 * regression (roll back), never as a usable bundle.
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canonicalManifestText,
  componentDir,
  fsyncDirectory,
  MANIFEST_FILE,
  NexgentError,
  type CapabilityComponentKind,
  type CapabilityComponentRef,
  type CapabilityManifest,
} from '@nexgent/kernel'
import { BASELINE_VERSION, checkManifest, EMPTY_MANIFEST, isBundleVersion, sha256 } from './manifest.js'

/** One file to store. */
export interface BundleFileInput {
  /** POSIX path relative to the component directory. */
  readonly path: string
  readonly content: string | Uint8Array
}

/** One component to store. */
export interface BundleComponentInput {
  readonly kind: CapabilityComponentKind
  readonly name: string
  readonly files: readonly BundleFileInput[]
}

/** A verified bundle. */
export interface StoredBundle {
  readonly version: string
  readonly manifest: CapabilityManifest
  /** Absolute bundle directory; `null` for the baseline, which has no files. */
  readonly directory: string | null
}

/** Why a stored bundle cannot be used. */
export type CapabilityIntegrityReason =
  | 'missing'
  | 'manifest'
  | 'version-mismatch'
  | 'file-missing'
  | 'file-mismatch'
  | 'unexpected-entry'

/** A stored bundle that fails verification (`session/corrupt`); never loaded. */
export class CapabilityIntegrityError extends NexgentError {
  readonly version: string
  readonly reason: CapabilityIntegrityReason
  /** Bundle-relative path of the offending entry, when there is one. */
  readonly path: string | undefined

  constructor(version: string, reason: CapabilityIntegrityReason, message: string, path?: string, options?: { cause?: unknown }) {
    super('session/corrupt', `capability bundle ${version}: ${message}`, {
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      details: { version, reason, ...(path === undefined ? {} : { path }) },
    })
    this.name = 'CapabilityIntegrityError'
    this.version = version
    this.reason = reason
    this.path = path
  }
}

/** The empty bundle every project starts from. */
export const BASELINE_BUNDLE: StoredBundle = Object.freeze({
  version: BASELINE_VERSION,
  manifest: EMPTY_MANIFEST,
  directory: null,
})

const STAGING_PREFIX = '.staging-'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content
}

/**
 * Build the normalized manifest for components without touching the disk.
 * @throws `config/invalid` for invalid names, paths or limits.
 */
export function buildManifest(components: readonly BundleComponentInput[]): CapabilityManifest {
  return checkManifest({
    formatVersion: 1,
    components: components.map(component => ({
      kind: component.kind,
      name: component.name,
      files: component.files.map(file => {
        const bytes = toBytes(file.content)
        return { path: file.path, sha256: sha256(bytes), bytes: bytes.byteLength }
      }),
    })),
  })
}

/** Absolute directory of one component inside a bundle, candidate or draft root. */
export function componentPath(root: string, component: CapabilityComponentRef): string {
  return join(root, ...componentDir(component.kind, component.name).split('/'))
}

/** Absolute directory of one component of a stored (non-baseline) bundle. */
export function componentDirectory(bundle: StoredBundle, component: CapabilityComponentRef): string {
  if (bundle.directory === null) throw new NexgentError('internal', 'the baseline bundle has no component directories')
  return componentPath(bundle.directory, component)
}

/** Read every file of one component of a verified bundle, as writer input. */
export async function readComponentFiles(bundle: StoredBundle, component: CapabilityComponentRef): Promise<BundleFileInput[]> {
  const entry = bundle.manifest.components.find(item => item.kind === component.kind && item.name === component.name)
  if (entry === undefined) throw new NexgentError('internal', `bundle ${bundle.version} has no ${componentDir(component.kind, component.name)}`)
  const directory = componentDirectory(bundle, component)
  return Promise.all(entry.files.map(async file => ({ path: file.path, content: await readFile(join(directory, ...file.path.split('/'))) })))
}

async function writeDurably(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

/**
 * Store a bundle once. Writing the same components again, from this or
 * another process, returns the existing version after verifying it.
 * @param capabilitiesDir - `.nexgent/capabilities`.
 * @throws `config/invalid` before anything is written when the input is invalid;
 *   {@link CapabilityIntegrityError} when a bundle with this version exists but is damaged.
 */
export async function writeBundle(capabilitiesDir: string, components: readonly BundleComponentInput[]): Promise<StoredBundle> {
  const manifest = buildManifest(components)
  const serialized = canonicalManifestText(manifest)
  const version = sha256(serialized)
  const destination = join(capabilitiesDir, version)
  if (await exists(destination)) return loadBundle(capabilitiesDir, version)

  await mkdir(capabilitiesDir, { recursive: true })
  const staging = join(capabilitiesDir, `${STAGING_PREFIX}${randomUUID()}`)
  await mkdir(staging)
  try {
    const directories = new Set<string>([staging])
    for (const component of components) {
      for (const file of component.files) {
        const target = join(componentPath(staging, component), ...file.path.split('/'))
        await writeDurably(target, toBytes(file.content))
        directories.add(dirname(target))
      }
    }
    await writeDurably(join(staging, MANIFEST_FILE), Buffer.from(`${serialized}\n`, 'utf8'))
    for (const directory of directories) await fsyncDirectory(directory)
    try {
      await rename(staging, destination)
    } catch (error) {
      // Another writer published the same version first (ENOTEMPTY/EEXIST on
      // POSIX, EPERM/EACCES on Windows): verify theirs instead.
      if (!(await exists(destination))) throw error
      return await loadBundle(capabilitiesDir, version)
    }
    await fsyncDirectory(capabilitiesDir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { version, manifest, directory: destination }
}

async function listEntries(root: string, relative: string, into: string[]): Promise<void> {
  const directory = relative === '' ? root : join(root, ...relative.split('/'))
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) await listEntries(root, path, into)
    else into.push(entry.isFile() ? path : `${path}\u0000`)
  }
}

/**
 * Read and fully verify a bundle. The baseline needs no files and always loads.
 * @param capabilitiesDir - `.nexgent/capabilities`.
 * @throws {@link CapabilityIntegrityError} when the bundle is missing or does not match its version.
 */
export async function loadBundle(capabilitiesDir: string, version: string): Promise<StoredBundle> {
  if (version === BASELINE_VERSION) return BASELINE_BUNDLE
  if (!isBundleVersion(version)) throw new CapabilityIntegrityError(String(version), 'missing', 'not a bundle version')
  const directory = join(capabilitiesDir, version)
  let raw: string
  try {
    const info = await lstat(directory)
    if (!info.isDirectory()) throw new CapabilityIntegrityError(version, 'missing', 'bundle path is not a directory')
    raw = await readFile(join(directory, MANIFEST_FILE), 'utf8')
  } catch (error) {
    if (error instanceof CapabilityIntegrityError) throw error
    const reason = errorCode(error) === 'ENOENT' ? 'missing' : 'manifest'
    throw new CapabilityIntegrityError(version, reason, `cannot read ${MANIFEST_FILE}: ${(error as Error).message}`, MANIFEST_FILE, { cause: error })
  }
  let manifest: CapabilityManifest
  try {
    manifest = checkManifest(JSON.parse(raw))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CapabilityIntegrityError(version, 'manifest', `invalid ${MANIFEST_FILE}: ${detail}`, MANIFEST_FILE, { cause: error })
  }
  if (sha256(canonicalManifestText(manifest)) !== version) {
    throw new CapabilityIntegrityError(version, 'version-mismatch', `${MANIFEST_FILE} does not hash to the bundle version`, MANIFEST_FILE)
  }

  const expected = new Map<string, { sha256: string; bytes: number }>()
  for (const component of manifest.components) {
    const base = componentDir(component.kind, component.name)
    for (const file of component.files) expected.set(`${base}/${file.path}`, file)
  }
  const present: string[] = []
  await listEntries(directory, '', present)
  for (const entry of present) {
    if (entry !== MANIFEST_FILE && !expected.has(entry)) {
      throw new CapabilityIntegrityError(version, 'unexpected-entry', `unlisted entry ${entry.replace('\u0000', '')}`, entry.replace('\u0000', ''))
    }
  }
  for (const [path, file] of expected) {
    let bytes: Buffer
    try {
      bytes = await readFile(join(directory, ...path.split('/')))
    } catch (error) {
      throw new CapabilityIntegrityError(version, 'file-missing', `cannot read ${path}: ${(error as Error).message}`, path, { cause: error })
    }
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new CapabilityIntegrityError(version, 'file-mismatch', `${path} does not match the manifest`, path)
    }
  }
  return { version, manifest, directory }
}

/** Versions of every bundle directory present (unverified), sorted. Staging directories are skipped. */
export async function listBundleVersions(capabilitiesDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(capabilitiesDir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  return names.filter(isBundleVersion).sort()
}
