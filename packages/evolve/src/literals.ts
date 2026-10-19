/**
 * What the instance-literal check of an improver change compares against
 * (ADR 0012 decision 5, ADR 0013 decision 2, `findInstanceLiterals`): the
 * feedback text of the meta job's batch and the deliverable versions that
 * feedback was about (the task's concrete values), and the user messages of
 * every task of the batch's projects (a value in two or more tasks of one
 * project is that project's constant, not a task's).
 *
 * Only text is read: a deliverable file larger than {@link MAX_FILE_BYTES}
 * or with a NUL byte near its start is skipped.
 */
import { open, readdir } from 'node:fs/promises'
import type { InstanceLiteralSource, ProjectTaskMessage } from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { LocalDeliverableStore, SessionFeedbackStore } from '@nexgent/tasking'
import type { MetaProject, ProjectJob } from './user.js'

/** Largest deliverable file read as a source. */
export const MAX_FILE_BYTES = 1_048_576

/** The texts {@link findInstanceLiterals} needs besides the change. */
export interface LiteralEvidence {
  readonly sources: readonly InstanceLiteralSource[]
  readonly messages: readonly ProjectTaskMessage[]
}

/** A file's text, or `undefined` when it is too large, binary or unreadable. */
async function textOf(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size > MAX_FILE_BYTES) return undefined
    const bytes = Buffer.alloc(size)
    await handle.read(bytes, 0, size, 0)
    if (bytes.subarray(0, 8192).includes(0)) return undefined
    return bytes.toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** The feedback text and the deliverable files of one job's feedback signals. */
async function jobSources({ project, job }: ProjectJob): Promise<InstanceLiteralSource[]> {
  const items = job.items.flatMap(item => (item.kind === 'feedback' ? [item] : []))
  if (items.length === 0) return []
  const layout = project.layout
  const feedback = new SessionFeedbackStore(layout, new JsonlSessionStore({ sessionsDir: layout.sessions }))
  const deliverables = new LocalDeliverableStore(layout)
  const sources: InstanceLiteralSource[] = []
  for (const item of items) {
    const entry = (await feedback.list({ sessionId: item.sessionId }).catch(() => [])).find(listing => listing.id === item.feedbackId)
    if (entry !== undefined && entry.comment.trim() !== '') sources.push({ kind: 'feedback', ref: `feedback:${entry.id}`, text: entry.comment, projectId: project.projectId })
    if (item.version === undefined) continue
    const version = await deliverables.get(item.deliverableId, item.version).catch(() => undefined)
    for (const file of version?.files ?? []) {
      const text = await textOf(deliverables.snapshotPath(item.deliverableId, item.version, file.path))
      if (text !== undefined) sources.push({ kind: 'deliverable', ref: `deliverable:${item.deliverableId}/v${item.version}/${file.path}`, text, projectId: project.projectId })
    }
  }
  return sources
}

/** The user's own messages of every task session of a project (improvement sessions excluded), keyed by session. */
async function projectMessages(project: MetaProject): Promise<ProjectTaskMessage[]> {
  let names: string[]
  try {
    names = await readdir(project.layout.sessions)
  } catch {
    return []
  }
  const store = new JsonlSessionStore({ sessionsDir: project.layout.sessions })
  const messages: ProjectTaskMessage[] = []
  for (const name of names) {
    const records = (await store.readAll(name).catch(() => undefined))?.records
    if (records === undefined) continue
    const start = records[0]
    if (start?.type === 'session.start' && start.purpose === 'improvement') continue
    for (const record of records) {
      if (record.type === 'user.message' && record.source === 'user') messages.push({ taskId: name, text: record.content, projectId: project.projectId })
    }
  }
  return messages
}

/** The evidence of a batch: its jobs' feedback and deliverables, and its projects' task messages. */
export async function literalEvidence(jobs: readonly ProjectJob[], projects: readonly MetaProject[]): Promise<LiteralEvidence> {
  const sources: InstanceLiteralSource[] = []
  for (const job of jobs) sources.push(...(await jobSources(job)))
  const messages: ProjectTaskMessage[] = []
  for (const project of projects) messages.push(...(await projectMessages(project)))
  return { sources, messages }
}
