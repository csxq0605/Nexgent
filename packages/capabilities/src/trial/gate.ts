// Adapted from Nexgent PR #4 runtime/packages/bundle/nexgent-app/src/architecture-trials.ts (archive/python-host): plan summary frozen in the receipt, three-way pass / fail / unknown results, a run that cannot be compared is unknown and never a failure.
/**
 * The gate `capability_trial` (`data-formats.md` §候选与门控, ADR 0005,
 * decisions 3–5). For one proposed candidate:
 *
 * 1. Build the replay set from the project's past root tasks (selection: the
 *    proposing task and the most similar ones; guard: the least similar;
 *    disjoint). Too little history: the gate waits and writes nothing.
 * 2. Claim the candidate (tried at most once), freeze the plan from the
 *    project's `capabilities` settings into `trial.start`.
 * 3. Run every case `repeats` times per arm, candidate bundle against the
 *    adopted bundle, each run in its own copy of the task's snapshot through
 *    the host's {@link TrialRunner} (a separate process in the product);
 *    the gate runs the recorded checks on the copy itself (ADR 0014: a
 *    recorded deliverable path the run did not use is checked on the file
 *    it presented instead). A run that does
 *    not complete is `unknown`. The trial budget is checked before every run
 *    and passed down as the run's per-task cap; running out stops the trial.
 * 4. On a check tie that the cost alone does not settle, the reviewer model
 *    compares the two arms' outputs per selection run (kept apart from the
 *    checks in the receipts). ADR 0015: it sees every changed and removed
 *    path (`runOutput`), and on a job's feedback task the feedback too.
 *    ADR 0016: every pair is asked in both orders (a vote counts only when
 *    both agree), and the reviewer sees the task's input files.
 * 5. `decideTrial` gives the verdict; the gate writes `trial.end`, then the
 *    decision: an adoption revision (`trigger: gate`), an awaiting-approval
 *    decision for a plugin (or, ADR 0007, a quality rise costing more than
 *    `costApprovalRatio` times the baseline), or a rejection. Rejected candidates and their
 *    receipts stay on disk.
 *
 * The gate reads its parameters from `.nexgent/config.json` (a candidate
 * bundle has no field that could change them).
 *
 * Step 5 (ADR 0006 decision 6): a candidate from an improvement job is
 * anchored on the job's feedback task (`selectionAnchor`); every run of a
 * case that carries feedback is followed by a feedback check (the reviewer
 * reads the run's output and the feedback, `trial.feedback`), counted into
 * that arm's quality by `decideTrial` and reported apart from the checks.
 * Replay runs of a job's candidate belong to the job's `trial` phase.
 * Costs carry the `estimatedUsd` the runner and reviewer give; ADR 0007:
 * the verdict's cost ratio is in those dollars (cache included) when both
 * arms have them, in tokens otherwise.
 *
 * ADR 0013 and 0014 (epoch `adr-0014`; ADR 0015: `adr-0015`; ADR 0016: `adr-0016`), an improvement job's candidate only: before
 * anything is replayed, its components are checked for the concrete values
 * of the job's task (`findInstanceLiterals`); a hit rejects the candidate
 * (`instance-literal`) without a trial. The selection cases other than the
 * feedback task that are like it (ADR 0014: their first messages overlap by
 * content words, `isSimilarTask`) are its similar cases: their deterministic checks are
 * tallied apart (`TrialTally.similar`) and may not get worse; with none, an
 * adopting verdict waits for the user (`no-similar-cases`).
 */
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addUsage,
  decideTrial,
  NexgentError,
  readProjectConfig,
  resolveProjectLayout,
  ZERO_USAGE,
  CAPABILITY_LIMITS,
  type ArmTally,
  type CandidateRecord,
  type CapabilityDecision,
  type CapabilityVersion,
  type FeedbackEntry,
  type ImproverComparisonParams,
  type LLMUsage,
  type ReplayCaseRef,
  type ReplaySet,
  type TaskCheck,
  type TrialArm,
  type TrialBudget,
  type TrialCost,
  type TrialPlan,
  type TrialReceipt,
  type TrialStatus,
  type TrialUnknownReason,
  type TrialVerdict,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { LocalDeliverableStore } from '@nexgent/tasking'
import { readCandidate } from '../candidates.js'
import { evaluatorEpoch } from './epoch.js'
import { candidateInstanceLiterals } from './literals.js'
import { selectionAnchor, type JobRunAttribution, type FeedbackCheckInput, type FeedbackCheckResult } from './feedback.js'
import type { Activation } from '../activation.js'
import { CapabilityStore } from '../capability-store.js'
import { runCheckSpecs } from './checks.js'
import { claimAttempt, releaseTrialLock, TrialReceiptWriter, wasAttempted, writeTrialLock } from './receipts.js'
import { prepareReplayProject } from './replay-project.js'
import { isSimilarTask } from './similar.js'
import { buildReplaySet, listReplayCases, type ReplayCase, type ReplayMessage } from './replay-set.js'

