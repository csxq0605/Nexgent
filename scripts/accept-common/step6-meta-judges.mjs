/**
 * Judges of the meta-improvement items H04–H17 over the observations of step6-meta.mjs
 * (`{ trigger, adopt, reject }`). Pure: each returns `{ status: 'passed' | 'failed', evidence }`;
 * missing observations fail. H07 judges the origin by ADR 0009 (user decision C).
 * Counterexamples: packages/test-support/tests/accept-step6-meta.spec.ts.
 */
import { referenceImproverDecision } from './step6-improver-rule.mjs'

const V0 = 'v0'
const VERSION = /^[a-f0-9]{64}$/
const pass = evidence => ({ status: 'passed', evidence })
const fail = (problems, context = '') => ({ status: 'failed', evidence: `${problems.join('; ')}${context === '' ? '' : ` (${context})`}` })
const short = value => (typeof value === 'string' && value.length > 12 ? `${value.slice(0, 12)}…` : String(value))
const missing = (obs, ...names) => names.filter(name => obs?.[name] === undefined)
const stepOf = (trigger, name) => trigger?.steps?.find(step => step.name === name)

/** H04: meta jobs start on the K-th counted finished job; cancelled / interrupted not counted; off → explicit only. */
export function judgeTrigger(obs) {
  const t = obs?.trigger
  if (t === undefined) return fail(['the trigger observations are missing'])
  const problems = []
  const offJobs = [1, 2, 3].map(n => stepOf(t, `off: explicit job ${n}`))
  if (offJobs.some(step => step === undefined)) problems.push('the three explicit jobs with meta off did not all run')
  if (offJobs.at(-1)?.pendingAfter !== 3) problems.push(`with meta off, 3 finished jobs left ${offJobs.at(-1)?.pendingAfter} counted (want 3)`)
  if (t.offNoMeta !== 0) problems.push(`with meta off, ${t.offNoMeta} meta job(s) started on their own`)
  const explicit = stepOf(t, 'off: explicit meta job')
  const explicitJob = explicit?.result
  if (explicitJob?.trigger !== 'explicit' || explicitJob?.status !== 'no-proposal') problems.push(`the explicit meta job with meta off: ${explicitJob?.code ?? `${explicitJob?.trigger} / ${explicitJob?.status}`}`)
  const basis = explicit?.metaJobs?.find(job => job.id === explicitJob?.id)?.basis ?? []
  if (basis.length !== 3) problems.push(`the explicit meta job's basis has ${basis.length} jobs (want the 3 counted)`)
  if (t.metaSetting?.enabled !== true || t.metaSetting?.everyJobs !== 3) problems.push('meta was not turned on through settings')
  for (const [name, status] of [['on: cancelled job', 'cancelled'], ['on: interrupted job', 'interrupted']]) {
    const step = stepOf(t, name)
    if (step?.result?.status !== status) problems.push(`${name}: ended ${step?.result?.status ?? 'unknown'}`)
    if (step?.pendingAfter !== step?.pendingBefore) problems.push(`${name}: counted (pending ${step?.pendingBefore} → ${step?.pendingAfter})`)
  }
  const second = stepOf(t, 'on: counted job 2')
  if (second?.pendingAfter !== 2) problems.push(`after the 2nd counted job ${second?.pendingAfter} pending (want 2)`)
  if (t.afterSecond !== 1) problems.push(`after the 2nd counted job ${t.afterSecond} meta jobs exist (want only the explicit one)`)
  const third = stepOf(t, 'on: counted job 3')
  const auto = third?.metaJobs?.find(job => job.trigger === 'job-count')
  if (auto === undefined) problems.push('no meta job started by itself after the 3rd counted job')
  else {
    if ((auto.basis ?? []).length !== 3) problems.push(`the automatic meta job's basis has ${(auto.basis ?? []).length} jobs`)
    const cancelled = stepOf(t, 'on: cancelled job')?.result?.id
    const interrupted = stepOf(t, 'on: interrupted job')?.result?.id
    if ((auto.basis ?? []).some(id => id === cancelled || id === interrupted)) problems.push('the basis includes a cancelled or interrupted job')
  }
  if (problems.length > 0) return fail(problems)
  return pass(`meta off: 3 finished jobs counted, no meta job; explicit meta job ran on those 3 (no-proposal); meta on (K=3): a cancelled and an interrupted job left the count unchanged, after the 2nd counted job no meta job, after the 3rd a job-count meta job started on exactly those 3`)
}

const READ_ONLY = /^improve_(list_jobs|read_job|read_session|read_ledger|report_meta_diagnosis|read_improver|propose_change)$/

