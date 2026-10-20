/**
 * The material-reference provider (`id: 'materials'`): when a user message
 * attaches materials (`TurnContextInput.materialIds`), it injects one
 * `user.message { source: 'inject' }` that lists each material and inlines
 * small text files. Large and binary materials are given by path only; the
 * model reads them with `read_file` / `read_document`. See
 * `docs/spec/data-formats.md` §材料元数据 ("引用方式").
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  NexgentError,
  resolveDataPath,
  type ContextContribution,
  type ContextProvider,
  type MaterialMetadata,
  type TurnContextInput,
} from '@nexgent/kernel'
import { validateMaterialMetadata } from '@nexgent/session'
import { createHash } from 'node:crypto'
import { fenceFor, formatBytes } from './text.js'

/** Provider id (fixed call order: after `goal` and `skills`). */
export const MATERIALS_PROVIDER_ID = 'materials'

/** Default inline cap per material (32 KiB, `data-formats.md`). */
export const DEFAULT_INLINE_MAX_BYTES = 32 * 1024

/** Default inline cap for all materials of one message together (96 KiB). */
export const DEFAULT_INLINE_TOTAL_MAX_BYTES = 96 * 1024

/** Extensions the `read_document` tool handles. */
const DOCUMENT_EXTENSIONS = ['.docx', '.xlsx', '.pdf']

/** Looks a material up by id; `undefined` when unknown. `dataDir` is the project's data directory (absent: `<projectRoot>/.nexgent`). */
export type MaterialLookup = (id: string, projectRoot: string, dataDir?: string) => Promise<MaterialMetadata | undefined>

/** Options of {@link materialsProvider}. */
export interface MaterialsProviderOptions {
  /** Where metadata comes from; default {@link readMaterialMetadata} (`material.json` on disk). */
  readonly lookup?: MaterialLookup
  /** Inline a text material up to this many bytes. */
  readonly inlineMaxBytes?: number
  /** Inline at most this many bytes over all materials of one message. */
  readonly inlineTotalMaxBytes?: number
}

/** How one attached material is presented. */
export type MaterialReference =
  | { readonly kind: 'inline'; readonly id: string; readonly material: MaterialMetadata; readonly content: string }
  | {
    readonly kind: 'path'
    readonly id: string
    readonly material: MaterialMetadata
    /** Why the content is not inlined. */
    readonly reason: 'binary' | 'too-large' | 'budget' | 'unreadable' | 'changed'
  }
  | { readonly kind: 'missing'; readonly id: string; readonly reason: 'unknown' | 'removed'; readonly material?: MaterialMetadata }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Default {@link MaterialLookup}: read and validate
 * `.nexgent/materials/<id>/material.json`. A missing file is `undefined`; a
 * file that fails the schema or names another id is an error (the provider
 * then fails for this turn and the loop records it).
 */
export async function readMaterialMetadata(id: string, projectRoot: string, dataDir?: string): Promise<MaterialMetadata | undefined> {
  if (!UUID.test(id)) return undefined
  const path = join(dataDir ?? join(projectRoot, '.nexgent'), 'materials', id, 'material.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NexgentError('internal', `cannot read material ${id}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`, { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new NexgentError('session/corrupt', `material ${id}: material.json is not valid JSON`, { cause: error })
  }
  const issues = validateMaterialMetadata(value)
  if (issues.length > 0) {
    throw new NexgentError('session/corrupt', `material ${id}: material.json fails its schema (${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')})`)
  }
  const material = value as MaterialMetadata
  if (material.id !== id) throw new NexgentError('session/corrupt', `material ${id}: material.json names id ${material.id}`)
  return material
}

/**
 * Decide how each attached material is presented, reading the inlined
 * content. A material whose `path` is not inside its own
 * `.nexgent/materials/<id>/` directory is never read.
 */
