/**
 * Capability files of a project written directly (step 4): bundles,
 * adoptions, candidates, trial receipts and gate decisions, so the SDK's
 * `capabilities.*` views can be tested without the gate.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { CapabilityStore, writeCandidate, type BundleComponentInput } from '@nexgent/capabilities'
import type { CandidateRecord, TrialReceipt, TrialVerdict } from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const COST = { usage: ZERO, requestCount: 0, estimatedUsd: 0 }

export const capabilitiesDir = (root: string): string => nodePath.join(root, '.nexgent', 'capabilities')
export const capabilityStore = (root: string): CapabilityStore => new CapabilityStore(capabilitiesDir(root))

/** A skill component; `variant` changes its content. */
export function skill(name: string, variant = 'a'): BundleComponentInput {
  return { kind: 'skill', name, files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Summarize orders (${variant}).\n---\n\n1. Read the CSV.\n` }] }
}

/** A plugin component (never loaded here). */
export function plugin(name: string): BundleComponentInput {
  return {
    kind: 'plugin',
    name,
    files: [
      { path: 'plugin.json', content: JSON.stringify({ formatVersion: 1, name, description: 'Greets.', permissions: 'Runs inside the app with its full rights.', tools: ['greet'] }) },
      { path: 'index.mjs', content: 'export function apply() {}\n' },
    ],
  }
}

/** Propose `components` on top of the adopted bundle, as `capability_propose` would. */
export async function propose(root: string, components: readonly BundleComponentInput[], summary = 'reusable order summary'): Promise<CandidateRecord> {
  const store = capabilityStore(root)
  const base = await store.load((await store.activation()).version)
  const { record } = await writeCandidate(capabilitiesDir(root), {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    turn: 1,
    base,
    components: components.map(component => ({
      kind: component.kind,
      name: component.name,
      files: new Map(component.files.map(file => [file.path, typeof file.content === 'string' ? Buffer.from(file.content) : Buffer.from(file.content)])),
    })),
    proofs: components.map(component => ({ kind: component.kind, name: component.name, turn: 1, toolCallId: 'call-1' })),
    summary,
  })
  return record
}

const caseRef = (caseId: string) => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })

/** Write a trial's receipts: `trial.start` always, then `trial.end` with `verdict` when given. Returns the trial id. */
export async function trialReceipts(root: string, candidate: CandidateRecord, verdict?: TrialVerdict): Promise<string> {
  const trialId = randomUUID()
  const ts = new Date().toISOString()
  const lines: TrialReceipt[] = [{
    type: 'trial.start',
    format: 1,
    trialId,
    ts,
    candidateId: candidate.id,
    candidateVersion: candidate.version,
    baselineVersion: candidate.base,
    plan: { selection: [caseRef('s1'), caseRef('s2')], guard: [caseRef('g1')], repeats: 2, costRatioCap: 1.2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } },
  }]
  if (verdict !== undefined) {
    lines.push({ type: 'trial.end', format: 1, trialId, ts, status: verdict.outcome === 'reject' ? 'fail' : 'pass', verdict, cost: { candidate: COST, baseline: COST, review: COST } })
  }
  for (const line of lines) {
    const issues = validateCapabilityFile('trialReceipt', line)
    if (issues.length > 0) throw new Error(`fixture receipt invalid: ${issues[0]!.path} ${issues[0]!.message}`)
  }
  const dir = nodePath.join(capabilitiesDir(root), 'trials')
  await mkdir(dir, { recursive: true })
  await appendFile(nodePath.join(dir, `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  return trialId
}

export const verdict = (outcome: TrialVerdict['outcome'], reason: TrialVerdict['reason']): TrialVerdict => ({
  outcome,
  reason,
  passRate: { candidate: 1, baseline: 0.5 },
  costRatio: 1,
  decidedByReview: false,
})

/** The gate's conclusion as a decision without a revision (rejected / awaiting approval). */
export async function gateDecision(root: string, candidate: CandidateRecord, trialId: string, trialVerdict: TrialVerdict, detail: string): Promise<void> {
  const store = capabilityStore(root)
  const current = (await store.activation()).version
  await store.recordDecision({
    outcome: trialVerdict.outcome === 'reject' ? 'rejected' : 'awaiting-approval',
    reason: trialVerdict.reason,
    trigger: 'gate',
    candidateId: candidate.id,
    trialId,
    fromVersion: current,
    toVersion: current,
    verdict: trialVerdict,
    cost: { candidate: COST, baseline: COST, review: COST },
    detail,
  })
}
