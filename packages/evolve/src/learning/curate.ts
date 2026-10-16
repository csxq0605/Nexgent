/**
 * Layer-1 curation (ADR 0018 decision 4): the host's deterministic decision
 * on what of a reflection reaches the handbook. Operations, never a rewrite;
 * every rule holds for any task:
 *
 * - Bounds of the contract (`HANDBOOK_LIMITS`): text 1–600 characters,
 *   keywords lowercased, at most 12 of at most 40 characters (derived from
 *   the text when none are given), reasons cut to 200.
 * - No concrete values of the task (ADR 0013 decision 2,
 *   `findInstanceLiterals` against the task's messages, feedback and
 *   answer; project-level entries may keep a value that is a project
 *   constant, user-level ones may not).
 * - No copied request: an entry sharing a run of
 *   {@link COPIED_REQUEST_CHARS} characters with a user message or a
 *   feedback comment restates what the user asked once.
 * - No duplicate: a new entry whose text is {@link DUPLICATE_SIMILARITY}
 *   similar to a visible entry it does not supersede is dropped.
 * - Supersedes and edits name visible entries of the same log (a
 *   user-level entry never retires another project's entry).
 * - Votes only on the entries given to the task, only with a known outcome,
 *   one per entry per task, never on an entry learned from the same task
 *   (an entry needs evidence from other tasks to be enabled).
 * - Project-level when the reflection says so or the project does not
 *   contribute (`learning.contribute`).
 *
 * What passes goes to `Handbook.apply` (`@nexgent/capabilities`), which
 * checks its own limits, duplicates and values again under the log's lock
 * and appends the status change the counts call for after a vote.
 */
import type { HandbookChange } from '@nexgent/capabilities'
import {
  findInstanceLiterals,
  HANDBOOK_LIMITS,
  type HandbookEntry,
  type HandbookEntryStatus,
  type HandbookOp,
  type HandbookScope,
  type InstanceLiteralSource,
  type ProjectTaskMessage,
  type SelfEvalOutcome,
} from '@nexgent/kernel'
import type { ProposedOp } from './reflect.js'
import { keywordsOf, longestSharedRun, similarity, type LearningLanguage } from './text.js'

/** Shared characters that make an entry a copy of a request. */
export const COPIED_REQUEST_CHARS = 24
/** Text similarity at which a new entry duplicates a visible one. */
export const DUPLICATE_SIMILARITY = 0.6
/** New entries one reflection may add. */
export const MAX_ADDS_PER_REFLECTION = 3
/** Operations one reflection may write. */
export const MAX_OPS_PER_REFLECTION = 10

/** Why an operation was not written. */
export type CurationRejection =
  | 'empty' | 'too-long' | 'instance-literal' | 'copies-request' | 'duplicate' | 'unknown-entry' | 'not-given'
  | 'outcome-unknown' | 'already-voted' | 'own-entry' | 'too-many'

/** What curation knows about the task. */
export interface CurationContext {
  readonly projectId: string
  /** The task reflected on. */
  readonly taskId: string
  readonly outcome: SelfEvalOutcome
  /** `learning.contribute`: whether user-level entries may be written. */
  readonly contribute: boolean
  /** Entries a vote may name. */
  readonly votable: ReadonlySet<string>
  /** Current entries of both logs (all statuses). */
  readonly user: readonly HandbookEntry[]
  readonly project: readonly HandbookEntry[]
  /** The task's own texts: user messages, feedback comments, the final answer. */
  readonly sources: readonly InstanceLiteralSource[]
  /** User messages of the project's tasks (a value in two or more is a project constant). */
  readonly projectMessages: readonly ProjectTaskMessage[]
  /** User messages and feedback comments (copied-request check). */
  readonly requests: readonly string[]
  /** Votes already in the logs from this task, as `entryId`. */
  readonly votedFromTask: ReadonlySet<string>
}

