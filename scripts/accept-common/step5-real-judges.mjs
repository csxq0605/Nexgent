/**
 * The R judges of accept-step5: each decides one real-model item from the observations
 * step5-real.mjs collected (`{ tasks, feedback, jobs, candidates, adopted, decisions,
 * trials, usage, prompts, … }`). Pure, so each is tested against hand-made observations
 * (packages/test-support/tests/accept-step5-real.spec.ts).
 *
 * A run against a loopback stand-in is never real-model evidence: every item then fails.
 * A task counts only when its turn completed and its output passed the hidden check
 * (scripts/real-task/step5-orders.mjs). The gate's conclusion is recorded whatever it is
 * (R04); R05 needs an adoption. R07 never decides the exit code.
 */
import { THRESHOLD } from '../real-task/step5-orders.mjs'
import { verdict } from './step2-judges.mjs'

/** Tool names a human must never have typed in this layer (R01–R03). */
export const TOOL_NAMES = /capability_(draft|try|propose)|load_skill|improve_/

const real = obs => [obs?.realModel === true, 'the run used the real model (not a loopback stand-in)']
const stopNote = obs => (obs?.stopped ? `; the scenario stopped at ${obs.stopped.step}: ${obs.stopped.reason}` : obs?.error ? `; the scenario failed at ${obs.error.step}: ${String(obs.error.message).split('\n')[0]}` : '')
const short = version => (typeof version === 'string' ? version.slice(0, 12) : String(version))
const completed = t => t?.reason?.kind === 'completed'
const checksPassed = t => (t?.checks ?? []).length > 0 && t.checks.every(c => c.passed === true)
const usageRecorded = u => typeof u?.callCount === 'number' && typeof u?.costUsd === 'number' && typeof u?.unknownCount === 'number' && u?.known !== undefined
const receiptsOf = job => job?.show?.candidate?.receipts ?? []
const SETTLED_CONCLUSIONS = ['adopted', 'rejected', 'waiting-history', 'no-proposal', 'failed', 'budget-exhausted', 'awaiting-approval', 'interrupted', 'cancelled']

/** Completed and the hidden check's `field` (pass, or base: the asked columns right). */
function taskDone(obs, key, label, field = 'pass') {
  const t = obs?.tasks?.[key]
  if (t === undefined) return [[false, `${label} did not run${stopNote(obs)}`]]
  return [
    [completed(t), `${label} completed (got ${JSON.stringify(t.reason?.kind ?? t.error ?? null)})`],
    [t.hidden?.[field] === true, `${label} passes the hidden check${field === 'base' ? ' on the asked columns' : ''}${t.hidden?.[field] ? '' : ` (${(t.hidden?.problems ?? ['not run']).slice(0, 3).join('; ')})`}`],
  ]
}

/** The asks and the feedback a human typed name no capability tool (R01–R03). */
const noToolNames = obs => {
  const named = [...(obs?.prompts?.asks ?? []), ...(obs?.prompts?.comments ?? [])].filter(text => TOOL_NAMES.test(text))
  return [(obs?.prompts?.asks ?? []).length > 0 && named.length === 0, `no task ask or feedback names a capability tool${named.length ? ` (got: ${named.map(t => t.slice(0, 60)).join(' | ')})` : ''}`]
}

