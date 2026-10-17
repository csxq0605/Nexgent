/**
 * ADR 0018 decision 4: layer 1, the experience handbook. An entry is one
 * reusable practice with counts; it changes only through small operations
 * appended to a log (add, edit, upvote, downvote, status), never by a model
 * rewriting the whole handbook. The current handbook is the fold of the log,
 * so rolling back to any moment is folding a prefix.
 *
 * Pure: shapes, the fold and the status rule. `@nexgent/capabilities` stores
 * and retrieves (V1); `@nexgent/evolve` proposes operations (E1).
 *
 * Normative text: `docs/spec/data-formats.md` §经验手册.
 */
import type { JsonSchema } from './json.js'
import type { Step2ToolSpec } from './step2-tools.js'

/** Where an entry applies: every project of the user, or one project. */
export type HandbookScope = 'user' | 'project'

/** Every {@link HandbookScope}. */
export const HANDBOOK_SCOPES: readonly HandbookScope[] = ['user', 'project']

/** An entry's life: tried on new tasks, enabled, or retired. */
export type HandbookEntryStatus = 'trial' | 'active' | 'retired'

/** Every {@link HandbookEntryStatus}. */
export const HANDBOOK_ENTRY_STATUSES: readonly HandbookEntryStatus[] = ['trial', 'active', 'retired']

/** Who appended an operation. */
export type HandbookActor = 'reflection' | 'execution' | 'user' | 'host' | 'migration'

/** Every {@link HandbookActor}. */
export const HANDBOOK_ACTORS: readonly HandbookActor[] = ['reflection', 'execution', 'user', 'host', 'migration']

/** The task an entry or a vote came from. */
export interface HandbookSource {
  readonly projectId?: string
  readonly taskId: string
  readonly sessionId?: string
}

