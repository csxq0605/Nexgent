/**
 * The R judges of accept-step4: each decides one real-model item from the
 * observations step4-real.mjs collected (`{ tasks, candidates, gate, trials,
 * decisions, activation, injection, usage, … }`). Pure, so each is tested
 * against hand-made observations (packages/test-support/tests/accept-step4-real.spec.ts).
 *
 * A run against a loopback stand-in is never real-model evidence: every item
 * then fails. A task counts only when its turn completed and its output
 * passed the hidden check (scripts/real-task/step4-orders.mjs). The gate's
 * verdict is recorded whatever it is (R03); R04 and R05 need an adoption.
 */
import { verdict } from './step2-judges.mjs'

const real = obs => [obs?.realModel === true, 'the run used the real model (not a loopback stand-in)']
const stopNote = obs => (obs?.stopped ? `; the scenario stopped at ${obs.stopped.step}: ${obs.stopped.reason}` : obs?.error ? `; the scenario failed at ${obs.error.step}: ${String(obs.error.message).split('\n')[0]}` : '')
const short = version => (typeof version === 'string' ? version.slice(0, 12) : String(version))
const completed = t => t?.reason?.kind === 'completed'
const checksPassed = t => (t?.checks ?? []).length > 0 && t.checks.every(c => c.passed === true)

/** Completed, hidden check passed, and the test command's checks recorded and passing. */
function taskDone(obs, key, label) {
  const t = obs?.tasks?.[key]
  if (t === undefined) return [[false, `${label} did not run${stopNote(obs)}`]]
  return [
    [completed(t), `${label} completed (got ${JSON.stringify(t.reason?.kind ?? t.error ?? null)})`],
    [t.hidden?.pass === true, `${label} passes the hidden check${t.hidden?.pass ? '' : ` (${(t.hidden?.problems ?? ['not run']).slice(0, 3).join('; ')})`}`],
  ]
}

/** The gate trial of a candidate: its receipts (the last trial that names it). */
const trialOf = (obs, candidateId) => Object.values(obs?.trials ?? {}).filter(r => r[0]?.type === 'trial.start' && r[0].candidateId === candidateId).at(-1) ?? []
const gateDecision = (obs, trialId) => (obs?.decisions ?? []).find(d => trialId !== undefined && d.trialId === trialId && d.trigger === 'gate')
const usageRecorded = u => typeof u?.callCount === 'number' && typeof u?.costUsd === 'number' && typeof u?.unknownCount === 'number' && u?.known !== undefined

