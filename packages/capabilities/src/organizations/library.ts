/**
 * New direction step 3: the user's organization library (`ctx.organizations`).
 *
 * Every root turn the organizer decided is recorded with its checks, the
 * user's corrections while it ran, rework (a later feedback turn on the
 * same session asking for changes) and its cost. Layer-1 learning may add
 * an external reviewer's score later (`noteReview`); the same model never
 * scores its own run. No replay.
 *
 * - Similar tasks form a class: a task joins the class of the most similar
 *   recorded task (Jaccard overlap of their similarity terms at least
 *   {@link ORGANIZATION_CLASS_MIN}). A run
 *   whose words match no class joins the class of the run that did the most
 *   similar things (its traits: file types changed, tools, checks; overlap
 *   at least {@link ORGANIZATION_TRAIT_MIN}), so tasks worded differently
 *   meet in one class and later tasks worded either way find it.
 * - A run went well when it completed, no check failed, the user made no
 *   correction and did not rework it, and, when an external reviewer
 *   scored it ({@link OrganizationLibrary.noteReview}), the review is good.
 *   Rework: a later feedback turn asking for changes, a later message saying the result is wrong or must be
 *   redone (`asksRedo`, decided by the organizer), or every file the run
 *   presented deleted while no later run deleted it.
 * - Within a class, team runs are compared with solo runs. With at least
 *   {@link ORGANIZATION_MIN_RUNS} on each side, one side is better when the
 *   lower end of its 90 % interval (Wilson) is above the other side's rate.
 * - The preferred side (team until solo is shown better) is used; the other
 *   one is used for comparison 1 in 5 turns, 1 in 10 once there is a verdict.
 * - Which organization a team starts from: Thompson sampling over the
 *   built-in organizations and any custom one that went well in the class,
 *   less {@link ORGANIZATION_COST_WEIGHT} for each 100 % it costs above the
 *   class's team mean. The suggestion carries the roles of the
 *   organization's latest good run in the class (organizations changed
 *   inside a task included), so a good arrangement is reused.
 *
 * - Coordinator: every recorded team run carries an organization profile
 *   (what each part cost, how long it ran, failures, idle wait, wasted
 *   work). Recording it reflects on it (`reflection.ts`): the change the
 *   class is trying gets its verdict, and the hottest part of the run gets
 *   one new change, which the next similar team tasks are given
 *   ({@link coordinatorAdvice}).
 *
 * Nothing here depends on the kind of task.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrganizationProfile, OrganizationChange, OrganizationChangeAction, OrganizationChangeVerdict, OrganizationClassSummary, OrganizationLevel, OrganizationMemory, OrganizationName, OrganizationRole, OrganizationRun, OrganizationSuggestion } from '@nexgent/kernel'
import { jaccard } from '../handbook/tokens.js'
import { similarityKey } from '../handbook/tokens.js'
import { changeNote, MAX_KEPT_CHANGES, reflectOnRun, sinceStart, withModelChoice, type ChangeState, type ReflectedRun } from './reflection.js'
import type { OrganizationReflector } from './model-reflection.js'

/** Overlap a task needs with a recorded one to join its class. */
export const ORGANIZATION_CLASS_MIN = 0.25
/** Trait overlap a run whose words match no class needs to join another run's class. */
export const ORGANIZATION_TRAIT_MIN = 0.6
/** Traits a run needs before it is classed by them. */
export const ORGANIZATION_MIN_TRAITS = 3
/** Recent runs of a project checked for deleted results. */
export const ORGANIZATION_REVERT_WINDOW = 50
/** Runs each side needs before a verdict. */
export const ORGANIZATION_MIN_RUNS = 5
/** Share of turns that go to the other side while comparing. */
export const ORGANIZATION_CONTROL_RATE = 0.2
/** Share once a verdict is in. */
export const ORGANIZATION_CONCLUDED_CONTROL_RATE = 0.1
/** What 100 % more cost than the class's team mean takes off a sampled success rate. */
export const ORGANIZATION_COST_WEIGHT = 0.1
/** A reviewed run went well only with at least this review score. */
export const ORGANIZATION_REVIEW_GOOD = 0.7
/** The organizations every class may try. */
export const BUILT_IN_ORGANIZATIONS: readonly OrganizationName[] = ['lead-checker', 'plan-build-review', 'explore-then-build']

const Z90 = 1.645
const MAX_BETA_DRAWS = 400