export const REAL_JUDGES = {
  R01(obs) {
    const keys = ['history1', 'history2', 'history3']
    return verdict([
      real(obs),
      ...keys.flatMap(key => taskDone(obs, key, key, 'base')),
      ...keys.map(key => [checksPassed(obs?.tasks?.[key]), `${key}'s task.outcome records its test command's checks, all passing (got ${JSON.stringify((obs?.tasks?.[key]?.checks ?? []).map(c => c.passed))})`]),
      [(obs?.snapshots ?? []).length > 0, `the project keeps snapshots for the replay set (${(obs?.snapshots ?? []).length} files)`],
      noToolNames(obs),
    ], `three history tasks (${keys.map(key => obs?.tasks?.[key]?.id).join(', ')}) completed with passing checks and snapshots; no ask names a capability tool`)
  },

  R02(obs) {
    const t = obs?.tasks?.feedback
    const entries = obs?.feedback?.main ?? []
    const counted = entries.filter(e => e.counted)
    return verdict([
      real(obs),
      ...taskDone(obs, 'feedback', 'the feedback task', 'base'),
      [t?.hidden?.missingConvention === true, `the hidden judge finds the problem the feedback names (the column is missing) in the feedback task's table (got ${(t?.hidden?.problems ?? ['not run']).join('; ') || 'no problem'})`],
      [entries.length >= THRESHOLD && entries.every(e => typeof e.id === 'string' && e.reason?.kind === 'completed'), `every feedback was recorded and its feedback turn completed (${entries.map(e => `${e.key} ${e.reason?.kind ?? 'none'}`).join(', ')})`],
      [counted.length === THRESHOLD, `${counted.length} counted feedbacks, expected ${THRESHOLD}`],
      noToolNames(obs),
    ], `the feedback task's table lacks only ${t?.hidden?.problems?.[0]?.replace(/^column | is missing$/g, '') ?? 'the convention column'}; ${entries.length} feedbacks recorded (${counted.length} counted), every feedback turn completed`)
  },

  R03(obs) {
    const job = obs?.jobs?.main
    const counted = (obs?.feedback?.main ?? []).filter(e => e.counted).map(e => e.id)
    const valid = obs?.diagnosisValid?.main
    const candidate = (obs?.candidates ?? []).find(c => c.id === job?.candidateId)
    const kinds = (candidate?.components ?? []).map(c => `${c.kind} ${c.name}`)
    return verdict([
      real(obs),
      [job !== undefined, `a job started after the third counted feedback${stopNote(obs)}`],
      [job?.trigger === 'feedback-count', `the job started by itself (trigger ${job?.trigger})`],
      [job !== undefined && counted.length === THRESHOLD && counted.every(id => (job.feedbackIds ?? []).includes(id)), `the job cites the counted feedback (${JSON.stringify(job?.feedbackIds)})`],
      [job?.diagnosis !== undefined && valid?.valid === true, `the diagnosis passes the schema (${valid === undefined || valid === null ? 'no diagnosis' : (valid.errors ?? []).slice(0, 2).join('; ') || 'valid'})`],
      [job?.diagnosis?.proposalKind !== 'none' && candidate !== undefined && candidate.components.length === 1 && candidate.origin === 'improvement' && candidate.jobId === job?.jobId, `the proposal produced one candidate of the job (got ${candidate === undefined ? `none; job ${job?.status}${job?.detail ? `: ${String(job.detail).slice(0, 160)}` : ''}` : kinds.join(', ')})`],
      noToolNames(obs),
    ], `the third counted feedback started job ${String(job?.jobId).slice(0, 8)} (feedback-count); diagnosis ${(job?.diagnosis?.failureTypes ?? []).map(f => f.category).join(', ')}, proposalKind ${job?.diagnosis?.proposalKind}; the model chose ${kinds.join(', ')}; nobody named a capability tool`)
  },

  R04(obs) {
    const job = obs?.jobs?.main
    const receipts = receiptsOf(job)
    const feedback = receipts.filter(r => r.type === 'trial.feedback')
    const end = receipts.find(r => r.type === 'trial.end')
    const decision = (obs?.decisions ?? []).find(d => d.id === job?.decisionId)
    const trialed = (job?.history ?? []).includes('trialing')
    return verdict([
      real(obs),
      [job !== undefined && SETTLED_CONCLUSIONS.includes(job.status), `the job reached a conclusion (got ${job?.status ?? 'no job'})${stopNote(obs)}`],
      [trialed, `the job's candidate went through the gate (history ${(job?.history ?? []).join(' → ')})`],
      [!trialed || job.status === 'waiting-history' || (decision !== undefined && typeof decision.detail === 'string'), `the gate's decision is written with its reasons (got ${decision?.outcome ?? 'none'})`],
      [!trialed || job.status === 'waiting-history' || (['candidate', 'baseline'].every(arm => feedback.some(r => r.arm === arm && ['pass', 'fail'].includes(r.status)))), `both arms have known feedback checks (${feedback.map(r => `${r.arm} ${r.status}`).join(', ') || 'none'})`],
      [!trialed || job.status === 'waiting-history' || (/Feedback checks/.test(decision?.detail ?? '') && end?.verdict?.feedbackPassRate !== undefined), 'the feedback checks are listed apart from the deterministic checks'],
    ], `gate: ${job?.status}${decision ? ` (${decision.reason}; ${String(decision.detail).split('. ').slice(0, 1).join('')})` : ''}; feedback pass rate ${JSON.stringify(end?.verdict?.feedbackPassRate)} beside pass rate ${JSON.stringify(end?.verdict?.passRate)}`)
  },

  R05(obs) {
    const adopted = obs?.adopted
    const next = obs?.tasks?.next
    const candidate = (obs?.candidates ?? []).find(c => c.id === adopted?.candidateId)
    const used = (next?.componentsUsed ?? []).filter(u => u.version === adopted?.version && (candidate?.components ?? []).some(c => c.kind === u.kind && c.name === u.name) && u.calls >= 1)
    const versions = obs?.ledgerVersions?.[next?.sessionId] ?? []
    const firstUse = obs?.jobs?.main?.firstUse
    return verdict([
      real(obs),
      [adopted != null, `the gate adopted the job's candidate (got ${adopted == null ? `${obs?.jobs?.main?.status ?? 'no job'}: R05 is not met when the gate does not adopt` : short(adopted.version)})${stopNote(obs)}`],
      ...taskDone(obs, 'next', 'the next task'),
      [next?.child?.exitCode === 0 && next?.child?.pid !== undefined && next.child.pid !== next.child.parentPid, `the next task ran in its own OS process (exit ${next?.child?.exitCode})`],
      [adopted != null && next?.version === adopted.version && versions.length === 1 && versions[0] === adopted.version, `the next task's session and ledger carry the adopted version (got ${short(next?.version)}; ${versions.map(short).join(', ') || 'none'})`],
      [used.length >= 1, `task.outcome.componentsUsed lists the adopted component, called (got ${JSON.stringify(next?.componentsUsed ?? null)})`],
      [firstUse?.taskId !== undefined && firstUse.taskId === next?.taskId, `the job's first use points at the next task (got ${JSON.stringify(firstUse ?? null)})`],
    ], `a new process loaded ${short(adopted?.version)} by itself, used ${used.map(u => `${u.kind} ${u.name} (${u.calls} calls)`).join(', ') || 'nothing'}, and the hidden judge finds the column the feedback named; first use recorded at ${firstUse?.at}`)
  },

  R06(obs) {
    const tasks = Object.entries(obs?.usage?.tasks ?? {})
    const turns = Object.entries(obs?.usage?.feedbackTurns ?? {})
    const jobs = Object.entries(obs?.usage?.jobs ?? {})
    const missing = [...tasks, ...turns].filter(([, u]) => !usageRecorded(u)).map(([key]) => key)
    const phaseMissing = jobs.flatMap(([label, j]) => Object.entries(j.phases ?? {}).filter(([, u]) => !usageRecorded(u)).map(([phase]) => `${label}:${phase}`))
    const spent = (obs?.spentBeforeUsd ?? 0) + (obs?.totalCostUsd ?? Infinity)
    const u = obs?.usage
    const sum = (u?.improvement?.costUsd ?? NaN) + (u?.trialOutsideJobs?.costUsd ?? NaN) + (u?.user?.costUsd ?? NaN)
    return verdict([
      real(obs),
      [tasks.length >= 1 && missing.length === 0, `every task and feedback turn records requests, tokens, unknown count and estimated cost${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`],
      [jobs.length >= 1 && phaseMissing.length === 0 && jobs.every(([, j]) => Object.keys(j.phases ?? {}).length >= 1), `every job's phases are priced from the ledger${phaseMissing.length ? ` (missing: ${phaseMissing.join(', ')})` : ''}`],
      [usageRecorded(u?.improvement) && usageRecorded(u?.user), 'the improvement cost is reported apart from the user\'s tasks'],
      [Math.abs(sum - (u?.total?.costUsd ?? NaN)) < 0.002, 'improvement, other trials and user costs add up to the total'],
      [typeof obs?.budgetUsd === 'number' && spent <= obs.budgetUsd, `cumulative estimated cost ${Number.isFinite(spent) ? spent.toFixed(2) : '?'} USD within the ${obs?.budgetUsd} USD cap`],
    ], `tasks: ${tasks.map(([key, x]) => `${key} ${x.callCount} req ~${x.costUsd} USD${x.unknownCount ? ` (${x.unknownCount} unknown)` : ''}`).join('; ')}; feedback turns ~${turns.reduce((s, [, x]) => s + (x.costUsd ?? 0), 0).toFixed(4)} USD; ${jobs.map(([label, j]) => `job ${label}: ${Object.entries(j.phases ?? {}).map(([phase, x]) => `${phase} ${x.callCount} req ~${x.costUsd} USD`).join(', ')}`).join('; ')}; improvement ~${u?.improvement?.costUsd} USD; total ~${u?.total?.costUsd} USD`)
  },

  R07(obs) {
    const job = obs?.jobs?.second
    const all = obs?.jobList ?? []
    const adopted = all.filter(j => j.status === 'adopted').length
    return verdict([
      real(obs),
      [job !== undefined && SETTLED_CONCLUSIONS.includes(job.status), `a second job ran to a conclusion (got ${job?.status ?? 'no job'})${stopNote(obs)}`],
      [job?.trigger === 'feedback-count', `the second job started by itself (trigger ${job?.trigger})`],
    ], `second job: ${job?.status}${job?.detail ? ` (${String(job.detail).slice(0, 160)})` : ''}; jobs ${all.length} / adopted ${adopted}`)
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