/** One replay run the host executes. */
export interface ReplayRunRequest {
  readonly trialId: string
  readonly arm: TrialArm
  readonly set: ReplaySet
  readonly caseId: string
  readonly repeat: number
  /** The run's own project copy. */
  readonly projectRoot: string
  /** The real project's ledgers directory: the run's records go there, with `trialId` and `arm`. */
  readonly ledgersDir: string
  /** User messages to send, in order, in one new session. */
  readonly messages: readonly ReplayMessage[]
  /** Deadline of the whole run. */
  readonly timeoutMs: number
  /**
   * Step 5: the improvement job whose candidate this is; the run's session
   * belongs to the job's `trial` phase. Step 6: with the job's pinned
   * improver and, in a comparison arm's copy, the meta job and the arm.
   */
  readonly improvement?: JobRunAttribution
}

/** How a run ended, as the runner reports it. */
export interface ReplayRunResult {
  /** `completed`: every turn ended (the gate then runs the checks). Anything else is `unknown`. */
  readonly outcome: 'completed' | 'cancelled' | 'budget' | 'error' | 'timeout'
  readonly detail?: string
  /** Sum of the run's model requests (members included). */
  readonly usage: LLMUsage
  readonly requestCount: number
  /** Display only (`@nexgent/llm` price table); absent counts as `unknown`. */
  readonly estimatedUsd?: number | 'unknown'
}

/** Runs one replay (the product starts a separate process per run). */
export interface TrialRunner {
  run(request: ReplayRunRequest, signal: AbortSignal): Promise<ReplayRunResult>
}

/**
 * What one arm produced, for the reviewer: the files the run created or
 * changed (text, truncated; at most {@link OUTPUT_FILES} with their
 * contents), and (ADR 0015) the paths of the other changed files and of the
 * snapshot files the run removed, so that a reviewer never mistakes a
 * shortened listing for missing work.
 */
export interface RunOutput {
  readonly files: readonly { readonly path: string; readonly text: string }[]
  /** Created or changed files whose contents are not shown (sorted; at most {@link OUTPUT_PATHS}). */
  readonly unshown?: readonly string[]
  /** How many created or changed files are not listed at all (beyond {@link OUTPUT_PATHS}). */
  readonly unlisted?: number
  /** Snapshot files the run removed (sorted; at most {@link OUTPUT_PATHS}). */
  readonly removed?: readonly string[]
  /** How many removed files are not listed (beyond {@link OUTPUT_PATHS}). */
  readonly removedUnlisted?: number
}

/** One reviewer question. */
export interface ReviewInput {
  readonly trialId: string
  readonly set: ReplaySet
  readonly caseId: string
  readonly repeat: number
  readonly messages: readonly ReplayMessage[]
  /** ADR 0015: the feedback of a job's feedback task (its standing preferences are part of what the user asked); absent for other cases. */
  readonly feedback?: readonly FeedbackEntry[]
  readonly candidate: RunOutput
  readonly baseline: RunOutput
  /**
   * ADR 0016: the project's files as the task started (the case's snapshot;
   * files the task's messages name first), so the reviewer can check the
   * attempts against their input.
   */
  readonly inputs: RunOutput
  /** ADR 0016: whether the candidate is shown as attempt A (the gate asks every pair in both orders). */
  readonly candidateFirst: boolean
}

/** The reviewer's answer. */
export interface ReviewResult {
  readonly preference: 'candidate' | 'baseline' | 'tie' | 'unknown'
  readonly reason: string
  readonly usage: LLMUsage
  readonly requestCount: number
  /** Display only; absent counts as `unknown`. */
  readonly estimatedUsd?: number | 'unknown'
}

/** The reviewer model (decision 5); its requests carry `trialId` without `arm`. */
export interface TrialReviewer {
  review(input: ReviewInput, settings: TrialPlan['reviewer'], signal: AbortSignal): Promise<ReviewResult>
  /** Step 5: the feedback check of one run; without it every feedback check is `unknown` (and the candidate is not adopted). */
  checkFeedback?(input: FeedbackCheckInput, settings: TrialPlan['reviewer'], signal: AbortSignal): Promise<FeedbackCheckResult>
}

/** Options of {@link runGate}. */
export interface GateOptions {
  readonly layout: WorkspaceLayout
  readonly candidateId: string
  readonly runner: TrialRunner
  /** Without one, a tie the cost does not settle rejects (`no-improvement`). */
  readonly reviewer?: TrialReviewer
  readonly signal?: AbortSignal
  /** Deadline of one run (default 30 minutes). */
  readonly runTimeoutMs?: number
  /** Parent directory of the run copies (default the OS temporary directory). */
  readonly tempRoot?: string
  /** Progress, one call per receipt line. */
  readonly onReceipt?: (receipt: TrialReceipt, progress: { readonly runsDone: number; readonly runsTotal: number }) => void
  /**
   * ADR 0016: the text of a file that is not UTF-8 (a spreadsheet, a
   * document), for the reviewer; the host supplies its document readers.
   * Absent or `undefined`: the file is shown as binary with its size.
   */
  readonly documentText?: (path: string, bytes: Uint8Array) => Promise<string | undefined> | string | undefined
  /** Called after the decision was written (the plugin appends the ledger's `capability.decision`). */
  readonly onDecision?: (decision: CapabilityDecision) => Promise<void> | void
  /** Diagnostics a receipt does not carry (why a run ended `unknown`); the product writes them to the gate's log. */
  readonly log?: (line: string) => void
  readonly now?: () => Date
  /**
   * Step 6: an improvement job's comparison parameters (its pinned
   * improver's); the counts never go below the project's
   * `capabilities.selectionCases` / `repeats`. Absent: the project's, by similarity.
   */
  readonly comparison?: ImproverComparisonParams
  /**
   * Step 6: the evaluator epoch the caller expects (a comparison arm: the
   * origin's). The gate runs in the epoch of the project's own settings;
   * when that differs it writes nothing and throws `improvement/epoch-mismatch`.
   */
  readonly epoch?: string
}

