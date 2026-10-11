/**
 * `MaterialStore` over `.nexgent/materials/`. Normative text:
 * `docs/spec/data-formats.md` §材料元数据.
 */
import { readdir, readFile, rm, stat, mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  MATERIAL_METADATA_FILE,
  NexgentError,
  toMaterialRef,
  type AddMaterialInput,
  type HostRecordInput,
  type MaterialMetadata,
  type MaterialStore,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { formatIssues, validateMaterialMetadata } from '@nexgent/session'
import {
  copyWithHash,
  guessMediaType,
  isKnownBinaryType,
  isNotFound,
  isTaskingId,
  newId,
  removeTempEntries,
  renameWithRetry,
  storedNameFor,
  syncDir,
  TEMP_PREFIX,
  writeJsonAtomic,
  writeJsonFile,
} from './files-util.js'

/** Options of {@link LocalMaterialStore}. */
export interface LocalMaterialStoreOptions {
  /** Clock for `addedAt` / `removedAt` (tests pin it). */
  readonly now?: () => Date
}

/** Materials of one project, stored under `layout.materials`. */
export class LocalMaterialStore implements MaterialStore {
  private readonly now: () => Date

  constructor(private readonly layout: WorkspaceLayout, options: LocalMaterialStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /** Remove `.tmp-*` leftovers of an interrupted `add`; called once at startup. */
  async cleanup(): Promise<number> {
    return removeTempEntries(this.layout.materials)
  }

  async add(input: AddMaterialInput): Promise<MaterialMetadata> {
    const source = nodePath.resolve(input.sourcePath)
    let info
    try {
      info = await stat(source)
    } catch (error) {
      if (isNotFound(error)) throw new NexgentError('workspace/not-found', `material source does not exist: ${source}`, { details: { path: source } })
      throw error
    }
    if (!info.isFile()) {
      throw new NexgentError('workspace/not-found', `material source is not a file: ${source}`, { details: { path: source } })
    }
    const id = newId()
    const originalName = nodePath.basename(source)
    const storedName = storedNameFor(originalName)
    const mediaType = guessMediaType(originalName)
    await mkdir(this.layout.materials, { recursive: true })
    const temp = nodePath.join(this.layout.materials, `${TEMP_PREFIX}${newId()}`)
    try {
      const copy = await copyWithHash(source, nodePath.join(temp, storedName))
      const metadata: MaterialMetadata = {
        formatVersion: 1,
        id,
        originalName: originalName === '' ? storedName : originalName,
        path: `.nexgent/materials/${id}/${storedName}`,
        size: copy.size,
        sha256: copy.sha256,
        mediaType,
        text: copy.utf8 && !isKnownBinaryType(mediaType),
        addedAt: this.now().toISOString(),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        status: 'active',
      }
      assertValid(metadata)
      await writeJsonFile(nodePath.join(temp, MATERIAL_METADATA_FILE), metadata)
      await syncDir(temp)
      await renameWithRetry(temp, nodePath.join(this.layout.materials, id))
      await syncDir(this.layout.materials)
      return metadata
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      throw error
    }
  }

  async list(options: { readonly includeRemoved?: boolean } = {}): Promise<readonly MaterialMetadata[]> {
    let entries: string[]
    try {
      entries = await readdir(this.layout.materials)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const found: MaterialMetadata[] = []
    for (const entry of entries) {
      if (entry.startsWith(TEMP_PREFIX) || !isTaskingId(entry)) continue
      const material = await this.read(entry)
      if (material === undefined) continue
      if (material.status === 'removed' && options.includeRemoved !== true) continue
      found.push(material)
    }
    return found.sort((a, b) => (a.addedAt === b.addedAt ? a.id.localeCompare(b.id) : a.addedAt < b.addedAt ? -1 : 1))
  }

  async get(id: string): Promise<MaterialMetadata | undefined> {
    if (!isTaskingId(id)) return undefined
    return this.read(id)
  }

  async remove(id: string): Promise<MaterialMetadata> {
    const material = await this.get(id)
    if (material === undefined) throw new NexgentError('workspace/not-found', `no material with id ${id}`, { details: { id } })
    if (material.status === 'removed') return material
    const removed: MaterialMetadata = { ...material, status: 'removed', removedAt: this.now().toISOString() }
    assertValid(removed)
    await writeJsonAtomic(nodePath.join(this.layout.materials, id, MATERIAL_METADATA_FILE), removed)
    return removed
  }

  /** Absolute path of a material's stored copy. */
  absolutePath(material: MaterialMetadata): string {
    return nodePath.join(this.layout.root, ...material.path.split('/'))
  }

  /** Read and validate one `material.json`; `undefined` when missing or invalid (an invalid file is never listed). */
  private async read(id: string): Promise<MaterialMetadata | undefined> {
    let raw: string
    try {
      raw = await readFile(nodePath.join(this.layout.materials, id, MATERIAL_METADATA_FILE), 'utf8')
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (validateMaterialMetadata(parsed).length > 0) return undefined
    const material = parsed as MaterialMetadata
    return material.id === id ? material : undefined
  }
}

function assertValid(metadata: MaterialMetadata): void {
  const issues = validateMaterialMetadata(metadata)
  if (issues.length > 0) throw new NexgentError('session/invalid-record', `invalid material metadata: ${formatIssues(issues)}`)
}

/** The `material.added` host record for a material (the SDK appends it through the agent's sink). Pure. */
export function materialAddedRecord(material: MaterialMetadata): HostRecordInput {
  return { type: 'material.added', material: toMaterialRef(material) }
}
