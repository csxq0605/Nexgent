/**
 * A project's view of the experience handbook (ADR 0018 decisions 4, 8;
 * `data-formats.md` §经验手册): the user-level log shared by every project
 * of the user and this project's own log, combined by the project's
 * `learning` switches.
 *
 * - `useShared` off: user-level entries are neither retrieved nor listed
 *   here (they stay in the user log for other projects).
 * - `contribute` off: an entry a writer adds at user level is kept at
 *   project level instead.
 *
 * Writers (`@nexgent/evolve` reflection, the `handbook_mark` tool, the user,
 * migration) change entries only through {@link Handbook.apply}: one small
 * operation each, checked (limits, duplicates, concrete values of the task)
 * and appended under the log's lock, never a rewrite. Votes are followed by
 * the `status` operation `nextHandbookStatus` calls for, except that a
 * trial entry is not enabled while the self-scorer is not reliable
 * (ADR 0018 risks, ADR 0019 decision 6: below the agreement line, or too
 * few calibrations to tell, the votes it drives stay counted but the entry
 * stays on trial). A task votes on an
 * entry at most once and never on an entry learned from it (checked under
 * the lock, so concurrent writers cannot both vote).
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  findInstanceLiterals,
  foldHandbook,
  HANDBOOK_LIMITS,
  HANDBOOK_TOP_K,
  isProjectId,
  isRetrievable,
  nexgentHome,
  nextHandbookStatus,
  NEXGENT_DIR,
  NexgentError,
  PROJECT_IDENTITY_FILE,
  readProjectConfig,
  resolveLearningConfig,
  resolveProjectDataLayout,
  resolveUserDataLayout,
  type HandbookActor,
  type HandbookEntry,
  type HandbookEntryStatus,
  type HandbookOp,
  type HandbookScope,
  type HandbookSource,
  type InstanceLiteralHit,
  type InstanceLiteralSource,
  type LearningConfig,
  type ProjectTaskMessage,
} from '@nexgent/kernel'
import { HandbookLog, normalizeKeywords, type HandbookOpInput } from './log.js'
import { HandbookIndex, type ScoredEntry } from './retrieval.js'
import { jaccard, termSet } from './tokens.js'
import { handbookUsage, HandbookUsageLog, idleReason, type HandbookEntryUsage, type HandbookUsageInput } from './usage.js'
import { scorerReliabilityOf } from '../learning/evaluations.js'

/** Term-set similarity at or above which a new entry is a duplicate of a retrievable one. */
export const HANDBOOK_DUPLICATE_SIMILARITY = 0.8

/**
 * A project's id (`data-formats.md` §用户数据目录): `.nexgent/project.json`'s
 * `projectId` when the file is there, else the SHA-256 of the root's
 * realpath as ADR 0012 derives it (what the file is created with).
 */
