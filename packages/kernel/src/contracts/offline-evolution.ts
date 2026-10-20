/**
 * ADR 0018 decision 6, ADR 0026: layer 3, offline evolution. A run searches
 * versions of the learnable parts of the harness on the practice set and
 * recommends one only when it beats the starting version on held-out
 * cases (ADR 0019 decision 4). It never runs unless the user approved its
 * cost cap, and its result takes effect only after the user approves it.
 *
 * Adapted from what the compared systems do (design notes,
 * `evolution-layer2-3-design.md` §3): GEPA's per-case Pareto front with
 * frequency sampling and minibatch acceptance, DGM's `1 / (1 + children)`
 * downweighting, staged evaluation (minibatch → selection → holdout), DSPy's
 * and ADAS's rejected-edit history in the proposal, and MASS's rule that
 * the evaluator sits outside what is learned.
 *
 * Pure: shapes, limits, the candidate check, parent selection, the paired
 * bootstrap and a persistable generator. `@nexgent/evolve` runs it.
 * Legacy, kept only to read old projects (`docs/spec/data-formats.md` §旧格式（只为读旧项目）).
 */

/** `<NEXGENT_HOME>/offline-runs/`: one directory per run. */
export const OFFLINE_RUNS_DIR = 'offline-runs'
/** A run's state file. */
export const OFFLINE_RUN_FILE = 'run.json'
/** Creating this file in a run's directory stops it at the next stage boundary. */
export const OFFLINE_STOP_FILE = 'stop'
/** `<NEXGENT_HOME>/offline-runs/applied.json`: the version the user approved, in force for every project (ADR 0027). */
export const OFFLINE_APPLIED_FILE = 'applied.json'
/** `<copy>/.nexgent/offline-candidate.json`: the candidate a replay copy of an offline run works under (read only in a trial copy). */
export const OFFLINE_CANDIDATE_FILE = 'offline-candidate.json'

/** The learnable parts of v1. */
export type OfflineComponent = 'execution-guidance' | 'retrieval'

/** Every {@link OfflineComponent}, in the round-robin order. */
export const OFFLINE_COMPONENTS: readonly OfflineComponent[] = ['execution-guidance', 'retrieval']

/**
 * What a run may never change (ADR 0018 decision 6): a candidate carrying
 * any of these fields is refused. The evaluator, rubric and practice set
 * are outside what the run learns, so it cannot game them.
 */
export const OFFLINE_FROZEN_FIELDS = ['permissions', 'approvals', 'sandbox', 'costCaps', 'budget', 'learning', 'evaluator', 'rubric', 'practice', 'model'] as const

/** Retrieval parameters of the handbook and the skill library. */
export interface OfflineRetrievalParams {
  /** Handbook entries retrieved per task. */
  readonly handbookTopK: number
  /** Share of an entry's self-score a task must reach. */
  readonly handbookMinCoverage: number
  /** Distinct terms a task and an entry must share. */
  readonly handbookMinSharedTerms: number
  /** Active learned skills drawn per task. */
  readonly skillMaxActive: number
}

/** Bounds of each retrieval parameter: `[min, max, integer]`. */
export const OFFLINE_RETRIEVAL_BOUNDS: { readonly [K in keyof OfflineRetrievalParams]: readonly [number, number, boolean] } = {
  handbookTopK: [1, 8, true],
  handbookMinCoverage: [0.05, 0.5, false],
  handbookMinSharedTerms: [1, 4, true],
  skillMaxActive: [0, 3, true],
}

/** The retrieval parameters in force when no offline version was applied (the product's constants). */
export const DEFAULT_OFFLINE_RETRIEVAL: OfflineRetrievalParams = {
  handbookTopK: 5,
  handbookMinCoverage: 0.2,
  handbookMinSharedTerms: 2,
  skillMaxActive: 2,
}

/** One version of the learnable parts. */
export interface OfflineCandidate {
  /** Guidance given once at the start of every root task (ADR 0027); may be empty. */
  readonly executionGuidance: string
  readonly retrieval: OfflineRetrievalParams
}