/** H05: meta diagnosis read-only, schema, evidence real; refused 3 times → failed; none → no-proposal. */
export function judgeMetaDiagnosis(obs) {
  const absent = missing(obs, 'trigger', 'adopt', 'reject')
  if (absent.length > 0) return fail([`observations missing: ${absent.join(', ')}`])
  const problems = []
  const sessions = [obs.trigger, obs.adopt, obs.reject].flatMap(p => p.metaSessions ?? []).filter(s => s.phase === 'meta-diagnose')
  if (sessions.length === 0) problems.push('no meta-diagnose session was seen')
  for (const s of sessions) {
    const writes = (s.tools ?? []).filter(name => !READ_ONLY.test(name) || name === 'improve_propose_change' || name === 'improve_read_improver')
    if (writes.length > 0) problems.push(`a meta-diagnose session was offered ${writes.join(', ')}`)
    if (!(s.tools ?? []).includes('improve_report_meta_diagnosis')) problems.push('a meta-diagnose session lacked the report tool')
  }
  const adopted = obs.adopt.meta?.files
  const diagnosis = adopted?.metaDiagnosis
  const jobIds = new Set((obs.adopt.jobs ?? []).map(job => job.id))
  if (diagnosis === undefined) problems.push('the adopt meta job has no meta-diagnosis.json')
  else {
    if (diagnosis.proposal !== 'change') problems.push(`meta-diagnosis.json proposal ${diagnosis.proposal}`)
    const cited = (diagnosis.findings ?? []).flatMap(f => f.jobIds ?? [])
    if (cited.length === 0) problems.push('the meta diagnosis cites no job')
    for (const id of cited) if (!jobIds.has(id)) problems.push(`the meta diagnosis cites ${short(id)}, which is not a job of the project`)
    if (cited.includes(obs.adopt.meta.id)) problems.push('the meta diagnosis cites its own job')
  }
  const schema = (obs.adopt.records?.fileIssues ?? []).filter(i => i.kind === 'metaDiagnosis')
  if (schema.length > 0) problems.push(`meta-diagnosis.json breaks the schema: ${schema[0].message}`)
  const invalid = obs.reject.extra?.invalid
  if (invalid?.status !== 'failed') problems.push(`a meta diagnosis refused three times ended ${invalid?.status ?? invalid?.code ?? 'unknown'}`)
  if (invalid?.files?.metaDiagnosis !== undefined) problems.push('a refused meta diagnosis was written')
  const none = stepOf(obs.trigger, 'off: explicit meta job')?.result
  if (none?.status !== 'no-proposal' || none?.files?.metaDiagnosis?.proposal !== 'none') problems.push(`a none meta diagnosis ended ${none?.status} (${none?.files?.metaDiagnosis?.proposal})`)
  if (none?.files?.change !== undefined) problems.push('a none meta diagnosis still produced a change')
  if (problems.length > 0) return fail(problems)
  return pass(`${sessions.length} meta-diagnose sessions offered only read tools and the report; the adopt job's meta-diagnosis.json passes the schema and cites ${(diagnosis.findings ?? []).flatMap(f => f.jobIds).length} real jobs; three refused reports → failed, nothing written; none → no-proposal, no change`)
}

/** H06: one change within bounds accepted; evaluator field, out of bounds, two changes refused. */
export function judgeMetaProposal(obs) {
  const absent = missing(obs, 'adopt', 'reject')
  if (absent.length > 0) return fail([`observations missing: ${absent.join(', ')}`])
  const problems = []
  const change = obs.adopt.meta?.files?.change
  if (change === undefined) problems.push('the adopt meta job has no change.json')
  else {
    if (change.change?.op !== 'set-diagnosis-paragraph') problems.push(`change.json op ${change.change?.op}`)
    if (change.parentVersion !== V0 || !VERSION.test(change.childVersion ?? '')) problems.push(`change.json versions ${change.parentVersion} → ${short(change.childVersion)}`)
    if (change.attempts !== 1) problems.push(`the valid change took ${change.attempts} proposals`)
    if (obs.adopt.show?.version !== change.childVersion || obs.adopt.show?.change?.childVersion !== change.childVersion) problems.push('improvers.show does not return the stored child with its change')
  }
  const schema = (obs.adopt.records?.fileIssues ?? []).filter(i => i.kind === 'change' || i.kind === 'improver')
  if (schema.length > 0) problems.push(`change.json / the child breaks the schema: ${schema[0].message}`)
  const extra = obs.reject.extra
  if (extra?.bounds?.status !== 'failed') problems.push(`three refused proposals (evaluator field, out of bounds, two changes) ended ${extra?.bounds?.status ?? extra?.bounds?.code ?? 'unknown'}`)
  if (extra?.bounds?.files?.change !== undefined) problems.push('a refused proposal wrote change.json')
  if (extra?.proposeRequests < 3) problems.push(`only ${extra?.proposeRequests} refused proposals were made`)
  if (JSON.stringify(extra?.versionsBefore) !== JSON.stringify(extra?.versionsAfter)) problems.push('a refused proposal stored an improver')
  if (problems.length > 0) return fail(problems)
  return pass(`one set-diagnosis-paragraph change accepted at the first proposal, stored as ${short(change.childVersion)} (schema ok, improvers.show returns it); an evaluator field (costApprovalRatio), an out-of-bounds repeats 9 and two changes at once were each refused, the job failed, no change.json, no improver stored`)
}