/** One entry, as the fold of its operations. */
export interface HandbookEntry {
  /** Lowercase uuid v4. */
  readonly id: string
  /** The practice, in the user's interface language (ADR 0018 decision 11); at most {@link HANDBOOK_LIMITS.maxTextChars} characters. */
  readonly text: string
  /** Where it applies: lowercase keywords of task descriptions (≤ {@link HANDBOOK_LIMITS.maxKeywords}); retrieval also reads `text`. */
  readonly keywords: readonly string[]
  readonly scope: HandbookScope
  /** `project` scope: the project it belongs to. */
  readonly projectId?: string
  readonly status: HandbookEntryStatus
  /** Helpful votes. Since ADR 0023 they mean “used”, not evidence that it helps. */
  readonly helpful: number
  /** Harmful votes. Since ADR 0023 they mean “said it misled”. */
  readonly harmful: number
  /** Tasks it was learned from, oldest first. */
  readonly sources: readonly HandbookSource[]
  /** Entries this one replaces (they are retired when it is added). */
  readonly supersedes: readonly string[]
  /** The entry that replaced this one. */
  readonly supersededBy?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Bounds the writer enforces. */
export const HANDBOOK_LIMITS = {
  maxTextChars: 600,
  maxKeywords: 12,
  maxKeywordChars: 40,
  maxReasonChars: 200,
} as const

/** Entries retrieved for a task (ADR 0018 decision 4: top k, default 5). */
export const HANDBOOK_TOP_K = 5

/** Helpful votes that move a trial entry to active (with fewer harmful ones). */
export const HANDBOOK_ACTIVATE_HELPFUL = 2
/** How far harmful votes must exceed helpful ones to retire an entry. */
export const HANDBOOK_RETIRE_MARGIN = 2

/** Fields every operation carries. */
interface HandbookOpBase {
  readonly formatVersion: 1
  /** Position in its log, from 1, without gaps. */
  readonly seq: number
  /** ISO-8601 UTC. */
  readonly at: string
  readonly entryId: string
  readonly actor: HandbookActor
  /** The task the operation came from, when any. */
  readonly source?: HandbookSource
  /** Why, in the user's language; at most {@link HANDBOOK_LIMITS.maxReasonChars} characters. */
  readonly reason?: string
}

/** A new entry (always starts as `trial`, except migrated context policies, which start `active`). */
export interface HandbookAddOp extends HandbookOpBase {
  readonly op: 'add'
  readonly text: string
  readonly keywords: readonly string[]
  readonly scope: HandbookScope
  readonly projectId?: string
  readonly status?: 'trial' | 'active'
  readonly supersedes?: readonly string[]
}

/** A wording or keyword change; counts and status stay. */
export interface HandbookEditOp extends HandbookOpBase {
  readonly op: 'edit'
  readonly text?: string
  readonly keywords?: readonly string[]
}

/** One helpful vote. */
export interface HandbookUpvoteOp extends HandbookOpBase {
  readonly op: 'upvote'
}

/** One harmful vote. */
export interface HandbookDownvoteOp extends HandbookOpBase {
  readonly op: 'downvote'
}

/** A status change the host derives ({@link nextHandbookStatus}) or the user makes. */
export interface HandbookStatusOp extends HandbookOpBase {
  readonly op: 'status'
  readonly status: HandbookEntryStatus
}

/**
 * One line of `<NEXGENT_HOME>/handbook/ops.jsonl` (user scope) or
 * `<projectdata>/handbook/ops.jsonl` (project scope).
 */
export type HandbookOp = HandbookAddOp | HandbookEditOp | HandbookUpvoteOp | HandbookDownvoteOp | HandbookStatusOp

/** The `op` vocabulary. */
export type HandbookOpKind = HandbookOp['op']

/** Every {@link HandbookOpKind}. */
export const HANDBOOK_OP_KINDS: readonly HandbookOpKind[] = ['add', 'edit', 'upvote', 'downvote', 'status']

/**
 * ADR 0018 decision 4 (pure): the status an entry's counts call for. A trial
 * entry becomes active after {@link HANDBOOK_ACTIVATE_HELPFUL} helpful votes
 * with fewer harmful ones; any entry is retired once harmful votes exceed
 * helpful ones by {@link HANDBOOK_RETIRE_MARGIN}, or once superseded. A
 * retired entry stays retired (only the user brings it back).
 *
 * Superseded by ADR 0023: votes come from the executing model and no longer
 * enable an entry; the host moves to {@link handbookStatusFromEvidence}
 * (`handbook-evidence.ts`). Kept so existing logs and callers still work
 * until that is implemented.
 */
export function nextHandbookStatus(entry: Pick<HandbookEntry, 'status' | 'helpful' | 'harmful' | 'supersededBy'>): HandbookEntryStatus {
  if (entry.status === 'retired' || entry.supersededBy !== undefined) return 'retired'
  if (entry.harmful - entry.helpful >= HANDBOOK_RETIRE_MARGIN) return 'retired'
  if (entry.status === 'trial' && entry.helpful >= HANDBOOK_ACTIVATE_HELPFUL && entry.harmful < entry.helpful) return 'active'
  return entry.status
}

/**
 * Fold a log into entries (pure), in first-added order. Operations on an
 * unknown entry are ignored; `untilSeq` folds only the prefix (rollback to
 * that moment). Votes do not change status by themselves: the host appends
 * the `status` operation {@link nextHandbookStatus} calls for, so the log
 * records why each change happened.
 */
export function foldHandbook(ops: readonly HandbookOp[], untilSeq = Number.POSITIVE_INFINITY): HandbookEntry[] {
  const entries = new Map<string, HandbookEntry>()
  for (const op of ops) {
    if (op.seq > untilSeq) break
    const current = entries.get(op.entryId)
    if (op.op === 'add') {
      if (current !== undefined) continue
      entries.set(op.entryId, {
        id: op.entryId,
        text: op.text,
        keywords: op.keywords,
        scope: op.scope,
        ...(op.projectId === undefined ? {} : { projectId: op.projectId }),
        status: op.status ?? 'trial',
        helpful: 0,
        harmful: 0,
        sources: op.source === undefined ? [] : [op.source],
        supersedes: op.supersedes ?? [],
        createdAt: op.at,
        updatedAt: op.at,
      })
      for (const replaced of op.supersedes ?? []) {
        const old = entries.get(replaced)
        if (old !== undefined) entries.set(replaced, { ...old, supersededBy: op.entryId, status: 'retired', updatedAt: op.at })
      }
      continue
    }
    if (current === undefined) continue
    switch (op.op) {
      case 'edit':
        entries.set(op.entryId, { ...current, ...(op.text === undefined ? {} : { text: op.text }), ...(op.keywords === undefined ? {} : { keywords: op.keywords }), updatedAt: op.at })
        break
      case 'upvote':
        entries.set(op.entryId, { ...current, helpful: current.helpful + 1, updatedAt: op.at })
        break
      case 'downvote':
        entries.set(op.entryId, { ...current, harmful: current.harmful + 1, updatedAt: op.at })
        break
      case 'status':
        entries.set(op.entryId, { ...current, status: op.status, updatedAt: op.at })
        break
    }
  }
  return [...entries.values()]
}

/** Entries a task may be given: active and trial ones (retired never). */
export function isRetrievable(entry: Pick<HandbookEntry, 'status'>): boolean {
  return entry.status !== 'retired'
}

/**
 * `handbook_mark`: the executing model says an injected entry helped or led
 * it astray (one vote per entry per task; the host ignores repeats). Since
 * ADR 0023 the vote is recorded as “used” / “said it misled”, not as
 * evidence that the entry is useful.
 * Bookkeeping only: it changes no file of the workspace.
 */
export const HANDBOOK_MARK_TOOL: Step2ToolSpec = {
  name: 'handbook_mark',
  effects: ['read'],
  approval: 'never',
  concurrent: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['entryId', 'verdict'],
    properties: {
      entryId: { type: 'string', minLength: 1, description: 'Id of an entry shown at the start of this task.' } satisfies JsonSchema,
      verdict: { enum: ['helpful', 'harmful'] },
      reason: { type: 'string', maxLength: HANDBOOK_LIMITS.maxReasonChars },
    },
  },
}