export async function handbookProjectId(root: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  try {
    const identity = JSON.parse(await readFile(join(root, NEXGENT_DIR, PROJECT_IDENTITY_FILE), 'utf8')) as { projectId?: unknown }
    if (isProjectId(identity.projectId)) return identity.projectId
  } catch {
    // No identity file yet.
  }
  let path = await realpath(root).catch(() => resolve(root))
  path = path.replace(/\\/g, '/')
  if (platform === 'win32') path = path.toLowerCase()
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/** The project's `learning` settings (defaults when the config is missing or unreadable). */
export async function projectLearning(root: string): Promise<LearningConfig> {
  try {
    const { input } = await readProjectConfig(join(root, NEXGENT_DIR, 'config.json'))
    return resolveLearningConfig(input.learning, {
      ...(input.autoImprove === undefined ? {} : { autoImprove: input.autoImprove }),
      ...(input.improvement?.shareImproverEvidence === undefined ? {} : { shareImproverEvidence: input.improvement.shareImproverEvidence }),
    })
  } catch {
    return resolveLearningConfig()
  }
}

/** Options of {@link Handbook.open}. */
export interface HandbookOpenOptions {
  readonly projectRoot: string
  /** Nexgent home; default `NEXGENT_HOME` or `~/.nexgent`. */
  readonly home?: string
  /** Default {@link handbookProjectId}. */
  readonly projectId?: string
  /** Default: read from the project's config. */
  readonly learning?: Pick<LearningConfig, 'useShared' | 'contribute'>
  readonly now?: () => Date
}

/** One change a writer asks for. */
export type HandbookChange =
  | {
      readonly op: 'add'
      readonly text: string
      readonly keywords: readonly string[]
      /** Default `user` (kept at project level when the project does not contribute). */
      readonly scope?: HandbookScope
      readonly status?: 'trial' | 'active'
      readonly supersedes?: readonly string[]
      /** Default a new uuid. */
      readonly entryId?: string
      readonly reason?: string
      readonly source?: HandbookSource
    }
  | { readonly op: 'edit'; readonly entryId: string; readonly text?: string; readonly keywords?: readonly string[]; readonly reason?: string; readonly source?: HandbookSource }
  | { readonly op: 'upvote' | 'downvote'; readonly entryId: string; readonly reason?: string; readonly source?: HandbookSource }
  | { readonly op: 'status'; readonly entryId: string; readonly status: HandbookEntryStatus; readonly reason?: string; readonly source?: HandbookSource }

/** What {@link Handbook.apply} did with one change. */
export type HandbookChangeResult =
  | { readonly outcome: 'applied'; readonly entryId: string; readonly scope: HandbookScope; readonly ops: readonly HandbookOp[] }
  | { readonly outcome: 'duplicate'; readonly entryId: string; readonly duplicateOf: string }
  | { readonly outcome: 'rejected'; readonly entryId?: string; readonly reason: 'not-found' | 'instance-literal' | 'invalid' | 'superseded-shared' | 'already-voted' | 'own-source'; readonly detail: string; readonly hits?: readonly InstanceLiteralHit[] }

/** Context of {@link Handbook.apply}. */
export interface HandbookApplyContext {
  readonly actor: HandbookActor
  /** The task the changes come from (each change may override it). */
  readonly source?: HandbookSource
  /**
   * ADR 0013 decision 2: an added or edited text must not carry a concrete
   * value of these sources unless the project's tasks give it twice.
   */
  readonly literals?: { readonly sources: readonly InstanceLiteralSource[]; readonly projectMessages: readonly ProjectTaskMessage[] }
  /** The `reason` of the `status` operation a vote leads to, in the user's language; default the vote counts. */
  readonly statusReason?: (status: HandbookEntryStatus, entry: HandbookEntry) => string
  /**
   * Whether a vote may enable a trial entry; default: the self-scorer's
   * agreement over the user's projects is `reliable` ({@link scorerReliabilityOf}).
   */
  readonly activate?: boolean
}

/** An entry and the log it lives in. */
export interface LocatedEntry {
  readonly entry: HandbookEntry
  readonly scope: HandbookScope
}

const indexCache = new Map<string, HandbookIndex>()

function trimReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const chars = [...reason]
  return chars.length > HANDBOOK_LIMITS.maxReasonChars ? chars.slice(0, HANDBOOK_LIMITS.maxReasonChars).join('') : reason
}

/** A project's view of the handbook. */
export class Handbook {
  readonly projectId: string
  readonly learning: Pick<LearningConfig, 'useShared' | 'contribute'>
  readonly user: HandbookLog
  readonly project: HandbookLog
  /** `usage.jsonl` next to each log. */
  readonly userUsage: HandbookUsageLog
  readonly projectUsage: HandbookUsageLog
  readonly #home: string
  readonly #now: () => Date

  private constructor(home: string, projectId: string, learning: Pick<LearningConfig, 'useShared' | 'contribute'>, user: HandbookLog, project: HandbookLog, now: () => Date) {
    this.#home = home
    this.#now = now
    this.projectId = projectId
    this.learning = learning
    this.user = user
    this.project = project
    this.userUsage = new HandbookUsageLog(user.directory, { now })
    this.projectUsage = new HandbookUsageLog(project.directory, { now })
  }

