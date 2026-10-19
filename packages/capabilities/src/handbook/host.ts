/**
 * The handbook in running sessions (ADR 0018 decision 4):
 *
 * - {@link HandbookHost.forTurn}: what the kernel gives a root task's user
 *   turn before its user message (never in the system prompt, so the
 *   prompt cache holds): the top entries for the turn's text that the
 *   session was not given yet, and the context-policy practices of the
 *   session's capability version that are not handbook entries (a version
 *   on trial in the gate; the adopted version's policies are migrated into
 *   the project's handbook first) or of a draft the session tried, each
 *   once. The kernel writes the ids to
 *   `turn.start.handbook`.
 * - `handbook_mark`: the executing model says an entry it was given was
 *   used or misled it (ADR 0023: “used” / “misled”, not evidence that it
 *   helps); one mark per entry per task.
 * - Evidence and usage (ADR 0023, `usage.ts`): each such turn first enables
 *   or retires entries by their randomized evidence and retires the ones
 *   nobody uses, then draws which found entries the model gets and records
 *   the draws; not in a trial copy or an improvement session.
 */
import { HANDBOOK_EVIDENCE, HANDBOOK_MARK_TOOL, NexgentError, type HandbookDraw, type HandbookEntry, type HandbookTurnInput, type HandbookTurnSelection, type SessionRecord, type Tool } from '@nexgent/kernel'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapabilityStore } from '../capability-store.js'
import { readDecision } from '../decisions.js'
import type { CapabilityService } from '../service.js'
import { Handbook, type HandbookTurnHit } from './handbook.js'
import { contextPolicyKey, migrateContextPolicies } from './migrate.js'

/** Reads a session's records. */
export type HandbookRecordReader = (sessionId: string) => Promise<readonly SessionRecord[]>

/** Options of {@link HandbookHost}. */
export interface HandbookHostOptions {
  readonly projectRoot: string
  /** Nexgent home; default `NEXGENT_HOME` or `~/.nexgent`. */
  readonly home?: string
  readonly readRecords: HandbookRecordReader
  /** The coin of the randomized exposure (ADR 0023); default `Math.random`. */
  readonly random?: () => number
  /** ADR 0027: retrieval parameters of the execution profile in force; default the constants. */
  readonly retrieval?: () => Promise<{ readonly k?: number; readonly minCoverage?: number; readonly minSharedTerms?: number } | undefined>
}

/** A small seeded generator in [0, 1) (mulberry32), for a reproducible exposure coin. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The opening line of the injected handbook message. */
export const HANDBOOK_INJECT_HEADER = 'Experience from earlier tasks (handbook). Use what fits this task and ignore the rest. If an entry clearly helped or misled you, say so with handbook_mark.'

/** The line before entries still on trial (ADR 0023: given to about half the tasks that find them). */
export const HANDBOOK_TRIAL_HEADER = 'On trial (may not fit this task; follow the task as asked):'

/**
 * ADR 0024: the opening line of the project's rules. They come first and
 * whole (no retrieval, no coin). The user set them after the project's
 * files were written, so they outrank those files; only the task's own
 * messages outrank them (as a direct request outranks AGENTS.md in Codex).
 */
export const HANDBOOK_RULES_HEADER = "Rules the user set for this project: the whole workspace this task runs in, every folder of it included, unless a rule names a narrower range. Follow each one where its range applies. A rule outranks what older project files (READMEs, comments, examples) suggest; only an explicit instruction in this task's own messages overrides it."

/** The opening line of practices that come with the session's capability version. */
export const VERSION_PRACTICES_HEADER = 'Practices of this capability version:'

/**
 * The details the gate writes on revision 1 of a throw-away copy's chain
 * (`src/trial/replay-project.ts`, `src/trial/project-copy.ts`).
 */
export const COPY_ADOPTION_DETAILS: readonly string[] = ['replay copy for a gate trial', 'project copy for an improver comparison arm']

/** The marker a replay copy writes in its data directory, whatever version it runs (`src/trial/replay-project.ts`). */
export const TRIAL_COPY_MARKER_FILE = 'trial-copy'