/** Bounds and defaults of a run. */
export const OFFLINE_LIMITS = {
  maxGuidanceChars: 4000,
  /** Cases each parent and child run in one iteration. */
  minibatchSize: 3,
  /** A child may be worse than its parent on at most this many minibatch cases and still be accepted. */
  maxWorseOnMinibatch: 1,
  maxSelectionCases: 12,
  maxHoldoutCases: 20,
  defaultMaxIterations: 10,
  /** Iterations in a row without an accepted child that end the search. */
  defaultPatience: 4,
  /** The default cost cap is the estimate times this. */
  capFactor: 1.5,
  /** Estimated dollars of one case run when the history has none. */
  defaultUsdPerRun: 0.5,
  /** Estimated dollars of one proposal request. */
  proposalUsd: 0.05,
  holdoutRepeats: 1,
  bootstrapResamples: 2000,
  /** A generic (guard) case may be worse on average by at most this. */
  guardTolerance: 0.05,
  /** Rejected edits shown to a proposal. */
  rejectedShown: 6,
} as const

/** Why a candidate is refused. */
export type OfflineCandidateProblem = string

/**
 * Check a candidate (pure): exactly the two parts, no frozen field, the
 * guidance within its limit and every retrieval parameter within its
 * bounds. Returns the problems; empty means it is valid.
 */
export function offlineCandidateProblems(value: unknown): OfflineCandidateProblem[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['a candidate is an object']
  const record = value as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(record)) {
    if ((OFFLINE_FROZEN_FIELDS as readonly string[]).includes(key)) problems.push(`${key} is frozen and may not be changed`)
    else if (key !== 'executionGuidance' && key !== 'retrieval') problems.push(`${key} is not a learnable part`)
  }
  if (typeof record.executionGuidance !== 'string') problems.push('executionGuidance must be text')
  else if ([...record.executionGuidance].length > OFFLINE_LIMITS.maxGuidanceChars) problems.push(`executionGuidance is longer than ${OFFLINE_LIMITS.maxGuidanceChars} characters`)
  const retrieval = record.retrieval
  if (retrieval === null || typeof retrieval !== 'object' || Array.isArray(retrieval)) {
    problems.push('retrieval must be an object')
  } else {
    const params = retrieval as Record<string, unknown>
    for (const key of Object.keys(params)) if (!(key in OFFLINE_RETRIEVAL_BOUNDS)) problems.push(`retrieval.${key} is not a learnable parameter`)
    for (const [key, [min, max, integer]] of Object.entries(OFFLINE_RETRIEVAL_BOUNDS)) {
      const n = params[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) problems.push(`retrieval.${key} must be ${integer ? 'an integer' : 'a number'} in ${min}–${max}`)
    }
  }
  return problems
}

/** One version in a run's archive. Scores are per selection case, 0–1. */
export interface OfflineArchiveEntry {
  /** 0 is the starting version. */
  readonly id: number
  readonly parentId?: number
  /** The part the proposal changed. */
  readonly component?: OfflineComponent
  readonly candidate: OfflineCandidate
  readonly scores: Readonly<Record<string, number>>
  readonly children: number
  readonly createdAt: string
}

/** A proposal the minibatch refused (shown to later proposals for the same part). */
export interface OfflineRejectedEdit {
  readonly at: string
  readonly parentId: number
  readonly component: OfflineComponent
  /** The proposed value, cut to 600 characters. */
  readonly proposal: string
  readonly reason: string
}

/** Where a run stands. */
export type OfflineRunStatus = 'awaiting-approval' | 'running' | 'stopped' | 'awaiting-user'

/** Why a run stopped before its end. */
export type OfflineStopReason = 'budget' | 'stop-file' | 'aborted' | 'error'

