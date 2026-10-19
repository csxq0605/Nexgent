/**
 * A layer-3 offline run (ADR 0018 decision 6, ADR 0019 decision 4, ADR
 * 0026), in `<NEXGENT_HOME>/offline-runs/<runId>/run.json`:
 *
 * 1. {@link planOfflineRun}: seeded split of the practice set into the
 *    minibatch pool (train), selection, holdout and guard cases; an
 *    estimate and a cap (estimate × `capFactor`); status
 *    `awaiting-approval`. Nothing is spent.
 * 2. {@link approveOfflineRun}: the user approves exactly the planned cap.
 * 3. {@link runOfflineEvolution}: evaluate the start on the selection set
 *    (archive entry 0); then per iteration pick a parent by per-case Pareto
 *    frequency × `1 / (1 + children)`, the next part round-robin, a seeded
 *    minibatch; run the parent there, ask for a child, run the child; accept
 *    when its minibatch sum is strictly higher and it is worse on at most
 *    `maxWorseOnMinibatch` cases, then evaluate it on the selection set;
 *    otherwise remember the refused edit. Stop at `maxIterations`, after
 *    `patience` iterations without an accepted child, at the stop file, on
 *    abort, or when the next stage would pass the cap.
 * 4. The best selection mean, if above the start, meets the start on the
 *    holdout cases: a recommendation needs the two-level paired bootstrap
 *    95% lower bound above 0 and the guard cases not worse by more than
 *    `guardTolerance`. Status `awaiting-user`; nothing takes effect here.
 *
 * The state is written atomically at every stage boundary with the
 * generator's state, so an interrupted run resumes and redoes only the
 * unfinished iteration; a plan whose hash no longer matches is refused.
 */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_OFFLINE_RETRIEVAL,
  NexgentError,
  OFFLINE_COMPONENTS,
  OFFLINE_LIMITS,
  OFFLINE_RUN_FILE,
  OFFLINE_STOP_FILE,
  offlineCandidateProblems,
  offlineMeanScore,
  offlinePairedBootstrap,
  offlineRng,
  offlineSelectParent,
  offlineShuffle,
  resolveUserDataLayout,
  type OfflineArchiveEntry,
  type OfflineCandidate,
  type OfflineHoldout,
  type OfflineRunPlan,
  type OfflineRunState,
  type OfflineStopReason,
  type PracticeCase,
} from '@nexgent/kernel'
import { readAppliedProfile, writeAppliedProfile } from '@nexgent/capabilities'
import { writeJsonAtomic } from '../lock.js'
import type { PracticeCaseResult, PracticeEvaluator } from './evaluator.js'
import type { OfflineProposer } from './propose.js'

/** A run's directory. */
export function offlineRunDirectory(home: string, runId: string): string {
  if (!/^[0-9a-f-]{8,64}$/.test(runId)) throw new NexgentError('tool/invalid-input', `offline run id ${JSON.stringify(runId)} is not valid`)
  return join(resolveUserDataLayout(home).offlineRuns, runId)
}

function hashPlan(plan: Omit<OfflineRunPlan, 'planHash' | 'runId' | 'createdAt'>): string {
  const { seed, cases, maxIterations, patience, holdoutRepeats, estimate, capUsd } = plan
  return createHash('sha256').update(JSON.stringify({ seed, cases, maxIterations, patience, holdoutRepeats, estimate, capUsd })).digest('hex')
}

/** Read a run's state. @throws `tool/not-found`. */
export async function readOfflineRun(home: string, runId: string): Promise<OfflineRunState> {
  try {
    const state = JSON.parse(await readFile(join(offlineRunDirectory(home, runId), OFFLINE_RUN_FILE), 'utf8')) as OfflineRunState
    if (state?.formatVersion !== 1) throw new Error('unknown format')
    return state
  } catch (error) {
    if (error instanceof NexgentError) throw error
    throw new NexgentError('tool/not-found', `no readable offline run ${runId}`)
  }
}

async function save(home: string, state: OfflineRunState): Promise<OfflineRunState> {
  await writeJsonAtomic(join(offlineRunDirectory(home, state.plan.runId), OFFLINE_RUN_FILE), state)
  return state
}