/** What {@link runGate} did. */
export type GateResult =
  /** Not enough replayable history: nothing was written; the gate can run again later. */
  | { readonly status: 'waiting'; readonly detail: string }
  /** The candidate was tried before, or already has a decision: nothing was written. */
  | { readonly status: 'skipped'; readonly detail: string }
  | { readonly status: 'decided'; readonly trialId: string; readonly verdict: TrialVerdict; readonly decision: CapabilityDecision }
  /** ADR 0013: an improvement job's candidate carries a concrete value of its task; rejected (`instance-literal`) without a trial. */
  | { readonly status: 'refused'; readonly decision: CapabilityDecision }

const RUN_TIMEOUT_MS = 30 * 60_000

/** A case as the plan freezes it. */
function planRef(item: ReplayCase): ReplayCaseRef {
  return {
    caseId: item.caseId,
    sessionId: item.sessionId,
    tree: item.tree,
    checks: item.checks,
    ...(item.throughTurn === undefined ? {} : { throughTurn: item.throughTurn }),
    ...(item.feedbackIds === undefined ? {} : { feedbackIds: item.feedbackIds }),
  }
}
/** Changed files shown to the reviewer with their contents. */
export const OUTPUT_FILES = 12
/** Characters of one file's contents shown to the reviewer. */
export const OUTPUT_CHARS = 6_000
/** Paths listed (without contents) per list: changed files not shown, removed files. */
export const OUTPUT_PATHS = 200

function tokensOf(usage: LLMUsage): number | 'unknown' {
  return typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? usage.inputTokens + usage.outputTokens : 'unknown'
}

function knownTokens(usage: LLMUsage): number {
  return (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) + (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0)
}

function cost(usage: LLMUsage, requestCount: number, estimatedUsd: number | 'unknown' = requestCount === 0 ? 0 : 'unknown'): TrialCost {
  return { usage, requestCount, estimatedUsd }
}

class CostTotal {
  usage: LLMUsage = ZERO_USAGE
  requests = 0
  usd: number | 'unknown' = 0
  add(usage: LLMUsage, requests: number, usd: number | 'unknown' | undefined): void {
    this.usage = addUsage(this.usage, usage)
    this.requests += requests
    if (requests > 0) this.usd = this.usd === 'unknown' || usd === undefined || usd === 'unknown' ? 'unknown' : this.usd + usd
  }
  get cost(): TrialCost {
    return cost(this.usage, this.requests, this.usd)
  }
}

function emptyTally(): ArmTally {
  return { passed: 0, failed: 0, unknown: 0 }
}

function bump(tally: ArmTally, status: TrialStatus): ArmTally {
  return status === 'pass' ? { ...tally, passed: tally.passed + 1 } : status === 'fail' ? { ...tally, failed: tally.failed + 1 } : { ...tally, unknown: tally.unknown + 1 }
}

type DocumentText = GateOptions['documentText']