/** Files of the project that changed between two states, allowing what a meta job writes. */
function stateChanges(before, after, metaJobId) {
  const changes = []
  const diff = (label, a, b) => {
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) changes.push(`${label} ${key}`)
  }
  diff('file', before?.work, after?.work)
  diff('capabilities', before?.capabilities, after?.capabilities)
  const sessions = { ...(after?.sessions ?? {}) }
  for (const [id, s] of Object.entries(sessions)) if (before?.sessions?.[id] === undefined && s.purpose === 'improvement' && (s.phase === 'meta-diagnose' || s.phase === 'meta-propose')) delete sessions[id]
  diff('session', before?.sessions, sessions)
  if (JSON.stringify(before?.deliverables) !== JSON.stringify(after?.deliverables)) changes.push('deliverables')
  if (before?.config !== after?.config) changes.push('config.json')
  return changes
}

/** H08: the comparison ran in copies; the real project's files, sessions, capabilities, deliverables and adoption history unchanged. */
export function judgeIsolation(obs) {
  const problems = []
  for (const name of ['adopt', 'reject']) {
    const p = obs?.[name]
    if (p?.before === undefined || p?.after === undefined) {
      problems.push(`${name}: project state before / after the meta job missing`)
      continue
    }
    const changed = stateChanges(p.before, p.after, p.meta?.id)
    if (changed.length > 0) problems.push(`${name}: the meta job changed ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` (+${changed.length - 6})` : ''}`)
    const armSessions = (p.newLedger ?? []).filter(r => r.comparisonArm !== undefined)
    if (armSessions.length === 0) problems.push(`${name}: no arm records with metaJobId / comparisonArm (did the arms run?)`)
    const armIds = new Set(armSessions.map(r => r.sessionId))
    for (const id of armIds) if (p.after.sessions?.[id] !== undefined) problems.push(`${name}: arm session ${short(id)} is in the real project's sessions`)
    if (Object.keys(p.after.capabilities ?? {}).length === 0 && Object.keys(p.before.capabilities ?? {}).length > 0) problems.push(`${name}: capabilities vanished`)
  }
  if (problems.length > 0) return fail(problems)
  return pass(`adopt and reject: working files, .nexgent/capabilities (adoption history and candidates), deliverables, config.json and every earlier session unchanged across the meta job; the only new sessions are its meta-diagnose / meta-propose sessions; the arms' sessions are not in the real project (their ledger records carry metaJobId and comparisonArm)`)
}

/** H09: the child must run a job in its copy and produce offspring to be adopted; none → not adopted. */
export function judgeChildRuns(obs) {
  const problems = []
  const a = obs?.adopt?.meta?.files?.comparison
  const r = obs?.reject?.meta?.files?.comparison
  if (a === undefined || r === undefined) return fail(['comparison.json of the adopt and reject meta jobs is missing'])
  if (a.verdict?.outcome !== 'adopt') problems.push(`adopt: verdict ${a.verdict?.outcome} (${a.verdict?.reason})`)
  if (a.child?.candidateId === undefined || a.child?.status !== 'adopted') problems.push(`adopt: the child arm ended ${a.child?.status} with${a.child?.candidateId === undefined ? 'out' : ''} offspring`)
  if (a.child?.improverVersion !== obs.adopt.meta.files.change?.childVersion) problems.push('adopt: the child arm did not run on the child improver')
  if (!(obs.adopt.newLedger ?? []).some(rec => rec.comparisonArm === 'child' && rec.improvementPhase === 'propose' && rec.improverVersion === a.child?.improverVersion)) problems.push('adopt: no child-arm propose request on the child improver in the ledger')
  const childSessions = (obs.adopt.armSessions ?? []).filter(s => s.arm === 'child')
  if (childSessions.length === 0) problems.push('adopt: the child arm opened no diagnose session')
  if (r.verdict?.outcome !== 'reject' || r.verdict?.reason !== 'no-offspring') problems.push(`reject: verdict ${r.verdict?.outcome} (${r.verdict?.reason}), want reject (no-offspring)`)
  if (r.child?.candidateId !== undefined) problems.push('reject: the child arm has offspring')
  if (!(obs.reject.newLedger ?? []).some(rec => rec.comparisonArm === 'child' && rec.improvementPhase === 'diagnose')) problems.push('reject: the child arm did not run its diagnosis')
  if (obs.reject.improvers?.current?.version !== V0) problems.push(`reject: improver in force ${short(obs.reject.improvers?.current?.version)}`)
  if (problems.length > 0) return fail(problems)
  return pass(`adopt: the child arm ran diagnose → propose → gate on ${short(a.child.improverVersion)} in its copy, offspring ${short(a.child.candidateId)} adopted there, child adopted (${a.verdict.reason}); reject: the child arm ran its diagnosis and produced no offspring → reject (no-offspring), v0 stays`)
}