/** One line of `runs.jsonl`. */
export type OrganizationLogLine =
  | ({ readonly type: 'run' } & OrganizationRun)
  /** The user asked for changes: the session's latest run before the line, or the run `runId` (its result was deleted). */
  | { readonly type: 'rework'; readonly sessionId: string; readonly runId?: string; readonly at: string }
  /** An external reviewer scored the run of `sessionId` and `turn` (0–1); a later line for the same run replaces it. */
  | { readonly type: 'review'; readonly sessionId: string; readonly turn: number; readonly score: number; readonly at: string }
  /** Coordinator: reflection on a run found a hotspot; the class tries this change on its next team tasks. */
  | { readonly type: 'change'; readonly change: OrganizationChange; readonly at: string }
  /** Coordinator: the verdict on a change. */
  | { readonly type: 'verdict'; readonly classId: string; readonly changeId: string; readonly verdict: OrganizationChangeVerdict; readonly at: string }
  /** Coordinator step two: the full profile of a run whose threads have all ended (replaces the run's profile and cost, ends its `waiting`). */
  | { readonly type: 'profile'; readonly sessionId: string; readonly turn: number; readonly profile: OrganizationProfile; readonly at: string }

/** A recorded run with what later lines said about it. */
export interface FoldedRun extends OrganizationRun {
  /** Position of the run's line in the log. */
  readonly seq?: number
  readonly reworked: boolean
  /** The external reviewer's score, when the run was reviewed. */
  readonly review?: number
}

/** Pure: runs in order, each marked when a later rework line names its session (only the session's latest run before it). */
export function foldOrganizationLog(lines: readonly OrganizationLogLine[]): FoldedRun[] {
  const runs: FoldedRun[] = []
  const latest = new Map<string, number>()
  for (const [seq, line] of lines.entries()) {
    if (line.type === 'run') {
      const { type: _type, ...run } = line
      latest.set(run.sessionId, runs.length)
      runs.push({ ...run, seq, reworked: false })
    } else if (line.type === 'change' || line.type === 'verdict') {
      continue
    } else if (line.type === 'profile') {
      const index = runs.findIndex(run => run.sessionId === line.sessionId && run.turn === line.turn)
      if (index >= 0) {
        const { waiting: _waiting, ...run } = runs[index]!
        runs[index] = { ...run, usd: line.profile.usd, profile: line.profile }
      }
    } else if (line.type === 'review') {
      const index = runs.findIndex(run => run.sessionId === line.sessionId && run.turn === line.turn)
      if (index >= 0) runs[index] = { ...runs[index]!, review: line.score }
    } else {
      const index = line.runId !== undefined ? runs.findIndex(run => run.id === line.runId) : latest.get(line.sessionId)
      if (index !== undefined && index >= 0) runs[index] = { ...runs[index]!, reworked: true }
    }
  }
  return runs
}

/** Pure: each class's changes in order, with their verdicts. */
export function foldChanges(lines: readonly OrganizationLogLine[]): Map<string, ChangeState[]> {
  const out = new Map<string, ChangeState[]>()
  for (const [seq, line] of lines.entries()) {
    if (line.type === 'change') out.set(line.change.classId, [...(out.get(line.change.classId) ?? []), { change: line.change, seq }])
    if (line.type === 'verdict') {
      const states = out.get(line.classId) ?? []
      const index = states.findIndex(state => state.change.id === line.changeId && state.verdict === undefined)
      if (index >= 0) states[index] = { ...states[index]!, verdict: { verdict: line.verdict, seq } }
    }
  }
  return out
}

/** Pure: a folded run as reflection reads it. */
export function reflectedRun(run: FoldedRun): ReflectedRun {
  return {
    id: run.id,
    seq: run.seq ?? 0,
    decision: run.decision,
    usd: run.usd,
    good: wentWell(run),
    sound: wentWell({ ...run, corrections: 0 }),
    ...(run.organization === undefined ? {} : { organization: run.organization }),
    // A run still waiting for its threads has no complete profile yet.
    ...(run.profile === undefined || run.waiting === true ? {} : { profile: run.profile }),
    ...(run.change === undefined ? {} : { change: run.change }),
    ...(run.level === undefined ? {} : { level: run.level }),
  }
}

/**
 * Pure: whether a run went well. A reviewed run also needs a review score
 * of at least {@link ORGANIZATION_REVIEW_GOOD}: without checks and user
 * signals, the review is what tells a good result from a poor one.
 */
export function wentWell(run: FoldedRun): boolean {
  return run.completed && !run.reworked && run.corrections === 0 && (run.checks === undefined || run.checks.passed === run.checks.total)
    && (run.review === undefined || run.review >= ORGANIZATION_REVIEW_GOOD)
}

