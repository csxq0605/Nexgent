/**
 * Coordinator: reflect on how a task was organized, without waiting for the
 * user (the user's own definition, 2026-10-20). After every team task the
 * library reads the run's {@link OrganizationProfile} and:
 *
 * 1. Judges the class's change under trial, when this run tried it
 *    ({@link judgeChange}): a run that did not go well, or cost the whole
 *    task more than {@link WHOLE_TOLERANCE} above the old median, reverts it at
 *    once; after {@link KEEP_AFTER} runs it is kept when every one of them
 *    beat the old median of the target value by {@link IMPROVE_BY}, and
 *    reverted otherwise. A reverted change is "tried, did not work" for that
 *    kind of part and cause, and is not tried again.
 * 2. With no change under trial, finds the hottest part ({@link findHotspot},
 *    deterministic rules on the measured data) and lists the changes that
 *    fit it. Coordinator step three: a model then reads that part's run
 *    records, judges the cause and picks one of them with a reason
 *    (`model-reflection.ts`, {@link withModelChoice}); when there is no
 *    model, or its call fails or its answer is not one of the listed
 *    changes, the first one in the fixed order is taken ({@link chooseAction}).
 *    The next similar team task gets the change as an instruction in its
 *    organization section. Keeping or reverting it is judged on the same
 *    data either way.
 *
 * Hotspot rules (any one makes a part hot; the hottest one wins):
 * - failures and retries together at least {@link FAILURE_MIN};
 * - its work was all rewritten or deleted later in the task (wasted);
 * - at least {@link HOTSPOT_SHARE} of the task's cost, or of its time, and
 *   above the median of the same kind of part on earlier similar tasks;
 * - a member idle (ready, waiting for a free slot) more than
 *   {@link IDLE_SHARE} of its own time.
 *
 * Nothing here depends on the kind of task; roles are matched across tasks
 * by their kind.
 */
import { randomUUID } from 'node:crypto'
import type {
  OrganizationChange,
  OrganizationChangeAction,
  OrganizationChangeNote,
  OrganizationChangeVerdict,
  OrganizationHotspot,
  OrganizationHotspotCause,
  OrganizationPart,
  OrganizationPartKind,
  OrganizationProfile,
  OrganizationShape,
} from '@nexgent/kernel'
import { ORGANIZATION_REASON_CHARS } from '@nexgent/kernel'

/** Share of the task's cost or time that makes a part hot. */
export const HOTSPOT_SHARE = 0.4
/** Idle time over a member's own time that makes it hot. */
export const IDLE_SHARE = 0.3
/** Failures plus retries that make a part hot. */
export const FAILURE_MIN = 2
/** How much a change must lower its target value (against the old median) to count as better. */
export const IMPROVE_BY = 0.2
/** Similar team tasks a change is tried on before it is kept. */
export const KEEP_AFTER = 2
/** How much more than the old median task cost a run under trial may cost. */
export const WHOLE_TOLERANCE = 0.2
/** Kept changes given to a task at most. */
export const MAX_KEPT_CHANGES = 3

/** What reflection needs of a recorded run. */
export interface ReflectedRun {
  readonly id: string
  /** Position of the run's line in the library (orders runs against verdicts). */
  readonly seq: number
  readonly decision: 'solo' | 'team'
  readonly usd: number
  readonly organization?: OrganizationShape
  readonly profile?: OrganizationProfile
  readonly change?: string
  /** It went well (completed, checks passed, no correction, no rework, review good when reviewed). */
  readonly good: boolean
}

/** Pure: the median (0 for none). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((l, r) => l - r)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

/** Pure: the value a cause measures on one part. */
export function partValue(part: OrganizationPart, cause: OrganizationHotspotCause, profile: OrganizationProfile): number {
  switch (cause) {
    case 'failures': return part.failures + part.retries
    case 'wasted': return part.wasted ? 1 : 0
    case 'cost': return part.share
    case 'time': return ratio(part.ms, profile.ms)
    case 'idle': return ratio(part.idleMs, part.ms)
  }
}