/**
 * Whether a project is a throw-away copy a gate trial or a comparison arm
 * runs in: its sessions read the handbook as the real project would, but
 * write nothing to it (no migration, no votes), so replays never change
 * the counts of real entries.
 */
export async function isTrialCopy(store: CapabilityStore): Promise<boolean> {
  // A copy on the baseline version has no adoption to tell it by: the copy writes a marker (`TRIAL_COPY_MARKER_FILE`).
  if (await access(join(dirname(store.directory), TRIAL_COPY_MARKER_FILE)).then(() => true, () => false)) return true
  const first = (await store.chain()).revisions[0]
  if (first === undefined || first.type !== 'adopt' || first.trigger !== 'manual') return false
  const decision = await readDecision(store.decisionsDirectory, first.decisionId).catch(() => undefined)
  return decision !== undefined && COPY_ADOPTION_DETAILS.includes(decision.detail)
}

/** The ids given to a session so far (`turn.start.handbook`). */
export function givenEntries(records: readonly SessionRecord[]): string[] {
  const ids: string[] = []
  for (const record of records) {
    if (record.type !== 'turn.start') continue
    for (const id of record.handbook ?? []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

function policyText(spec: { readonly instructions?: string; readonly personaSuffix?: string }): string {
  return [spec.instructions, spec.personaSuffix].filter((part): part is string => part !== undefined && part.trim() !== '').join('\n\n')
}

/** The handbook side of a project's running sessions. */
export class HandbookHost {
  readonly #service: CapabilityService
  readonly #options: HandbookHostOptions
  #copy: Promise<boolean> | undefined

  constructor(service: CapabilityService, options: HandbookHostOptions) {
    this.#service = service
    this.#options = options
  }

  /** Whether this project is a trial copy (asked once). */
  readOnly(): Promise<boolean> {
    this.#copy ??= isTrialCopy(this.#service.store).catch(() => false)
    return this.#copy
  }

  async #retrieval(): Promise<{ readonly k?: number; readonly minCoverage?: number; readonly minSharedTerms?: number }> {
    return (await this.#options.retrieval?.().catch(() => undefined)) ?? {}
  }

  open(): Promise<Handbook> {
    return Handbook.open({ projectRoot: this.#options.projectRoot, ...(this.#options.home === undefined ? {} : { home: this.#options.home }) })
  }

  /** What a root task's user turn is given; `undefined` for any other session or when there is nothing. */
  async forTurn(input: HandbookTurnInput): Promise<HandbookTurnSelection | undefined> {
    const records = await this.#options.readRecords(input.sessionId)
    const start = records[0]
    if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.member !== undefined) return undefined
    // An improvement session is no task: it gets only the policies it tries itself.
    const improvement = start.purpose === 'improvement'
    const handbook = await this.open()
    const policies = (await this.#service.components(input.sessionId)).flatMap(component =>
      component.spec.kind === 'context-policy' && (!improvement || component.version === 'draft') ? [{ version: component.version, text: policyText(component.spec.spec) }] : [])
    const adopted = (await this.#service.store.chain()).activation.version
    const toMigrate = policies.filter(policy => policy.version === adopted && policy.text !== '')
    if (toMigrate.length > 0 && !improvement && !(await this.readOnly())) await migrateContextPolicies(handbook, toMigrate.map(policy => policy.text))
    const migrated = new Set((await handbook.project.read()).flatMap(op => (op.actor === 'migration' && op.source !== undefined ? [op.source.taskId] : [])))
    // A policy that is not a handbook entry (a trial version's, a tried draft's) is given once; it stays in the history after that.
    const injected = records.flatMap(record => (record.type === 'user.message' && record.source === 'inject' ? [record.content] : []))
    const pinned = policies.filter(policy => policy.text !== '' && (policy.version === 'draft' || !migrated.has(contextPolicyKey(policy.text))) && !injected.some(text => text.includes(policy.text)))
    // Bookkeeping of a real task: enable or retire by evidence, retire what nobody uses, record the draws.
    // A failure here never stops the turn.
    const counted = !improvement && !(await this.readOnly())
    if (counted) {
      await handbook.applyEvidence().catch(() => undefined)
      await handbook.retireIdle().catch(() => undefined)
    }
    const drawn = counted ? await handbook.drawsOf(input.sessionId).catch(() => new Map<string, { readonly draw: HandbookDraw; readonly status?: 'trial' | 'active' }>()) : new Map<string, { readonly draw: HandbookDraw; readonly status?: 'trial' | 'active' }>()
    const usage = improvement ? undefined : await handbook.usage().catch(() => undefined)
    const found = improvement ? [] : await handbook.retrieve(input.text, { ...(await this.#retrieval()), exclude: [...givenEntries(records), ...drawn.keys()], ...(usage === undefined ? {} : { usage }) })
    const hits = this.#draw(found.map(({ entry }) => entry), [...drawn.values()].filter(draw => draw.status === 'trial').length, counted)
    if (counted) await handbook.recordTurn({ sessionId: input.sessionId, taskId: input.sessionId, hits }).catch(() => undefined)
    const given0 = givenEntries(records)
    const rules = improvement ? [] : (await handbook.rules().catch(() => [])).filter(rule => !given0.includes(rule.id))
    const byId = new Map(found.map(({ entry }) => [entry.id, entry]))
    const given = (status: 'trial' | 'active') => hits.filter(hit => hit.given && hit.status === status).map(hit => byId.get(hit.entryId)!)
    const active = given('active')
    const trial = given('trial')
    if (rules.length === 0 && active.length === 0 && trial.length === 0 && pinned.length === 0) return undefined
    const line = (entry: HandbookEntry) => `- [${entry.id}] ${entry.text.replace(/\s*\n\s*/g, ' ')}`
    const ruleLine = (entry: HandbookEntry) => `- [${entry.id}]${entry.appliesTo === undefined ? '' : ` (applies to: ${entry.appliesTo})`} ${entry.text.replace(/\s*\n\s*/g, ' ')}`
    const lines: string[] = []
    if (rules.length > 0) lines.push(HANDBOOK_RULES_HEADER, ...rules.map(ruleLine))
    if (active.length > 0 || trial.length > 0) lines.push(...(lines.length > 0 ? [''] : []), HANDBOOK_INJECT_HEADER, ...active.map(line))
    if (trial.length > 0) lines.push(HANDBOOK_TRIAL_HEADER, ...trial.map(line))
    if (pinned.length > 0) lines.push(...(lines.length > 0 ? [''] : []), VERSION_PRACTICES_HEADER, ...pinned.map(policy => policy.text))
    return { ids: [...rules, ...active, ...trial].map(entry => entry.id), text: lines.join('\n') }
  }

  /**
   * ADR 0023 decision 3: which found entries the model gets. Active entries,
   * at most `maxActivePerTask`, each by a coin with `activeShowProbability`;
   * one trial entry per task by a coin with `trialShowProbability`; the
   * rest are noted as found but not given. A trial copy draws nothing: it
   * gives the chosen entries, so gate replays do not depend on a coin.
   */
  #draw(found: readonly HandbookEntry[], trialDrawn: number, counted: boolean): HandbookTurnHit[] {
    const random = this.#options.random ?? Math.random
    let activeLeft = HANDBOOK_EVIDENCE.maxActivePerTask
    let trialLeft = Math.max(0, HANDBOOK_EVIDENCE.maxTrialPerTask - trialDrawn)
    return found.map(entry => {
      const status = entry.status === 'active' ? 'active' : 'trial'
      const chosen = status === 'active' ? activeLeft-- > 0 : trialLeft-- > 0
      if (!chosen) return { entryId: entry.id, given: false, status }
      if (!counted) return { entryId: entry.id, given: true, status }
      const showProbability = status === 'active' ? HANDBOOK_EVIDENCE.activeShowProbability : HANDBOOK_EVIDENCE.trialShowProbability
      const draw: HandbookDraw = random() < showProbability ? 'shown' : 'held-back'
      return { entryId: entry.id, given: draw === 'shown', status, draw, showProbability }
    })
  }

  /** The root session of a session (members mark entries their root task was given). */
  async #rootRecords(sessionId: string): Promise<{ readonly sessionId: string; readonly records: readonly SessionRecord[] }> {
    let id = sessionId
    let records = await this.#options.readRecords(id)
    for (let depth = 0; depth < 4; depth += 1) {
      const start = records[0]
      if (start?.type !== 'session.start' || start.parentSessionId === undefined) break
      id = start.parentSessionId
      records = await this.#options.readRecords(id)
    }
    return { sessionId: id, records }
  }

  /**
   * `handbook_mark`. One vote per entry per root session (a task and its
   * later turns, as step 5 counts a task); the vote's `source.sessionId` is
   * the root session.
   */
  markTool(): Tool {
    return {
      definition: {
        name: HANDBOOK_MARK_TOOL.name,
        description: 'Say that a handbook entry given at the start of this task helped (helpful) or led you astray (harmful), with a short reason. Use it only for entries that clearly mattered; it changes no file.',
        inputSchema: HANDBOOK_MARK_TOOL.inputSchema,
        effects: [...HANDBOOK_MARK_TOOL.effects],
        approval: HANDBOOK_MARK_TOOL.approval,
        ...(HANDBOOK_MARK_TOOL.concurrent === undefined ? {} : { concurrent: HANDBOOK_MARK_TOOL.concurrent }),
      },
      handler: async (raw, context) => {
        const input = raw as { readonly entryId?: unknown; readonly verdict?: unknown; readonly reason?: unknown }
        if (typeof input.entryId !== 'string' || (input.verdict !== 'helpful' && input.verdict !== 'harmful')) {
          throw new NexgentError('tool/invalid-input', 'give entryId and verdict ("helpful" or "harmful")')
        }
        const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : undefined
        const root = await this.#rootRecords(context.sessionId)
        const taskId = context.attribution?.taskId ?? root.sessionId
        if (!givenEntries(root.records).includes(input.entryId)) {
          throw new NexgentError('tool/invalid-input', `entry ${input.entryId} was not given to this task; mark only entries listed at its start`)
        }
        if (await this.readOnly()) {
          return { content: `Noted; marks are not recorded in a trial copy of the project.`, meta: { entryId: input.entryId, verdict: input.verdict, recorded: false } }
        }
        const handbook = await this.open()
        const located = await handbook.find(input.entryId)
        if (located === undefined) throw new NexgentError('handbook/not-found', `no handbook entry ${input.entryId} in this project`, { details: { entryId: input.entryId } })
        const ops = await handbook.logOf(located.scope).read()
        const voted = ops.some(op => op.entryId === input.entryId && op.actor === 'execution' && (op.op === 'upvote' || op.op === 'downvote') && op.source?.sessionId === root.sessionId)
        if (voted) {
          return { content: `Entry ${input.entryId} was already marked in this task; this mark is ignored.`, meta: { entryId: input.entryId, verdict: input.verdict, recorded: false } }
        }
        const [result] = await handbook.apply(
          [{ op: input.verdict === 'helpful' ? 'upvote' : 'downvote', entryId: input.entryId, ...(reason === undefined ? {} : { reason }) }],
          { actor: 'execution', source: { projectId: handbook.projectId, taskId, sessionId: root.sessionId } },
        )
        if (result?.outcome === 'rejected' && (result.reason === 'already-voted' || result.reason === 'own-source')) {
          return { content: `Entry ${input.entryId} cannot be marked again by this task; this mark is ignored.`, meta: { entryId: input.entryId, verdict: input.verdict, recorded: false } }
        }
        if (result?.outcome !== 'applied') throw new NexgentError('tool/failed', `entry ${input.entryId} could not be marked`)
        return { content: `Marked entry ${input.entryId} ${input.verdict}.`, meta: { entryId: input.entryId, verdict: input.verdict, recorded: true } }
      },
    }
  }
}