/** H10: the product's verdict equals the rule recomputed from the arms' records; any unknown not adopted. */
export function judgeRule(obs) {
  const problems = []
  const lines = []
  for (const name of ['adopt', 'reject']) {
    const c = obs?.[name]?.meta?.files?.comparison
    if (c === undefined) {
      problems.push(`${name}: no comparison.json`)
      continue
    }
    const ours = referenceImproverDecision(c.origin, c.parent, c.child)
    if (ours.outcome !== c.verdict?.outcome || ours.reason !== c.verdict?.reason) problems.push(`${name}: product ${c.verdict?.outcome} (${c.verdict?.reason}), recomputed ${ours.outcome} (${ours.reason})`)
    // The same records with one arm made unknown: never adopted.
    const unknown = referenceImproverDecision(c.origin, c.parent, { ...c.child, cost: { ...c.child.cost, estimatedUsd: 'unknown' } })
    if (unknown.outcome !== 'reject' || unknown.reason !== 'unknown-arm') problems.push(`${name}: with the child's cost unknown the rule gives ${unknown.outcome} (${unknown.reason})`)
    const usd = arm => arm?.cost?.estimatedUsd
    if (typeof usd(c.parent) !== 'number' || typeof usd(c.child) !== 'number') problems.push(`${name}: an arm's cost is not known (${usd(c.parent)} / ${usd(c.child)}): its verdict should be unknown-arm`)
    lines.push(`${name}: ${c.verdict?.outcome} (${c.verdict?.reason}) = recomputed`)
  }
  if (obs?.ruleGrid !== undefined && obs.ruleGrid.disagreements !== 0) problems.push(`the rule grid disagrees with decideImprover in ${obs.ruleGrid.disagreements} cases`)
  if (problems.length > 0) return fail(problems)
  return pass(`${lines.join('; ')} from comparison.json's origin and arm records; the same records with an unknown cost recompute to reject (unknown-arm); the unit grid (accept-step6.spec.ts) checks decideImprover against the rule over 10 000+ arm pairs`)
}

/** H11: after adoption, the next job (new OS process) runs on the child; the ledger shows it; it is the child's first job. */
export function judgeAdoptedNext(obs) {
  const a = obs?.adopt
  if (a === undefined) return fail(['the adopt observations are missing'])
  const problems = []
  const child = a.meta?.files?.change?.childVersion
  if (a.improvers?.current?.version !== child || a.improvers?.current?.jobId !== a.meta?.id || a.improvers?.current?.trigger !== 'meta-job') problems.push(`improver in force after the meta job: ${short(a.improvers?.current?.version)} (trigger ${a.improvers?.current?.trigger}, job ${short(a.improvers?.current?.jobId)})`)
  const next = a.next
  if (next?.code !== 0 || next?.error !== undefined) problems.push(`the next job's process: exit ${next?.code} ${next?.error ?? ''}`)
  if (next?.pid === undefined || next?.pid === next?.parentPid) problems.push('the next job was not started from a new OS process')
  if (next?.improverVersion !== child) problems.push(`the next job pinned ${short(next?.improverVersion)}, not the child`)
  const records = (a.facts?.ledger ?? []).filter(r => r.improvementId === next?.jobId)
  if (records.length === 0) problems.push('the next job has no ledger records')
  if (records.some(r => r.improverVersion !== child)) problems.push(`the next job's ledger records are not all on the child (${[...new Set(records.map(r => short(r.improverVersion)))].join(', ')})`)
  const sessions = (a.facts?.sessions ?? []).filter(s => s.jobId === next?.jobId)
  if (sessions.length === 0 || sessions.some(s => s.improverVersion !== child)) problems.push('the next job\'s session headers are not on the child')
  const onChild = (a.jobs ?? []).filter(job => job.improverVersion === child && job.arm === undefined).sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))
  if (onChild[0]?.id !== next?.jobId) problems.push(`the first real job on the child is ${short(onChild[0]?.id)}, not the next job`)
  if (problems.length > 0) return fail(problems)
  return pass(`child ${short(child)} in force (meta-job revision by ${short(a.meta.id)}); the next job, from OS process ${next.pid}, pinned it; its ${records.length} ledger records and ${sessions.length} session headers say so; it is the first real job on the child (no improver firstUse field exists; judged by job order)`)
}