/** A file's text for the reviewer: UTF-8, else (ADR 0016) the host's document reader, else a binary marker; truncated. */
async function fileText(path: string, bytes: Uint8Array, documentText: DocumentText): Promise<string> {
  let text: string | undefined
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = await Promise.resolve(documentText?.(path, bytes)).catch(() => undefined)
  }
  text ??= `(binary, ${bytes.byteLength} bytes)`
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n…(truncated)` : text
}

/**
 * ADR 0016: the project's files as a task started (its snapshot copy before
 * the run), for the reviewer: the files a task message names (by path or
 * file name) first, then the rest by path, at most {@link OUTPUT_FILES}.
 */
async function taskInputs(root: string, snapshot: ReadonlyMap<string, string>, messages: readonly ReplayMessage[], documentText: DocumentText): Promise<RunOutput> {
  const said = messages.map(message => message.text).join('\n')
  const named = (path: string) => said.includes(path) || said.includes(path.slice(path.lastIndexOf('/') + 1))
  const paths = [...snapshot.keys()].filter(path => !path.startsWith('.nexgent/')).sort((left, right) => Number(named(right)) - Number(named(left)) || (left < right ? -1 : left > right ? 1 : 0))
  const files: { path: string; text: string }[] = []
  for (const path of paths.slice(0, OUTPUT_FILES)) {
    const bytes = await readFile(join(root, ...path.split('/'))).catch(() => undefined)
    if (bytes !== undefined) files.push({ path, text: await fileText(path, bytes, documentText) })
  }
  const rest = paths.slice(OUTPUT_FILES)
  return {
    files,
    ...(rest.length === 0 ? {} : { unshown: rest.slice(0, OUTPUT_PATHS) }),
    ...(rest.length > OUTPUT_PATHS ? { unlisted: rest.length - OUTPUT_PATHS } : {}),
  }
}

/**
 * Files of the copy the run created or changed, for the reviewer (ADR 0015):
 * every changed path is found first; the first {@link OUTPUT_FILES} in path
 * order are shown with their (truncated) text, the rest by path, and the
 * snapshot files the run removed are listed too.
 */
export async function runOutput(root: string, before: ReadonlyMap<string, string>, documentText?: DocumentText): Promise<RunOutput> {
  const changed: string[] = []
  const present = new Set<string>()
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (['.nexgent', '.git', 'node_modules'].includes(entry.name)) continue
        await visit(join(directory, entry.name), path)
      } else if (entry.isFile()) {
        present.add(path)
        const bytes = await readFile(join(directory, entry.name)).catch(() => undefined)
        if (bytes === undefined) continue
        if (before.get(path) === createHash('sha256').update(bytes).digest('hex')) continue
        changed.push(path)
      }
    }
  }
  await visit(root, '')
  changed.sort()
  // Only the shown files are kept in memory: they are read again here.
  const files: { path: string; text: string }[] = []
  for (const path of changed.slice(0, OUTPUT_FILES)) {
    const bytes = await readFile(join(root, ...path.split('/'))).catch(() => undefined)
    if (bytes === undefined) continue
    files.push({ path, text: await fileText(path, bytes, documentText) })
  }
  const rest = changed.slice(OUTPUT_FILES)
  const gone = [...before.keys()].filter(path => !present.has(path) && !path.startsWith('.nexgent/')).sort()
  return {
    files,
    ...(rest.length === 0 ? {} : { unshown: rest.slice(0, OUTPUT_PATHS) }),
    ...(rest.length > OUTPUT_PATHS ? { unlisted: rest.length - OUTPUT_PATHS } : {}),
    ...(gone.length === 0 ? {} : { removed: gone.slice(0, OUTPUT_PATHS) }),
    ...(gone.length > OUTPUT_PATHS ? { removedUnlisted: gone.length - OUTPUT_PATHS } : {}),
  }
}

function remaining(budget: TrialBudget, spent: { tokens: number; requests: number }): TrialBudget | undefined {
  const tokens = budget.maxTokens === undefined ? undefined : budget.maxTokens - spent.tokens
  const requests = budget.maxRequests === undefined ? undefined : budget.maxRequests - spent.requests
  if ((tokens !== undefined && tokens <= 0) || (requests !== undefined && requests <= 0)) return undefined
  return { ...(tokens === undefined ? {} : { maxTokens: tokens }), ...(requests === undefined ? {} : { maxRequests: requests }) }
}

function unknownReason(outcome: ReplayRunResult['outcome']): TrialUnknownReason {
  return outcome === 'completed' ? 'error' : outcome
}

function ratioText(verdict: TrialVerdict): string {
  return verdict.costRatio === 'unknown' ? 'unknown' : `${verdict.costRatio.toFixed(3)}×`
}

function usdText(value: number | 'unknown'): string {
  return value === 'unknown' ? 'unknown' : value.toFixed(4)
}

function explain(verdict: TrialVerdict, tally: { selection: { candidate: ArmTally; baseline: ArmTally }; guard: { candidate: ArmTally; baseline: ArmTally }; similar?: { candidate: ArmTally; baseline: ArmTally } | 'none'; usd?: { candidate: number | 'unknown'; baseline: number | 'unknown' } }, review: { candidate: number; baseline: number; tie: number }, extra?: string): string {
  const usd = tally.usd
  const rate = (value: number) => `${Math.round(value * 100)}%`
  const parts = [
    `${verdict.outcome} (${verdict.reason}).`,
    `${verdict.feedbackPassRate === undefined ? 'Selection checks passed' : 'Quality (selection checks and feedback checks) passed'}: candidate ${rate(verdict.passRate.candidate)}, baseline ${rate(verdict.passRate.baseline)}`
      + ` (runs pass/fail/unknown ${tally.selection.candidate.passed}/${tally.selection.candidate.failed}/${tally.selection.candidate.unknown}`
      + ` vs ${tally.selection.baseline.passed}/${tally.selection.baseline.failed}/${tally.selection.baseline.unknown}).`,
    `Guard runs passed: candidate ${tally.guard.candidate.passed}, baseline ${tally.guard.baseline.passed}.`,
    ...(tally.similar === undefined
      ? []
      : tally.similar === 'none'
        ? ['Similar cases: none (no other selection task is like the feedback task by content words), so it was checked on the feedback task only.']
        : [`Similar cases (selection tasks other than the feedback task; deterministic checks only) passed: candidate ${rate(verdict.similarPassRate?.candidate ?? 0)}, baseline ${rate(verdict.similarPassRate?.baseline ?? 0)}`
          + ` (runs pass/fail/unknown ${tally.similar.candidate.passed}/${tally.similar.candidate.failed}/${tally.similar.candidate.unknown}`
          + ` vs ${tally.similar.baseline.passed}/${tally.similar.baseline.failed}/${tally.similar.baseline.unknown}).`]),
    ...(verdict.feedbackPassRate === undefined
      ? []
      : [`Feedback checks (reviewer model, separate from the deterministic checks) passed: candidate ${rate(verdict.feedbackPassRate.candidate)}, baseline ${rate(verdict.feedbackPassRate.baseline)}.`]),
    `Cost candidate/baseline (${verdict.costBasis === 'usd' ? 'estimated USD, cache included' : 'tokens'}): ${ratioText(verdict)}${usd === undefined ? '' : ` (about ${usdText(usd.candidate)} vs ${usdText(usd.baseline)} USD)`}.`,
    review.candidate + review.baseline + review.tie > 0
      ? `Reviewer model (separate from the checks): candidate ${review.candidate}, baseline ${review.baseline}, tie ${review.tie}${verdict.decidedByReview ? '; it decided this verdict' : ''}.`
      : 'No reviewer opinion was needed.',
    ...(extra === undefined ? [] : [extra]),
  ]
  return parts.join(' ')
}

/**
 * ADR 0016: one pair's vote from its two orders (candidate as A, then as B).
 * Both prefer the same attempt: that attempt. Either unknown: unknown (not
 * counted). Anything else, a tie or a flip with the order: a tie. Costs add up.
 */
export function bothOrders(candidateFirst: ReviewResult, baselineFirst: ReviewResult): ReviewResult {
  const preference = candidateFirst.preference === 'unknown' || baselineFirst.preference === 'unknown'
    ? 'unknown'
    : candidateFirst.preference === baselineFirst.preference ? candidateFirst.preference : 'tie'
  const usd = (value: ReviewResult['estimatedUsd']) => value ?? 'unknown'
  const estimatedUsd = usd(candidateFirst.estimatedUsd) === 'unknown' || usd(baselineFirst.estimatedUsd) === 'unknown'
    ? 'unknown'
    : (candidateFirst.estimatedUsd as number) + (baselineFirst.estimatedUsd as number)
  return {
    preference,
    reason: `Candidate as A: ${candidateFirst.preference} (${candidateFirst.reason}) Candidate as B: ${baselineFirst.preference} (${baselineFirst.reason})`.slice(0, 2_000),
    usage: addUsage(candidateFirst.usage, baselineFirst.usage),
    requestCount: candidateFirst.requestCount + baselineFirst.requestCount,
    estimatedUsd,
  }
}

/** Why an awaiting-approval verdict waits (every reason that applies). */
function approvalText(verdict: TrialVerdict, candidate: CandidateRecord, plan: TrialPlan): string {
  const reasons: string[] = []
  if (verdict.reason === 'no-similar-cases') reasons.push('It was checked on the feedback task only, with no similar past task to show it carries over (ADR 0013).')
  if (candidate.requiresApproval) reasons.push('The candidate contains a plugin.')
  const approvalRatio = plan.costApprovalRatio ?? 2
  if (verdict.passRate.candidate > verdict.passRate.baseline && verdict.costRatio !== 'unknown' && verdict.costRatio > approvalRatio) {
    reasons.push(`It checks better but costs ${ratioText(verdict)} the baseline, above the ${approvalRatio}× that adopts on its own (ADR 0007).`)
  }
  return `${reasons.join(' ')} It is adopted only after the user approves it.`
}

/** ADR 0014: the files a replay run presented (latest version of each of its deliverables, in presentation order). */
async function deliveredFiles(root: string): Promise<string[]> {
  const summaries = await new LocalDeliverableStore(resolveProjectLayout(root)).list().catch(() => [])
  return [...new Set(summaries.flatMap(summary => summary.versions.at(-1)?.files.map(file => file.path) ?? []))]
}

/**
 * Run the gate for one candidate. Never throws for a run that fails: such a
 * run is `unknown`. Throws only when the candidate cannot be read or the
 * project's files cannot be written.
 */
export async function runGate(options: GateOptions): Promise<GateResult> {
  const { layout } = options
  const now = options.now ?? (() => new Date())
  const capabilitiesDir = layout.capabilities
  const store = new CapabilityStore(capabilitiesDir, { now, ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }) })
  const candidate: CandidateRecord = await readCandidate(capabilitiesDir, options.candidateId)
  if ((await store.decisions()).some(decision => decision.candidateId === candidate.id)) {
    return { status: 'skipped', detail: `candidate ${candidate.id} already has a decision` }
  }
  if (await wasAttempted(capabilitiesDir, candidate.id)) return { status: 'skipped', detail: `candidate ${candidate.id} was tried before; a candidate is tried once` }

  const settings = (await readProjectConfig(layout.configFile)).config.capabilities
  // ADR 0008 decision 5: the evaluator is frozen into the plan as an epoch; a caller expecting another epoch gets no trial.
  const epoch = evaluatorEpoch(settings)
  if (options.epoch !== undefined && options.epoch !== epoch) {
    throw new NexgentError('improvement/epoch-mismatch', `the gate's evaluator epoch ${epoch.slice(0, 12)} is not the expected ${options.epoch.slice(0, 12)}; candidate ${candidate.id} was not tried`)
  }
  // ADR 0013 decision 2: a component carrying a concrete value of the job's task is rejected before anything is replayed.
  const literals = await candidateInstanceLiterals(layout, candidate)
  if (literals !== undefined && literals.length > 0) {
    if (!(await claimAttempt(capabilitiesDir, candidate.id))) return { status: 'skipped', detail: `candidate ${candidate.id} is being or was tried by another process` }
    const version = (await store.activation()).version
    const shown = literals.slice(0, CAPABILITY_LIMITS.maxInstanceLiterals)
    const decision = await store.recordDecision({
      outcome: 'rejected',
      reason: 'instance-literal',
      trigger: 'gate',
      candidateId: candidate.id,
      fromVersion: version,
      toVersion: version,
      instanceLiterals: shown,
      detail: `rejected (instance-literal), not replayed. The proposed components carry concrete values of the improvement job's own task (its feedback or its deliverables) that no two past tasks of the project share, so they would fit that one task rather than the next: `
        + `${shown.map(hit => `${hit.value} in ${hit.path} (from ${hit.source})`).join('; ')}${literals.length > shown.length ? `; and ${literals.length - shown.length} more` : ''}.`,
    })
    return { status: 'refused', decision }
  }
  const history = await listReplayCases(layout)
  const anchor = await selectionAnchor(layout, candidate, history)
  if (anchor.kind === 'missing') return { status: 'skipped', detail: anchor.detail }
  const feedbackOf = new Map(anchor.kind === 'job' && anchor.feedback.length > 0 ? [[anchor.caseId, anchor.feedback]] : [])
  const counts = options.comparison === undefined
    ? { selectionCases: settings.selectionCases, repeats: settings.repeats, selection: 'similarity' as const }
    : {
      selectionCases: Math.max(settings.selectionCases, options.comparison.selectionCases),
      repeats: Math.max(settings.repeats, options.comparison.repeats),
      selection: options.comparison.selection,
    }
  const built = buildReplaySet(history, anchor.caseId, { selection: counts.selectionCases, guard: settings.guardCases, order: counts.selection })
  if (built.status === 'waiting') return { status: 'waiting', detail: built.detail }
  // The job's feedback task carries its feedback ids (each run of it gets a feedback check).
  const set = {
    ...built,
    selection: built.selection.map(item => {
      const entries = feedbackOf.get(item.caseId)
      return entries === undefined ? item : { ...item, feedbackIds: entries.map(entry => entry.id) }
    }),
  }

  if (!(await claimAttempt(capabilitiesDir, candidate.id))) return { status: 'skipped', detail: `candidate ${candidate.id} is being or was tried by another process` }
  const observed: Activation = await store.activation()
  const baselineVersion: CapabilityVersion = observed.version
  const plan: TrialPlan = {
    selection: set.selection.map(planRef),
    guard: set.guard.map(planRef),
    repeats: counts.repeats,
    costRatioCap: settings.costRatioCap,
    costApprovalRatio: settings.costApprovalRatio,
    reviewer: settings.reviewer,
    budget: settings.trialBudget,
    epoch,
  }
  const trialId = randomUUID()
  const receipts = await TrialReceiptWriter.create(capabilitiesDir, trialId, now)
  await writeTrialLock(capabilitiesDir, trialId)
  const signal = options.signal ?? new AbortController().signal
  const runsTotal = (plan.selection.length + plan.guard.length) * plan.repeats * 2
  let runsDone = 0
  const emit = (receipt: TrialReceipt) => options.onReceipt?.(receipt, { runsDone, runsTotal })
  try {
    emit(await receipts.append({ type: 'trial.start', candidateId: candidate.id, candidateVersion: candidate.version, baselineVersion, plan }))

    const arms: Record<TrialArm, CostTotal> = { candidate: new CostTotal(), baseline: new CostTotal() }
    const reviewCost = new CostTotal()
    const tokens: Record<TrialArm, number | 'unknown'> = { candidate: 0, baseline: 0 }
    const spent = () => ({ tokens: knownTokens(addUsage(arms.candidate.usage, arms.baseline.usage, reviewCost.usage)), requests: arms.candidate.requests + arms.baseline.requests + reviewCost.requests })
    const tally = { selection: { candidate: emptyTally(), baseline: emptyTally() }, guard: { candidate: emptyTally(), baseline: emptyTally() } }
    const hasFeedback = set.selection.some(item => item.feedbackIds !== undefined)
    const feedbackTally = { candidate: emptyTally(), baseline: emptyTally() }
    // ADR 0013 as amended by ADR 0014: an improvement job's similar cases are the selection cases other than its
    // feedback task whose first message overlaps the feedback task's by content words (`isSimilarTask`).
    const anchorText = set.selection.find(item => item.caseId === anchor.caseId)?.messages[0]?.text ?? ''
    const similarIds = new Set(anchor.kind !== 'job' ? [] : set.selection
      .filter(item => item.caseId !== anchor.caseId && isSimilarTask(anchorText, item.messages[0]?.text ?? ''))
      .map(item => item.caseId))
    const similarCase = (caseId: string) => similarIds.has(caseId)
    const similarTally = { candidate: emptyTally(), baseline: emptyTally() }
    const similar = anchor.kind !== 'job' ? undefined : similarIds.size > 0 ? similarTally : 'none' as const
    const outputs = new Map<string, RunOutput>()
    const inputs = new Map<string, RunOutput>()
    // The feedback the user gave on a replayed case (only a job's feedback task has any).
    const feedbackOfCase = (replay: ReplayCase): readonly FeedbackEntry[] => {
      const ids = replay.feedbackIds ?? []
      return (anchor.kind === 'job' ? anchor.feedback : []).filter(entry => ids.includes(entry.id))
    }
    let budgetExhausted = false

    const runOne = async (half: ReplaySet, replay: ReplayCase, repeat: number, arm: TrialArm): Promise<void> => {
      const started = Date.now()
      const left = remaining(plan.budget, spent())
      let status: TrialStatus = 'unknown'
      let reason: TrialUnknownReason | undefined
      let checks: TaskCheck[] = []
      let runCost = cost(ZERO_USAGE, 0)
      if (left === undefined || signal.aborted) {
        reason = signal.aborted ? 'cancelled' : 'budget'
        if (reason === 'budget') budgetExhausted = true
      } else {
        let project: Awaited<ReturnType<typeof prepareReplayProject>> | undefined
        try {
          project = await prepareReplayProject({
            layout,
            replay,
            version: arm === 'candidate' ? candidate.version : baselineVersion,
            budget: left,
            ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
          })
          // ADR 0016: the reviewer sees the task's input files (the snapshot, before any run changes it).
          if (half === 'selection' && !inputs.has(replay.caseId)) inputs.set(replay.caseId, await taskInputs(project.root, project.files, replay.messages, options.documentText))
          const result = await options.runner.run({
            trialId,
            arm,
            set: half,
            caseId: replay.caseId,
            repeat,
            projectRoot: project.root,
            ledgersDir: layout.ledgers,
            messages: replay.messages,
            timeoutMs: options.runTimeoutMs ?? RUN_TIMEOUT_MS,
            ...(anchor.kind === 'job' ? { improvement: anchor.run } : {}),
          }, signal)
          runCost = cost(result.usage, result.requestCount, result.estimatedUsd ?? 'unknown')
          arms[arm].add(result.usage, result.requestCount, result.estimatedUsd)
          const runTokens = tokensOf(result.usage)
          tokens[arm] = tokens[arm] === 'unknown' || runTokens === 'unknown' ? 'unknown' : tokens[arm] + runTokens
          if (result.outcome === 'completed') {
            checks = await runCheckSpecs(project.root, replay.checks, { signal, delivered: await deliveredFiles(project.root) })
            status = checks.every(check => check.passed) ? 'pass' : 'fail'
            if (half === 'selection' || replay.feedbackIds !== undefined) outputs.set(`${replay.caseId}#${repeat}#${arm}`, await runOutput(project.root, project.files, options.documentText))
          } else {
            reason = unknownReason(result.outcome)
            if (result.outcome === 'budget') budgetExhausted = true
            options.log?.(`run ${half} ${replay.caseId}#${repeat} ${arm}: ${result.outcome}${result.detail === undefined ? '' : ` (${result.detail})`}`)
          }
        } catch (error) {
          reason = 'error'
          options.log?.(`run ${half} ${replay.caseId}#${repeat} ${arm}: ${(error as Error).message}`)
        } finally {
          await project?.dispose().catch(() => undefined)
        }
      }
      tally[half][arm] = bump(tally[half][arm], status)
      if (half === 'selection' && similarCase(replay.caseId)) similarTally[arm] = bump(similarTally[arm], status)
      runsDone += 1
      emit(await receipts.append({
        type: 'trial.run',
        set: half,
        caseId: replay.caseId,
        arm,
        repeat,
        status,
        ...(reason === undefined ? {} : { reason }),
        checks,
        cost: runCost,
        durationMs: Date.now() - started,
      }))
      if (replay.feedbackIds !== undefined && half === 'selection') await feedbackCheck(replay, repeat, arm, status)
    }

    // ADR 0006: the feedback check of one run, after its checks; an unknown run gives an unknown check.
    const feedbackCheck = async (replay: ReplayCase, repeat: number, arm: TrialArm, runStatus: TrialStatus): Promise<void> => {
      const ids = replay.feedbackIds ?? []
      const entries = feedbackOfCase(replay)
      const output = outputs.get(`${replay.caseId}#${repeat}#${arm}`)
      let result: FeedbackCheckResult
      if (runStatus === 'unknown' || output === undefined) {
        result = { status: 'unknown', reason: 'The run did not complete, so its output was not checked against the feedback.', usage: ZERO_USAGE, requestCount: 0 }
      } else if (options.reviewer?.checkFeedback === undefined) {
        result = { status: 'unknown', reason: 'No reviewer model is available for feedback checks.', usage: ZERO_USAGE, requestCount: 0 }
      } else if (remaining(plan.budget, spent()) === undefined || signal.aborted) {
        if (!signal.aborted) budgetExhausted = true
        result = { status: 'unknown', reason: signal.aborted ? 'The trial was cancelled.' : 'The trial budget ran out before this feedback check.', usage: ZERO_USAGE, requestCount: 0 }
      } else {
        try {
          result = await options.reviewer.checkFeedback({ trialId, caseId: replay.caseId, arm, repeat, messages: replay.messages, feedback: entries, output }, plan.reviewer, signal)
        } catch (error) {
          result = { status: 'unknown', reason: `the reviewer failed: ${(error as Error).message}`, usage: ZERO_USAGE, requestCount: 0 }
        }
      }
      reviewCost.add(result.usage, result.requestCount, result.estimatedUsd)
      feedbackTally[arm] = bump(feedbackTally[arm], result.status)
      emit(await receipts.append({
        type: 'trial.feedback',
        caseId: replay.caseId,
        arm,
        repeat,
        feedbackIds: [...ids],
        status: result.status,
        reason: result.reason.slice(0, 2_000) || '(no reason given)',
        model: plan.reviewer.model,
        cost: cost(result.usage, result.requestCount, result.estimatedUsd ?? 'unknown'),
      }))
    }

    const cases: [ReplaySet, readonly ReplayCase[]][] = [['selection', set.selection], ['guard', set.guard]]
    outer: for (const [half, list] of cases) {
      for (const replay of list) {
        for (let repeat = 1; repeat <= plan.repeats; repeat += 1) {
          for (const arm of ['candidate', 'baseline'] as const) {
            await runOne(half, replay, repeat, arm)
            if (budgetExhausted || signal.aborted) break outer
          }
        }
      }
    }

    const review = { candidate: 0, baseline: 0, tie: 0 }
    const verdictOf = () => decideTrial({
      selection: tally.selection,
      guard: tally.guard,
      review,
      tokens,
      usd: { candidate: arms.candidate.usd, baseline: arms.baseline.usd },
      budgetExhausted,
      requiresApproval: candidate.requiresApproval,
      ...(hasFeedback ? { feedback: feedbackTally } : {}),
      ...(similar === undefined ? {} : { similar }),
    }, plan.costRatioCap, plan.costApprovalRatio)
    let verdict = verdictOf()
    // The reviewer is asked only when its opinion can change the verdict: a check tie the cost does not settle.
    const needsReview = !budgetExhausted && verdict.reason === 'no-improvement' && verdict.costRatio !== 'unknown' && verdict.costRatio <= plan.costRatioCap
    if (needsReview && options.reviewer !== undefined) {
      for (const replay of set.selection) {
        for (let repeat = 1; repeat <= plan.repeats; repeat += 1) {
          const candidateOutput = outputs.get(`${replay.caseId}#${repeat}#candidate`)
          const baselineOutput = outputs.get(`${replay.caseId}#${repeat}#baseline`)
          if (candidateOutput === undefined || baselineOutput === undefined) continue
          // ADR 0016: every pair is asked in both orders; a vote counts only when both orders agree.
          const asked: ReviewResult[] = []
          for (const candidateFirst of [true, false]) {
            if (remaining(plan.budget, spent()) === undefined) {
              budgetExhausted = true
              break
            }
            let answer: ReviewResult
            try {
              answer = await options.reviewer.review({ trialId, set: 'selection', caseId: replay.caseId, repeat, messages: replay.messages, ...(feedbackOfCase(replay).length === 0 ? {} : { feedback: feedbackOfCase(replay) }), candidate: candidateOutput, baseline: baselineOutput, inputs: inputs.get(replay.caseId) ?? { files: [] }, candidateFirst }, plan.reviewer, signal)
            } catch (error) {
              answer = { preference: 'unknown', reason: `the reviewer failed: ${(error as Error).message}`.slice(0, 2_000), usage: ZERO_USAGE, requestCount: 0 }
            }
            reviewCost.add(answer.usage, answer.requestCount, answer.estimatedUsd)
            asked.push(answer)
          }
          if (budgetExhausted) break
          const result = bothOrders(asked[0]!, asked[1]!)
          if (result.preference !== 'unknown') review[result.preference] += 1
          emit(await receipts.append({
            type: 'trial.review',
            set: 'selection',
            caseId: replay.caseId,
            repeat,
            preference: result.preference,
            reason: result.reason.slice(0, 2_000) || '(no reason given)',
            model: plan.reviewer.model,
            cost: cost(result.usage, result.requestCount, result.estimatedUsd ?? 'unknown'),
          }))
        }
        if (budgetExhausted) break
      }
      verdict = verdictOf()
    }

    const costs = { candidate: arms.candidate.cost, baseline: arms.baseline.cost, review: reviewCost.cost }
    const status: TrialStatus = verdict.reason === 'unknown-runs' || verdict.reason === 'budget-exhausted' ? 'unknown' : verdict.outcome === 'reject' ? 'fail' : 'pass'
    emit(await receipts.append({ type: 'trial.end', status, verdict, cost: costs }))

    const common = { candidateId: candidate.id, trialId, verdict, cost: costs }
    const shown = { ...tally, ...(similar === undefined ? {} : { similar }), usd: { candidate: arms.candidate.usd, baseline: arms.baseline.usd } }
    let decision: CapabilityDecision
    if (verdict.outcome === 'adopt') {
      const committed = await store.adopt(candidate.version, { trigger: 'gate', reason: verdict.reason, detail: explain(verdict, shown, review), ...common }, observed).catch(() => null)
      decision = committed?.decision ?? await store.recordDecision({
        outcome: 'rejected',
        reason: 'interrupted',
        trigger: 'gate',
        fromVersion: baselineVersion,
        toVersion: baselineVersion,
        ...common,
        detail: explain(verdict, shown, review, 'The adopted version changed while the trial ran, so this result was not applied.'),
      })
    } else {
      decision = await store.recordDecision({
        outcome: verdict.outcome === 'await-approval' ? 'awaiting-approval' : 'rejected',
        reason: verdict.reason,
        trigger: 'gate',
        fromVersion: baselineVersion,
        toVersion: baselineVersion,
        ...common,
        detail: explain(verdict, shown, review, verdict.outcome !== 'await-approval' ? undefined : approvalText(verdict, candidate, plan)),
      })
    }
    return { status: 'decided', trialId, verdict, decision }
  } finally {
    await receipts.close().catch(() => undefined)
    await releaseTrialLock(capabilitiesDir, trialId).catch(() => undefined)
  }
}
