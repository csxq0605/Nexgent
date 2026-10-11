/**
 * The R judges of accept-step3: each decides one real-model item from the
 * observations step3-real.mjs collected (`{ runs: { R01…R05 }, totalCostUsd,
 * budgetUsd, … }`). Pure, so each is tested against hand-made observations
 * (packages/test-support/tests/accept-step3-real.spec.ts).
 *
 * A run against a loopback stand-in is never real-model evidence: every item
 * then fails. The hidden check decides whether the deliverable is right; the
 * form conditions decide whether the run used the form the user asked for.
 */
import { verdict } from './step2-judges.mjs'

const runOf = (obs, id) => obs?.runs?.[id]
const completed = phase => phase?.reason?.kind === 'completed'
const workflowMembers = run => (run?.collaboration?.runs ?? []).filter(r => r.executionForm === 'workflow')
const formsOf = run => [...new Set((run?.formsUsed ?? []).flat().filter(Boolean))]

/** Conditions every run shares: real model, both turns completed, hidden check passed. */
function common(run, id) {
  if (run === undefined) return [[false, `${id} did not run`]]
  return [
    [run.realModel === true, 'the run used the real model (not a loopback stand-in)'],
    [run.error === undefined, `the run finished without a scenario error${run.error ? ` (${String(run.error).split('\n')[0]})` : ''}`],
    [completed(run.phases?.first) && completed(run.phases?.feedback), `round 1 and the feedback round completed (got ${run.phases?.first?.reason?.kind}, ${run.phases?.feedback?.reason?.kind ?? run.phases?.feedback?.skipped})`],
    [run.hidden?.pass === true, `hidden check: v1, v2 and the unchanged v1 snapshot${run.hidden?.pass ? '' : ` (${(run.hidden?.problems ?? ['not run']).slice(0, 4).join('; ')})`}`],
  ]
}

export const REAL_JUDGES = {
  R01(obs) {
    const run = runOf(obs, 'R01')
    return verdict([
      ...common(run, 'R01'),
      [run !== undefined && (run.children ?? []).length === 0 && formsOf(run).join() === 'direct', `direct: no child session, formsUsed [direct] (got ${(run?.children ?? []).length} children, ${JSON.stringify(formsOf(run))})`],
    ], 'direct: purchase.xlsx v1 and v2 pass the hidden check (Plan formulas, order quantities, amounts, Summary totals)')
  },

  R02(obs) {
    const run = runOf(obs, 'R02')
    const delegated = (run?.children ?? []).filter(c => c.member?.executionForm === 'delegated')
    const memberPresented = (run?.deliverables ?? []).some(d => d.versions.some(v => v.memberName !== null))
    return verdict([
      ...common(run, 'R02'),
      [delegated.length >= 1, `at least one delegated child session (got ${delegated.length})`],
      [memberPresented, 'a member presented a file'],
    ], 'delegated: a child session presented files and the final deliverable passes the hidden check')
  },

  R03(obs) {
    const run = runOf(obs, 'R03')
    const team = run?.collaboration?.team
    const messages = team?.messages ?? []
    return verdict([
      ...common(run, 'R03'),
      [(team?.members ?? []).length >= 2, `at least two teammates (got ${(team?.members ?? []).map(m => m.name).join(', ') || 'none'})`],
      [messages.length >= 1, `at least one mailbox message (got ${messages.length})`],
    ], 'team: two or more teammates, at least one mailbox message, and the final deliverable passes the hidden check')
  },

  R04(obs) {
    const run = runOf(obs, 'R04')
    const workflows = run?.collaboration?.workflows ?? []
    const members = workflowMembers(run)
    return verdict([
      ...common(run, 'R04'),
      [workflows.length >= 1, `a workflow record (got ${workflows.length})`],
      [members.length >= 2, `at least two workflow members (got ${members.length})`],
    ], 'workflow: a workflow with two or more members, and the final deliverable passes the hidden check')
  },

  R05(obs) {
    const run = runOf(obs, 'R05')
    const reason = (run?.rootTexts ?? []).find(t => t.turn === 1)?.text ?? ''
    return verdict([
      ...common(run, 'R05'),
      [formsOf(run).length >= 1, `the form the model chose is recorded (formsUsed ${JSON.stringify(formsOf(run))})`],
      [reason.trim() !== '', 'the model stated its choice in round 1 (recorded; the choice itself is not judged)'],
    ], `unspecified: the model chose ${JSON.stringify(formsOf(run))}; the deliverable passes the hidden check`)
  },

  R06(obs) {
    const rows = ['R01', 'R02', 'R03', 'R04'].map(id => ({ id, run: runOf(obs, id) }))
    const missing = rows.filter(r => r.run === undefined || typeof r.run.usage?.costUsd !== 'number' || typeof r.run.usage?.callCount !== 'number' || typeof r.run.hidden?.pass !== 'boolean')
    const real = rows.every(r => r.run?.realModel === true)
    const table = rows.map(r => `${r.id} ${r.run?.form ?? '?'}: ${r.run?.usage?.callCount ?? '?'} requests, ~${r.run?.usage?.costUsd ?? '?'} USD, ${r.run?.hidden?.pass === true ? 'pass' : 'fail'}`).join('; ')
    return verdict([
      [real, 'all four runs used the real model'],
      [missing.length === 0, `cost, request count and result recorded for R01–R04${missing.length ? ` (missing: ${missing.map(r => r.id).join(', ')})` : ''}`],
    ], `same-budget comparison, recorded side by side (no claim that collaboration helps): ${table}`)
  },

  R07(obs) {
    const runs = Object.values(obs?.runs ?? {})
    const incomplete = runs.filter(run => typeof run.usage?.callCount !== 'number' || typeof run.usage?.costUsd !== 'number' || typeof run.usage?.unknownCount !== 'number' || run.usage?.known === undefined)
    const spent = (obs?.spentBeforeUsd ?? 0) + (obs?.totalCostUsd ?? Infinity)
    return verdict([
      [runs.length === 5, `five runs (got ${runs.length}${obs?.stoppedForBudget ? `; stopped before ${obs.stoppedForBudget.before} for the budget` : ''})`],
      [runs.every(run => run.realModel === true), 'every run used the real model'],
      [incomplete.length === 0, 'every run records requests, tokens, unknown count and estimated cost'],
      [typeof obs?.budgetUsd === 'number' && spent <= obs.budgetUsd, `cumulative estimated cost ${Number.isFinite(spent) ? spent.toFixed(2) : '?'} USD within the ${obs?.budgetUsd} USD cap`],
    ], `per run: ${runs.map(run => `${run.id} ${run.usage?.callCount} req, ${(run.usage?.known?.input ?? 0) + (run.usage?.known?.output ?? 0)} tokens, ${run.usage?.unknownCount} unknown, ~${run.usage?.costUsd} USD`).join('; ')}`)
  },
}

/**
 * Judge one real item; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judgeReal(id, obs) {
  const fn = REAL_JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return fn(obs ?? {})
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