export async function planMaterialReferences(
  ids: readonly string[],
  projectRoot: string,
  options: MaterialsProviderOptions = {},
  dataDir?: string,
): Promise<MaterialReference[]> {
  const data = { root: projectRoot, dataDir: dataDir ?? join(projectRoot, '.nexgent') }
  // The path the model reads: project-relative while the data is in the project, else absolute (K1).
  const shown = (material: MaterialMetadata): MaterialMetadata => {
    if (dataDir === undefined || resolve(dataDir) === resolve(projectRoot, '.nexgent')) return material
    return { ...material, path: resolveDataPath(data, material.path) }
  }
  const lookup = options.lookup ?? readMaterialMetadata
  const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES
  let budget = options.inlineTotalMaxBytes ?? DEFAULT_INLINE_TOTAL_MAX_BYTES
  const references: MaterialReference[] = []
  for (const id of [...new Set(ids)]) {
    const found = await lookup(id, projectRoot, dataDir)
    const material = found === undefined ? undefined : shown(found)
    if (material === undefined) {
      references.push({ kind: 'missing', id, reason: 'unknown' })
      continue
    }
    if (material.status === 'removed') {
      references.push({ kind: 'missing', id, reason: 'removed', material })
      continue
    }
    if (!material.text) {
      references.push({ kind: 'path', id, material, reason: 'binary' })
      continue
    }
    if (material.size > inlineMax) {
      references.push({ kind: 'path', id, material, reason: 'too-large' })
      continue
    }
    if (material.size > budget) {
      references.push({ kind: 'path', id, material, reason: 'budget' })
      continue
    }
    const prefix = `.nexgent/materials/${material.id}/`
    const recorded = found!.path
    if (!recorded.startsWith(prefix) || recorded.slice(prefix.length).includes('/') || recorded.includes('..')) {
      references.push({ kind: 'path', id, material, reason: 'unreadable' })
      continue
    }
    let buffer: Buffer
    try {
      buffer = await readFile(resolveDataPath(data, recorded))
    } catch {
      references.push({ kind: 'path', id, material, reason: 'unreadable' })
      continue
    }
    if (buffer.byteLength !== material.size || createHash('sha256').update(buffer).digest('hex') !== material.sha256) {
      references.push({ kind: 'path', id, material, reason: 'changed' })
      continue
    }
    budget -= buffer.byteLength
    references.push({ kind: 'inline', id, material, content: buffer.toString('utf8') })
  }
  return references
}

function readHint(material: MaterialMetadata): string {
  const lower = material.path.toLowerCase()
  if (DOCUMENT_EXTENSIONS.some(extension => lower.endsWith(extension))) return 'read it with read_document'
  return material.text ? 'read it with read_file (use offset/limit for large files)' : 'binary file; inspect it with the available tools if needed'
}

const REASON_TEXT: Record<Extract<MaterialReference, { kind: 'path' }>['reason'], string> = {
  binary: 'not inlined (binary)',
  'too-large': 'not inlined (too large)',
  budget: 'not inlined (inline budget for this message used up)',
  unreadable: 'not inlined (could not be read)',
  changed: 'not inlined (the stored copy no longer matches its metadata)',
}

/** Render the inject text for a set of references. Pure. */
export function renderMaterialReferences(references: readonly MaterialReference[]): string {
  const lines = [
    'The user attached these materials. They are read-only copies at the paths below; write results into the project.',
    '',
  ]
  references.forEach((reference, index) => {
    const n = index + 1
    if (reference.kind === 'missing') {
      const name = reference.material === undefined ? reference.id : `${reference.material.originalName} (${reference.id})`
      lines.push(`${n}. ${name}: ${reference.reason === 'removed' ? 'removed by the user; do not use it' : 'not found'}`)
      return
    }
    const { material } = reference
    lines.push(`${n}. ${material.originalName}`)
    lines.push(`   - path: ${material.path}`)
    lines.push(`   - size: ${material.size} bytes (${formatBytes(material.size)}), type: ${material.mediaType}`)
    if (reference.kind === 'inline') {
      lines.push('   - content: inlined below')
    } else {
      lines.push(`   - content: ${REASON_TEXT[reference.reason]}; ${readHint(material)}`)
    }
  })
  for (const reference of references) {
    if (reference.kind !== 'inline') continue
    const fence = fenceFor(reference.content)
    lines.push('', `Content of ${reference.material.path}:`, `${fence}`, reference.content.replace(/\n$/, ''), fence)
  }
  return lines.join('\n')
}

/** The materials {@link ContextProvider}. */
export function materialsProvider(options: MaterialsProviderOptions = {}): ContextProvider {
  for (const [field, value] of [['inlineMaxBytes', options.inlineMaxBytes], ['inlineTotalMaxBytes', options.inlineTotalMaxBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new NexgentError('config/invalid', `materials ${field} must be a non-negative integer, got ${String(value)}`)
    }
  }
  return {
    id: MATERIALS_PROVIDER_ID,
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      if (input.materialIds.length === 0) return {}
      const references = await planMaterialReferences(input.materialIds, input.projectRoot, options, input.dataDir)
      return { inject: [renderMaterialReferences(references)] }
    },
  }
}
