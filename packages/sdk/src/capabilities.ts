/**
 * Step 4 (W4): the SDK's `capabilities.*` methods over one project's
 * `@nexgent/capabilities` service. Candidate status is derived from the
 * files (`data-formats.md` §候选与门控 “状态”): the candidate record, its
 * trial receipts, its decisions and the activation chain.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CAPABILITY_DIRS,
  NexgentError,
  type ActivationRevision,
  type CandidateRecord,
  type CandidateStatus,
  type CapabilityDecision,
  type CapabilityVersion,
  type TrialReceipt,
} from '@nexgent/kernel'
import { listCandidates, readCandidate, type CapabilityService } from '@nexgent/capabilities'
import { validateCapabilityFile } from '@nexgent/session'
import type { CandidateDetail, CandidateView, CapabilityListing, CapabilityVersionView } from './api.js'

/**
 * The gate's entry the SDK calls for `capabilities.trial`. The gate engine
 * (`@nexgent/capabilities` `src/trial/**`, 「门控」) adds it to the service;
 * until then `capabilities.trial` answers that it is not implemented yet.
 */
export interface CapabilityGateEntry {
  /** Start the gate for a `proposed` candidate (resolves once the trial is under way or decided). */
  startTrial(candidateId: string): Promise<unknown>
}

function gateOf(service: CapabilityService): CapabilityGateEntry | undefined {
  const entry = (service as unknown as Partial<CapabilityGateEntry>).startTrial
  return typeof entry === 'function' ? { startTrial: id => entry.call(service, id) } : undefined
}

/** The adopted version the way a new session would get it (a bundle that fails verification is rolled back first). */
export async function currentView(service: CapabilityService): Promise<CapabilityVersionView> {
  await service.resolveVersion()
  const status = await service.status()
  return {
    version: status.version,
    revision: status.revision,
    ...(status.since === undefined ? {} : { since: status.since }),
    ...(status.trigger === undefined ? {} : { trigger: status.trigger }),
    components: status.components,
    ...(status.problem === undefined ? {} : { problem: status.problem }),
  }
}

/** Trial receipts by trial id (lines that do not validate are skipped; an unreadable file counts as absent). */
async function readTrials(capabilitiesDir: string): Promise<Map<string, TrialReceipt[]>> {
  const dir = join(capabilitiesDir, CAPABILITY_DIRS.trials)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const trials = new Map<string, TrialReceipt[]>()
  for (const name of names.filter(entry => entry.endsWith('.jsonl')).sort()) {
    let text: string
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const receipts: TrialReceipt[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const value = JSON.parse(line) as unknown
        if (validateCapabilityFile('trialReceipt', value).length === 0) receipts.push(value as TrialReceipt)
      } catch {
        // a torn last line (the process died mid-write) ends the file
        break
      }
    }
    const start = receipts[0]
    if (start?.type === 'trial.start') trials.set(start.trialId, receipts)
  }
  return trials
}

interface CapabilityFiles {
  readonly history: readonly ActivationRevision[]
  readonly decisions: readonly CapabilityDecision[]
  readonly trials: Map<string, TrialReceipt[]>
}

async function readFiles(service: CapabilityService): Promise<CapabilityFiles> {
  const [history, decisions, trials] = await Promise.all([service.store.history(), service.store.decisions(), readTrials(service.store.directory)])
  return { history, decisions, trials }
}

/** Trials of one candidate, oldest first. */
function trialsOf(files: CapabilityFiles, candidateId: string): TrialReceipt[][] {
  return [...files.trials.values()]
    .filter(receipts => receipts[0]?.type === 'trial.start' && receipts[0].candidateId === candidateId)
    .sort((a, b) => (a[0]!.ts < b[0]!.ts ? -1 : a[0]!.ts > b[0]!.ts ? 1 : 0))
}

/** Decisions about one candidate, oldest first. */
function decisionsOf(files: CapabilityFiles, candidateId: string): CapabilityDecision[] {
  return files.decisions
    .filter(decision => decision.candidateId === candidateId)
    .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0))
}

/**
 * A candidate's status from its files: the latest decision decides
 * (an adoption later rolled back away from the candidate's version reads
 * `rolled-back`); without one, an unfinished trial reads `trialing`, and no
 * trial reads `proposed`.
 */
