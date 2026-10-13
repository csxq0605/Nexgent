/**
 * Step 4 (W4): the SDK's `capabilities.*` methods over one project's
 * `@nexgent/capabilities` service. Candidate status is derived from the
 * files (`data-formats.md` §候选与门控 “状态”): the candidate record, its
 * trial receipts, its decisions and the activation chain.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CAPABILITY_DIRS,
  NexgentError,
  componentDir,
  pluginApprovalInfo,
  type ActivationRevision,
  type CandidateRecord,
  type CandidateStatus,
  type CapabilityDecision,
  type CapabilityVersion,
  type PluginApprovalInfo,
  type PluginSpec,
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

const PLUGIN_FILE = 'plugin.json'

/**
 * What the approval dialog shows for each plugin component, from the
 * candidate's copy of `plugins/<name>/plugin.json`. A copy that cannot be
 * read, does not match the record's hash, fails validation or names another
 * plugin leaves its entry out (the dialog then does not offer `allow`).
 */
async function pluginInfo(service: CapabilityService, record: CandidateRecord): Promise<PluginApprovalInfo[] | undefined> {
  const plugins = record.components.filter(component => component.kind === 'plugin')
  if (plugins.length === 0) return undefined
  const dir = join(service.store.directory, CAPABILITY_DIRS.candidates, record.id)
  const out: PluginApprovalInfo[] = []
  for (const component of plugins) {
    try {
      const bytes = await readFile(join(dir, ...componentDir('plugin', component.name).split('/'), PLUGIN_FILE))
      const expected = component.files.find(file => file.path === PLUGIN_FILE)?.sha256
      if (expected === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) continue
      const spec = JSON.parse(bytes.toString('utf8')) as unknown
      if (validateCapabilityFile('plugin', spec).length > 0 || (spec as PluginSpec).name !== component.name) continue
      out.push(pluginApprovalInfo(spec as PluginSpec))
    } catch {
      // unreadable or not JSON: the entry is missing
    }
  }
  return out
}

/** `capabilities.show`. */
export async function show(service: CapabilityService, candidateId: string): Promise<CandidateDetail> {
  const record = await candidate(service, candidateId)
  const [files, plugins] = await Promise.all([readFiles(service), pluginInfo(service, record)])
  return {
    view: view(record, files),
    record,
    receipts: trialsOf(files, record.id).flat(),
    decisions: decisionsOf(files, record.id),
    ...(plugins === undefined ? {} : { plugins }),
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

/** `capabilities.approve`: the user's answer for a plugin candidate that passed its gate. */
export async function approve(service: CapabilityService, candidateId: string, decision: unknown): Promise<CandidateView> {
  if (decision !== 'allow' && decision !== 'deny') throw new NexgentError('tool/invalid-input', 'decision must be "allow" or "deny"')
  const record = await candidate(service, candidateId)
  const files = await readFiles(service)
  const before = view(record, files)
  if (before.status !== 'awaiting-approval') throw new NexgentError('tool/invalid-input', `candidate ${candidateId} is ${before.status}; only a candidate awaiting approval can be approved or denied`)
  const pending = decisionsOf(files, candidateId).at(-1)
  const trialId = pending?.trialId
  if (decision === 'allow') {
    const committed = await service.store.adopt(record.version, {
      trigger: 'approval',
      reason: 'approved',
      detail: 'The user approved the candidate after it passed its gate (a plugin package, or a quality rise above the cost ratio that adopts on its own).',
      candidateId,
      ...(trialId === undefined ? {} : { trialId }),
      ...(pending?.verdict === undefined ? {} : { verdict: pending.verdict }),
      ...(pending?.cost === undefined ? {} : { cost: pending.cost }),
    })
    if (committed === null) throw new NexgentError('internal', 'the capability history changed meanwhile; try again')
  } else {
    const current = await service.store.activation()
    await service.store.recordDecision({
      outcome: 'rejected',
      reason: 'approval-denied',
      trigger: 'approval',
      candidateId,
      ...(trialId === undefined ? {} : { trialId }),
      fromVersion: current.version,
      toVersion: current.version,
      detail: 'The user denied the candidate; it is not adopted and none of its code runs.',
    })
  }
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
