/**
 * `sessions.export`: the minimal export bundle of one session
 * (`step-2-work-partition.md` W4): the session JSONL, the ledger lines of
 * that session, and the metadata of the materials and deliverable versions
 * it touched, plus a manifest. No secret goes in: every file is scanned for
 * the configured key values before it is written, and a hit is replaced by
 * {@link REDACTED}.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  NexgentError,
  type DeliverableSummary,
  type DeliverableVersion,
  type MaterialMetadata,
  type SessionRecord,
} from '@nexgent/kernel'
import type { ExportResult } from './api.js'

/** Replacement written where a secret value was found. */
export const REDACTED = '[REDACTED]'

/** Export bundle format version (`manifest.json`). */
export const EXPORT_FORMAT_VERSION = 1

/** The files of a bundle, in the order they are written. */
export const EXPORT_FILES = ['session.jsonl', 'ledger.jsonl', 'materials.json', 'deliverables.json', 'manifest.json'] as const

/** What {@link writeExportBundle} needs. */
export interface ExportInput {
  readonly sessionId: string
  /** Absolute project root. */
  readonly projectRoot: string
  /** `.nexgent/sessions/<id>/session.jsonl`. */
  readonly sessionFile: string
  /** `.nexgent/ledgers`. */
  readonly ledgersDir: string
  /** Parsed records of the session (to find the materials and deliverables it touched). */
  readonly records: readonly SessionRecord[]
  readonly materials: readonly MaterialMetadata[]
  readonly deliverables: readonly DeliverableSummary[]
  /** Values that must never appear in the bundle (the API keys in force). */
  readonly secrets: readonly string[]
  readonly outDir: string
  readonly appVersion: string
  readonly sdkVersion: number
  readonly now: () => Date
}

/** Replace every occurrence of a secret (and its JSON-escaped form). */
export function redactSecrets(text: string, secrets: readonly string[]): { text: string; hits: number } {
  let hits = 0
  let out = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      const parts = out.split(form)
      hits += parts.length - 1
      out = parts.join(REDACTED)
    }
  }
  return { text: out, hits }
}

async function ledgerLines(dir: string, sessionId: string): Promise<string[]> {
  let months: string[]
  try {
    months = (await readdir(dir)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines: string[] = []
  for (const month of months) {
    let text: string
    try {
      text = await readFile(join(dir, month, 'requests.jsonl'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue
      throw error
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as { sessionId?: unknown }
        if (record.sessionId === sessionId) lines.push(line)
      } catch {
        // a torn last line is not this session's evidence
      }
    }
  }
  return lines
}

async function ensureEmptyDir(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      await mkdir(dir, { recursive: true })
      return
    }
    if (code === 'ENOTDIR') throw new NexgentError('workspace/not-found', `export target is a file: ${dir}`)
    throw error
  }
  if (entries.length > 0) throw new NexgentError('tool/invalid-input', `export target is not empty: ${dir}`, { details: { path: dir } })
}

/** Write the bundle into `outDir` (created; must be missing or empty). */
export async function writeExportBundle(input: ExportInput): Promise<ExportResult> {
  const dir = resolve(input.outDir)
  await ensureEmptyDir(dir)

  const materialIds = new Set<string>()
  const versions = new Set<string>()
  for (const record of input.records) {
    if (record.type === 'material.added') materialIds.add(record.material.id)
    if (record.type === 'user.message') for (const id of record.materials ?? []) materialIds.add(id)
    if (record.type === 'deliverable.presented') versions.add(`${record.deliverable.deliverableId}/${record.deliverable.version}`)
  }
  const materials = input.materials.filter(material => materialIds.has(material.id) || material.sessionId === input.sessionId)
  const deliverables: DeliverableVersion[] = input.deliverables.flatMap(entry => entry.versions)
    .filter(version => version.sessionId === input.sessionId || versions.has(`${version.deliverableId}/${version.version}`))

  const ledger = await ledgerLines(input.ledgersDir, input.sessionId)
  const session = await readFile(input.sessionFile, 'utf8')
  const bodies: Record<(typeof EXPORT_FILES)[number], string> = {
    'session.jsonl': session,
    'ledger.jsonl': ledger.length === 0 ? '' : `${ledger.join('\n')}\n`,
    'materials.json': `${JSON.stringify(materials, null, 2)}\n`,
    'deliverables.json': `${JSON.stringify(deliverables, null, 2)}\n`,
    'manifest.json': '',
  }
  let redactions = 0
  for (const name of EXPORT_FILES) {
    if (name === 'manifest.json') continue
    const { text, hits } = redactSecrets(bodies[name], input.secrets)
    bodies[name] = text
    redactions += hits
  }
  bodies['manifest.json'] = `${JSON.stringify({
    formatVersion: EXPORT_FORMAT_VERSION,
    sessionId: input.sessionId,
    projectName: input.projectRoot.split(/[\\/]/).filter(part => part !== '').at(-1) ?? '',
    exportedAt: input.now().toISOString(),
    appVersion: input.appVersion,
    sdkVersion: input.sdkVersion,
    counts: {
      sessionRecords: input.records.length,
      ledgerRecords: ledger.length,
      materials: materials.length,
      deliverableVersions: deliverables.length,
    },
    redactions,
    files: EXPORT_FILES.filter(name => name !== 'manifest.json'),
  }, null, 2)}\n`
  for (const name of EXPORT_FILES) await writeFile(join(dir, name), bodies[name], { encoding: 'utf8', mode: 0o600 })
  return { path: dir, files: [...EXPORT_FILES] }
}
