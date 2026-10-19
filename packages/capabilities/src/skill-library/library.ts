/**
 * The learned skill library (ADR 0025, `data-formats.md` §技能库) in the
 * user's Nexgent home: `log.jsonl` (add / status operations, appended under
 * `log.lock`), the versioned `SKILL.md` files, `usage.jsonl` (ADR 0023
 * draws and outcomes, the handbook's {@link HandbookUsageLog}) and
 * `rejected.jsonl` (refused candidates).
 *
 * Status changes follow the handbook's randomized exposure rule
 * (`handbookStatusFromEvidence`): a skill version is drawn for root tasks
 * whose text it matches, and only outcomes from the user, deterministic
 * checks and the external review count.
 */
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  foldSkillLibrary,
  handbookExposureEvidence,
  handbookStatusFromEvidence,
  isLearnedSkillInForce,
  LEARNED_SKILL_NAME_PATTERN,
  LEARNED_SKILL_STATUSES,
  learnedSkillId,
  learnedSkillPath,
  NexgentError,
  renderLearnedSkill,
  resolveUserDataLayout,
  SKILL_LIBRARY_ACTORS,
  SKILL_LIBRARY_LIMITS,
  SKILL_LIBRARY_LOG_FILE,
  SKILL_LIBRARY_REJECTED_FILE,
  type HandbookDraw,
  type HandbookEntry,
  type HandbookExposureEvidence,
  type HandbookOutcomeEvidence,
  type HandbookSource,
  type LearnedSkill,
  type LearnedSkillStatus,
  type SkillLibraryActor,
  type SkillLibraryOp,
  type SkillRejection,
} from '@nexgent/kernel'
import { retryTransient } from '../fs-retry.js'
import { HandbookIndex } from '../handbook/retrieval.js'
import { HandbookUsageLog } from '../handbook/usage.js'

/** The append lock of the library. */
export const SKILL_LIBRARY_LOCK_FILE = 'log.lock'

type WithoutStamp<T> = T extends unknown ? Omit<T, 'formatVersion' | 'seq' | 'at'> : never

/** An operation as a writer gives it. */
export type SkillLibraryOpInput = WithoutStamp<SkillLibraryOp>

/** A new version as induction (or the user) gives it. */
export interface NewLearnedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly body: string
  readonly replaces?: string
  readonly sources: readonly HandbookSource[]
  readonly actor?: SkillLibraryActor
  readonly reason?: string
}

/** One drawn or found skill of a root turn. */
export interface SkillTurnHit {
  readonly skillId: string
  readonly given: boolean
  readonly status: 'trial' | 'active'
  readonly draw?: HandbookDraw
  readonly showProbability?: number
}

/** A ranked skill. */
export interface ScoredSkill {
  readonly skill: LearnedSkill
  readonly score: number
}

function invalid(message: string): never {
  throw new NexgentError('tool/invalid-input', `skill library: ${message}`)
}

function chars(text: string): number {
  return [...text].length
}