/** H12: rejection keeps reason, change and both arms; the parent stays in use. */
export function judgeRejected(obs) {
  const r = obs?.reject
  if (r === undefined) return fail(['the reject observations are missing'])
  const problems = []
  const files = r.meta?.files
  if (r.meta?.status !== 'rejected') problems.push(`the meta job ended ${r.meta?.status}`)
  if (files?.comparison?.verdict?.reason === undefined) problems.push('comparison.json keeps no reason')
  if (files?.change?.change === undefined) problems.push('change.json is gone')
  for (const arm of ['parent', 'child']) if (files?.comparison?.[arm]?.status === undefined) problems.push(`comparison.json keeps no ${arm} arm result`)
  if (files?.job?.status !== 'rejected') problems.push(`job.json says ${files?.job?.status}`)
  if (r.improvers?.current?.version !== V0 || (r.improvers?.history ?? []).length !== 0) problems.push(`the improver in force is ${short(r.improvers?.current?.version)} with ${(r.improvers?.history ?? []).length} revisions`)
  if (r.next?.improverVersion !== V0) problems.push(`the next job pinned ${short(r.next?.improverVersion)}, not v0`)
  if (problems.length > 0) return fail(problems)
  return pass(`rejected (${files.comparison.verdict.reason}): change.json, both arm results (parent ${files.comparison.parent.status}, child ${files.comparison.child.status}) and the reason kept; no improver revision; the next job ran on v0`)
}

/** H13: epoch changes with evaluator settings; cross-epoch not compared; improvers cannot write evaluator settings. */
export function judgeEpoch(obs) {
  const e = obs?.reject?.extra
  if (e === undefined) return fail(['the epoch observations are missing'])
  const problems = []
  if (!/^[a-f0-9]{64}$/.test(e.epochBefore ?? '')) problems.push('no epoch before')
  if (e.costRatioCap?.error !== undefined || e.costRatioCap?.after === e.costRatioCap?.before) problems.push(`costRatioCap was not changed in config.json (${e.costRatioCap?.error ?? 'unchanged'})`)
  if (e.epochAfter === e.epochBefore) problems.push('the epoch did not change with an evaluator setting')
  if (e.epochAfterOther !== e.epochAfter) problems.push('the epoch changed with a non-evaluator setting (feedbackThreshold)')
  const c = obs.reject.meta?.files?.comparison
  if (c?.origin?.epoch !== e.epochBefore || c?.parent?.origin?.epoch !== c?.origin?.epoch || c?.child?.origin?.epoch !== c?.origin?.epoch) problems.push('the comparison did not run in the project\'s epoch')
  if (c !== undefined) {
    const crossed = referenceImproverDecision(c.origin, c.parent, { ...c.child, origin: { ...c.child.origin, epoch: e.epochAfter } })
    if (crossed.reason !== 'epoch-mismatch') problems.push(`arms from two epochs recompute to ${crossed.reason}`)
    if (obs?.crossEpochProduct !== undefined && obs.crossEpochProduct.reason !== 'epoch-mismatch') problems.push(`decideImprover on arms from two epochs: ${obs.crossEpochProduct.reason}`)
  }
  if (e.configBefore !== e.configAfter) problems.push('a meta job changed config.json')
  const evaluator = obs?.evaluatorKeysInImprovers ?? []
  if (evaluator.length > 0) problems.push(`a stored improver names evaluator fields: ${evaluator.join(', ')}`)
  if (e.bounds?.status !== 'failed') problems.push('a meta proposal naming an evaluator field was not refused')
  if (problems.length > 0) return fail(problems)
  return pass(`epoch ${short(e.epochBefore)} → ${short(e.epochAfter)} when costRatioCap was edited in config.json (settings.update does not take evaluator fields: ${e.costRatioCap.settingsPatch ?? 'accepted'}), unchanged by feedbackThreshold; both arms and the origin carried the project's epoch; the same records with the child in the new epoch → epoch-mismatch (decideImprover and the rule); a meta proposal on costApprovalRatio refused, config.json unchanged by meta jobs, no stored improver names an evaluator field`)
}