/** What curation decided: the changes to apply, in order, and what it dropped. */
export interface CurationResult {
  readonly changes: HandbookChange[]
  readonly rejected: readonly { readonly op: ProposedOp; readonly reason: CurationRejection; readonly detail?: string }[]
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Lowercased, trimmed, bounded, distinct keywords; derived from `text` when none remain. */
export function normalizeKeywords(keywords: readonly string[], text: string): string[] {
  const out: string[] = []
  for (const raw of keywords) {
    const keyword = raw.toLowerCase().replace(/\s+/g, ' ').trim()
    if (keyword === '' || keyword.length > HANDBOOK_LIMITS.maxKeywordChars || out.includes(keyword)) continue
    out.push(keyword)
    if (out.length === HANDBOOK_LIMITS.maxKeywords) break
  }
  return out.length > 0 ? out : keywordsOf(text, 8, HANDBOOK_LIMITS.maxKeywordChars)
}

/** Decide on a reflection's operations (pure). */
export function curateReflection(proposed: readonly ProposedOp[], ctx: CurationContext): CurationResult {
  const result: { changes: HandbookChange[]; rejected: { op: ProposedOp; reason: CurationRejection; detail?: string }[] } = { changes: [], rejected: [] }
  const byId = new Map<string, HandbookEntry>()
  for (const entry of ctx.project) if (entry.projectId === undefined || entry.projectId === ctx.projectId) byId.set(entry.id, entry)
  for (const entry of ctx.user) byId.set(entry.id, entry)
  const visible = [...byId.values()].filter(entry => entry.status !== 'retired')
  const voted = new Set(ctx.votedFromTask)
  const added: { text: string; scope: HandbookScope }[] = []
  let adds = 0
  let written = 0
  const reject = (op: ProposedOp, reason: CurationRejection, detail?: string) => result.rejected.push({ op, reason, ...(detail === undefined ? {} : { detail }) })
  const push = (change: HandbookChange) => {
    result.changes.push(change)
    written += 1
  }
  const reasonOf = (op: ProposedOp) => (op.reason === undefined || op.reason.trim() === '' ? {} : { reason: clip(op.reason.trim(), HANDBOOK_LIMITS.maxReasonChars) })

  /** The text checks shared by add and edit; a rejection reason or undefined. */
  const checkText = (text: string, scope: HandbookScope): { reason: CurationRejection; detail?: string } | undefined => {
    if (text === '') return { reason: 'empty' }
    if (text.length > HANDBOOK_LIMITS.maxTextChars) return { reason: 'too-long', detail: `${text.length} characters` }
    const hits = findInstanceLiterals([{ path: 'text', text }], ctx.sources, scope === 'project' ? ctx.projectMessages : [])
    if (hits.length > 0) return { reason: 'instance-literal', detail: hits.map(hit => hit.value).join(', ') }
    const copied = ctx.requests.find(request => longestSharedRun(text, request) >= COPIED_REQUEST_CHARS)
    if (copied !== undefined) return { reason: 'copies-request' }
    return undefined
  }

  for (const op of proposed) {
    if (written >= MAX_OPS_PER_REFLECTION) {
      reject(op, 'too-many')
      continue
    }
    if (op.op === 'add') {
      if (adds >= MAX_ADDS_PER_REFLECTION) {
        reject(op, 'too-many')
        continue
      }
      const scope: HandbookScope = op.scope === 'project' || !ctx.contribute ? 'project' : 'user'
      const text = op.text.trim()
      const failed = checkText(text, scope)
      if (failed !== undefined) {
        reject(op, failed.reason, failed.detail)
        continue
      }
      const supersedes = [...new Set(op.supersedes)].filter(id => {
        const old = byId.get(id)
        return old !== undefined && old.status !== 'retired' && old.scope === scope
      })
      const twin = [...visible.filter(entry => !supersedes.includes(entry.id)), ...added].find(entry => similarity(text, entry.text) >= DUPLICATE_SIMILARITY)
      if (twin !== undefined) {
        reject(op, 'duplicate', 'id' in twin ? (twin as HandbookEntry).id : undefined)
        continue
      }
      push({
        op: 'add',
        ...reasonOf(op),
        text,
        keywords: normalizeKeywords(op.keywords, text),
        scope,
        ...(supersedes.length > 0 ? { supersedes } : {}),
      })
      added.push({ text, scope })
      adds += 1
      continue
    }
    const entry = byId.get(op.entryId)
    if (entry === undefined || entry.status === 'retired') {
      reject(op, 'unknown-entry')
      continue
    }
    if (op.op === 'edit') {
      const text = op.text?.trim()
      if (text !== undefined) {
        const failed = checkText(text, entry.scope)
        if (failed !== undefined) {
          reject(op, failed.reason, failed.detail)
          continue
        }
      }
      const keywords = op.keywords === undefined ? undefined : normalizeKeywords(op.keywords, text ?? entry.text)
      push({ op: 'edit', entryId: entry.id, ...reasonOf(op), ...(text === undefined ? {} : { text }), ...(keywords === undefined ? {} : { keywords }) })
      continue
    }
    if (!ctx.votable.has(entry.id)) {
      reject(op, 'not-given')
      continue
    }
    if (ctx.outcome === 'unknown') {
      reject(op, 'outcome-unknown')
      continue
    }
    if (entry.sources.some(source => source.taskId === ctx.taskId)) {
      reject(op, 'own-entry')
      continue
    }
    if (voted.has(entry.id)) {
      reject(op, 'already-voted')
      continue
    }
    voted.add(entry.id)
    push({ op: op.op, entryId: entry.id, ...reasonOf(op) })
  }
  return result
}

/** Entry ids already voted on from `taskId` in a log. */
export function votesFromTask(ops: readonly HandbookOp[], taskId: string): Set<string> {
  const ids = new Set<string>()
  for (const op of ops) if ((op.op === 'upvote' || op.op === 'downvote') && op.source?.taskId === taskId) ids.add(op.entryId)
  return ids
}

/** The reason of the status change a vote leads to, in the user's language (`Handbook.apply`'s `statusReason`). */
export function statusReason(status: HandbookEntryStatus, entry: Pick<HandbookEntry, 'helpful' | 'harmful'>, language: LearningLanguage): string {
  const zh = language.toLowerCase().startsWith('zh')
  if (status === 'active') return zh ? `有用 ${entry.helpful} 票、有害 ${entry.harmful} 票，转为启用` : `${entry.helpful} helpful and ${entry.harmful} harmful votes: enabled`
  if (status === 'retired') return zh ? `有害 ${entry.harmful} 票、有用 ${entry.helpful} 票，下线` : `${entry.harmful} harmful and ${entry.helpful} helpful votes: retired`
  return zh ? '回到试用' : 'back to trial'
}