/** Pure: the class a task with `key` joins (`undefined`: a new one). */
export function classFor(key: readonly string[], runs: readonly Pick<OrganizationRun, 'key' | 'classId'>[]): string | undefined {
  const mine = new Set(key)
  let best: { classId: string; overlap: number } | undefined
  for (const run of runs) {
    const overlap = jaccard(mine, new Set(run.key))
    if (overlap >= ORGANIZATION_CLASS_MIN && (best === undefined || overlap > best.overlap)) best = { classId: run.classId, overlap }
  }
  return best?.classId
}

/** Pure: the class of the run with the most similar traits, when it is similar enough. */
export function classByTraits(traits: readonly string[] | undefined, runs: readonly Pick<OrganizationRun, 'traits' | 'classId'>[]): string | undefined {
  if (traits === undefined || traits.length < ORGANIZATION_MIN_TRAITS) return undefined
  const mine = new Set(traits)
  let best: { classId: string; overlap: number } | undefined
  for (const run of runs) {
    if (run.traits === undefined || run.traits.length < ORGANIZATION_MIN_TRAITS) continue
    const overlap = jaccard(mine, new Set(run.traits))
    if (overlap >= ORGANIZATION_TRAIT_MIN && (best === undefined || overlap > best.overlap)) best = { classId: run.classId, overlap }
  }
  return best?.classId
}

/**
 * Pure: recent runs of a project (oldest first, not yet reworked) whose
 * presented files are all gone while no later run of the project deleted
 * any of them.
 */
export function revertedRuns(runs: readonly FoldedRun[], projectRoot: string, exists: (root: string, path: string) => boolean): FoldedRun[] {
  const mine = runs.filter(run => run.projectRoot === projectRoot).slice(-ORGANIZATION_REVERT_WINDOW)
  return mine.filter((run, index) => {
    if (run.reworked || run.outputs === undefined || run.outputs.length === 0) return false
    const laterDeleted = new Set(mine.slice(index + 1).flatMap(later => later.deleted ?? []))
    return run.outputs.every(path => !exists(projectRoot, path) && !laterDeleted.has(path))
  })
}