/** H14: meta budget stops a meta job (budget-exhausted) and refuses the next; meta costs separate. */
export function judgeBudget(obs) {
  const t = obs?.trigger
  const a = obs?.adopt
  if (t?.budget === undefined || a?.costs === undefined) return fail(['the budget or cost observations are missing'])
  const problems = []
  if (t.budget.stopped?.status !== 'budget-exhausted') problems.push(`a meta job over the meta budget ended ${t.budget.stopped?.status ?? t.budget.stopped?.code}`)
  if (t.budget.refused?.code !== 'improvement/budget-exhausted') problems.push(`the next meta job was ${t.budget.refused?.code ?? 'started'}`)
  const c = a.costs
  for (const key of ['metaDiagnose', 'metaPropose', 'parentArm', 'childArm', 'source']) if (!(c[key]?.requests > 0)) problems.push(`no ${key} requests found by attribution`)
  if (c.meta?.requests !== (c.metaDiagnose?.requests ?? 0) + (c.metaPropose?.requests ?? 0) + (c.parentArm?.requests ?? 0) + (c.childArm?.requests ?? 0)) problems.push(`metaJobId requests ${c.meta?.requests} ≠ meta-diagnose + meta-propose + both arms in the real ledger`)
  const records = a.newLedger ?? []
  const metaRecords = records.filter(r => r.improvementId === a.meta?.id)
  if (metaRecords.some(r => r.improvementPhase !== 'meta-diagnose' && r.improvementPhase !== 'meta-propose' && r.type !== 'improvement.end')) problems.push('a meta job record carries another phase')
  const arms = records.filter(r => r.comparisonArm !== undefined)
  if (arms.some(r => r.metaJobId !== a.meta?.id || r.improvementId === a.meta?.id)) problems.push('an arm record does not name the meta job as metaJobId under its own job id')
  if (records.some(r => r.improvementId === a.source?.id)) problems.push('the meta job wrote records under the source job')
  if (problems.length > 0) return fail(problems)
  return pass(`meta budget lowered to ${t.budget.limit} tokens: the next meta job ended budget-exhausted, the one after was refused (improvement/budget-exhausted); in the adopt project sumLedgerCost by attribution: meta-diagnose ${c.metaDiagnose.requests}, meta-propose ${c.metaPropose.requests}, parent arm ${c.parentArm.requests}, child arm ${c.childArm.requests} requests (= ${c.meta.requests} by metaJobId), source job ${c.source.requests}, kept apart`)
}

/** H15: one slot for meta and ordinary jobs; a killed meta job is interrupted at the next start, not rerun. */
export function judgeConcurrency(obs) {
  const x = obs?.trigger?.h15
  if (x === undefined) return fail(['the concurrency observations are missing'])
  const problems = []
  if (x.busy?.code !== 'improvement/busy') problems.push(`an ordinary job during a meta job was ${x.busy?.code ?? 'started'}`)
  if (x.statusBeforeKill !== 'meta-diagnosing') problems.push(`the meta job was ${x.statusBeforeKill} when killed`)
  if (x.killed?.pid === undefined || x.killed?.error !== undefined) problems.push(`killing the meta job's process: ${x.killed?.error ?? 'no pid'}`)
  if (x.statusAfter !== 'interrupted') problems.push(`after the next start the meta job is ${x.statusAfter}`)
  if (x.starts !== 1) problems.push(`the meta job's process started ${x.starts} times`)
  if (x.metaDiagnoseRequests !== 1) problems.push(`its meta diagnosis was asked ${x.metaDiagnoseRequests} times (a rerun?)`)
  if (problems.length > 0) return fail(problems)
  return pass(`an ordinary job was refused (improvement/busy) while the meta job held the slot; the meta job's process ${x.killed.pid} killed in meta-diagnosing; the next SDK start marked it interrupted; job.log shows one start and one meta-diagnose request`)
}

/** H16: copies removed by default; kept and registered on request; over the limit removed. */
export function judgeCopies(obs) {
  const problems = []
  const a = obs?.adopt
  const r = obs?.reject
  if (a === undefined || r === undefined) return fail(['the adopt / reject observations are missing'])
  if (a.meta?.files?.comparison?.kept !== undefined) problems.push('the default meta job registered kept copies')
  if ((a.tempAfter ?? []).length !== (a.tempBefore ?? []).length) problems.push(`the default meta job left ${(a.tempAfter ?? []).length - (a.tempBefore ?? []).length} copies in the temporary directory`)
  const kept = r.kept ?? []
  if (kept.length !== 2) problems.push(`keepCopies registered ${kept.length} copies (want parent and child)`)
  for (const k of kept) if (!k.exists || !k.hasProject || !(k.bytes > 0)) problems.push(`kept copy ${k.root} is not there with its project`)
  const limit = obs?.copyLimit
  if (limit === undefined) problems.push('the over-limit copy was not tried')
  else if (limit.status !== 'too-large' || limit.exists !== false) problems.push(`a copy over the limit: ${limit.status}, ${limit.exists ? 'still on disk' : 'removed'}`)
  if (problems.length > 0) return fail(problems)
  return pass(`default: no copy registered or left in the temporary directory; keepCopies: parent and child copies kept and registered in comparison.json (${kept.map(k => k.bytes).join(' / ')} bytes); a copy over the limit (prepareProjectCopy keepMaxBytes ${limit.keepMaxBytes}): too-large and removed — the limit is not settable through the SDK, so this one is the package call`)
}