/** What a run is planned from. */
export interface PlanOfflineRunInput {
  readonly home: string
  /** The practice set (learner and holdout cases). */
  readonly cases: readonly Pick<PracticeCase, 'id' | 'split'>[]
  /** The version the run starts from. */
  readonly start: OfflineCandidate
  readonly seed?: number
  /** Estimated dollars of one case run (from the ledger's history); default `OFFLINE_LIMITS.defaultUsdPerRun`. */
  readonly usdPerRun?: number
  readonly maxIterations?: number
  readonly patience?: number
  readonly holdoutRepeats?: number
  readonly runId?: string
  readonly now?: () => Date
}

/** Plan a run (spends nothing). @throws `tool/invalid-input` for an invalid start or too few cases. */
export async function planOfflineRun(input: PlanOfflineRunInput): Promise<OfflineRunState> {
  const problems = offlineCandidateProblems(input.start)
  if (problems.length > 0) throw new NexgentError('tool/invalid-input', `the starting version is not valid: ${problems.join('; ')}`)
  const now = (input.now ?? (() => new Date()))().toISOString()
  const seed = (input.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0
  const holder = { state: seed }
  const random = offlineRng(holder)
  const ids = (split: PracticeCase['split']) => offlineShuffle(input.cases.filter(item => item.split === split).map(item => item.id).sort(), random)
  const cases = {
    minibatch: ids('train'),
    selection: ids('selection').slice(0, OFFLINE_LIMITS.maxSelectionCases),
    holdout: ids('holdout').slice(0, OFFLINE_LIMITS.maxHoldoutCases),
    guard: ids('guard').slice(0, OFFLINE_LIMITS.maxHoldoutCases),
  }
  if (cases.minibatch.length === 0 || cases.selection.length === 0 || cases.holdout.length === 0) {
    throw new NexgentError('tool/invalid-input', `an offline run needs train, selection and holdout cases (has ${cases.minibatch.length}, ${cases.selection.length}, ${cases.holdout.length})`)
  }
  const maxIterations = input.maxIterations ?? OFFLINE_LIMITS.defaultMaxIterations
  const patience = input.patience ?? OFFLINE_LIMITS.defaultPatience
  const holdoutRepeats = input.holdoutRepeats ?? OFFLINE_LIMITS.holdoutRepeats
  const usdPerRun = input.usdPerRun ?? OFFLINE_LIMITS.defaultUsdPerRun
  const minibatch = Math.min(OFFLINE_LIMITS.minibatchSize, cases.minibatch.length)
  // Worst case: every iteration accepted (so evaluated on the whole selection set), then the holdout comparison.
  const caseRuns = cases.selection.length + maxIterations * (2 * minibatch + cases.selection.length) + 2 * holdoutRepeats * (cases.holdout.length + cases.guard.length)
  const estimate = { caseRuns, proposals: maxIterations, usdPerRun, usd: round(caseRuns * usdPerRun + maxIterations * OFFLINE_LIMITS.proposalUsd) }
  const capUsd = round(estimate.usd * OFFLINE_LIMITS.capFactor)
  const body = { seed, cases, maxIterations, patience, holdoutRepeats, estimate, capUsd }
  const plan: OfflineRunPlan = { runId: input.runId ?? randomUUID(), createdAt: now, ...body, planHash: hashPlan(body) }
  await mkdir(offlineRunDirectory(input.home, plan.runId), { recursive: true })
  return save(input.home, {
    formatVersion: 1,
    plan,
    status: 'awaiting-approval',
    archive: [{ id: 0, candidate: input.start, scores: {}, children: 0, createdAt: now }],
    rejected: [],
    rng: holder.state,
    iteration: 0,
    sinceAccepted: 0,
    componentCursor: {},
    spentUsd: 0,
    caseRuns: 0,
    updatedAt: now,
  })
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100
}

/**
 * The user approves a planned run at exactly its planned cap. A run that
 * stopped at its cap stays stopped: a larger cap is a new plan.
 * @throws `tool/invalid-input` when the cap differs or the run is not
 * waiting for approval.
 */
export async function approveOfflineRun(home: string, runId: string, capUsd: number, now: () => Date = () => new Date()): Promise<OfflineRunState> {
  const state = await readOfflineRun(home, runId)
  if (state.status !== 'awaiting-approval') throw new NexgentError('tool/invalid-input', `offline run ${runId} is ${state.status}, not waiting for approval`)
  if (capUsd !== state.plan.capUsd) throw new NexgentError('tool/invalid-input', `the approved cap ${capUsd} USD differs from the planned ${state.plan.capUsd} USD`)
  return save(home, { ...state, approval: { at: now().toISOString(), capUsd }, updatedAt: now().toISOString() })
}

/** Ask a running run to stop at its next stage boundary. */
export async function stopOfflineRun(home: string, runId: string): Promise<void> {
  await writeFile(join(offlineRunDirectory(home, runId), OFFLINE_STOP_FILE), '')
}

/** What a run uses. */
export interface OfflineRunServices {
  readonly evaluator: PracticeEvaluator
  readonly proposer: OfflineProposer
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

class Stop extends Error {
  constructor(readonly reason: OfflineStopReason, readonly detail: string) {
    super(detail)
  }
}

/**
 * Run (or resume) an approved run until it ends or stops; returns the final
 * state. @throws `tool/invalid-input` when the run is not approved or its
 * plan no longer matches its hash.
 */
export async function runOfflineEvolution(home: string, runId: string, services: OfflineRunServices): Promise<OfflineRunState> {
  let state = await readOfflineRun(home, runId)
  const { plan } = state
  const { planHash, runId: _id, createdAt: _at, ...body } = plan
  if (hashPlan(body) !== planHash) throw new NexgentError('tool/invalid-input', `offline run ${runId}: the plan no longer matches its hash; plan a new run`)
  if (state.status === 'awaiting-user') return state
  if (state.approval === undefined || state.approval.capUsd !== plan.capUsd) throw new NexgentError('tool/invalid-input', `offline run ${runId} is not approved at its planned cap`)
  const signal = services.signal ?? new AbortController().signal
  const now = () => (services.now ?? (() => new Date()))().toISOString()
  const directory = offlineRunDirectory(home, runId)
  const selection = plan.cases.selection
  const commit = async (next: Partial<OfflineRunState>) => {
    state = await save(home, { ...state, ...next, updatedAt: now() })
  }
  // Resuming: a stop file of the last stop no longer applies, nor does its reason.
  await rm(join(directory, OFFLINE_STOP_FILE), { force: true })
  const { stop: _stop, ...rest } = state
  state = rest
  await commit({ status: 'running' })

  const checkStop = async () => {
    if (signal.aborted) throw new Stop('aborted', 'the run was cancelled')
    if (await access(join(directory, OFFLINE_STOP_FILE)).then(() => true, () => false)) throw new Stop('stop-file', 'the stop file was found')
  }
  /** Stop before a stage whose estimated cost would pass the cap. */
  const afford = (caseRuns: number, proposals = 0) => {
    const perRun = state.caseRuns > 0 ? Math.max(plan.estimate.usdPerRun * 0.25, state.spentUsd / state.caseRuns) : plan.estimate.usdPerRun
    const next = caseRuns * perRun + proposals * OFFLINE_LIMITS.proposalUsd
    if (state.spentUsd + next > plan.capUsd) throw new Stop('budget', `the next stage (about ${next.toFixed(2)} USD) would pass the cap of ${plan.capUsd} USD with ${state.spentUsd.toFixed(2)} USD spent`)
  }
  const evaluate = async (candidate: OfflineCandidate, caseIds: readonly string[], repeat = 0): Promise<readonly PracticeCaseResult[]> => {
    const results = await services.evaluator.evaluate({ candidate, caseIds, repeat, signal })
    const byId = new Map(results.map(result => [result.caseId, result]))
    const ordered = caseIds.map(caseId => byId.get(caseId) ?? { caseId, score: 0, feedback: 'no result', unknown: true })
    const usd = ordered.reduce((sum, result) => sum + (result.usd ?? 0), 0)
    state = { ...state, spentUsd: state.spentUsd + usd, caseRuns: state.caseRuns + ordered.length }
    return ordered
  }
  const scoresOf = (results: readonly PracticeCaseResult[]) => Object.fromEntries(results.map(result => [result.caseId, result.score]))

  try {
    // The starting version on the selection set.
    if (Object.keys(state.archive[0]!.scores).length === 0) {
      await checkStop()
      afford(selection.length)
      const results = await evaluate(state.archive[0]!.candidate, selection)
      await commit({ archive: [{ ...state.archive[0]!, scores: scoresOf(results) }, ...state.archive.slice(1)] })
    }
    while (state.iteration < plan.maxIterations && state.sinceAccepted < plan.patience) {
      await checkStop()
      const minibatchSize = Math.min(OFFLINE_LIMITS.minibatchSize, plan.cases.minibatch.length)
      afford(2 * minibatchSize, 1)
      const holder = { state: state.rng }
      const random = offlineRng(holder)
      const parent = offlineSelectParent(state.archive, selection, random)
      const cursor = state.componentCursor[String(parent.id)] ?? 0
      const component = OFFLINE_COMPONENTS[cursor % OFFLINE_COMPONENTS.length]!
      const minibatch = offlineShuffle(plan.cases.minibatch, random).slice(0, minibatchSize)
      const parentResults = await evaluate(parent.candidate, minibatch)
      const proposal = await services.proposer.propose({
        runId,
        component,
        parent: parent.candidate,
        minibatch: parentResults,
        rejected: state.rejected.filter(edit => edit.component === component).slice(-OFFLINE_LIMITS.rejectedShown),
      }, signal)
      state = { ...state, spentUsd: state.spentUsd + proposal.usd }
      const nextCursor = { ...state.componentCursor, [String(parent.id)]: cursor + 1 }
      const refuse = async (proposalText: string, reason: string) => {
        await commit({
          rng: holder.state,
          componentCursor: nextCursor,
          iteration: state.iteration + 1,
          sinceAccepted: state.sinceAccepted + 1,
          rejected: [...state.rejected, { at: now(), parentId: parent.id, component, proposal: proposalText.slice(0, 600), reason: reason.slice(0, 300) }],
        })
      }
      const problems = proposal.candidate === undefined ? [proposal.detail ?? 'no proposal'] : offlineCandidateProblems(proposal.candidate)
      if (proposal.candidate === undefined || problems.length > 0) {
        await refuse(proposal.candidate === undefined ? '(none)' : JSON.stringify(proposal.candidate), problems.join('; '))
        continue
      }
      const child = proposal.candidate
      const shown = component === 'execution-guidance' ? child.executionGuidance : JSON.stringify(child.retrieval)
      const childResults = await evaluate(child, minibatch)
      const parentSum = parentResults.reduce((sum, result) => sum + result.score, 0)
      const childSum = childResults.reduce((sum, result) => sum + result.score, 0)
      const worse = childResults.filter((result, index) => result.score < parentResults[index]!.score).length
      if (!(childSum > parentSum) || worse > OFFLINE_LIMITS.maxWorseOnMinibatch) {
        await refuse(shown, `minibatch ${childSum.toFixed(2)} vs parent ${parentSum.toFixed(2)}, worse on ${worse} of ${minibatch.length}`)
        continue
      }
      afford(selection.length)
      const full = await evaluate(child, selection)
      const id = Math.max(...state.archive.map(entry => entry.id)) + 1
      const entry: OfflineArchiveEntry = { id, parentId: parent.id, component, candidate: child, scores: scoresOf(full), children: 0, createdAt: now() }
      await commit({
        rng: holder.state,
        componentCursor: nextCursor,
        iteration: state.iteration + 1,
        sinceAccepted: 0,
        archive: [...state.archive.map(other => (other.id === parent.id ? { ...other, children: other.children + 1 } : other)), entry],
      })
    }

    // The final comparison on held-out cases.
    const start = state.archive[0]!
    const best = [...state.archive].sort((a, b) => offlineMeanScore(b, selection) - offlineMeanScore(a, selection) || a.id - b.id)[0]!
    if (best.id === start.id || offlineMeanScore(best, selection) <= offlineMeanScore(start, selection)) {
      await commit({ status: 'awaiting-user', result: { verdict: 'no-better', bestId: start.id, detail: `no version beat the start on the selection set (start ${offlineMeanScore(start, selection).toFixed(3)})` } })
      return state
    }
    const heldOut = [...plan.cases.holdout, ...plan.cases.guard]
    await checkStop()
    afford(2 * plan.holdoutRepeats * heldOut.length)
    const seedScores: Record<string, number[]> = {}
    const bestScores: Record<string, number[]> = {}
    for (let repeat = 0; repeat < plan.holdoutRepeats; repeat += 1) {
      for (const result of await evaluate(start.candidate, heldOut, repeat)) (seedScores[result.caseId] ??= []).push(result.score)
      for (const result of await evaluate(best.candidate, heldOut, repeat)) (bestScores[result.caseId] ??= []).push(result.score)
    }
    const pick = (scores: Record<string, number[]>, ids: readonly string[]) => Object.fromEntries(ids.map(id => [id, scores[id] ?? []]))
    const holder = { state: state.rng }
    const interval = offlinePairedBootstrap(pick(seedScores, plan.cases.holdout), pick(bestScores, plan.cases.holdout), offlineRng(holder))
    const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
    const guardDiff = plan.cases.guard.length === 0 ? undefined : mean(plan.cases.guard.map(id => mean(bestScores[id] ?? []) - mean(seedScores[id] ?? [])))
    const holdout: OfflineHoldout = { seed: pick(seedScores, heldOut), best: pick(bestScores, heldOut), ...interval, ...(guardDiff === undefined ? {} : { guardDiff }) }
    const guardOk = guardDiff === undefined || guardDiff >= -OFFLINE_LIMITS.guardTolerance
    const recommended = interval.ciLow > 0 && guardOk
    const detail = recommended
      ? `version ${best.id} beat the start on held-out cases: mean difference ${interval.meanDiff.toFixed(3)}, 95% interval ${interval.ciLow.toFixed(3)} to ${interval.ciHigh.toFixed(3)}`
      : !guardOk
        ? `version ${best.id} did worse on generic cases (${guardDiff!.toFixed(3)})`
        : `version ${best.id} did not beat the start on held-out cases: 95% interval ${interval.ciLow.toFixed(3)} to ${interval.ciHigh.toFixed(3)}`
    await commit({ rng: holder.state, status: 'awaiting-user', result: { verdict: recommended ? 'recommended' : 'no-better', bestId: recommended ? best.id : start.id, detail, holdout } })
    return state
  } catch (error) {
    const stop = error instanceof Stop ? error : new Stop(signal.aborted ? 'aborted' : 'error', error instanceof Error ? error.message : String(error))
    // Spending of the unfinished stage is kept; its results are not.
    await commit({ status: 'stopped', stop: { reason: stop.reason, detail: stop.detail.slice(0, 500) } })
    return state
  }
}

/** Every readable run of the user, newest first. */
export async function listOfflineRuns(home: string): Promise<OfflineRunState[]> {
  const directory = resolveUserDataLayout(home).offlineRuns
  const runs: OfflineRunState[] = []
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^[0-9a-f-]{8,64}$/.test(name)) continue
    const state = await readOfflineRun(home, name).catch(() => undefined)
    if (state !== undefined && state.plan.runId === name) runs.push(state)
  }
  return runs.sort((left, right) => (left.plan.createdAt < right.plan.createdAt ? 1 : left.plan.createdAt > right.plan.createdAt ? -1 : 0))
}