  /** Open the handbook a project sees. */
  static async open(options: HandbookOpenOptions): Promise<Handbook> {
    const home = resolve(options.home ?? nexgentHome())
    const projectId = options.projectId ?? (await handbookProjectId(options.projectRoot))
    const learning = options.learning ?? (await projectLearning(options.projectRoot))
    const now = options.now === undefined ? {} : { now: options.now }
    return new Handbook(
      home,
      projectId,
      { useShared: learning.useShared, contribute: learning.contribute },
      new HandbookLog(resolveUserDataLayout(home).handbook, now),
      new HandbookLog(resolveProjectDataLayout(home, projectId).handbook, now),
      options.now ?? (() => new Date()),
    )
  }

  logOf(scope: HandbookScope): HandbookLog {
    return scope === 'user' ? this.user : this.project
  }

  usageLogOf(scope: HandbookScope): HandbookUsageLog {
    return scope === 'user' ? this.userUsage : this.projectUsage
  }

  /** Every entry of the logs this project reads, project entries first. */
  async #located(untilSeq?: { readonly user?: number; readonly project?: number }): Promise<LocatedEntry[]> {
    const own = (await this.project.entries(untilSeq?.project)).filter(entry => entry.projectId === this.projectId).map(entry => ({ entry, scope: 'project' as const }))
    if (!this.learning.useShared) return own
    const shared = (await this.user.entries(untilSeq?.user)).filter(entry => entry.scope === 'user').map(entry => ({ entry, scope: 'user' as const }))
    return [...own, ...shared]
  }

  /** The entries this project sees; retired ones only with `includeRetired`; `scope` narrows. */
  async entries(options: { readonly scope?: HandbookScope; readonly includeRetired?: boolean } = {}): Promise<HandbookEntry[]> {
    return (await this.#located())
      .filter(located => (options.scope === undefined || located.scope === options.scope) && (options.includeRetired === true || isRetrievable(located.entry)))
      .map(located => located.entry)
  }

  /** One entry this project sees, with its log; `undefined` when unknown or not visible. */
  async find(entryId: string): Promise<LocatedEntry | undefined> {
    return (await this.#located()).find(located => located.entry.id === entryId)
  }

  /** Every operation on an entry, oldest first. @throws `handbook/not-found`. */
  async ops(entryId: string): Promise<{ readonly entry: HandbookEntry; readonly ops: readonly HandbookOp[] }> {
    const located = await this.find(entryId)
    if (located === undefined) throw new NexgentError('handbook/not-found', `no handbook entry ${entryId} in this project`, { details: { entryId } })
    return { entry: located.entry, ops: (await this.logOf(located.scope).read()).filter(op => op.entryId === entryId) }
  }

  /** The top `k` retrievable entries for a task description (BM25), best first. */
  async retrieve(text: string, options: { readonly k?: number; readonly exclude?: Iterable<string>; readonly usage?: ReadonlyMap<string, HandbookEntryUsage> } = {}): Promise<ScoredEntry[]> {
    const [userOps, projectOps] = await Promise.all([this.learning.useShared ? this.user.read() : Promise.resolve([]), this.project.read()])
    const key = `${this.user.file}\u0000${userOps.at(-1)?.seq ?? 0}\u0000${userOps.length}\u0000${this.project.file}\u0000${projectOps.at(-1)?.seq ?? 0}\u0000${projectOps.length}\u0000${this.projectId}\u0000${this.learning.useShared}`
    let index = indexCache.get(key)
    if (index === undefined) {
      const entries = [
        ...foldHandbook(projectOps).filter(entry => entry.projectId === this.projectId),
        ...foldHandbook(userOps).filter(entry => entry.scope === 'user'),
      ].filter(isRetrievable)
      index = new HandbookIndex(entries)
      if (indexCache.size >= 16) indexCache.delete(indexCache.keys().next().value!)
      indexCache.set(key, index)
    }
    return index.search(text, options.k ?? HANDBOOK_TOP_K, new Set(options.exclude ?? []), options.usage)
  }

  /** How each entry this project sees (retired ones too) has been used. */
  async usage(): Promise<Map<string, HandbookEntryUsage>> {
    const out = new Map<string, HandbookEntryUsage>()
    for (const scope of this.learning.useShared ? (['project', 'user'] as const) : (['project'] as const)) {
      const [ops, records] = await Promise.all([this.logOf(scope).read(), this.usageLogOf(scope).read()])
      const entries = (await this.#located()).filter(located => located.scope === scope).map(located => located.entry)
      for (const [id, usage] of handbookUsage(entries, ops, records)) out.set(id, usage)
    }
    return out
  }

  /**
   * Note a root turn that asked the handbook and what retrieval found for
   * it (`given`: the ids put in front of the model). The turn counts in
   * every log this project reads; a hit in its entry's log.
   */
  async recordTurn(input: { readonly sessionId: string; readonly found: readonly string[]; readonly given: readonly string[] }): Promise<void> {
    const located = await this.#located()
    const scopes: HandbookScope[] = this.learning.useShared ? ['project', 'user'] : ['project']
    await Promise.all(scopes.map(scope => {
      const lines: HandbookUsageInput[] = [{ kind: 'turn', projectId: this.projectId, sessionId: input.sessionId }]
      for (const entryId of input.found) {
        if (located.find(candidate => candidate.entry.id === entryId)?.scope !== scope) continue
        lines.push({ kind: 'hit', projectId: this.projectId, sessionId: input.sessionId, entryId, given: input.given.includes(entryId) })
      }
      return this.usageLogOf(scope).append(lines)
    }))
  }

  /**
   * Retire the entries nobody uses ({@link idleReason}): a `status`
   * operation by the host per entry, decided under the log's lock. The user
   * brings one back with {@link Handbook.restore}.
   */
  async retireIdle(): Promise<HandbookOp[]> {
    const written: HandbookOp[] = []
    const now = this.#now()
    for (const scope of this.learning.useShared ? (['project', 'user'] as const) : (['project'] as const)) {
      const records = await this.usageLogOf(scope).read()
      const idle = (current: readonly HandbookOp[]): HandbookOpInput[] => {
        const entries = foldHandbook(current).filter(entry => entry.status !== 'retired' && (scope === 'user' ? entry.scope === 'user' : entry.projectId === this.projectId))
        const usage = handbookUsage(entries, current, records)
        return entries.flatMap(entry => {
          const reason = idleReason(entry, usage.get(entry.id)!, now)
          return reason === undefined ? [] : [{ op: 'status' as const, entryId: entry.id, actor: 'host' as const, status: 'retired' as const, reason: trimReason(reason)! }]
        })
      }
      // Most turns retire nothing: look first, take the lock only when there is something to write.
      if (idle(await this.logOf(scope).read()).length === 0) continue
      written.push(...await this.logOf(scope).append(idle))
    }
    return written
  }

  /**
   * The user brings a retired entry back, to the status it had before it was
   * retired (trial when it never had another). Its idle time starts again.
   * A superseded entry stays retired: the one that replaced it is the one to
   * bring back or edit.
   */
  async restore(entryId: string, options: { readonly reason?: string } = {}): Promise<HandbookChangeResult> {
    const located = await this.find(entryId)
    if (located === undefined) return { outcome: 'rejected', entryId, reason: 'not-found', detail: `no handbook entry ${entryId} in this project` }
    if (located.entry.supersededBy !== undefined) return { outcome: 'rejected', entryId, reason: 'invalid', detail: `entry ${entryId} was replaced by ${located.entry.supersededBy}` }
    if (located.entry.status !== 'retired') return { outcome: 'applied', entryId, scope: located.scope, ops: [] }
    const ops = (await this.logOf(located.scope).read()).filter(op => op.entryId === entryId)
    let before: HandbookEntryStatus = 'trial'
    let status: HandbookEntryStatus = 'trial'
    for (const op of ops) {
      const next: HandbookEntryStatus = op.op === 'add' ? op.status ?? 'trial' : op.op === 'status' ? op.status : status
      if (next === 'retired' && status !== 'retired') before = status
      status = next
    }
    return (await this.apply([{ op: 'status', entryId, status: before, reason: options.reason ?? 'brought back by the user' }], { actor: 'user' }))[0]!
  }

  /**
   * Apply changes in order. Each is checked against the handbook as it is
   * when its log is locked; a rejected or duplicate change writes nothing
   * and the others go on.
   */
  async apply(changes: readonly HandbookChange[], context: HandbookApplyContext): Promise<HandbookChangeResult[]> {
    const results: HandbookChangeResult[] = []
    for (const change of changes) {
      try {
        results.push(await this.#applyOne(change, context))
      } catch (error) {
        if (error instanceof NexgentError && error.code === 'tool/invalid-input') {
          results.push({ outcome: 'rejected', ...('entryId' in change && change.entryId !== undefined ? { entryId: change.entryId } : {}), reason: 'invalid', detail: error.message })
        } else {
          throw error
        }
      }
    }
    return results
  }

  /** A user-level entry is read by every project, so a constant of this project is no exemption there. */
  #literalHits(text: string, context: HandbookApplyContext, scope: HandbookScope): InstanceLiteralHit[] {
    if (context.literals === undefined) return []
    return findInstanceLiterals([{ path: 'text', text }], context.literals.sources, scope === 'project' ? context.literals.projectMessages : [])
  }

  async #applyOne(change: HandbookChange, context: HandbookApplyContext): Promise<HandbookChangeResult> {
    const source = change.source ?? context.source
    const common = { actor: context.actor, ...(source === undefined ? {} : { source }), ...(change.reason === undefined ? {} : { reason: trimReason(change.reason)! }) }
    if (change.op === 'add') {
      const entryId = change.entryId ?? randomUUID()
      const scope: HandbookScope = (change.scope ?? 'user') === 'user' && this.learning.contribute ? 'user' : 'project'
      const keywords = normalizeKeywords(change.keywords)
      const hits = this.#literalHits(change.text, context, scope)
      if (hits.length > 0) return { outcome: 'rejected', entryId, reason: 'instance-literal', detail: `carries values of the task: ${[...new Set(hits.map(hit => hit.value))].join(', ')}`, hits }
      const visible = await this.#located()
      const supersedes = [...new Set(change.supersedes ?? [])]
      for (const id of supersedes) {
        const old = visible.find(located => located.entry.id === id)
        if (old === undefined) return { outcome: 'rejected', entryId, reason: 'not-found', detail: `supersedes unknown entry ${id}` }
        if (scope === 'project' && old.scope === 'user') return { outcome: 'rejected', entryId, reason: 'superseded-shared', detail: `a project entry cannot replace the shared entry ${id}` }
      }
      const terms = termSet(`${change.text} ${keywords.join(' ')}`)
      const duplicate = visible.find(located => isRetrievable(located.entry) && !supersedes.includes(located.entry.id) && jaccard(terms, termSet(`${located.entry.text} ${located.entry.keywords.join(' ')}`)) >= HANDBOOK_DUPLICATE_SIMILARITY)
      if (duplicate !== undefined) return { outcome: 'duplicate', entryId, duplicateOf: duplicate.entry.id }
      const add: HandbookOpInput = {
        op: 'add',
        entryId,
        ...common,
        text: change.text,
        keywords,
        scope,
        ...(scope === 'project' ? { projectId: this.projectId } : {}),
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(supersedes.length === 0 ? {} : { supersedes }),
      }
      const written = await this.logOf(scope).append(() => [add])
      // Replaced entries in the other log are retired there (the fold retires those in the same log).
      const elsewhere = supersedes.filter(id => visible.find(located => located.entry.id === id)?.scope !== scope)
      if (elsewhere.length > 0) {
        written.push(...await this.logOf(scope === 'user' ? 'project' : 'user').append(() => elsewhere.map(id => ({ op: 'status', entryId: id, status: 'retired', actor: 'host', ...(source === undefined ? {} : { source }), reason: trimReason(`superseded by ${entryId}`)! }))))
      }
      return { outcome: 'applied', entryId, scope, ops: written }
    }
    const located = await this.find(change.entryId)
    if (located === undefined) return { outcome: 'rejected', entryId: change.entryId, reason: 'not-found', detail: `no handbook entry ${change.entryId} in this project` }
    if (change.op === 'edit' && change.text !== undefined) {
      const hits = this.#literalHits(change.text, context, located.scope)
      if (hits.length > 0) return { outcome: 'rejected', entryId: change.entryId, reason: 'instance-literal', detail: `carries values of the task: ${[...new Set(hits.map(hit => hit.value))].join(', ')}`, hits }
    }
    const log = this.logOf(located.scope)
    const activate = change.op === 'upvote' ? context.activate ?? (await scorerReliabilityOf({ home: this.#home }).catch(() => undefined))?.status === 'reliable' : true
    let refused: HandbookChangeResult | undefined
    const written = await log.append(current => {
      const entry = foldHandbook(current).find(candidate => candidate.id === change.entryId)
      if (entry === undefined) return []
      if ((change.op === 'upvote' || change.op === 'downvote') && source !== undefined) {
        // One vote per entry per task, whoever casts it; a task does not vote on what it taught.
        if (entry.sources.some(from => from.taskId === source.taskId)) {
          refused = { outcome: 'rejected', entryId: entry.id, reason: 'own-source', detail: `entry ${entry.id} was learned from task ${source.taskId}` }
          return []
        }
        if (current.some(op => op.entryId === entry.id && (op.op === 'upvote' || op.op === 'downvote') && op.source?.taskId === source.taskId)) {
          refused = { outcome: 'rejected', entryId: entry.id, reason: 'already-voted', detail: `task ${source.taskId} already voted on entry ${entry.id}` }
          return []
        }
      }
      switch (change.op) {
        case 'edit':
          return [{ op: 'edit', entryId: entry.id, ...common, ...(change.text === undefined ? {} : { text: change.text }), ...(change.keywords === undefined ? {} : { keywords: normalizeKeywords(change.keywords) }) }]
        case 'status':
          return entry.status === change.status ? [] : [{ op: 'status', entryId: entry.id, ...common, status: change.status }]
        case 'upvote':
        case 'downvote': {
          const voted = change.op === 'upvote' ? { ...entry, helpful: entry.helpful + 1 } : { ...entry, harmful: entry.harmful + 1 }
          const next = nextHandbookStatus(voted)
          const vote: HandbookOpInput = { op: change.op, entryId: entry.id, ...common }
          if (next === entry.status || (next === 'active' && !activate)) return [vote]
          const why = context.statusReason?.(next, voted) ?? `${voted.helpful} helpful / ${voted.harmful} harmful`
          return [vote, { op: 'status', entryId: entry.id, actor: 'host', ...(source === undefined ? {} : { source }), status: next, reason: trimReason(why)! }]
        }
      }
    })
    if (refused !== undefined) return refused
    return { outcome: 'applied', entryId: change.entryId, scope: located.scope, ops: written }
  }

  /**
   * Bring one log back to how it was after `toSeq` by appending the
   * operations that undo what came later: entries added since are retired,
   * text, keywords and status get their old values back. Vote counts are not
   * taken back (there is no operation for it); the restored status holds.
   */
  async rollback(scope: HandbookScope, toSeq: number, options: { readonly reason?: string } = {}): Promise<HandbookOp[]> {
    return this.logOf(scope).append(current => {
      const then = new Map(foldHandbook(current, toSeq).map(entry => [entry.id, entry]))
      const ops: HandbookOpInput[] = []
      const reason = trimReason(options.reason ?? `rolled back to #${toSeq}`)!
      for (const entry of foldHandbook(current)) {
        const old = then.get(entry.id)
        if (old === undefined) {
          if (entry.status !== 'retired') ops.push({ op: 'status', entryId: entry.id, actor: 'user', status: 'retired', reason })
          continue
        }
        const textChanged = old.text !== entry.text
        const keywordsChanged = JSON.stringify(old.keywords) !== JSON.stringify(entry.keywords)
        if (textChanged || keywordsChanged) ops.push({ op: 'edit', entryId: entry.id, actor: 'user', ...(textChanged ? { text: old.text } : {}), ...(keywordsChanged ? { keywords: old.keywords } : {}), reason })
        if (old.status !== entry.status) ops.push({ op: 'status', entryId: entry.id, actor: 'user', status: old.status, reason })
      }
      return ops
    })
  }
}
