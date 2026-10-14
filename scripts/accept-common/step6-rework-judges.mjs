/**
 * Judges of the step-6 rework items H19–H24 (ADR 0012, 0013) over the observations of
 * step6-rework.mjs (`{ shared, literal, similar, metaLiteral }`). Pure: each returns
 * `{ status: 'passed' | 'failed', evidence }`; missing observations fail, nothing passes on
 * absence. Counterexamples: packages/test-support/tests/accept-step6-rework.spec.ts.
 */

const V0 = 'v0'
const VERSION = /^[a-f0-9]{64}$/
const FINAL = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled'])
const pass = evidence => ({ status: 'passed', evidence })
const fail = (problems, context = '') => ({ status: 'failed', evidence: `${problems.join('; ')}${context === '' ? '' : ` (${context})`}` })
const short = value => (typeof value === 'string' && value.length > 12 ? `${value.slice(0, 12)}…` : String(value))
const text = value => String(value ?? '')

/** H19: one improver for every project of a home; the old project line read-only; opting out stops counting and reading, not use. */
export function judgeShared(obs) {
  const s = obs?.shared
  if (s === undefined) return fail(['the shared-improver observations are missing'])
  const problems = []
  const child = s.child
  const jobs = s.jobs ?? {}
  if (!VERSION.test(child ?? '')) problems.push(`no child improver in the user's line (${child})`)
  for (const [key, label, want] of [['oneOnChild', 'project one', child], ['twoOnChild', 'project two (sharing off)', child], ['oneAfterRollback', 'project one after the rollback', V0], ['twoAfterRollback', 'project two after the rollback', V0]]) {
    const job = jobs[key]
    if (job?.id === undefined) {
      problems.push(`${label}: the job did not start (${job?.code ?? 'not run'})`)
      continue
    }
    if (!FINAL.has(job.status)) problems.push(`${label}: the job ended ${job.status}`)
    if (job.improverVersion !== want) problems.push(`${label}: the job pinned ${short(job.improverVersion)}, want ${short(want)}`)
    if (job.improverScope !== 'user') problems.push(`${label}: job.json improverScope ${job.improverScope ?? 'absent'}`)
  }
  if (s.rollback?.inForce !== V0 || s.rollback?.version !== V0) problems.push(`the rollback left ${short(s.rollback?.inForce)} in force`)
  const line = s.projectLine ?? {}
  if (!VERSION.test(line.planted ?? '')) problems.push('no step-6-era project line was planted')
  if (line.scope !== 'project' || line.readOnly !== true) problems.push(`ImproverStore.project is ${line.scope}${line.readOnly ? '' : ', writable'}`)
  if (line.write !== 'improver/activation' || line.adopt !== 'improver/activation') problems.push(`writing / adopting in the project line: ${line.write} / ${line.adopt}`)
  if (line.resolved !== line.planted) problems.push(`the project line no longer reads as history (resolved ${short(line.resolved)})`)
  if (jobs.oneOnChild?.improverVersion === line.planted) problems.push('a job of project one ran on its old project-level improver')
  if (s.projectLineAfter?.revisions !== 1 || s.projectLineAfter?.bundles !== 1) problems.push(`the project line changed after the planting (${JSON.stringify(s.projectLineAfter)})`)
  if (s.shares?.one !== true || s.shares?.two !== false) problems.push(`sharing: one ${s.shares?.one}, two ${s.shares?.two}`)
  const ids = s.projectIds ?? {}
  const counted = s.queue?.counted ?? []
  for (const key of ['oneOnChild', 'oneAfterRollback']) if (jobs[key]?.id !== undefined && !counted.includes(`${ids.one}:${jobs[key].id}`)) problems.push(`project one's job ${short(jobs[key].id)} is not counted in the user queue`)
  if (counted.some(key => key.startsWith(`${ids.two}:`)) || (s.queue?.pending ?? []).some(entry => entry.projectId === ids.two)) problems.push('a job of project two (sharing off) was counted toward meta jobs')
  const probe = s.probe ?? {}
  const outside = (probe.toolResults ?? []).find(r => r.projectId === ids.two)
  const inside = (probe.toolResults ?? []).find(r => r.projectId === ids.one)
  if (outside?.isError !== true) problems.push(`a meta job of project one read project two (${outside === undefined ? 'not asked' : outside.text.slice(0, 120)})`)
  if (inside?.isError !== false) problems.push(`a meta job of project one could not read its own project (${inside?.text?.slice(0, 120) ?? 'not asked'})`)
  if ((probe.batch ?? []).some(id => id !== ids.one)) problems.push('the meta job\'s batch names project two')
  const ends = s.ledger?.one ?? []
  for (const key of ['oneOnChild', 'oneAfterRollback']) {
    const end = ends.find(r => r.improvementId === jobs[key]?.id)
    if (end === undefined) problems.push(`project one's job ${short(jobs[key]?.id)} has no improvement.end ledger record`)
    else if (end.improverScope !== 'user') problems.push(`project one's improvement.end says improverScope ${end.improverScope ?? 'absent'}`)
  }
  if (problems.length > 0) return fail(problems)
  return pass(`one NEXGENT_HOME, two projects: child ${short(child)} adopted in <home>/improvers → a job in each project pinned it (job.json improverScope user, improvement.end too); rolled back → the next job in each pinned v0; project one's step-6-era .nexgent/improvers (adopted ${short(line.planted)}) reads as history through ImproverStore.project (read-only: write and adopt refused improver/activation) and no job used it; project two (shareImproverEvidence off) still ran on the shared improver, but none of its jobs was counted in the user queue and a meta job of project one was refused reading it (improve_list_jobs: ${outside.text.slice(0, 80)}…)`)
}

