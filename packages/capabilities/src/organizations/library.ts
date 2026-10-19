/**
 * New direction step 3: the user's organization library (`ctx.organizations`).
 *
 * Every root turn the organizer decided is recorded with deterministic
 * signals only: its checks, the user's corrections while it ran, rework (a
 * later feedback turn on the same session asking for changes) and its cost.
 * No replay, no model scoring.
 *
 * - Similar tasks form a class: a task joins the class of the most similar
 *   recorded task (Jaccard overlap of their similarity terms at least
 *   {@link ORGANIZATION_CLASS_MIN}, the practice set's clustering), else a
 *   new one.
 * - A run went well when it completed, no check failed, the user made no
 *   correction and did not rework it.
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
 * Nothing here depends on the kind of task.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrganizationClassSummary, OrganizationMemory, OrganizationName, OrganizationRole, OrganizationRun, OrganizationSuggestion } from '@nexgent/kernel'
import { jaccard } from '../handbook/tokens.js'
import { similarityKey } from '../learning/practice.js'

/** Overlap a task needs with a recorded one to join its class. */
export const ORGANIZATION_CLASS_MIN = 0.25
/** Runs each side needs before a verdict. */
export const ORGANIZATION_MIN_RUNS = 5
/** Share of turns that go to the other side while comparing. */
export const ORGANIZATION_CONTROL_RATE = 0.2
/** Share once a verdict is in. */
export const ORGANIZATION_CONCLUDED_CONTROL_RATE = 0.1
/** What 100 % more cost than the class's team mean takes off a sampled success rate. */
export const ORGANIZATION_COST_WEIGHT = 0.1
/** The organizations every class may try. */
export const BUILT_IN_ORGANIZATIONS: readonly OrganizationName[] = ['lead-checker', 'plan-build-review', 'explore-then-build']

const Z90 = 1.645
const MAX_BETA_DRAWS = 400

/** One line of `runs.jsonl`. */
export type OrganizationLogLine = ({ readonly type: 'run' } & OrganizationRun) | { readonly type: 'rework'; readonly sessionId: string; readonly at: string }

/** A recorded run with what later lines said about it. */
export interface FoldedRun extends OrganizationRun {
  readonly reworked: boolean
}

/** Pure: runs in order, each marked when a later rework line names its session (only the session's latest run before it). */
export function foldOrganizationLog(lines: readonly OrganizationLogLine[]): FoldedRun[] {
  const runs: FoldedRun[] = []
  const latest = new Map<string, number>()
  for (const line of lines) {
    if (line.type === 'run') {
      const { type: _type, ...run } = line
      latest.set(run.sessionId, runs.length)
      runs.push({ ...run, reworked: false })
    } else {
      const index = latest.get(line.sessionId)
      if (index !== undefined) runs[index] = { ...runs[index]!, reworked: true }
    }
  }
  return runs
}

/** Pure: whether a run went well. */
export function wentWell(run: FoldedRun): boolean {
  return run.completed && !run.reworked && run.corrections === 0 && (run.checks === undefined || run.checks.passed === run.checks.total)
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

/** Pure: what a task of `key` should do, given every recorded run. */
export function suggestOrganization(key: readonly string[], runs: readonly FoldedRun[], random: () => number): OrganizationSuggestion {
  const classId = classFor(key, runs) ?? randomUUID()
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
    ...(decision === 'team' ? { organization: pickOrganization(mine.filter(run => run.decision === 'team'), random) } : {}),
  }
}

/** Pure: one line per class with at least two runs, most runs first. */
export function summarizeOrganizations(runs: readonly FoldedRun[]): OrganizationClassSummary[] {
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
    out.push({
      classId,
      keywords,
      soloRuns: solo.n,
      teamRuns: team.n,
      verdict: classVerdict(members),
      ...(organization === undefined ? {} : { organization }),
      ...(solo.n === 0 ? {} : { soloGood: solo.good / solo.n }),
      ...(team.n === 0 ? {} : { teamGood: team.good / team.n }),
      ...(solo.n > 0 && team.n > 0 && soloUsd > 0 ? { costChange: team.usd / team.n / soloUsd - 1 } : {}),
    })
  }
  return out.sort((l, r) => r.soloRuns + r.teamRuns - (l.soloRuns + l.teamRuns))
}

/** The library in `<home>/organizations/runs.jsonl` (append-only). */
export class OrganizationLibrary implements OrganizationMemory {
  readonly #file: string
  readonly #directory: string
  readonly #readOnly: () => Promise<boolean>
  readonly #now: () => Date

  constructor(directory: string, options: { readonly readOnly?: () => Promise<boolean>; readonly now?: () => Date } = {}) {
    this.#directory = directory
    this.#file = join(directory, 'runs.jsonl')
    this.#readOnly = options.readOnly ?? (async () => false)
    this.#now = options.now ?? (() => new Date())
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
        if (value.type === 'run' || value.type === 'rework') out.push(value)
      } catch {
        // a torn last line
      }
    }
    return out
  }

  async runs(): Promise<FoldedRun[]> {
    return foldOrganizationLog(await this.lines())
  }

  async suggest(input: { readonly text: string; readonly random?: () => number }): Promise<OrganizationSuggestion> {
    return suggestOrganization(similarityKey(input.text), await this.runs(), input.random ?? Math.random)
  }

  async #append(line: OrganizationLogLine): Promise<void> {
    if (await this.#readOnly()) return
    await mkdir(this.#directory, { recursive: true })
    await appendFile(this.#file, `${JSON.stringify(line)}\n`, 'utf8')
  }

  async record(run: Omit<OrganizationRun, 'id' | 'at'>): Promise<void> {
    await this.#append({ type: 'run', id: randomUUID(), at: this.#now().toISOString(), ...run })
  }

  async noteRework(input: { readonly sessionId: string }): Promise<void> {
    if (!(await this.runs()).some(run => run.sessionId === input.sessionId)) return
    await this.#append({ type: 'rework', sessionId: input.sessionId, at: this.#now().toISOString() })
  }

  async summary(): Promise<OrganizationClassSummary[]> {
    return summarizeOrganizations(await this.runs())
  }
}
