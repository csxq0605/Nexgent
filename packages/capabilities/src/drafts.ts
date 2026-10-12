/**
 * A session's draft area `.nexgent/capabilities/drafts/<sessionId>/`
 * (`data-formats.md` §候选与门控): `<kind-dir>/<name>/` holds the current
 * draft of each component, written only by the host on the model's behalf
 * (`capability_draft`); the model's file tools cannot reach it. A tried
 * revision is frozen under `.tried/<kind-dir>/<name>/<revision>/`, so later
 * edits of the draft do not change what the session already loaded.
 */
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CAPABILITY_DIRS,
  CAPABILITY_LIMITS,
  COMPONENT_ENTRY_FILES,
  componentDir,
  NexgentError,
  writeFileAtomic,
  type CapabilityComponentRef,
  type CapabilityFile,
} from '@nexgent/kernel'
import type { ComponentFiles } from './components.js'
import { checkComponentPath, sha256 } from './manifest.js'
import { componentPath } from './store.js'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TRIED_DIR = '.tried'

/** `.nexgent/capabilities/drafts/<sessionId>`. */
export function draftRoot(capabilitiesDir: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId) || sessionId.includes('..')) throw new NexgentError('internal', `unusable session id for a draft area: ${JSON.stringify(sessionId)}`)
  return join(capabilitiesDir, CAPABILITY_DIRS.drafts, sessionId)
}

/** Absolute directory of a draft component. */
export function draftDirectory(capabilitiesDir: string, sessionId: string, component: CapabilityComponentRef): string {
  return componentPath(draftRoot(capabilitiesDir, sessionId), component)
}

/** Absolute directory of a frozen tried revision. */
export function triedDirectory(capabilitiesDir: string, sessionId: string, component: CapabilityComponentRef, revision: number): string {
  return join(componentPath(join(draftRoot(capabilitiesDir, sessionId), TRIED_DIR), component), String(revision))
}

async function walk(root: string, relative: string, into: Map<string, Uint8Array>): Promise<void> {
  const directory = relative === '' ? root : join(root, ...relative.split('/'))
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return
    throw error
  }
  for (const entry of entries) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) await walk(root, path, into)
    else if (entry.isFile()) into.set(path, await readFile(join(root, ...path.split('/'))))
  }
}

/** Every file of a component directory (empty when it does not exist). */
export async function readComponentDirectory(directory: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  await walk(directory, '', files)
  return files
}

/** The manifest entries of in-memory files, sorted by path. */
export function fileEntries(files: ComponentFiles): CapabilityFile[] {
  return [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.byteLength }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/** A `capability_draft` change. */
export interface DraftChange {
  readonly files?: readonly { readonly path: string; readonly content: string }[]
  readonly remove?: readonly string[]
}

/**
 * Apply a change to a draft component. Everything is checked against the
 * resulting file set before the disk is touched: paths, removals of files
 * that exist, the entry file, per-file and per-component limits.
 * @returns the component's files after the change.
 * @throws `tool/invalid-input` naming the problem; nothing is written then.
 */
export async function applyDraft(capabilitiesDir: string, sessionId: string, component: CapabilityComponentRef, change: DraftChange): Promise<CapabilityFile[]> {
  const where = componentDir(component.kind, component.name)
  const fail = (message: string): never => {
    throw new NexgentError('tool/invalid-input', `${where}: ${message}`)
  }
  const directory = draftDirectory(capabilitiesDir, sessionId, component)
  const next = await readComponentDirectory(directory)
  const writes = change.files ?? []
  const removals = change.remove ?? []
  if (writes.length === 0 && removals.length === 0) fail('give files to write or files to remove')
  for (const path of removals) {
    try {
      checkComponentPath(path)
    } catch (error) {
      fail((error as Error).message)
    }
    if (!next.delete(path)) fail(`cannot remove ${path}: no such draft file`)
  }
  const written = new Set<string>()
  for (const file of writes) {
    try {
      checkComponentPath(file.path)
    } catch (error) {
      fail((error as Error).message)
    }
    if (written.has(file.path)) fail(`${file.path} is given twice`)
    written.add(file.path)
    const bytes = Buffer.from(file.content, 'utf8')
    if (bytes.byteLength > CAPABILITY_LIMITS.maxFileBytes) fail(`${file.path} is ${bytes.byteLength} bytes; the limit is ${CAPABILITY_LIMITS.maxFileBytes}`)
    next.set(file.path, bytes)
  }
  if (next.size > CAPABILITY_LIMITS.maxFilesPerComponent) fail(`more than ${CAPABILITY_LIMITS.maxFilesPerComponent} files`)
  const entry = COMPONENT_ENTRY_FILES[component.kind]
  if (!next.has(entry)) fail(`the entry file ${entry} must exist after the change`)
  const folded = new Map<string, string>()
  for (const path of next.keys()) {
    const clash = folded.get(path.toLowerCase())
    if (clash !== undefined) fail(`"${clash}" and "${path}" collide on a case-insensitive file system`)
    folded.set(path.toLowerCase(), path)
    for (const other of next.keys()) if (other.startsWith(`${path}/`)) fail(`"${path}" would be both a file and a directory`)
  }

  for (const path of removals) await rm(join(directory, ...path.split('/')), { force: true })
  for (const file of writes) {
    const target = join(directory, ...file.path.split('/'))
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isDirectory()) await rm(target, { recursive: true, force: true })
    await writeFileAtomic(target, next.get(file.path)!, { mode: 0o644 })
  }
  return fileEntries(next)
}

/** Copy a draft's current files into a frozen tried revision; returns the files and the directory. */
export async function freezeDraft(capabilitiesDir: string, sessionId: string, component: CapabilityComponentRef, revision: number): Promise<{ readonly files: Map<string, Uint8Array>; readonly directory: string }> {
  const files = await readComponentDirectory(draftDirectory(capabilitiesDir, sessionId, component))
  if (files.size === 0) throw new NexgentError('tool/invalid-input', `no draft of ${componentDir(component.kind, component.name)} in this session; write it with capability_draft first`)
  const directory = triedDirectory(capabilitiesDir, sessionId, component, revision)
  await rm(directory, { recursive: true, force: true })
  for (const [path, bytes] of files) {
    const target = join(directory, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  return { files, directory }
}