/** The held-out comparison of the best version with the starting one. */
export interface OfflineHoldout {
  /** Scores per case and repeat. */
  readonly seed: Readonly<Record<string, readonly number[]>>
  readonly best: Readonly<Record<string, readonly number[]>>
  readonly meanDiff: number
  /** Two-level (case, repeat) bootstrap 95% interval of the mean paired difference. */
  readonly ciLow: number
  readonly ciHigh: number
  /** Mean paired difference on generic cases; absent without any. */
  readonly guardDiff?: number
}

/** A finished run's conclusion. */
export interface OfflineRunResult {
  /** `recommended`: the best version beat the start on held-out cases; it still needs the user's approval. */
  readonly verdict: 'recommended' | 'no-better'
  readonly bestId: number
  readonly detail: string
  readonly holdout?: OfflineHoldout
}

/** What a run is set up with before it is approved. */
export interface OfflineRunPlan {
  readonly runId: string
  readonly createdAt: string
  readonly seed: number
  /** Case ids by stage. Minibatch cases come from `train`, selection from `selection`, holdout from `holdout`, guard from `guard`. */
  readonly cases: { readonly minibatch: readonly string[]; readonly selection: readonly string[]; readonly holdout: readonly string[]; readonly guard: readonly string[] }
  readonly maxIterations: number
  readonly patience: number
  readonly holdoutRepeats: number
  readonly estimate: { readonly caseRuns: number; readonly proposals: number; readonly usdPerRun: number; readonly usd: number }
  readonly capUsd: number
  /** Hash of the fields above (cases, seed, limits); a run whose plan no longer matches it does not resume. */
  readonly planHash: string
}

/** `run.json`. */
export interface OfflineRunState {
  readonly formatVersion: 1
  readonly plan: OfflineRunPlan
  readonly status: OfflineRunStatus
  readonly approval?: { readonly at: string; readonly capUsd: number }
  readonly archive: readonly OfflineArchiveEntry[]
  readonly rejected: readonly OfflineRejectedEdit[]
  /** The generator's state after the last finished stage. */
  readonly rng: number
  /** Iterations finished. */
  readonly iteration: number
  /** Finished iterations in a row without an accepted child. */
  readonly sinceAccepted: number
  /** Index into {@link OFFLINE_COMPONENTS} of the next part per parent id. */
  readonly componentCursor: Readonly<Record<string, number>>
  /** Estimated dollars spent so far (case runs and proposals). */
  readonly spentUsd: number
  readonly caseRuns: number
  readonly stop?: { readonly reason: OfflineStopReason; readonly detail: string }
  readonly result?: OfflineRunResult
  /** The user's answer to a finished run (ADR 0027): `applied` wrote the best version to `applied.json`. */
  readonly decision?: { readonly outcome: 'applied' | 'declined'; readonly at: string }
  readonly updatedAt: string
}

/** `applied.json` (ADR 0027): the offline version in force for every project of the user. */
export interface OfflineAppliedProfile {
  readonly formatVersion: 1
  readonly runId: string
  /** Archive id of the version in its run. */
  readonly versionId: number
  readonly candidate: OfflineCandidate
  readonly appliedAt: string
}

// ---------------------------------------------------------------------------
// Pure search helpers
// ---------------------------------------------------------------------------

/** One step of mulberry32: the value in [0, 1) and the next state. */
export function offlineRandom(state: number): { readonly value: number; readonly state: number } {
  const next = (state + 0x6d2b79f5) >>> 0
  let t = next
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next }
}

/** A generator over a mutable state holder (for a stage; persist `state` after it). */
export function offlineRng(holder: { state: number }): () => number {
  return () => {
    const { value, state } = offlineRandom(holder.state)
    holder.state = state
    return value
  }
}

/** Shuffle a copy (Fisher–Yates). */
export function offlineShuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * GEPA × DGM parent weights (pure): for each selection case, the entries
 * with the best score on it form its front; entries dominated by another
 * front member (at least as good everywhere, better somewhere) are
 * removed; an entry's weight is the number of cases whose front it is on,
 * divided by `1 + children`. Entries on no front weigh 0; when every
 * weight is 0, all entries weigh equally.
 */
