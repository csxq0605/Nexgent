/**
 * The host side of the instance-literal check (ADR 0013 decision 2,
 * `data-formats.md` §候选与门控 具体数值检查): gather the texts the pure
 * `findInstanceLiterals` compares.
 *
 * - Component texts: every file of a proposed component that decodes as
 *   UTF-8 text, by component-relative path (`SKILL.md`, `functions.json`, …).
 * - The task's sources: an improvement job's feedback text (its feedback
 *   entries, and an explicit request's note) and the text files of every
 *   deliverable version presented in the sessions the job answers.
 * - Project history: the user messages of the project's root task sessions,
 *   one task per session (feedback turns and improvement sessions excluded),
 *   so a value two tasks were given counts as a project constant.
 *
 * Used by `capability_propose` in a propose session and, through the same
 * functions, before a gate replays (`src/trial/`).
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  componentDir,
  findInstanceLiterals,
  IMPROVEMENT_FILES,
  IMPROVEMENTS_DIR,
  type CapabilityComponentKind,
  type ImprovementJob,
  type InstanceLiteralHit,
  type InstanceLiteralSource,
  type InstanceLiteralText,
  type ProjectTaskMessage,
  type SessionRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'

/** Larger files are not read as sources or component texts. */
export const MAX_LITERAL_TEXT_BYTES = 2 * 1024 * 1024

const decoder = new TextDecoder('utf-8', { fatal: true })

/** The text of a file, or `undefined` when it is binary or too large. */
function textOf(bytes: Uint8Array | string): string | undefined {
  if (typeof bytes === 'string') return bytes
  if (bytes.byteLength > MAX_LITERAL_TEXT_BYTES) return undefined
  try {
    const text = decoder.decode(bytes)
    return text.includes('\u0000') ? undefined : text
  } catch {
    return undefined
  }
}

/** The text files of a component, by component-relative path. */
export function componentLiteralTexts(files: ReadonlyMap<string, Uint8Array | string>): InstanceLiteralText[] {
  const texts: InstanceLiteralText[] = []
  for (const [path, bytes] of [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const text = textOf(bytes)
    if (text !== undefined) texts.push({ path, text })
  }
  return texts
}

async function sessionRecords(layout: WorkspaceLayout, sessionId: string): Promise<readonly SessionRecord[]> {
  try {
    return (await new JsonlSessionStore({ sessionsDir: layout.sessions }).readAll(sessionId)).records
  } catch {
    return []
  }
}

async function readJob(layout: WorkspaceLayout, jobId: string): Promise<ImprovementJob | undefined> {
  try {
    return JSON.parse(await readFile(join(layout.dataDir, IMPROVEMENTS_DIR, jobId, IMPROVEMENT_FILES.job), 'utf8')) as ImprovementJob
  } catch {
    return undefined
  }
}

/**
 * The sources of an improvement job: its feedback text and the text files of
 * every deliverable version presented in the sessions it answers.
 * @returns `undefined` when the job cannot be read.
 */
export async function jobLiteralSources(layout: WorkspaceLayout, jobId: string, options: { readonly projectId?: string } = {}): Promise<InstanceLiteralSource[] | undefined> {
  const job = await readJob(layout, jobId)
  if (job === undefined) return undefined
  const project = options.projectId === undefined ? {} : { projectId: options.projectId }
  const sources: InstanceLiteralSource[] = []
  const feedbackIds = new Set<string>()
  const sessions: string[] = []
  const addSession = (sessionId: string | undefined) => {
    if (sessionId !== undefined && !sessions.includes(sessionId)) sessions.push(sessionId)
  }
  for (const item of job.items) {
    if (item.kind === 'feedback') feedbackIds.add(item.feedbackId)
    addSession(item.sessionId)
  }
  addSession(job.request?.sessionId)
  if (job.request?.note !== undefined && job.request.note !== '') sources.push({ kind: 'feedback', ref: `request:${job.id}`, text: job.request.note, ...project })
  const seenVersions = new Set<string>()
  for (const sessionId of sessions) {
    for (const record of await sessionRecords(layout, sessionId)) {
      if (record.type === 'feedback' && feedbackIds.has(record.feedback.id)) {
        sources.push({ kind: 'feedback', ref: `feedback:${record.feedback.id}`, text: record.feedback.comment, ...project })
      } else if (record.type === 'deliverable.presented') {
        const { deliverableId, version, files } = record.deliverable
        const key = `${deliverableId}/v${version}`
        if (seenVersions.has(key)) continue
        seenVersions.add(key)
        for (const file of files) {
          if (file.size > MAX_LITERAL_TEXT_BYTES) continue
          let bytes: Uint8Array
          try {
            bytes = await readFile(join(layout.outputs, deliverableId, `v${version}`, 'files', ...file.path.split('/')))
          } catch {
            continue
          }
          const text = textOf(bytes)
          if (text !== undefined) sources.push({ kind: 'deliverable', ref: `deliverable:${key}/${file.path}`, text, ...project })
        }
      }
    }
  }
  return sources
}

/**
 * The user messages of the project's root task sessions, one task per
 * session; improvement sessions, member sessions and feedback turns are left out.
 */
export async function projectTaskMessages(layout: WorkspaceLayout, options: { readonly projectId?: string } = {}): Promise<ProjectTaskMessage[]> {
  let names: string[]
  try {
    names = await readdir(layout.sessions)
  } catch {
    return []
  }
  const messages: ProjectTaskMessage[] = []
  for (const sessionId of names.sort()) {
    const records = await sessionRecords(layout, sessionId)
    const start = records[0]
    if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.purpose === 'improvement') continue
    for (const record of records) {
      if (record.type === 'user.message' && record.source === 'user') {
        messages.push({ taskId: sessionId, text: record.content, ...(options.projectId === undefined ? {} : { projectId: options.projectId }) })
      }
    }
  }
  return messages
}

/** A proposed component's files, for {@link checkJobLiterals}. */
export interface LiteralCheckComponent {
  readonly kind: CapabilityComponentKind
  readonly name: string
  readonly files: ReadonlyMap<string, Uint8Array | string>
}

/**
 * The instance-literal hits of components proposed for an improvement job,
 * each `path` prefixed with the component directory (`skills/<name>/SKILL.md`).
 * Empty when nothing hits or the job cannot be read (there is nothing to compare).
 */
export async function checkJobLiterals(layout: WorkspaceLayout, jobId: string, components: readonly LiteralCheckComponent[]): Promise<InstanceLiteralHit[]> {
  const sources = await jobLiteralSources(layout, jobId)
  if (sources === undefined || sources.length === 0) return []
  const texts = components.flatMap(component => componentLiteralTexts(component.files).map(text => ({ path: `${componentDir(component.kind, component.name)}/${text.path}`, text: text.text })))
  return findInstanceLiterals(texts, sources, await projectTaskMessages(layout))
}

/** One line per hit for a tool result: the value, where it is and which source has it; no advice on what to write instead. */
export function instanceLiteralText(hits: readonly InstanceLiteralHit[]): string {
  return hits.map(hit => `${hit.value} (${hit.kind}) in ${hit.path}, from ${hit.source}`).join('; ')
}