/** H20: capability_propose refuses a component carrying the feedback task's values; without them it is proposed; constants and names pass. */
export function judgeProposeLiteral(obs) {
  const l = obs?.literal
  if (l?.first === undefined) return fail(['the literal observations are missing'])
  const problems = []
  const [refused, accepted] = l.first.proposals ?? []
  if (refused === undefined) problems.push('the proposal carrying the figure was not made')
  else {
    if (refused.isError !== true) problems.push(`the proposal carrying the feedback table's figure ${l.figure} was accepted`)
    // ADR 0013 decision 2.1: refused with the value and its source (the reason id instance-literal is the gate's, 2.2).
    if (refused.isError !== true || !/not proposed/.test(text(refused.text))) problems.push(`the proposal was not refused (${text(refused.text).slice(0, 160)})`)
    if (!text(refused.text).includes('skills/region-table-figures/')) problems.push('the refusal does not name the file the value is in')
    if (!text(refused.text).includes(l.figure)) problems.push(`the refusal does not name the value ${l.figure}`)
    if (!/feedback:|deliverable:/.test(text(refused.text))) problems.push('the refusal does not name the source of the value')
    if (new RegExp(`(^|\\D)${l.constant}(\\D|$)`).test(text(refused.text))) problems.push(`the refusal names the project constant ${l.constant} (it is in the messages of three tasks)`)
    if (text(refused.text).includes('avg_order_value')) problems.push('the refusal names the column avg_order_value')
  }
  if (accepted === undefined) problems.push('the redrafted proposal was not made')
  else if (accepted.isError !== false) problems.push(`the proposal without the figure was refused: ${text(accepted.text).slice(0, 200)}`)
  if (l.first.candidateId === undefined) problems.push(`job 1 has no candidate (ended ${l.first.status})`)
  if (problems.length > 0) return fail(problems)
  return pass(`in an improvement job's proposal session capability_propose refused a skill carrying ${l.figure} (the feedback task's table), naming the value, the file and its source and neither the project constant ${l.constant} (in three tasks' messages and a feedback comment) nor the column name; redrafted without the figure the same skill was proposed and became candidate ${short(l.first.candidateId)}`)
}

/** Trial runs of one case: `{ candidate: [...statuses], baseline: [...] }`. */
const runsOf = (c, caseId) => c?.decision?.runs?.[caseId] ?? { candidate: [], baseline: [] }

