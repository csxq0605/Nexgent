/**
 * ADR 0023: who decides whether a handbook entry is useful. The executing
 * model's own votes (`handbook_mark`, and reflection votes grounded only in
 * the same model's self-evaluation) count as “used” or “said it misled”,
 * never as “useful”. An entry moves from trial to active only on a
 * randomized exposure comparison: when retrieval finds a trial entry for a
 * root task, a coin with {@link HANDBOOK_EVIDENCE.trialShowProbability}
 * decides whether the model gets it, both draws are recorded, and the
 * task's outcome comes only from the user, deterministic checks or the
 * external review.
 *
 * Both records live in the handbook directory's `usage.jsonl` (next to
 * `ops.jsonl`, written by `@nexgent/capabilities`): the exposure is the
 * existing `hit` line with a `draw`, the outcome is a new `outcome` line per
 * root task. `ops.jsonl` keeps its five operations; an entry's `helpful` /
 * `harmful` counts now read as “used” / “said it misled”.
 *
 * Pure: shapes, constants and the decision rule; storage and injection are
 * implemented downstream. Normative text: `docs/spec/data-formats.md`
 * §经验手册 “使用记录” and “随机注入对照”.
 */
import type { HandbookEntry, HandbookEntryStatus } from './handbook.js'

/**
 * ADR 0023 constants, frozen with the ADR (change them with a new ADR).
 * Probabilities are the chance that a retrieved entry is given.
 */
export const HANDBOOK_EVIDENCE = {
  /** A trial entry that passed retrieval is given with this probability. */
  trialShowProbability: 0.5,
  /** At most this many trial entries are drawn for one root task. */
  maxTrialPerTask: 1,
  /** At most this many active entries are given to one root task. */
  maxActivePerTask: 4,
  /** An active entry is still held back with probability 1 − this, to catch decline. */
  activeShowProbability: 0.9,
  /** Tasks with a known outcome each arm needs before a trial entry may be enabled. */
  activateMinPerArm: 3,
  /** Shown tasks with a known outcome needed before an entry may be retired for doing worse. */
  retireMinShown: 4,
  /** Retire when the shown mean is below the held-back mean by more than this. */
  retireMargin: 0.1,
} as const

/** What the coin decided for one retrieved entry. */
export type HandbookDraw = 'shown' | 'held-back'

/** Every {@link HandbookDraw}. */
export const HANDBOOK_DRAWS: readonly HandbookDraw[] = ['shown', 'held-back']

/**
 * Where an outcome comes from. Only these count (ADR 0023 decision 2): the
 * user's explicit signal, a deterministic check, or the external review on
 * a calibration sample. The same model's self-evaluation and votes are not
 * outcome evidence, so there is no value for them.
 */
export type HandbookOutcomeEvidence = 'user-rating' | 'user-comment' | 'user-revert' | 'check' | 'external-review'

/** Every {@link HandbookOutcomeEvidence}. */
export const HANDBOOK_OUTCOME_EVIDENCE: readonly HandbookOutcomeEvidence[] = ['user-rating', 'user-comment', 'user-revert', 'check', 'external-review']

/** Evidence from the user (grade 甲): one negative signal is enough to retire. */
export const HANDBOOK_USER_EVIDENCE: readonly HandbookOutcomeEvidence[] = ['user-rating', 'user-comment', 'user-revert']

interface HandbookUsageBase {
  readonly formatVersion: 1
  /** ISO-8601 UTC. */
  readonly at: string
  readonly projectId: string
  /** The root session. */
  readonly sessionId: string
}

/** A root task's turn asked the handbook. */
export interface HandbookUsageTurn extends HandbookUsageBase {
  readonly kind: 'turn'
}

/**
 * Retrieval found an entry for a root task. Written in the file the entry
 * lives in. `draw` is present only when the coin decided (ADR 0023); then
 * `given` equals `draw === 'shown'` and `showProbability` is the chance it
 * had. A hit without `draw` (older lines, or an entry left out by the
 * per-task limits) is not exposure evidence.
 */
export interface HandbookUsageHit extends HandbookUsageBase {
  readonly kind: 'hit'
  readonly entryId: string
  readonly given: boolean
  readonly taskId?: string
  readonly status?: Exclude<HandbookEntryStatus, 'retired'>
  readonly draw?: HandbookDraw
  readonly showProbability?: number
}

/**
 * The outcome of a root task, written to every usage file that has a drawn
 * hit for its session. A later line for the same session replaces an
 * earlier one (a user rating can arrive after the checks).
 */