/**
 * Pure: the value of a cause over every part of one kind in a run (a role
 * split in two counts as both halves): costs and failures add up, time and
 * idle take the slowest part, wasted is whether any part was. A kind the run
 * no longer has measures 0 (its work moved elsewhere; the whole task's cost
 * guards against that).
 */
export function kindValue(profile: OrganizationProfile, kind: OrganizationPartKind, cause: OrganizationHotspotCause): number {
  const parts = profile.parts.filter(part => part.kind === kind)
  const values = parts.map(part => partValue(part, cause, profile))
  if (values.length === 0) return 0
  return cause === 'cost' || cause === 'failures' ? values.reduce((sum, value) => sum + value, 0) : Math.max(...values)
}

const CAUSE_ORDER: readonly OrganizationHotspotCause[] = ['failures', 'wasted', 'cost', 'time', 'idle']

/**
 * Pure: the hottest part of a run, or `undefined` when nothing is hot.
 * `earlier`: the profiles of earlier team runs of the same class (for the
 * "above the median of the same kind" condition; with none, the share alone
 * decides).
 */
export function findHotspot(profile: OrganizationProfile, earlier: readonly OrganizationProfile[]): OrganizationHotspot | undefined {
  let best: (OrganizationHotspot & { heat: number }) | undefined
  const consider = (part: OrganizationPart, cause: OrganizationHotspotCause, value: number, heat: number) => {
    if (best === undefined || heat > best.heat || (heat === best.heat && CAUSE_ORDER.indexOf(cause) < CAUSE_ORDER.indexOf(best.cause))) {
      best = { part: part.name, kind: part.kind, cause, value: Math.round(value * 1000) / 1000, heat }
    }
  }
  const aboveMedian = (part: OrganizationPart, of: (item: OrganizationPart, whole: OrganizationProfile) => number) => {
    const values = earlier.flatMap(other => other.parts.filter(item => item.kind === part.kind).map(item => of(item, other)))
    return values.length === 0 || of(part, profile) > median(values)
  }
  for (const part of profile.parts) {
    const failures = part.failures + part.retries
    if (failures >= FAILURE_MIN) consider(part, 'failures', failures, failures / FAILURE_MIN)
    if (part.wasted) consider(part, 'wasted', 1, 1 + part.share)
    if (part.share >= HOTSPOT_SHARE && aboveMedian(part, item => item.usd)) consider(part, 'cost', part.share, part.share / HOTSPOT_SHARE)
    const time = ratio(part.ms, profile.ms)
    if (time >= HOTSPOT_SHARE && aboveMedian(part, item => item.ms)) consider(part, 'time', time, time / HOTSPOT_SHARE)
    const idle = ratio(part.idleMs, part.ms)
    if (part.kind !== 'coordinator' && idle > IDLE_SHARE) consider(part, 'idle', idle, idle / IDLE_SHARE)
  }
  if (best === undefined) return undefined
  const { heat: _heat, ...hotspot } = best
  return hotspot
}

/** Pure: the changes that fit a hotspot, best first. */
export function actionsFor(hotspot: OrganizationHotspot, organization: OrganizationShape | undefined): OrganizationChangeAction[] {
  const role = organization?.roles.find(item => item.name === hotspot.part)
  const waitsForSameKind = role !== undefined && role.after.some(name => organization!.roles.find(item => item.name === name)?.kind === role.kind)
  const waits = role !== undefined && role.after.length > 0
  switch (hotspot.cause) {
    case 'failures':
      if (hotspot.kind === 'coordinator') return ['split']
      return waits ? ['full-handoff', 'sequence', 'split'] : ['sequence', 'split', 'full-handoff']
    case 'wasted':
      return ['merge', 'full-handoff']
    case 'cost':
      if (hotspot.kind === 'coordinator' || hotspot.kind === 'implement') return ['split', 'narrow-reading']
      return ['narrow-reading', 'merge']
    case 'time':
      if (hotspot.kind === 'coordinator') return ['split']
      if (hotspot.kind === 'implement') return waitsForSameKind ? ['parallelize', 'split'] : ['split', 'parallelize']
      return ['narrow-reading', 'split']
    case 'idle':
      return ['merge', 'sequence']
  }
}

