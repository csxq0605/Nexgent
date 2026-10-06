/** Immutable saved graph definitions; execution and adoption remain separate. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareArchitecture } from './architecture.ts'

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * Read and verify a saved definition before compiling it with the current engine.
 * @param directory - Application-owned graph storage directory.
 * @param version - Content digest returned by an earlier graph execution.
 * @returns the validated graph and its current compiled script.
 */
export async function loadArchitecture(directory: string, version: string): Promise<ReturnType<typeof prepareArchitecture>> {
  if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('architectureVersion must be a lowercase SHA-256 digest')
  const raw: unknown = JSON.parse(await readFile(join(directory, `${version}.json`), 'utf8'))
  if (raw === null || typeof raw !== 'object' || !('format' in raw) || raw.format !== 1
    || !('architecture' in raw) || Object.keys(raw).some(key => !['format', 'architecture'].includes(key))) {
    throw new Error('invalid saved architecture record')
  }
  const prepared = prepareArchitecture(raw.architecture)
  if (prepared.version !== version) throw new Error('saved architecture digest mismatch')
  return prepared
}

/**
 * Publish a complete definition once; concurrent identical writers share a record.
 * @param directory - Application-owned graph storage directory.
 * @param value - Model-authored JSON graph, validated before any write.
 * @returns the saved graph and compiled script; saving is not approval or adoption.
 */
export async function saveArchitecture(directory: string, value: unknown): Promise<ReturnType<typeof prepareArchitecture>> {
  const prepared = prepareArchitecture(value)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const destination = join(directory, `${prepared.version}.json`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify({ format: 1, architecture: prepared.architecture }) + '\n')
    } finally {
      await file.close()
    }
    try {
      // A hard link publishes the complete file without replacing an existing record.
      await link(temporary, destination)
    } catch (error) {
      if (!alreadyExists(error)) throw error
      await loadArchitecture(directory, prepared.version)
    }
  } finally {
    await unlink(temporary)
  }
  return prepared
}