/** H21: a candidate that fixes the feedback task but makes its similar case worse is rejected; an unknown there is unknown. */
export function judgeSimilarRegression(obs) {
  const f = obs?.similar?.fail
  const u = obs?.similar?.unknown
  if (f === undefined || u === undefined) return fail(['the similar-case observations are missing'])
  const problems = []
  for (const [name, c] of [['fail', f], ['unknown', u]]) if (c.error !== undefined) problems.push(`${name}: ${c.error}`)
  if (problems.length > 0) return fail(problems)
  const v = f.decision?.verdict
  if (f.job?.status !== 'rejected' || f.decision?.reason !== 'similar-regression') problems.push(`fail: the job ended ${f.job?.status} (${f.decision?.reason})`)
  if (!(v?.feedbackPassRate?.candidate > v?.feedbackPassRate?.baseline)) problems.push(`fail: the candidate did not fix the feedback task (feedback checks ${JSON.stringify(v?.feedbackPassRate)})`)
  if (!(v?.similarPassRate?.candidate < v?.similarPassRate?.baseline)) problems.push(`fail: the similar case did not get worse (${JSON.stringify(v?.similarPassRate)})`)
  const similar = runsOf(f, f.similarTaskCase)
  if (!similar.candidate.includes('fail') || similar.baseline.some(status => status !== 'pass') || similar.baseline.length === 0) problems.push(`fail: the similar case's runs ${JSON.stringify(similar)}`)
  if (!(v?.passRate?.candidate > v?.passRate?.baseline)) problems.push(`fail: overall the candidate is not better (${JSON.stringify(v?.passRate)}), so the similar-case rule is not what stopped it`)
  if (!(f.similarReplays > 0)) problems.push('fail: the candidate never replayed the similar case')
  if (!text(f.decision?.detail).includes('Similar cases')) problems.push('fail: the decision text does not report the similar cases')
  const unknownRuns = runsOf(u, u.similarTaskCase)
  if (u.job?.status !== 'rejected' || u.decision?.reason !== 'unknown-runs') problems.push(`unknown: the job ended ${u.job?.status} (${u.decision?.reason})`)
  if (!unknownRuns.candidate.includes('unknown')) problems.push(`unknown: the similar case's candidate runs ${JSON.stringify(unknownRuns.candidate)} carry no unknown`)
  if (problems.length > 0) return fail(problems)
  return pass(`the convention skill fixed the feedback task (feedback checks ${v.feedbackPassRate.candidate} vs ${v.feedbackPassRate.baseline}; overall ${v.passRate.candidate.toFixed(2)} vs ${v.passRate.baseline.toFixed(2)}) but one of its replays of the similar history table failed (similar cases ${v.similarPassRate.candidate} vs ${v.similarPassRate.baseline}) → rejected, similar-regression; with that replay's model request failing instead the similar case's run is unknown → rejected, unknown-runs`)
}

/** H22: no similar case in the selection → not adopted automatically, await-approval (no-similar-cases); user-task candidates unchanged (step 4's H01–H19 via step 5's H19). */
export function judgeNoSimilar(obs) {
  const n = obs?.similar?.none
  if (n === undefined) return fail(['the no-similar-case observations are missing'])
  if (n.error !== undefined) return fail([n.error])
  const problems = []
  const v = n.decision?.verdict
  if (n.job?.status !== 'awaiting-approval') problems.push(`the job ended ${n.job?.status}`)
  if (v?.outcome !== 'await-approval' || n.decision?.reason !== 'no-similar-cases') problems.push(`the gate: ${v?.outcome} (${n.decision?.reason})`)
  if (v?.similarPassRate !== undefined) problems.push('the verdict carries a similar pass rate without similar cases')
  if (!(v?.feedbackPassRate?.candidate > v?.feedbackPassRate?.baseline)) problems.push(`the candidate did not fix the feedback task (${JSON.stringify(v?.feedbackPassRate)}): this would not have been adopted anyway`)
  if (!text(n.decision?.detail).includes('feedback task only')) problems.push('the decision text does not say it was checked on the feedback task only')
  const asks = n.asks ?? []
  if (asks.length < 4 || asks.some(task => task.check !== true)) problems.push(`the history tasks asked in other words did not all pass their checks (${JSON.stringify(asks)})`)
  const userTasks = obs?.step5H19
  if (userTasks?.status !== 'passed') problems.push(`user-task candidates (step 5 H19, step 4's items): ${userTasks?.status ?? 'not judged'}`)
  if (problems.length > 0) return fail(problems)
  return pass(`history tasks asked in words the feedback task does not share (checks passed): the candidate fixed the feedback task (${v.feedbackPassRate.candidate} vs ${v.feedbackPassRate.baseline}) yet, with no similar case in the selection, the job waits for approval (await-approval, no-similar-cases, "checked on the feedback task only"); candidates proposed by user tasks decide as before (step 5 H19 = step 4 H01–H19 passed)`)
}