export function offlineParentWeights(archive: readonly OfflineArchiveEntry[], caseIds: readonly string[]): Map<number, number> {
  const score = (entry: OfflineArchiveEntry, caseId: string) => entry.scores[caseId] ?? 0
  const fronts = new Map<number, number>()
  const dominated = (a: OfflineArchiveEntry, b: OfflineArchiveEntry) => caseIds.every(id => score(b, id) >= score(a, id)) && caseIds.some(id => score(b, id) > score(a, id))
  const onFront = new Set<number>()
  const perCase = caseIds.map(caseId => {
    const best = Math.max(...archive.map(entry => score(entry, caseId)))
    return archive.filter(entry => score(entry, caseId) === best)
  })
  for (const front of perCase) for (const entry of front) onFront.add(entry.id)
  const survivors = archive.filter(entry => onFront.has(entry.id) && !archive.some(other => other.id !== entry.id && onFront.has(other.id) && dominated(entry, other)))
  const alive = new Set(survivors.map(entry => entry.id))
  for (const front of perCase) for (const entry of front) if (alive.has(entry.id)) fronts.set(entry.id, (fronts.get(entry.id) ?? 0) + 1)
  const weights = new Map<number, number>()
  let total = 0
  for (const entry of archive) {
    const weight = (fronts.get(entry.id) ?? 0) / (1 + entry.children)
    weights.set(entry.id, weight)
    total += weight
  }
  if (total === 0) for (const entry of archive) weights.set(entry.id, 1)
  return weights
}

/** Draw a parent by {@link offlineParentWeights}. */
export function offlineSelectParent(archive: readonly OfflineArchiveEntry[], caseIds: readonly string[], random: () => number): OfflineArchiveEntry {
  const weights = offlineParentWeights(archive, caseIds)
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  let point = random() * total
  for (const entry of archive) {
    point -= weights.get(entry.id) ?? 0
    if (point < 0) return entry
  }
  return archive.at(-1)!
}

/** The mean of an entry's selection scores (missing cases count 0). */
export function offlineMeanScore(entry: Pick<OfflineArchiveEntry, 'scores'>, caseIds: readonly string[]): number {
  return caseIds.length === 0 ? 0 : caseIds.reduce((sum, id) => sum + (entry.scores[id] ?? 0), 0) / caseIds.length
}

/**
 * Two-level paired bootstrap (pure): resample cases, then repeats within
 * each drawn case, and take the mean difference `best − seed`. Returns the
 * observed mean and the 2.5% and 97.5% quantiles.
 */
export function offlinePairedBootstrap(
  seed: Readonly<Record<string, readonly number[]>>,
  best: Readonly<Record<string, readonly number[]>>,
  random: () => number,
  resamples: number = OFFLINE_LIMITS.bootstrapResamples,
): { readonly meanDiff: number; readonly ciLow: number; readonly ciHigh: number } {
  const cases = Object.keys(seed).filter(id => (seed[id]?.length ?? 0) > 0 && (best[id]?.length ?? 0) > 0)
  if (cases.length === 0) return { meanDiff: 0, ciLow: 0, ciHigh: 0 }
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!
  const meanDiff = mean(cases.map(id => mean(best[id]!) - mean(seed[id]!)))
  const draws: number[] = []
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0
    for (let c = 0; c < cases.length; c += 1) {
      const id = pick(cases)
      const s = seed[id]!
      const b = best[id]!
      let ds = 0
      let db = 0
      for (let k = 0; k < s.length; k += 1) ds += pick(s)
      for (let k = 0; k < b.length; k += 1) db += pick(b)
      sum += db / b.length - ds / s.length
    }
    draws.push(sum / cases.length)
  }
  draws.sort((a, b) => a - b)
  const quantile = (q: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))]!
  return { meanDiff, ciLow: quantile(0.025), ciHigh: quantile(0.975) }
}