/** Key of a change for "tried, did not work". */
export function changeKey(change: Pick<OrganizationChange, 'action' | 'target'>): string {
  return `${change.target.kind}:${change.target.cause}:${change.action}`
}

/** Pure: the first fitting change not already tried without success, or `undefined`. */
export function chooseAction(hotspot: OrganizationHotspot, organization: OrganizationShape | undefined, failed: ReadonlySet<string>): OrganizationChangeAction | undefined {
  return actionsFor(hotspot, organization).find(action => !failed.has(changeKey({ action, target: hotspot })))
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function whoText(kind: OrganizationPartKind): string {
  return kind === 'coordinator' ? 'you yourself' : kind === 'member' ? 'a delegated member' : kind === 'thread' ? 'a thread' : `the \`${kind}\` role`
}

function whatText(hotspot: OrganizationHotspot): string {
  switch (hotspot.cause) {
    case 'failures': return `failed or was retried ${hotspot.value} times`
    case 'wasted': return 'had all its work rewritten or deleted later'
    case 'cost': return `used ${percent(hotspot.value)} of the cost`
    case 'time': return `took ${percent(hotspot.value)} of the time`
    case 'idle': return `waited ${percent(hotspot.value)} of its time for a free slot`
  }
}

/** Pure: the model-facing instruction of a change (generic; no example task). */
export function changeInstruction(action: OrganizationChangeAction, hotspot: OrganizationHotspot, redoneBy?: string): string {
  const lead = `On the last similar task ${whoText(hotspot.kind)} ${whatText(hotspot)}. Change only this:`
  switch (action) {
    case 'narrow-reading':
      return `${lead} tell that role exactly which files and directories its part touches and to read only those, not the whole project.`
    case 'split':
      if (hotspot.kind === 'coordinator') return `${lead} give the largest piece of your own work to an \`implement\` member and keep only the short step everything else waits on.`
      return hotspot.kind === 'thread'
        ? `${lead} split that thread's part between two threads that change different files.`
        : `${lead} split that role's part between two members of the same kind that change different files and run at the same time.`
    case 'merge':
      return hotspot.cause === 'idle'
        ? `${lead} use fewer members: merge parts of the same kind so that no member waits for a free slot.`
        : `${lead} do not give that part ${hotspot.kind === 'thread' ? 'a thread' : 'a member'} of its own; ${redoneBy === undefined || redoneBy === 'coordinator' ? 'do it yourself' : `give it to the role that redid it (${redoneBy})`}.`
    case 'parallelize':
      return `${lead} start that role at the same time as the role of the same kind it waited for, with parts that change different files.`
    case 'sequence':
      if (hotspot.kind === 'thread') return `${lead} start a thread whose files another thread also changes only after that thread has ended, instead of at the same time.`
      return `${lead} run the parts that touch the same files one after another (list the earlier one in \`after\`) instead of at the same time.`
    case 'full-handoff':
      return `${lead} give that role the full results of the roles before it (file paths, decisions, what is left), not a summary.`
  }
}

/** Pure: a new change for a run's hotspot. */
export function newChange(input: {
  readonly classId: string
  readonly run: ReflectedRun
  readonly hotspot: OrganizationHotspot
  readonly action: OrganizationChangeAction
  /** Team runs of the class with profiles, this one included. */
  readonly history: readonly ReflectedRun[]
  readonly id?: string
}): OrganizationChange {
  const profiles = input.history.filter(run => run.profile !== undefined)
  const redoneBy = input.run.profile?.parts.find(part => part.name === input.hotspot.part)?.redoneBy
  return {
    id: input.id ?? randomUUID(),
    classId: input.classId,
    action: input.action,
    target: input.hotspot,
    baseline: Math.round(median(profiles.map(run => kindValue(run.profile!, input.hotspot.kind, input.hotspot.cause))) * 1000) / 1000,
    baselineUsd: Math.round(median(input.history.map(run => run.usd)) * 1e6) / 1e6,
    runId: input.run.id,
    instruction: changeInstruction(input.action, input.hotspot, redoneBy),
  }
}

/** Pure: whether a run under a change beat the change's baseline. */
export function improved(change: OrganizationChange, run: ReflectedRun): boolean {
  if (run.profile === undefined) return false
  const value = kindValue(run.profile, change.target.kind, change.target.cause)
  if (change.target.cause === 'wasted') return value === 0
  return value <= change.baseline * (1 - IMPROVE_BY) && (change.baseline > 0 || value === 0)
}

/** Pure: whether a run under a change kept the bottom line (went well, the whole task no costlier beyond the tolerance). */
export function keptBottomLine(change: OrganizationChange, run: ReflectedRun): boolean {
  return run.good && (change.baselineUsd <= 0 || run.usd <= change.baselineUsd * (1 + WHOLE_TOLERANCE))
}

/** Pure: the verdict on a change from the runs that tried it (in order), or `undefined` while it is still being tried. */
export function judgeChange(change: OrganizationChange, runs: readonly ReflectedRun[]): OrganizationChangeVerdict | undefined {
  const tried = runs.filter(run => run.change === change.id && run.decision === 'team')
  if (tried.some(run => !keptBottomLine(change, run))) return 'reverted'
  if (tried.length < KEEP_AFTER) return undefined
  return tried.slice(0, KEEP_AFTER).every(run => improved(change, run)) ? 'kept' : 'reverted'
}

/** A change line of the library with its verdict, when it has one. */
export interface ChangeState {
  readonly change: OrganizationChange
  /** Position of the change's line in the library. */
  readonly seq: number
  readonly verdict?: { readonly verdict: OrganizationChangeVerdict; readonly seq: number }
}

/** What reflecting on one recorded run wrote. */
export interface Reflection {
  readonly verdict?: { readonly changeId: string; readonly verdict: OrganizationChangeVerdict }
  /** The rule's change (`chosenBy: rule`); a model may pick another of {@link allowed} for the same hotspot ({@link withModelChoice}). */
  readonly change?: OrganizationChange
  /** With `change`: the changes that fit its hotspot and were not tried without success, best first. */
  readonly allowed?: readonly OrganizationChangeAction[]
}

/**
 * Pure: reflect on the latest run of a class. `runs`: the class's runs in
 * order, the new one last; `changes`: the class's changes in order.
 */
export function reflectOnRun(classId: string, runs: readonly ReflectedRun[], changes: readonly ChangeState[]): Reflection {
  const run = runs.at(-1)
  // A run still waiting for its threads has no profile yet (reflectedRun): nothing to reflect on.
  if (run === undefined || run.decision !== 'team' || run.profile === undefined) return {}
  const active = changes.find(state => state.verdict === undefined)
  let verdict: Reflection['verdict']
  if (active !== undefined) {
    if (run.change !== active.change.id) return {}
    const decided = judgeChange(active.change, runs)
    if (decided === undefined) return {}
    verdict = { changeId: active.change.id, verdict: decided }
  }
  const team = runs.filter(item => item.decision === 'team')
  const earlier = team.slice(0, -1).flatMap(item => (item.profile === undefined ? [] : [item.profile]))
  const hotspot = findHotspot(run.profile, earlier)
  const failed = new Set(changes.filter(state => state.verdict?.verdict === 'reverted' || (verdict?.verdict === 'reverted' && state.change.id === verdict.changeId)).map(state => changeKey(state.change)))
  const allowed = hotspot === undefined ? [] : actionsFor(hotspot, run.organization).filter(action => !failed.has(changeKey({ action, target: hotspot })))
  const action = allowed[0]
  const change = hotspot === undefined || action === undefined ? undefined : { ...newChange({ classId, run, hotspot, action, history: team }), chosenBy: 'rule' as const }
  return { ...(verdict === undefined ? {} : { verdict }), ...(change === undefined ? {} : { change, allowed }) }
}

/** What a model chose for a hotspot: one of the allowed changes, the cause it found and why this change. */
export interface ModelChoice {
  readonly action: OrganizationChangeAction
  readonly cause: string
  readonly reason: string
}

function clipText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ORGANIZATION_REASON_CHARS ? `${flat.slice(0, ORGANIZATION_REASON_CHARS - 1)}…` : flat
}