/** The version a new run starts from: the applied one, else the product's defaults (ADR 0027). */
export async function offlineStartingVersion(home: string): Promise<OfflineCandidate> {
  return (await readAppliedProfile(home))?.candidate ?? { executionGuidance: '', retrieval: { ...DEFAULT_OFFLINE_RETRIEVAL } }
}

/**
 * The user's answer to a finished run (ADR 0027): `apply` writes its
 * recommended version to `applied.json`, in force for every project from
 * the next task on; `decline` only records the answer.
 * @throws `tool/invalid-input` when the run is not finished, already
 * answered, or (for `apply`) recommends nothing.
 */
export async function decideOfflineRun(home: string, runId: string, answer: 'apply' | 'decline', now: () => Date = () => new Date()): Promise<OfflineRunState> {
  const state = await readOfflineRun(home, runId)
  if (state.status !== 'awaiting-user' || state.result === undefined) throw new NexgentError('tool/invalid-input', `offline run ${runId} has not finished`)
  if (state.decision !== undefined) throw new NexgentError('tool/invalid-input', `offline run ${runId} was already ${state.decision.outcome}`)
  const at = now().toISOString()
  if (answer === 'apply') {
    if (state.result.verdict !== 'recommended') throw new NexgentError('tool/invalid-input', `offline run ${runId} recommends no version`)
    const best = state.archive.find(entry => entry.id === state.result!.bestId)
    if (best === undefined) throw new NexgentError('tool/invalid-input', `offline run ${runId} has no version ${state.result.bestId}`)
    await writeAppliedProfile(home, { formatVersion: 1, runId, versionId: best.id, candidate: best.candidate, appliedAt: at })
  }
  return save(home, { ...state, decision: { outcome: answer === 'apply' ? 'applied' : 'declined', at }, updatedAt: at })
}