/** Validate an operation before it is written. @throws `tool/invalid-input`. */
export function checkSkillLibraryOp(op: SkillLibraryOpInput): void {
  if (!SKILL_LIBRARY_ACTORS.includes(op.actor)) invalid(`unknown actor ${JSON.stringify(op.actor)}`)
  if (op.reason !== undefined && chars(op.reason) > SKILL_LIBRARY_LIMITS.maxReasonChars) invalid(`reason is longer than ${SKILL_LIBRARY_LIMITS.maxReasonChars} characters`)
  if (op.op === 'add') {
    if (!LEARNED_SKILL_NAME_PATTERN.test(op.name) || op.name.length > SKILL_LIBRARY_LIMITS.maxNameChars) invalid(`name ${JSON.stringify(op.name)} must be kebab-case, at most ${SKILL_LIBRARY_LIMITS.maxNameChars} characters`)
    if (!Number.isSafeInteger(op.version) || op.version < 1) invalid('version must be a positive integer')
    if (op.skillId !== learnedSkillId(op.name, op.version)) invalid('skillId must be <name>@v<version>')
    if (op.description.trim() === '' || chars(op.description) > SKILL_LIBRARY_LIMITS.maxDescriptionChars) invalid(`description must be 1–${SKILL_LIBRARY_LIMITS.maxDescriptionChars} characters`)
    if (op.whenToUse !== undefined && (op.whenToUse.trim() === '' || chars(op.whenToUse) > SKILL_LIBRARY_LIMITS.maxWhenToUseChars)) invalid(`when_to_use must be 1–${SKILL_LIBRARY_LIMITS.maxWhenToUseChars} characters`)
    if (op.sources.length === 0) invalid('a skill names the tasks it was learned from')
  } else if (op.op === 'status') {
    if (!LEARNED_SKILL_STATUSES.includes(op.status)) invalid(`unknown status ${JSON.stringify(op.status)}`)
  } else {
    invalid(`unknown operation ${JSON.stringify((op as { op?: unknown }).op)}`)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const LOCK_DELAYS_MS = [5, 10, 20, 40, 80, 160, 250, 250, 250, 250, 500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000]

/** The pseudo handbook entry the BM25 index ranks a skill as: its description and when-to-use, its name as a keyword. */
function indexEntry(skill: LearnedSkill): HandbookEntry {
  return {
    id: skill.id,
    text: [skill.description, skill.whenToUse ?? ''].join(' '),
    keywords: [skill.name.replace(/-/g, ' ')],
    scope: 'user',
    status: skill.status,
    helpful: 0,
    harmful: 0,
    sources: skill.sources,
    supersedes: [],
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

function evidenceReason(status: LearnedSkillStatus, evidence: HandbookExposureEvidence): string {
  const mean = (value: number | undefined): string => (value === undefined ? '-' : value.toFixed(2))
  const arms = `shown ${evidence.shown} (mean ${mean(evidence.shownMean)}), held back ${evidence.heldBack} (mean ${mean(evidence.heldBackMean)})`
  if (status === 'active') return `enabled: ${arms}`
  if (evidence.userNegative) return `retired: the user rejected a result it was shown to; ${arms}`
  return `retired: did worse when shown; ${arms}`
}

/** The learned skill library of a Nexgent home. */
export class SkillLibrary {
  readonly directory: string
  readonly logFile: string
  readonly usage: HandbookUsageLog
  readonly #now: () => Date
  #cache: { readonly size: number; readonly mtimeMs: number; readonly ops: readonly SkillLibraryOp[] } | undefined
  #index: { readonly key: string; readonly index: HandbookIndex; readonly byId: ReadonlyMap<string, LearnedSkill> } | undefined

  constructor(directory: string, options: { readonly now?: () => Date } = {}) {
    this.directory = directory
    this.logFile = join(directory, SKILL_LIBRARY_LOG_FILE)
    this.#now = options.now ?? (() => new Date())
    this.usage = new HandbookUsageLog(directory, { now: this.#now })
  }

  /** The library of a Nexgent home (absolute). */
  static of(home: string, options: { readonly now?: () => Date } = {}): SkillLibrary {
    return new SkillLibrary(resolveUserDataLayout(home).skillLibrary, options)
  }

  /** Every operation in `seq` order (missing file: none; torn lines skipped). */
  async read(): Promise<readonly SkillLibraryOp[]> {
    let info
    try {
      info = await stat(this.logFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (this.#cache !== undefined && this.#cache.size === info.size && this.#cache.mtimeMs === info.mtimeMs) return this.#cache.ops
    const raw = await retryTransient(() => readFile(this.logFile, 'utf8'))
    const ops: SkillLibraryOp[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const op = JSON.parse(line) as SkillLibraryOp
        if (op !== null && typeof op === 'object' && typeof op.seq === 'number' && typeof op.skillId === 'string') ops.push(op)
      } catch {
        // A torn line.
      }
    }
    ops.sort((a, b) => a.seq - b.seq)
    this.#cache = { size: Buffer.byteLength(raw), mtimeMs: info.mtimeMs, ops }
    return ops
  }

  /** The skill versions; retired ones only with `includeRetired`. */
  async skills(options: { readonly includeRetired?: boolean } = {}): Promise<LearnedSkill[]> {
    return foldSkillLibrary(await this.read()).filter(skill => options.includeRetired === true || isLearnedSkillInForce(skill))
  }

  /** One version, retired ones included. */
  async find(skillId: string): Promise<LearnedSkill | undefined> {
    return foldSkillLibrary(await this.read()).find(skill => skill.id === skillId)
  }

  /** Absolute path of a version's `SKILL.md`. */
  pathOf(skill: Pick<LearnedSkill, 'name' | 'version'>): string {
    return join(this.directory, ...learnedSkillPath(skill.name, skill.version).split('/'))
  }

  /** A version's body (the file after its front matter); `undefined` when the file is gone. */
  async body(skill: Pick<LearnedSkill, 'name' | 'version'>): Promise<string | undefined> {
    const text = await readFile(this.pathOf(skill), 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
    return (match === null ? text : text.slice(match[0].length)).trim()
  }

  /**
   * Append operations under the lock; `prepare` sees the current log and
   * returns what to write.
   */
  async append(prepare: (ops: readonly SkillLibraryOp[]) => readonly SkillLibraryOpInput[] | Promise<readonly SkillLibraryOpInput[]>): Promise<SkillLibraryOp[]> {
    await mkdir(this.directory, { recursive: true })
    await this.#lock()
    try {
      const current = await this.read()
      const inputs = await prepare(current)
      if (inputs.length === 0) return []
      for (const input of inputs) checkSkillLibraryOp(input)
      let seq = current.at(-1)?.seq ?? 0
      const at = this.#now().toISOString()
      const written = inputs.map(input => ({ formatVersion: 1, seq: ++seq, at, ...input }) as SkillLibraryOp)
      const raw = await readFile(this.logFile, 'utf8').catch(() => '')
      const lead = raw !== '' && !raw.endsWith('\n') ? '\n' : ''
      await retryTransient(() => appendFile(this.logFile, lead + written.map(op => `${JSON.stringify(op)}\n`).join(''), 'utf8'))
      return written
    } finally {
      await retryTransient(() => rm(join(this.directory, SKILL_LIBRARY_LOCK_FILE), { force: true }))
    }
  }

  /**
   * Add a version: the next version number of its name, the `SKILL.md`
   * written first, then the `add` operation, as trial. A version's file is
   * never changed after its `add`.
   * @throws `tool/invalid-input` for a candidate outside the limits or an
   * unknown `replaces`.
   */
  async add(input: NewLearnedSkill): Promise<LearnedSkill> {
    if (chars(input.body.trim()) === 0 || chars(input.body) > SKILL_LIBRARY_LIMITS.maxBodyChars) invalid(`body must be 1–${SKILL_LIBRARY_LIMITS.maxBodyChars} characters`)
    let added: LearnedSkill | undefined
    await this.append(async ops => {
      const skills = foldSkillLibrary(ops)
      if (input.replaces !== undefined && !skills.some(skill => skill.id === input.replaces && skill.status !== 'retired')) invalid(`replaces unknown or retired skill ${input.replaces}`)
      const version = skills.filter(skill => skill.name === input.name).reduce((max, skill) => Math.max(max, skill.version), 0) + 1
      const at = this.#now().toISOString()
      const op: SkillLibraryOpInput = {
        op: 'add',
        skillId: learnedSkillId(input.name, version),
        actor: input.actor ?? 'induction',
        name: input.name,
        version,
        description: input.description,
        ...(input.whenToUse === undefined ? {} : { whenToUse: input.whenToUse }),
        ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
        sources: input.sources,
        ...(input.reason === undefined ? {} : { reason: input.reason.slice(0, SKILL_LIBRARY_LIMITS.maxReasonChars) }),
      }
      checkSkillLibraryOp(op)
      // The file first: an add in the log always has its file. A file left by a crash before its add is replaced.
      const path = this.pathOf({ name: input.name, version })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, renderLearnedSkill(input), 'utf8')
      added = {
        id: op.skillId,
        name: input.name,
        version,
        description: input.description,
        ...(input.whenToUse === undefined ? {} : { whenToUse: input.whenToUse }),
        status: 'trial',
        ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
        sources: input.sources,
        createdAt: at,
        updatedAt: at,
      }
      return [op]
    })
    return added!
  }

  /** Change a version's status (the user, or the host). */
  async setStatus(skillId: string, status: LearnedSkillStatus, actor: SkillLibraryActor, reason: string): Promise<SkillLibraryOp[]> {
    return this.append(ops => {
      const skill = foldSkillLibrary(ops).find(candidate => candidate.id === skillId)
      if (skill === undefined) throw new NexgentError('tool/not-found', `no learned skill ${skillId}`)
      return skill.status === status ? [] : [{ op: 'status', skillId, actor, status, reason: reason.slice(0, SKILL_LIBRARY_LIMITS.maxReasonChars) }]
    })
  }

  /**
   * The versions in force whose description and when-to-use match `text`
   * (the handbook's BM25 with its relevance gate), best first.
   */
  async retrieve(text: string, options: { readonly k?: number; readonly exclude?: Iterable<string> } = {}): Promise<ScoredSkill[]> {
    const ops = await this.read()
    const key = `${ops.at(-1)?.seq ?? 0}:${ops.length}`
    if (this.#index?.key !== key) {
      const skills = foldSkillLibrary(ops).filter(isLearnedSkillInForce)
      this.#index = { key, index: new HandbookIndex(skills.map(indexEntry)), byId: new Map(skills.map(skill => [skill.id, skill])) }
    }
    const { index, byId } = this.#index
    const k = options.k ?? SKILL_LIBRARY_LIMITS.maxActivePerTask + SKILL_LIBRARY_LIMITS.maxTrialPerTask + 2
    return index.search(text, k, new Set(options.exclude ?? [])).map(scored => ({ skill: byId.get(scored.entry.id)!, score: scored.score }))
  }

  /** Note a root turn and the skills found for it (with the draws). */
  async recordTurn(input: { readonly projectId: string; readonly sessionId: string; readonly hits: readonly SkillTurnHit[] }): Promise<void> {
    await this.usage.append([
      { kind: 'turn', projectId: input.projectId, sessionId: input.sessionId },
      ...input.hits.map(hit => ({
        kind: 'hit' as const,
        projectId: input.projectId,
        sessionId: input.sessionId,
        entryId: hit.skillId,
        given: hit.given,
        taskId: input.sessionId,
        status: hit.status,
        ...(hit.draw === undefined ? {} : { draw: hit.draw }),
        ...(hit.showProbability === undefined ? {} : { showProbability: hit.showProbability }),
      })),
    ])
  }

  /** The draws made for a root session, by skill (its first draw counts). */
  async drawsOf(sessionId: string): Promise<Map<string, { readonly draw: HandbookDraw; readonly status?: 'trial' | 'active' }>> {
    const draws = new Map<string, { readonly draw: HandbookDraw; readonly status?: 'trial' | 'active' }>()
    for (const record of await this.usage.read()) {
      if (record.kind === 'hit' && record.sessionId === sessionId && record.draw !== undefined && !draws.has(record.entryId)) {
        draws.set(record.entryId, { draw: record.draw, ...(record.status === undefined ? {} : { status: record.status }) })
      }
    }
    return draws
  }

  /**
   * A root task's outcome (ADR 0023: never the same model's
   * self-evaluation), written only when its session has a draw here.
   * Returns whether it was written.
   */
  async recordOutcome(outcome: { readonly projectId: string; readonly sessionId: string; readonly taskId: string; readonly score: number; readonly evidence: readonly HandbookOutcomeEvidence[]; readonly userNegative?: boolean }): Promise<boolean> {
    if (!(outcome.score >= 0 && outcome.score <= 1)) throw new NexgentError('tool/invalid-input', 'skill library: an outcome score is between 0 and 1')
    if (outcome.evidence.length === 0) throw new NexgentError('tool/invalid-input', 'skill library: an outcome needs at least one source of evidence')
    const records = await this.usage.read()
    if (!records.some(record => record.kind === 'hit' && record.sessionId === outcome.sessionId && record.draw !== undefined)) return false
    await this.usage.append([{
      kind: 'outcome',
      projectId: outcome.projectId,
      sessionId: outcome.sessionId,
      taskId: outcome.taskId,
      score: outcome.score,
      evidence: [...new Set(outcome.evidence)],
      ...(outcome.userNegative === true ? { userNegative: true } : {}),
    }])
    return true
  }

  /** Each version's randomized evidence. */
  async evidence(): Promise<Map<string, HandbookExposureEvidence>> {
    const records = await this.usage.read()
    return new Map((await this.skills({ includeRetired: true })).map(skill => [skill.id, handbookExposureEvidence(skill.id, records)]))
  }

  /** Enable or retire versions by their randomized evidence (`handbookStatusFromEvidence`). */
  async applyEvidence(): Promise<SkillLibraryOp[]> {
    const records = await this.usage.read()
    const decide = (ops: readonly SkillLibraryOp[]): SkillLibraryOpInput[] => foldSkillLibrary(ops)
      .filter(isLearnedSkillInForce)
      .flatMap(skill => {
        const evidence = handbookExposureEvidence(skill.id, records)
        const next = handbookStatusFromEvidence(skill, evidence)
        return next === skill.status ? [] : [{ op: 'status' as const, skillId: skill.id, actor: 'host' as const, status: next, reason: evidenceReason(next, evidence).slice(0, SKILL_LIBRARY_LIMITS.maxReasonChars) }]
      })
    if (decide(await this.read()).length === 0) return []
    return this.append(decide)
  }

  /** The refused candidates, oldest first. */
  async rejected(): Promise<SkillRejection[]> {
    const raw = await readFile(join(this.directory, SKILL_LIBRARY_REJECTED_FILE), 'utf8').catch(() => '')
    const out: SkillRejection[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as SkillRejection
        if (record !== null && typeof record === 'object' && typeof record.reason === 'string') out.push(record)
      } catch {
        // A torn line.
      }
    }
    return out
  }

  /** Archive refused candidates. */
  async reject(records: readonly Omit<SkillRejection, 'formatVersion' | 'at'>[]): Promise<void> {
    if (records.length === 0) return
    await mkdir(this.directory, { recursive: true })
    const at = this.#now().toISOString()
    await retryTransient(() => appendFile(join(this.directory, SKILL_LIBRARY_REJECTED_FILE), records.map(record => `${JSON.stringify({ formatVersion: 1, at, ...record })}\n`).join(''), 'utf8'))
  }

  async #lock(): Promise<void> {
    const path = join(this.directory, SKILL_LIBRARY_LOCK_FILE)
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o644)
        try {
          await handle.writeFile(`${process.pid}\n`)
        } finally {
          await handle.close()
        }
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      }
      const pid = Number.parseInt((await readFile(path, 'utf8').catch(() => '')).trim(), 10)
      if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      const delay = LOCK_DELAYS_MS[attempt]
      if (delay === undefined) throw new NexgentError('internal', `skill library: ${path} is held by another process`)
      await sleep(delay)
    }
  }
}