/** H17: every new record and field passes its schema; the test key is nowhere in .nexgent/ or the export. */
export function judgeLedger(obs) {
  const problems = []
  const projects = ['trigger', 'adopt', 'reject'].map(name => [name, obs?.[name]?.records])
  for (const [name, rec] of projects) {
    if (rec === undefined) {
      problems.push(`${name}: records missing`)
      continue
    }
    if ((rec.issues ?? []).length > 0) problems.push(`${name}: ${rec.issues.length} schema issues, first ${rec.issues[0]}`)
    if ((rec.fileIssues ?? []).length > 0) problems.push(`${name}: ${rec.fileIssues.length} improvement-file issues, first ${rec.fileIssues[0].path}: ${rec.fileIssues[0].message}`)
    if ((rec.secretHits ?? []).length > 0) problems.push(`${name}: the test key is in ${rec.secretHits.join(', ')}`)
    if (!(rec.checked?.sessions > 0 && rec.checked?.ledger > 0 && rec.checked?.files > 0)) problems.push(`${name}: nothing checked (${JSON.stringify(rec.checked)})`)
  }
  const kinds = new Set(projects.flatMap(([, rec]) => rec?.checked?.kinds ?? []))
  for (const kind of ['metaDiagnosis', 'change', 'comparison', 'improver', 'improverRevision']) if (!kinds.has(kind)) problems.push(`no ${kind} file was checked`)
  const exp = obs?.export
  if (exp === undefined || exp.code !== 0) problems.push(`the export of the meta project failed (${exp?.code} ${exp?.stderr ?? ''})`)
  else if ((exp.secretHits ?? []).length > 0) problems.push(`the test key is in the export: ${exp.secretHits.join(', ')}`)
  if (problems.length > 0) return fail(problems)
  const total = key => projects.reduce((n, [, rec]) => n + (rec?.checked?.[key] ?? 0), 0)
  return pass(`${total('sessions')} session records, ${total('ledger')} ledger records and ${total('files')} improvement files (${[...kinds].sort().join(', ')}) of the three meta projects pass their schemas; the test key is in none of their .nexgent/ nor in the export (${exp.files.length} files)`)
}

// ---- H07: the origin (ADR 0009) --------------------------------------------------------------

const ORIGIN_KINDS = ['unresolved', 'feedback-version']
const FINAL = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled'])
const UNRESOLVED = new Set(['rejected', 'failed', 'no-proposal'])
const ORIGIN_FIELDS = ['sourceJobId', 'tree', 'feedbackIds', 'capabilityVersion', 'kind']

/**
 * The origin ADR 0009 gives, recomputed from the project's job files, adoption history and
 * feedback sessions (`originFacts` in step6-meta.mjs), without the product's chooseOrigin:
 * the latest finished feedback job the real job did not solve (rejected / failed /
 * no-proposal, its gate not finding the baseline already passing every feedback check) on
 * the version it started on; else the latest finished feedback job on the version its
 * feedback task ran on.
 * @returns `{ kind, jobId, versions, feedbackIds }` (`versions`: the acceptable capability
 *   versions) or `undefined` when there is no feedback job.
 */
export function expectedOrigin(facts, meta) {
  const jobs = (facts?.jobs ?? [])
    .filter(job => job.kind !== 'meta' && job.arm === undefined && FINAL.has(job.status) && (job.feedbackIds ?? []).length > 0 && job.createdAt <= meta.createdAt && job.id !== meta.id)
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0))
  const unresolved = jobs.find(job => UNRESOLVED.has(job.status) && job.baselineFeedbackPassRate !== 1)
  if (unresolved !== undefined) {
    const at = unresolved.history?.find(entry => entry.status !== 'queued')?.at ?? unresolved.createdAt
    const inForce = (facts.revisions ?? []).filter(revision => revision.committedAt <= at).at(-1)?.version ?? 'baseline'
    return { kind: 'unresolved', jobId: unresolved.id, versions: [unresolved.baseVersion ?? inForce], feedbackIds: unresolved.feedbackIds }
  }
  const latest = jobs[0]
  if (latest === undefined) return undefined
  return { kind: 'feedback-version', jobId: latest.id, versions: [...new Set(Object.values(latest.taskVersions ?? {}))], feedbackIds: latest.feedbackIds }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** H07: both arms start from one origin, chosen by ADR 0009 and named; any field changed (the kind too) → not compared. */