export interface HandbookUsageOutcome extends HandbookUsageBase {
  readonly kind: 'outcome'
  readonly taskId: string
  /** 0–1: the combined score of the evidence below. */
  readonly score: number
  /** At least one; never the same model's self-evaluation. */
  readonly evidence: readonly HandbookOutcomeEvidence[]
  /** The user explicitly rejected the result (low rating, a complaint, reverting or deleting it). */
  readonly userNegative?: boolean
}

/** One line of a handbook directory's `usage.jsonl`. */
export type HandbookUsageRecord = HandbookUsageTurn | HandbookUsageHit | HandbookUsageOutcome

/** The `kind` vocabulary of `usage.jsonl`. */
export type HandbookUsageKind = HandbookUsageRecord['kind']

/** Every {@link HandbookUsageKind}. */
export const HANDBOOK_USAGE_KINDS: readonly HandbookUsageKind[] = ['turn', 'hit', 'outcome']

/** One entry's randomized evidence. Means are `undefined` with no tasks in that arm. */
export interface HandbookExposureEvidence {
  /** Root tasks it was drawn and shown to, with a known outcome. */
  readonly shown: number
  /** Root tasks it was drawn and held back from, with a known outcome. */
  readonly heldBack: number
  readonly shownMean?: number
  readonly heldBackMean?: number
  /** A task it was shown to ended with an explicit negative user signal. */
  readonly userNegative: boolean
}

/**
 * Pure: the randomized evidence for one entry from its usage file. Only
 * drawn hits count; a session counts once (its first drawn hit); the outcome
 * is the session's last outcome line. Sessions without an outcome are
 * unknown and left out.
 */
export function handbookExposureEvidence(entryId: string, records: readonly HandbookUsageRecord[]): HandbookExposureEvidence {
  const draws = new Map<string, HandbookDraw>()
  const outcomes = new Map<string, HandbookUsageOutcome>()
  for (const record of records) {
    if (record.kind === 'hit' && record.entryId === entryId && record.draw !== undefined && !draws.has(record.sessionId)) draws.set(record.sessionId, record.draw)
    else if (record.kind === 'outcome' && record.evidence.length > 0) outcomes.set(record.sessionId, record)
  }
  const shown: number[] = []
  const held: number[] = []
  let userNegative = false
  for (const [sessionId, draw] of draws) {
    const outcome = outcomes.get(sessionId)
    if (outcome === undefined) continue
    if (draw === 'shown') {
      shown.push(outcome.score)
      if (outcome.userNegative === true) userNegative = true
    } else {
      held.push(outcome.score)
    }
  }
  const mean = (xs: readonly number[]): number | undefined => (xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length)
  const shownMean = mean(shown)
  const heldBackMean = mean(held)
  return {
    shown: shown.length,
    heldBack: held.length,
    ...(shownMean === undefined ? {} : { shownMean }),
    ...(heldBackMean === undefined ? {} : { heldBackMean }),
    userNegative,
  }
}

/**
 * ADR 0023 decision 4 (pure): the status an entry's randomized evidence
 * calls for. Retired or superseded stays retired. Retire on a negative user
 * signal, or when shown on at least {@link HANDBOOK_EVIDENCE.retireMinShown}
 * tasks its mean is below the held-back mean by more than
 * {@link HANDBOOK_EVIDENCE.retireMargin}. A trial entry is enabled when both
 * arms have {@link HANDBOOK_EVIDENCE.activateMinPerArm} known outcomes and
 * the shown mean is not lower. `misled` (the model or the reflection said
 * it misled since it was enabled) sends an active entry back to trial: the
 * cautious direction is the only one the model's own word can move.
 * Replaces the vote rule of {@link nextHandbookStatus} once implemented.
 */
export function handbookStatusFromEvidence(
  entry: Pick<HandbookEntry, 'status' | 'supersededBy'>,
  evidence: HandbookExposureEvidence,
  misled = false,
): HandbookEntryStatus {
  if (entry.status === 'retired' || entry.supersededBy !== undefined) return 'retired'
  if (evidence.userNegative) return 'retired'
  const { shownMean, heldBackMean } = evidence
  if (shownMean !== undefined && heldBackMean !== undefined) {
    if (evidence.shown >= HANDBOOK_EVIDENCE.retireMinShown && heldBackMean - shownMean > HANDBOOK_EVIDENCE.retireMargin) return 'retired'
    if (entry.status === 'trial' && evidence.shown >= HANDBOOK_EVIDENCE.activateMinPerArm && evidence.heldBack >= HANDBOOK_EVIDENCE.activateMinPerArm && shownMean >= heldBackMean) return 'active'
  }
  if (entry.status === 'active' && misled) return 'trial'
  return entry.status
}
