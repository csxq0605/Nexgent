/**
 * The inputs of the instance-literal check (ADR 0013 decision 2,
 * `data-formats.md` §候选与门控 具体数值检查) as the gate gathers them
 * before it replays an improvement job's candidate. The rule itself is the
 * kernel's pure `findInstanceLiterals`; this file only reads the texts:
 *
 * - the component texts: every text file of the candidate's proposed
 *   components, by component-relative path, read from the candidate
 *   directory;
 * - the sources (the job's own task): the job's feedback text (each feedback
 *   signal's comment, the explicit request's note) and the text files of
 *   every version of the deliverables of the job's sessions (the feedback
 *   task) and of the deliverables the feedback names;
 * - the project messages: the user messages of every root task session, the
 *   session standing for its task (one root session is one task).
 *
 * Binary files and files above {@link LITERAL_TEXT_LIMIT} bytes are not read.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  findInstanceLiterals,
  type CandidateRecord,
  type ImprovementJob,
  type InstanceLiteralHit,
  type InstanceLiteralSource,
  type InstanceLiteralText,
  type ProjectTaskMessage,
  type SessionRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { LocalDeliverableStore } from '@nexgent/tasking'
import { CANDIDATES_DIR } from '../candidates.js'
import { componentPath } from '../store.js'
import { readImprovementJob } from './feedback.js'

/** Largest file the check reads (bytes); larger ones are left out. */
export const LITERAL_TEXT_LIMIT = 2 * 1024 * 1024

async function readText(path: string): Promise<string | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return undefined
  }
  if (bytes.byteLength > LITERAL_TEXT_LIMIT) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Every text file of a candidate's proposed components (component-relative paths). */
export async function candidateComponentTexts(capabilitiesDir: string, candidate: CandidateRecord): Promise<InstanceLiteralText[]> {
  const root = join(capabilitiesDir, CANDIDATES_DIR, candidate.id)
  const texts: InstanceLiteralText[] = []
  for (const component of candidate.components) {
    for (const file of component.files) {
      const text = await readText(join(componentPath(root, component), ...file.path.split('/')))
      if (text !== undefined) texts.push({ path: file.path, text })
    }
  }
  return texts
}

class SessionReader {
  readonly #store: JsonlSessionStore
  readonly #cache = new Map<string, readonly SessionRecord[]>()
  constructor(layout: WorkspaceLayout) {
    this.#store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  }
  async records(sessionId: string): Promise<readonly SessionRecord[]> {
    const cached = this.#cache.get(sessionId)
    if (cached !== undefined) return cached
    let records: readonly SessionRecord[]
    try {
      records = (await this.#store.readAll(sessionId)).records
    } catch {
      records = []
    }
    this.#cache.set(sessionId, records)
    return records
  }
}

/** The job's own task as sources: its feedback text and its feedback task's deliverables (every version). */
export async function jobLiteralSources(layout: WorkspaceLayout, job: ImprovementJob): Promise<InstanceLiteralSource[]> {
  return sourcesOf(layout, job, new SessionReader(layout))
}

async function sourcesOf(layout: WorkspaceLayout, job: ImprovementJob, sessions: SessionReader): Promise<InstanceLiteralSource[]> {
  const sources: InstanceLiteralSource[] = []
  const sessionIds = new Set<string>()
  const deliverableIds = new Set<string>()
  for (const item of job.items) {
    sessionIds.add(item.sessionId)
    if (item.kind !== 'feedback') continue
    deliverableIds.add(item.deliverableId)
    const record = (await sessions.records(item.sessionId)).find(entry => entry.type === 'feedback' && entry.feedback.id === item.feedbackId)
    if (record?.type === 'feedback') sources.push({ kind: 'feedback', ref: `feedback:${item.feedbackId}`, text: record.feedback.comment })
  }
  if (job.request?.sessionId !== undefined) sessionIds.add(job.request.sessionId)
  if (job.request?.deliverableId !== undefined) deliverableIds.add(job.request.deliverableId)
  if (job.request?.note !== undefined) sources.push({ kind: 'feedback', ref: 'request:note', text: job.request.note })

  const deliverables = new LocalDeliverableStore(layout)
  for (const summary of await deliverables.list().catch(() => [])) {
    if (!deliverableIds.has(summary.deliverableId) && !summary.versions.some(version => sessionIds.has(version.sessionId))) continue
    for (const version of summary.versions) {
      for (const file of version.files) {
        const text = await readText(deliverables.snapshotPath(summary.deliverableId, version.version, file.path))
        if (text !== undefined) sources.push({ kind: 'deliverable', ref: `deliverable:${summary.deliverableId}/v${version.version}/${file.path}`, text })
      }
    }
  }
  return sources
}

/** The user messages of every root task session of the project (the session id stands for its task). */
export async function projectTaskMessages(layout: WorkspaceLayout): Promise<ProjectTaskMessage[]> {
  return messagesOf(layout, new SessionReader(layout))
}

async function messagesOf(layout: WorkspaceLayout, sessions: SessionReader): Promise<ProjectTaskMessage[]> {
  let ids: string[]
  try {
    ids = (await readdir(layout.sessions, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
  const messages: ProjectTaskMessage[] = []
  for (const id of ids) {
    const records = await sessions.records(id)
    const start = records[0]
    if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.purpose === 'improvement') continue
    for (const record of records) {
      if (record.type === 'user.message' && record.source === 'user') messages.push({ taskId: id, text: record.content })
    }
  }
  return messages
}

/**
 * ADR 0013 decision 2 for one candidate: the hits of its components against
 * its job's task, or `undefined` when the candidate is not an improvement
 * job's (or its job cannot be read), which the check does not apply to.
 */
export async function candidateInstanceLiterals(layout: WorkspaceLayout, candidate: CandidateRecord): Promise<InstanceLiteralHit[] | undefined> {
  if (candidate.origin !== 'improvement' || candidate.jobId === undefined) return undefined
  const job = await readImprovementJob(layout, candidate.jobId)
  if (job === undefined) return undefined
  const sessions = new SessionReader(layout)
  return findInstanceLiterals(await candidateComponentTexts(layout.capabilities, candidate), await sourcesOf(layout, job, sessions), await messagesOf(layout, sessions))
}