/** Pure: lower end of the 90 % Wilson interval of `good` of `n`. */
export function wilsonLower(good: number, n: number): number {
  if (n === 0) return 0
  const p = good / n
  const z2 = Z90 * Z90
  return (p + z2 / (2 * n) - Z90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
}

interface Side {
  readonly n: number
  readonly good: number
  readonly usd: number
}

function side(runs: readonly FoldedRun[]): Side {
  return { n: runs.length, good: runs.filter(wentWell).length, usd: runs.reduce((sum, run) => sum + run.usd, 0) }
}

/** Pure: the verdict of a class's runs. */
export function classVerdict(runs: readonly FoldedRun[]): OrganizationClassSummary['verdict'] {
  const solo = side(runs.filter(run => run.decision === 'solo'))
  const team = side(runs.filter(run => run.decision === 'team'))
  if (solo.n < ORGANIZATION_MIN_RUNS || team.n < ORGANIZATION_MIN_RUNS) return 'comparing'
  if (wilsonLower(team.good, team.n) > solo.good / solo.n) return 'team-better'
  if (wilsonLower(solo.good, solo.n) > team.good / team.n) return 'solo-better'
  return 'comparing'
}

/** A draw from Beta(a, b) for whole a, b ≥ 1: the a-th smallest of a + b − 1 uniforms (scaled down past {@link MAX_BETA_DRAWS}). */
export function betaDraw(a: number, b: number, random: () => number): number {
  let [x, y] = [a, b]
  if (x + y - 1 > MAX_BETA_DRAWS) {
    const scale = MAX_BETA_DRAWS / (x + y)
    x = Math.max(1, Math.round(x * scale))
    y = Math.max(1, Math.round(y * scale))
  }
  const draws = Array.from({ length: x + y - 1 }, () => random()).sort((l, r) => l - r)
  return draws[x - 1]!
}

/** Pure: the organization a team of this class starts from. */
export function pickOrganization(teamRuns: readonly FoldedRun[], random: () => number): { readonly name: OrganizationName; readonly roles?: readonly OrganizationRole[] } {
  const named = teamRuns.filter(run => run.organization !== undefined)
  const candidates = new Set<OrganizationName>(BUILT_IN_ORGANIZATIONS)
  if (named.some(run => run.organization!.name === 'custom' && wentWell(run))) candidates.add('custom')
  const meanUsd = named.length === 0 ? 0 : named.reduce((sum, run) => sum + run.usd, 0) / named.length
  let best: { name: OrganizationName; value: number } | undefined
  for (const name of candidates) {
    const runs = named.filter(run => run.organization!.name === name)
    const stats = side(runs)
    let value = betaDraw(1 + stats.good, 1 + stats.n - stats.good, random)
    if (stats.n > 0 && meanUsd > 0) value -= ORGANIZATION_COST_WEIGHT * Math.max(0, stats.usd / stats.n / meanUsd - 1)
    if (best === undefined || value > best.value) best = { name, value }
  }
  const name = best!.name
  const good = [...named].reverse().find(run => run.organization!.name === name && wentWell(run))
  return good === undefined ? { name } : { name, roles: good.organization!.roles }
}

/**
 * Pure: for a task whose words match no class, the class `record` would put
 * it in if it did what the project's latest run did ({@link classByTraits}
 * over that run's traits). Without this the task got a new class's advice
 * and was then recorded in another class, whose change it never tried.
 */
export function projectClass(projectRoot: string | undefined, runs: readonly FoldedRun[]): string | undefined {
  if (projectRoot === undefined) return undefined
  const latest = runs.filter(run => run.projectRoot === projectRoot && run.traits !== undefined).at(-1)
  return latest === undefined ? undefined : classByTraits(latest.traits, runs)
}

/** Pure: what a task of `key` should do, given every recorded run (`projectRoot`: see {@link projectClass}). */
export function suggestOrganization(key: readonly string[], runs: readonly FoldedRun[], random: () => number, changes: ReadonlyMap<string, readonly ChangeState[]> = new Map(), projectRoot?: string): OrganizationSuggestion {
  const classId = classFor(key, runs) ?? projectClass(projectRoot, runs) ?? randomUUID()
  const mine = runs.filter(run => run.classId === classId)
  const verdict = classVerdict(mine)
  const preferred = verdict === 'solo-better' ? 'solo' : 'team'
  const control = random() < (verdict === 'comparing' ? ORGANIZATION_CONTROL_RATE : ORGANIZATION_CONCLUDED_CONTROL_RATE)
  const decision = control ? (preferred === 'team' ? 'solo' : 'team') : preferred
  return {
    classId,
    key,
    runs: mine.length,
    decision,
    control,
    ...(decision === 'team' ? { organization: pickOrganization(mine.filter(run => run.decision === 'team'), random), ...coordinatorAdvice(changes.get(classId) ?? [], mine) } : {}),
  }
}

/** Pure: the change a team task of a class tries, the changes it kept, and the team card's line. */
export function coordinatorAdvice(changes: readonly ChangeState[], runs: readonly FoldedRun[]): Pick<OrganizationSuggestion, 'change' | 'kept' | 'note'> {
  const active = changes.find(state => state.verdict === undefined)?.change
  const kept = changes.filter(state => state.verdict?.verdict === 'kept').map(state => state.change).reverse().slice(0, MAX_KEPT_CHANGES)
  const note = changeNote(changes, runs.map(reflectedRun))
  return { ...(active === undefined ? {} : { change: active }), ...(kept.length === 0 ? {} : { kept }), ...(note === undefined ? {} : { note }) }
}

/** Pure: one line per class with at least two runs, most runs first. */
export function summarizeOrganizations(runs: readonly FoldedRun[], changes: ReadonlyMap<string, readonly ChangeState[]> = new Map()): OrganizationClassSummary[] {
  const classes = new Map<string, FoldedRun[]>()
  for (const run of runs) classes.set(run.classId, [...(classes.get(run.classId) ?? []), run])
  const out: OrganizationClassSummary[] = []
  for (const [classId, members] of classes) {
    if (members.length < 2) continue
    const counts = new Map<string, number>()
    for (const run of members) for (const term of run.key) counts.set(term, (counts.get(term) ?? 0) + 1)
    const keywords = [...counts.entries()].sort((l, r) => r[1] - l[1]).slice(0, 6).map(([term]) => term)
    const solo = side(members.filter(run => run.decision === 'solo'))
    const team = side(members.filter(run => run.decision === 'team'))
    const names = new Map<OrganizationName, number>()
    for (const run of members) if (run.organization !== undefined) names.set(run.organization.name, (names.get(run.organization.name) ?? 0) + 1)
    const organization = [...names.entries()].sort((l, r) => r[1] - l[1])[0]?.[0]
    const soloUsd = solo.n === 0 ? 0 : solo.usd / solo.n
    const since = sinceStart(members.map(reflectedRun))
    const states = changes.get(classId) ?? []
    const kept = states.filter(state => state.verdict?.verdict === 'kept').length
    const reverted = states.filter(state => state.verdict?.verdict === 'reverted').length
    out.push({
      classId,
      ...(members[0]!.level === undefined ? {} : { level: members[0]!.level }),
      keywords,
      soloRuns: solo.n,
      teamRuns: team.n,
      verdict: classVerdict(members),
      ...(organization === undefined ? {} : { organization }),
      ...(solo.n === 0 ? {} : { soloGood: solo.good / solo.n }),
      ...(team.n === 0 ? {} : { teamGood: team.good / team.n }),
      ...(solo.n > 0 && team.n > 0 && soloUsd > 0 ? { costChange: team.usd / team.n / soloUsd - 1 } : {}),
      ...(since === undefined ? {} : { sinceStart: since }),
      ...(kept === 0 ? {} : { changesKept: kept }),
      ...(reverted === 0 ? {} : { changesReverted: reverted }),
    })
  }
  return out.sort((l, r) => r.soloRuns + r.teamRuns - (l.soloRuns + l.teamRuns))
}

/** The library in `<home>/organizations/runs.jsonl` (append-only). */
export class OrganizationLibrary implements OrganizationMemory {
  readonly #file: string
  readonly #directory: string
  readonly #now: () => Date
  readonly #reflector: OrganizationReflector | undefined
  /** Model reflections still running (their change lines are not written yet). */
  readonly #pending = new Set<Promise<void>>()

  constructor(directory: string, options: { readonly now?: () => Date; readonly reflector?: OrganizationReflector } = {}) {
    this.#directory = directory
    this.#file = join(directory, 'runs.jsonl')
    this.#now = options.now ?? (() => new Date())
    this.#reflector = options.reflector
  }

  /**
   * Coordinator step three: settles once the model reflections started so
   * far have written their change. Suggesting, recording and profiling wait
   * for it, so the next task sees the change.
   */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
  }

  /** Every line; unreadable lines are skipped. */
  async lines(): Promise<OrganizationLogLine[]> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch {
      return []
    }
    const out: OrganizationLogLine[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line) as OrganizationLogLine
        if (value.type === 'run' || value.type === 'rework' || value.type === 'review' || value.type === 'change' || value.type === 'verdict' || value.type === 'profile') out.push(value)
      } catch {
        // a torn last line
      }
    }
    return out
  }

  async runs(): Promise<FoldedRun[]> {
    return foldOrganizationLog(await this.lines())
  }

  async suggest(input: { readonly text: string; readonly random?: () => number; readonly projectRoot?: string; readonly level?: OrganizationLevel }): Promise<OrganizationSuggestion> {
    await this.idle()
    const lines = await this.lines()
    const runs = foldOrganizationLog(lines).filter(run => run.level === input.level)
    return suggestOrganization(similarityKey(input.text), runs, input.random ?? Math.random, foldChanges(lines), input.projectRoot)
  }

  /** Coordinator: each class's changes with their verdicts. */
  async changes(): Promise<Map<string, ChangeState[]>> {
    return foldChanges(await this.lines())
  }

  async #append(line: OrganizationLogLine): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    await appendFile(this.#file, `${JSON.stringify(line)}\n`, 'utf8')
  }

  async record(run: Omit<OrganizationRun, 'id' | 'at'>): Promise<void> {
    await this.idle()
    // Coordinator-level runs (the split into threads) and member-level runs are classed apart.
    const runs = (await this.runs()).filter(other => other.level === run.level)
    // Words matched no class: join the class of the run that did the most similar things.
    const classId = runs.some(other => other.classId === run.classId) ? run.classId : classByTraits(run.traits, runs) ?? run.classId
    await this.#append({ type: 'run', id: randomUUID(), at: this.#now().toISOString(), ...run, classId })
    if (run.waiting !== true) await this.#reflect(classId)
  }

  /**
   * Coordinator step two: a run's full profile once its threads have ended;
   * the threads' cost (`addUsd`) joins the run's cost. Reflects on its class
   * up to that run. A run that is not waiting for threads is left alone.
   */
  async noteProfile(input: { readonly sessionId: string; readonly turn: number; readonly profile: OrganizationProfile; readonly addUsd?: number }): Promise<void> {
    await this.idle()
    const run = (await this.runs()).find(item => item.sessionId === input.sessionId && item.turn === input.turn)
    if (run === undefined || run.waiting !== true) return
    const usd = Math.round((run.usd + Math.max(0, input.addUsd ?? 0)) * 1e6) / 1e6
    // The host does not know the turn's check retries: the first profile's stand.
    const retries = run.profile?.parts.find(part => part.kind === 'coordinator')?.retries ?? 0
    const profile: OrganizationProfile = {
      ...input.profile,
      usd,
      parts: input.profile.parts.map(part => ({
        ...part,
        usd: Math.round(usd * part.share * 1e6) / 1e6,
        ...(part.kind === 'coordinator' ? { retries: Math.max(part.retries, retries) } : {}),
      })),
    }
    await this.#append({ type: 'profile', sessionId: input.sessionId, turn: input.turn, profile, at: this.#now().toISOString() })
    await this.#reflect(run.classId, run.id)
  }

  /**
   * Coordinator: reflect on the class's latest run, or on run `upTo`: the
   * verdict on the change under trial, then one new change for the hottest
   * part. Step three: with a reflector, a model picks that change among the
   * fitting ones in the background (the turn does not wait for it); the rule's
   * pick stands when it gives no valid choice.
   */
  async #reflect(classId: string, upTo?: string): Promise<void> {
    const lines = await this.lines()
    const all = foldOrganizationLog(lines).filter(run => run.classId === classId)
    const end = upTo === undefined ? all.length : all.findIndex(run => run.id === upTo) + 1
    const runs = all.slice(0, end)
    const reflection = reflectOnRun(classId, runs.map(reflectedRun), foldChanges(lines).get(classId) ?? [])
    const at = this.#now().toISOString()
    if (reflection.verdict !== undefined) await this.#append({ type: 'verdict', classId, ...reflection.verdict, at })
    if (reflection.change === undefined) return
    const run = runs.at(-1)
    // With one fitting change there is nothing to choose.
    if (this.#reflector === undefined || run?.profile === undefined || (reflection.allowed ?? []).length < 2) {
      await this.#append({ type: 'change', change: reflection.change, at })
      return
    }
    const task = this.#choose(this.#reflector, reflection.change, reflection.allowed ?? [], run)
    this.#pending.add(task)
    void task.finally(() => this.#pending.delete(task))
  }

  /** Ask the model for the change, then write it (the rule's when the answer is not valid). */
  async #choose(reflector: OrganizationReflector, rule: OrganizationChange, allowed: readonly OrganizationChangeAction[], run: FoldedRun): Promise<void> {
    const choice = await reflector({
      sessionId: run.sessionId,
      turn: run.turn,
      hotspot: rule.target,
      profile: run.profile!,
      ...(run.organization === undefined ? {} : { organization: run.organization }),
      allowed,
    }).catch(() => undefined)
    const redoneBy = run.profile?.parts.find(part => part.name === rule.target.part)?.redoneBy
    const change = withModelChoice(rule, allowed, choice, redoneBy, reflectedRun(run)) ?? rule
    await this.#append({ type: 'change', change, at: this.#now().toISOString() }).catch(() => undefined)
  }

  async noteReverts(input: { readonly projectRoot: string }): Promise<void> {
    for (const run of revertedRuns(await this.runs(), input.projectRoot, (root, path) => existsSync(join(root, path)))) {
      await this.#append({ type: 'rework', sessionId: run.sessionId, runId: run.id, at: this.#now().toISOString() })
    }
  }

  async noteRework(input: { readonly sessionId: string }): Promise<void> {
    if (!(await this.runs()).some(run => run.sessionId === input.sessionId)) return
    await this.#append({ type: 'rework', sessionId: input.sessionId, at: this.#now().toISOString() })
  }

  /** An external review of a recorded run (layer-1 learning's review of the task); ignored when no run of that turn is recorded. */
  async noteReview(input: { readonly sessionId: string; readonly turn: number; readonly score: number }): Promise<void> {
    if (!Number.isFinite(input.score)) return
    if (!(await this.runs()).some(run => run.sessionId === input.sessionId && run.turn === input.turn)) return
    await this.#append({ type: 'review', sessionId: input.sessionId, turn: input.turn, score: Math.min(1, Math.max(0, input.score)), at: this.#now().toISOString() })
  }

  async summary(): Promise<OrganizationClassSummary[]> {
    const lines = await this.lines()
    return summarizeOrganizations(foldOrganizationLog(lines), foldChanges(lines))
  }
}