/** H23: a candidate carrying a concrete value is refused by the gate before any replay; the rules id is adr-0015 (ADR 0015, after ADR 0014 decision 3) and the epoch moved with it. */
export function judgeGateLiteral(obs) {
  const l = obs?.literal
  const x = l?.second
  if (x === undefined) return fail(['the gate-literal observations are missing'])
  const problems = []
  if (x.proposal?.isError !== false) problems.push(`the late value's proposal was refused at propose time (${text(x.proposal?.text).slice(0, 120)}): the gate's own check is not reached`)
  if (x.note?.error !== undefined) problems.push(`the user's note turn failed: ${x.note.error}`)
  if (x.notePresented !== true) problems.push('the note with the value was not presented in the feedback session')
  if (x.status !== 'rejected') problems.push(`job 2 ended ${x.status}`)
  if (x.decision?.reason !== 'instance-literal' || x.decision?.outcome !== 'rejected') problems.push(`the gate decided ${x.decision?.outcome} (${x.decision?.reason})`)
  const hit = (x.decision?.instanceLiterals ?? []).find(h => h.value === l.lateValue)
  if (hit === undefined) problems.push(`the decision does not list ${l.lateValue}`)
  else if (!text(hit.source).startsWith('deliverable:')) problems.push(`the hit's source is ${hit.source}`)
  if (x.decision?.trialId !== undefined || (x.trials ?? []).length > 0) problems.push('a trial was created for the refused candidate')
  if (x.newTrialRecords !== 0) problems.push(`${x.newTrialRecords} ledger records with a trialId were written during job 2`)
  if (x.replayRequests !== 0) problems.push(`${x.replayRequests} replay / review requests reached the model during job 2`)
  const r = l.rules ?? {}
  if (r.id !== 'adr-0015') problems.push(`the evaluator rules id is ${r.id}`)
  if (!VERSION.test(r.epoch ?? '') || r.epoch !== r.projectEpoch) problems.push('the project epoch is not the adr-0015 epoch of its settings')
  if (r.epoch === r.epochAdr0008) problems.push('the epoch did not change with the rules id')
  if (r.firstTrialEpoch !== undefined && r.firstTrialEpoch !== r.projectEpoch) problems.push(`job 1's trial ran in epoch ${short(r.firstTrialEpoch)}`)
  if (problems.length > 0) return fail(problems)
  return pass(`a skill carrying ${l.lateValue} passed capability_propose (no source had it); the user then presented a note with it in the feedback session; the gate refused the candidate before replaying (rejected, instance-literal, ${hit.source}): no trial, no ledger record with a trialId, no replay or review request; rules id adr-0015, epoch ${short(r.epoch)} (adr-0008 would give ${short(r.epochAdr0008)})${r.firstTrialEpoch === undefined ? '' : ', job 1\'s trial ran in it'}`)
}

/** H24: a meta change carrying a concrete value of the batch's tasks is refused, the value named, no child stored. */
export function judgeMetaLiteral(obs) {
  const m = obs?.metaLiteral
  if (m === undefined) return fail(['the meta-literal observations are missing'])
  const problems = []
  if (m.refusal === undefined) problems.push('the change was not proposed')
  else {
    if (m.refusal.isError !== true || !text(m.refusal.text).includes('instance-literal')) problems.push(`the change carrying ${m.figure} was not refused as instance-literal (${text(m.refusal.text).slice(0, 160)})`)
    if (!text(m.refusal.text).includes(m.figure)) problems.push(`the refusal does not name ${m.figure}`)
  }
  if (m.meta?.change !== undefined) problems.push('change.json was written')
  if (m.meta?.status === 'adopted' || m.meta?.status === 'rejected' || !FINAL.has(m.meta?.status)) problems.push(`the meta job ended ${m.meta?.status ?? m.meta?.code}`)
  if ((m.lineAfter?.versions ?? []).length !== (m.lineBefore?.versions ?? []).length || m.bundlesAfter !== (m.lineBefore?.versions ?? []).length) problems.push('a child improver was stored in the user\'s line')
  if ((m.lineAfter?.history ?? []).length !== (m.lineBefore?.history ?? []).length) problems.push('the user\'s improver line got a revision')
  if (!(m.meta?.batch ?? []).includes(m.source?.id)) problems.push('the meta job\'s batch lacks the feedback job')
  if (problems.length > 0) return fail(problems)
  return pass(`a meta change whose paragraph carried ${m.figure} (the feedback task's table, a deliverable of the batch's job) was refused by improve_propose_change (instance-literal, value named); the meta job ended ${m.meta.status} with no change.json and nothing stored or adopted in <NEXGENT_HOME>/improvers`)
}

/** Judges by item id. */
export const REWORK_JUDGES = {
  H19: judgeShared,
  H20: judgeProposeLiteral,
  H21: judgeSimilarRegression,
  H22: judgeNoSimilar,
  H23: judgeGateLiteral,
  H24: judgeMetaLiteral,
}