export function candidateStatus(record: CandidateRecord, decisions: readonly CapabilityDecision[], trials: readonly TrialReceipt[][], history: readonly ActivationRevision[]): CandidateStatus {
  const latest = decisions.at(-1)
  if (latest !== undefined) {
    if (latest.outcome === 'rejected') return 'rejected'
    if (latest.outcome === 'awaiting-approval') return 'awaiting-approval'
    if (latest.outcome === 'rolled-back') return 'rolled-back'
    const adopted = history.find(revision => revision.decisionId === latest.id)
    if (adopted === undefined) return 'adopted'
    const left = history.some(revision => revision.revision > adopted.revision && revision.type === 'rollback' && revision.from === record.version)
    return left ? 'rolled-back' : 'adopted'
  }
  if (trials.length > 0) return 'trialing'
  return 'proposed'
}

function view(record: CandidateRecord, files: CapabilityFiles): CandidateView {
  const decisions = decisionsOf(files, record.id)
  const trials = trialsOf(files, record.id)
  const latest = decisions.at(-1)
  const trialId = trials.at(-1)?.[0]?.trialId
  return {
    id: record.id,
    status: candidateStatus(record, decisions, trials, files.history),
    proposedAt: record.proposedAt,
    sessionId: record.sessionId,
    components: record.components.map(component => ({ kind: component.kind, name: component.name })),
    requiresApproval: record.requiresApproval,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(trialId === undefined ? {} : { trialId }),
    ...(latest === undefined ? {} : { decision: { id: latest.id, outcome: latest.outcome, reason: latest.reason, detail: latest.detail } }),
  }
}

async function candidate(service: CapabilityService, candidateId: unknown): Promise<CandidateRecord> {
  if (typeof candidateId !== 'string' || candidateId === '') throw new NexgentError('tool/invalid-input', 'candidateId must be a string')
  try {
    return await readCandidate(service.store.directory, candidateId)
  } catch (error) {
    if (error instanceof NexgentError && error.code === 'session/not-found') throw new NexgentError('tool/invalid-input', `no candidate ${JSON.stringify(candidateId)}`)
    throw error
  }
}

/** One candidate as lists show it. */
export async function candidateView(service: CapabilityService, candidateId: string): Promise<CandidateView> {
  return view(await candidate(service, candidateId), await readFiles(service))
}

/** `capabilities.list`. */
export async function listing(service: CapabilityService): Promise<CapabilityListing> {
  const current = await currentView(service)
  const [records, files] = await Promise.all([listCandidates(service.store.directory), readFiles(service)])
  return {
    current,
    history: files.history,
    candidates: records.map(record => view(record, files)).reverse(),
  }
}

/** `capabilities.show`. */
export async function show(service: CapabilityService, candidateId: string): Promise<CandidateDetail> {
  const record = await candidate(service, candidateId)
  const files = await readFiles(service)
  return {
    view: view(record, files),
    record,
    receipts: trialsOf(files, record.id).flat(),
    decisions: decisionsOf(files, record.id),
  }
}

/** `capabilities.trial`: hand a `proposed` candidate to the gate. */
export async function trial(service: CapabilityService, candidateId: string): Promise<CandidateView> {
  const gate = gateOf(service)
  if (gate === undefined) throw new NexgentError('internal', 'capabilities.trial is not implemented yet: the capability gate is not in this build')
  const before = await candidateView(service, candidateId)
  if (before.status !== 'proposed') throw new NexgentError('tool/invalid-input', `candidate ${candidateId} is ${before.status}; only a proposed candidate can start a trial`)
  await gate.startTrial(candidateId)
  return candidateView(service, candidateId)
}

/** `capabilities.rollback`: back to the previous version, or down the stack to `toVersion`. */
export async function rollback(service: CapabilityService, toVersion: CapabilityVersion | undefined, reason: string | undefined): Promise<CapabilityVersionView> {
  if (reason !== undefined && typeof reason !== 'string') throw new NexgentError('tool/invalid-input', 'reason must be a string')
  const activation = await service.store.activation()
  if (activation.revision === 0 || activation.stack.length < 2) throw new NexgentError('tool/invalid-input', 'nothing to roll back: the baseline is in force')
  const stack = activation.stack
  const target = toVersion ?? stack[stack.length - 2]!
  const index = stack.lastIndexOf(target)
  if (index < 0 || index === stack.length - 1) throw new NexgentError('tool/invalid-input', `version ${String(toVersion)} is not an earlier version in the adopted history`)
  const detail = (reason ?? '').trim() === '' ? 'Rolled back by the user.' : `Rolled back by the user: ${reason!.trim()}`.slice(0, 2000)
  let base = activation
  while (base.version !== target) {
    const committed = await service.store.rollback({ trigger: 'manual', reason: 'manual', detail }, base)
    if (committed === null) throw new NexgentError('internal', 'the capability history changed meanwhile; try again')
    base = committed.activation
  }
  return currentView(service)
}