export const REAL_JUDGES = {
  R01(obs) {
    const keys = ['history1', 'history2']
    return verdict([
      real(obs),
      ...keys.flatMap(key => taskDone(obs, key, key)),
      ...keys.map(key => [checksPassed(obs?.tasks?.[key]), `${key}'s task.outcome records its test command's checks, all passing (got ${JSON.stringify((obs?.tasks?.[key]?.checks ?? []).map(c => c.passed))})`]),
      [(obs?.snapshots ?? []).length > 0, `the project keeps snapshots for the replay set (${(obs?.snapshots ?? []).length} files)`],
    ], `two history tasks (${keys.map(key => obs?.tasks?.[key]?.id).join(', ')}) completed with passing checks and snapshots`)
  },

  R02(obs) {
    const candidates = obs?.candidates ?? []
    const kinds = candidates.flatMap(c => c.components.map(x => x.kind))
    const proofs = (obs?.proposals ?? []).flatMap(p => p.proofs ?? [])
    return verdict([
      real(obs),
      ...taskDone(obs, 'A', 'task A'),
      [candidates.length >= 1, `task A proposed a candidate (got ${candidates.length})`],
      [kinds.some(kind => kind === 'function-module' || kind === 'skill'), `the candidate holds a function module or a skill (got ${JSON.stringify(kinds)})`],
      [candidates.every(c => c.taskId === obs?.tasks?.A?.taskId) && proofs.length >= 1, 'the proposal names task A and carries proofs of successful calls'],
    ], `task A proposed ${candidates.map(c => `${short(c.version)} [${c.components.map(x => `${x.kind} ${x.name}`).join(', ')}]`).join('; ')}`)
  },

  R03(obs) {
    const candidate = (obs?.candidates ?? [])[0]
    const receipts = candidate === undefined ? [] : trialOf(obs, candidate.id)
    const start = receipts.find(r => r.type === 'trial.start')
    const runs = receipts.filter(r => r.type === 'trial.run')
    const end = receipts.find(r => r.type === 'trial.end')
    const decision = gateDecision(obs, start?.trialId)
    const line = candidate === undefined ? undefined : obs?.gate?.[candidate.id]?.line
    const arms = new Set(runs.map(r => r.arm))
    const trialCost = obs?.usage?.trials?.[start?.trialId]
    return verdict([
      real(obs),
      [candidate !== undefined, `a candidate reached the gate${stopNote(obs)}`],
      [start !== undefined && typeof start.plan?.repeats === 'number' && start.plan.repeats >= 1, `the gate started a trial with r = ${start?.plan?.repeats}`],
      [arms.has('candidate') && arms.has('baseline'), `both arms ran on the replay set (${runs.length} runs)`],
      [end !== undefined && end.status !== 'unknown', `the trial ended with a known result (got ${end?.status ?? 'no end'})`],
      [line != null && line.verdict !== undefined, `the gate printed its result (got ${line == null ? 'none' : line.status})`],
      [decision !== undefined && decision.verdict !== undefined && decision.cost !== undefined, `a gate decision with its verdict and per-arm costs was written (got ${decision?.outcome ?? 'none'})`],
      [usageRecorded(trialCost), 'the trial\'s requests, tokens and cost are read from the ledger apart from the tasks'],
    ], `gate verdict ${end?.verdict?.outcome ?? '?'} (${end?.verdict?.reason ?? '?'}): pass rate candidate ${end?.verdict?.passRate?.candidate} vs baseline ${end?.verdict?.passRate?.baseline}, cost ratio ${end?.verdict?.costRatio}, decided by review ${end?.verdict?.decidedByReview}; decision ${decision?.outcome}; trial ~${trialCost?.costUsd} USD in ${trialCost?.callCount} requests`)
  },

  R04(obs) {
    const adopted = obs?.adopted
    const b = obs?.tasks?.B
    const candidate = (obs?.candidates ?? []).find(c => c.id === adopted?.candidateId)
    const used = (b?.componentsUsed ?? []).filter(u => u.version === adopted?.version && (candidate?.components ?? []).some(c => c.kind === u.kind && c.name === u.name) && u.calls >= 1)
    const versions = obs?.ledgerVersions?.[b?.sessionId] ?? []
    return verdict([
      real(obs),
      [adopted != null, `the gate adopted a candidate (got ${adopted == null ? 'none: R04 is not met when the gate rejects' : short(adopted.version)})${stopNote(obs)}`],
      ...taskDone(obs, 'B', 'task B'),
      [b?.child?.exitCode === 0 && b?.child?.pid !== undefined && b.child.pid !== b.child.parentPid, `task B ran in its own OS process (exit ${b?.child?.exitCode})`],
      [adopted != null && b?.version === adopted.version, `B's session.start carries the adopted version (got ${short(b?.version)})`],
      [adopted != null && versions.length === 1 && versions[0] === adopted.version, `every ledger record of B carries the adopted version (got ${versions.map(short).join(', ') || 'none'})`],
      [used.length >= 1, `task.outcome.componentsUsed lists a component of the adopted candidate, called (got ${JSON.stringify(b?.componentsUsed ?? null)})`],
    ], `a new process loaded ${short(adopted?.version)} by itself and used ${used.map(u => `${u.kind} ${u.name} (${u.calls} calls, ${u.errors} errors)`).join(', ') || 'nothing'}`)
  },

  R05(obs) {
    const injection = obs?.injection
    const decision = (obs?.decisions ?? []).find(d => d.outcome === 'rolled-back' && d.trigger === 'usage-regression' && d.fromVersion === injection?.version)
    const revision = (obs?.activation ?? []).find(r => decision !== undefined && r.decisionId === decision.id)
    const regress = obs?.regression?.tasks ?? []
    const after = obs?.tasks?.afterRollback
    const window = obs?.rule?.windowTasks ?? 3
    return verdict([
      real(obs),
      [injection?.version !== undefined, `a broken copy of the adopted function module was adopted on purpose (got ${injection?.skipped ?? (injection ? short(injection.version) : 'none')})${stopNote(obs)}`],
      [regress.length >= 1 && regress.every(key => obs?.tasks?.[key]?.version === injection?.version), `the tasks after the injection ran on it (${regress.map(key => `${key} ${short(obs?.tasks?.[key]?.version)}`).join(', ') || 'none'})`],
      [decision !== undefined, `a usage-regression rollback decision was written (got ${(obs?.decisions ?? []).filter(d => d.outcome === 'rolled-back').map(d => d.trigger).join(', ') || 'none'})`],
      [(decision?.regression?.observations ?? []).length >= 1 && decision.regression.observations.length <= window, `within the rule's window of ${window} tasks (observed ${decision?.regression?.observations?.length ?? 0})`],
      [revision?.type === 'rollback' && revision.from === injection?.version && revision.version === injection?.from, `the rollback revision goes from ${short(injection?.version)} back to ${short(injection?.from)} (got ${JSON.stringify(revision && [revision.type, short(revision.from), short(revision.version)])})`],
      [after !== undefined && after.version === injection?.from, `the next task ran on the version before the injection (got ${short(after?.version)})`],
      ...taskDone(obs, 'afterRollback', 'the task after the rollback'),
    ], `injected ${short(injection?.version)}; rolled back (${decision?.reason ?? '?'}) after ${decision?.regression?.observations?.length ?? '?'} task(s); the next task ran on ${short(after?.version)}`)
  },

  R06(obs) {
    const tasks = Object.entries(obs?.usage?.tasks ?? {})
    const missing = tasks.filter(([, u]) => !usageRecorded(u)).map(([key]) => key)
    const spent = (obs?.spentBeforeUsd ?? 0) + (obs?.totalCostUsd ?? Infinity)
    const sum = (obs?.usage?.trial?.costUsd ?? NaN) + (obs?.usage?.main?.costUsd ?? NaN)
    return verdict([
      real(obs),
      [tasks.length >= 1 && missing.length === 0, `every task records requests, tokens, unknown count and estimated cost${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`],
      [usageRecorded(obs?.usage?.trial) && usageRecorded(obs?.usage?.main), 'the trial\'s cost is reported apart from the tasks\''],
      [Math.abs(sum - (obs?.usage?.total?.costUsd ?? NaN)) < 0.001, 'trial and task costs add up to the total'],
      [typeof obs?.budgetUsd === 'number' && spent <= obs.budgetUsd, `cumulative estimated cost ${Number.isFinite(spent) ? spent.toFixed(2) : '?'} USD within the ${obs?.budgetUsd} USD cap`],
    ], `tasks: ${tasks.map(([key, u]) => `${key} ${u.callCount} req, ~${u.costUsd} USD, ${u.unknownCount} unknown`).join('; ')}; trial ${obs?.usage?.trial?.callCount} req ~${obs?.usage?.trial?.costUsd} USD; total ~${obs?.usage?.total?.costUsd} USD`)
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