export function judgeOrigin(obs) {
  const problems = []
  const lines = []
  const kinds = new Set()
  for (const name of ['adopt', 'reject']) {
    const p = obs?.[name]
    const c = p?.meta?.files?.comparison
    const meta = p?.meta?.files?.job
    if (c?.origin === undefined || meta === undefined || p?.origin === undefined) {
      problems.push(`${name}: comparison.json, the meta job or the origin facts are missing`)
      continue
    }
    const o = c.origin
    kinds.add(o.kind)
    if (!ORIGIN_KINDS.includes(o.kind)) problems.push(`${name}: origin kind ${o.kind}`)
    const want = expectedOrigin(p.origin, meta)
    if (want === undefined) problems.push(`${name}: the project has no finished feedback job to start from`)
    else {
      if (o.kind !== want.kind || o.sourceJobId !== want.jobId) problems.push(`${name}: origin ${o.kind} job ${short(o.sourceJobId)}, ADR 0009 gives ${want.kind} job ${short(want.jobId)}`)
      if (!want.versions.includes(o.capabilityVersion)) problems.push(`${name}: the arms start on ${short(o.capabilityVersion)}, ADR 0009 gives ${want.versions.map(short).join(' / ')}`)
      if (!sameValue([...(o.feedbackIds ?? [])].sort(), want.feedbackIds)) problems.push(`${name}: the origin's feedback set is not the source job's`)
    }
    for (const arm of ['parent', 'child']) {
      const a = c[arm]?.origin
      for (const field of [...ORIGIN_FIELDS, 'epoch']) if (!sameValue(a?.[field], o[field])) problems.push(`${name}: the ${arm} arm's ${field} differs from the origin`)
    }
    if (!VERSION.test(o.tree ?? '') || !VERSION.test(o.epoch ?? '')) problems.push(`${name}: the origin has no snapshot tree or epoch id`)
    if (!(p.origin.logLine ?? '').includes(`${o.kind} origin`) || !(p.origin.logLine ?? '').includes(o.sourceJobId)) problems.push(`${name}: job.log does not name the origin kind and job (${p.origin.logLine ?? 'no compare line'})`)
    // One field of one arm's origin changed: never compared.
    const t = p.tampered
    if (t === undefined) problems.push(`${name}: the changed-origin decisions are missing`)
    else {
      if (t.none !== c.verdict?.reason) problems.push(`${name}: decideImprover on the records as written gives ${t.none}, comparison.json ${c.verdict?.reason}`)
      for (const field of ORIGIN_FIELDS) if (t[field] !== 'origin-mismatch') problems.push(`${name}: the child's origin with another ${field} → ${t[field]}`)
      if (t.epoch !== 'epoch-mismatch') problems.push(`${name}: the child's origin in another epoch → ${t.epoch}`)
    }
    const other = ORIGIN_KINDS.find(kind => kind !== o.kind)
    const ours = referenceImproverDecision(o, c.parent, { ...c.child, origin: { ...c.child.origin, kind: other } })
    if (ours.reason !== 'origin-mismatch') problems.push(`${name}: the rule with the child's kind changed gives ${ours.reason}`)
    lines.push(`${name}: ${o.kind} origin (job ${short(o.sourceJobId)}, ${p.origin.jobs.find(job => job.id === o.sourceJobId)?.status}) on ${short(o.capabilityVersion)}`)
  }
  for (const kind of ORIGIN_KINDS) if (problems.length === 0 && !kinds.has(kind)) problems.push(`no comparison started from a ${kind} origin`)
  if (problems.length > 0) return fail(problems)
  return pass(`${lines.join('; ')} = ADR 0009 recomputed from the job files, adoption history and feedback sessions; both arms carry the origin's kind, job, tree, feedback set, version and epoch; job.log names the kind; the recorded arms with the child's sourceJobId, tree, feedbackIds, capabilityVersion or kind changed → origin-mismatch, its epoch changed → epoch-mismatch (decideImprover; the rule agrees on the kind)`)
}

/** Judges by item id (H07 included since ADR 0009 merged). */
export const META_JUDGES = {
  H04: judgeTrigger,
  H05: judgeMetaDiagnosis,
  H06: judgeMetaProposal,
  H07: judgeOrigin,
  H08: judgeIsolation,
  H09: judgeChildRuns,
  H10: judgeRule,
  H11: judgeAdoptedNext,
  H12: judgeRejected,
  H13: judgeEpoch,
  H14: judgeBudget,
  H15: judgeConcurrency,
  H16: judgeCopies,
  H17: judgeLedger,
}