/**
 * Pure: the rule's change with the model's choice, or `undefined` when the
 * choice is not valid (an action outside `allowed`, or no cause or reason).
 * The target, baselines and judging stay the same: only the action, its
 * instruction (with the cause the model found) and the reason change.
 */
export function withModelChoice(change: OrganizationChange, allowed: readonly OrganizationChangeAction[], choice: ModelChoice | undefined, redoneBy?: string): OrganizationChange | undefined {
  if (choice === undefined || !allowed.includes(choice.action)) return undefined
  if (typeof choice.cause !== 'string' || typeof choice.reason !== 'string') return undefined
  const cause = clipText(choice.cause)
  const reason = clipText(choice.reason)
  if (cause === '' || reason === '') return undefined
  return {
    ...change,
    action: choice.action,
    instruction: `${changeInstruction(choice.action, change.target, redoneBy)} (Found cause: ${cause})`,
    chosenBy: 'model',
    cause,
    reason,
  }
}

/**
 * Pure: the team card's line for the next team task of a class: a verdict
 * no team task has shown yet (with the change tried now), or the change
 * under trial.
 */
export function changeNote(changes: readonly ChangeState[], runs: readonly Pick<ReflectedRun, 'seq' | 'decision'>[]): OrganizationChangeNote | undefined {
  const active = changes.find(state => state.verdict === undefined)
  const judged = changes.filter(state => state.verdict !== undefined).sort((l, r) => l.verdict!.seq - r.verdict!.seq).at(-1)
  const unseen = judged !== undefined && !runs.some(run => run.decision === 'team' && run.seq > judged.verdict!.seq)
  if (unseen) {
    return {
      status: judged!.verdict!.verdict,
      action: judged!.change.action,
      target: judged!.change.target,
      ...(active === undefined ? {} : { next: { action: active.change.action, target: active.change.target } }),
    }
  }
  return active === undefined ? undefined : { status: 'trying', action: active.change.action, target: active.change.target }
}

/** Pure: the class's latest team runs against its first ones (needs 4 team runs with profiles). */
export function sinceStart(runs: readonly ReflectedRun[]): { readonly costChange: number; readonly timeChange: number; readonly qualityHeld: boolean } | undefined {
  const team = runs.filter(run => run.decision === 'team' && run.profile !== undefined)
  if (team.length < 4) return undefined
  const size = Math.min(3, Math.floor(team.length / 2))
  const first = team.slice(0, size)
  const last = team.slice(-size)
  const cost = (items: readonly ReflectedRun[]) => median(items.map(run => run.usd))
  const time = (items: readonly ReflectedRun[]) => median(items.map(run => run.profile!.ms))
  const good = (items: readonly ReflectedRun[]) => items.filter(run => run.good).length / items.length
  const change = (now: number, then: number) => (then > 0 ? Math.round((now / then - 1) * 100) / 100 : 0)
  return { costChange: change(cost(last), cost(first)), timeChange: change(time(last), time(first)), qualityHeld: good(last) >= good(first) }
}
