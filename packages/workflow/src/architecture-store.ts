// Adapted from deepseek-harness@46a7f68b packages/workflow/tool-workflow (MIT), via Nexgent PR #4 runtime/packages/workflow/tool-workflow/src/architecture-store.ts (refactor/dsh-application fd0b2f42)
/**
 * Content-addressed storage of workflow graphs (`data-formats.md`
 * §架构图存储): `.nexgent/architectures/<sha256>.json` holding
 * `{ "format": 1, "architecture": { "nodes": [...] } }`. A file is written
 * once and never changed: the complete content goes to a temporary file
 * first and is published under its final name with a hard link, which fails
 * instead of replacing an existing file; when the name already exists the
 * existing file is read back and its hash checked. Saving a graph is not
 * adopting it (step 4).
 */
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { NexgentError, type ArchitectureFile } from '@nexgent/kernel'
import { prepareArchitecture, type PreparedArchitecture } from './architecture.js'

const VERSION = /^[a-f0-9]{64}$/

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

/**
 * Read and verify a saved graph, and compile it with the current compiler.
 * @throws `tool/invalid-input` for a malformed version, `session/corrupt` for a file that does not hold that graph.
 */
export async function loadArchitecture(directory: string, version: string): Promise<PreparedArchitecture> {
  if (!VERSION.test(version)) throw new NexgentError('tool/invalid-input', 'an architecture version is a lowercase SHA-256 hex digest')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(directory, `${version}.json`), 'utf8'))
  } catch (error) {
    throw new NexgentError('session/corrupt', `cannot read saved architecture ${version}: ${(error as Error).message}`, { cause: error })
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as Partial<ArchitectureFile>).format !== 1 || !('architecture' in raw)
    || Object.keys(raw).some(key => key !== 'format' && key !== 'architecture')) {
    throw new NexgentError('session/corrupt', `saved architecture ${version} is not a format 1 record`)
  }
  let prepared: PreparedArchitecture
  try {
    prepared = prepareArchitecture((raw as ArchitectureFile).architecture)
  } catch (error) {
    throw new NexgentError('session/corrupt', `saved architecture ${version} is invalid: ${(error as Error).message}`, { cause: error })
  }
  if (prepared.version !== version) throw new NexgentError('session/corrupt', `saved architecture ${version} hashes to ${prepared.version}`)
  return prepared
}

/**
 * Validate a model-written graph, then publish it once; concurrent writers
 * of the same graph share one file.
 * @throws `tool/invalid-input` before anything is written when the graph is invalid.
 */
export async function saveArchitecture(directory: string, value: unknown): Promise<PreparedArchitecture> {
  const prepared = prepareArchitecture(value)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const destination = join(directory, `${prepared.version}.json`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      const record: ArchitectureFile = { format: 1, architecture: prepared.architecture }
      await file.writeFile(`${JSON.stringify(record)}\n`)
    } finally {
      await file.close()
    }
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!alreadyExists(error)) throw error
      await loadArchitecture(directory, prepared.version)
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return prepared
}
