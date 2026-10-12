/**
 * Judges of accept-step4 (round 2: H01–H05, H07, H10, H17 and the four items
 * of the midterm checkpoint; round 3: H13, H14, H18; after the gate: H06,
 * H08, H09, H11, H12, H15, H16 and H14's adoption half from the gate scenario,
 * `obs.gate`, step4-gate.mjs), each a pure function of the observations the
 * scenarios collected. Each is tested against observations made wrong on
 * purpose (packages/test-support/tests/accept-step4-judges.spec.ts).
 *
 * An item whose product part has not landed yet reports `not-implemented`
 * with the reason, never a pass: the capability tools (W2 part 2) decide
 * H02–H05, H07, H10, H17; `capabilityVersion` in sessions and the ledger
 * (W1) decides H01, H07 and checkpoint 4; the gate (W3) decides the gate
 * items. With the gate there, a gate scenario that did not run fails them.
 */
import { judgeSummary, ordersCsv } from '../real-task/step4-orders.mjs'
import { verdict, partial } from './step2-judges.mjs'
import { COMPONENTS, TASK_B, UNUSED_SKILL } from './step4-fixtures.mjs'

/** Context policies and the plugin of the extras phase (copies of step4-scenario.mjs; a test pins them). */
export const EXTRAS = {
  goodPolicy: 'short-summaries',
  badPolicies: [['auto-approve', 'approvals'], ['more-budget', 'costCapUsd'], ['open-sandbox', 'sandbox'], ['skip-gate', 'capabilities'], ['nested-budget', 'budgetUsd']],
  plugin: 'probe-plugin',
  pluginTool: 'probe_plugin_ping',
}

/** `functionToolName('order-summary', 'summarizeOrders')` (contract; pinned by the judges' tests). */
export const FUNCTION_TOOL = 'cap_order-summary_summarizeOrders'
const CAPABILITY_TOOLS = ['capability_draft', 'capability_try', 'capability_propose']
const FM = COMPONENTS.good.functionModule
const SKILL = COMPONENTS.good.skill

const recordsOf = (obs, sessionId) => (sessionId === undefined ? [] : obs?.sessions?.[sessionId] ?? [])
const startOf = (obs, sessionId) => recordsOf(obs, sessionId).find(r => r.type === 'session.start')
const resultOf = (obs, sessionId, callId) => recordsOf(obs, sessionId).find(r => r.type === 'tool.result' && r.toolCallId === callId)
const ok = result => result !== undefined && result.isError === false
const refused = result => result !== undefined && result.isError === true
const ledgerOf = (obs, sessionId) => (obs?.ledger ?? []).filter(r => r.sessionId === sessionId)
const requestsOn = (obs, route) => (obs?.requests ?? []).filter(r => r.route === route)
const completed = phase => phase?.reason?.kind === 'completed'
const sessionOf = (obs, phase) => obs?.phases?.[phase]?.sessionId

/** Whether the kernel writes `capabilityVersion` at all yet (W1). */
export function versionWritten(obs) {
  const starts = Object.values(obs?.sessions ?? {}).map(records => records.find(r => r.type === 'session.start')).filter(Boolean)
  return starts.some(s => 'capabilityVersion' in s) || (obs?.ledger ?? []).some(r => 'capabilityVersion' in r)
}

const NO_TOOLS = 'the product does not offer capability_draft / try / propose yet (W2 part 2)'
const NO_VERSION = 'the kernel does not write capabilityVersion into sessions or the ledger yet (W1)'
const NO_GATE = 'the gate (W3) has not landed: SDK capabilities.trial is not implemented'
const pending = evidence => ({ status: 'not-implemented', evidence })

/** Settings and names of the gate scenario (copies of step4-gate.mjs; a test pins them). */
export const GATE = { budgetMaxRequests: 3, plugin: 'greeter', pluginTool: 'greet_user', selectionCases: 2, guardCases: 1, windowTasks: 3, consecutiveErrors: 3 }

/**
 * A gate item: its judge over the gate scenario's observations (`obs.gate`,
 * step4-gate.mjs). Not-implemented while the gate is missing; failed when the
 * gate is there but its scenario did not run.
 */
const gateItem = fn => (obs) => {
  if (obs?.features?.gate !== true) return pending(NO_GATE)
  const g = obs.gate
  if (g === undefined) return { status: 'failed', evidence: 'the gate is present, but the gate scenario did not run' }
  return withGateStop(g, fn(g, obs))
}

function withGateStop(g, result) {
  if (result.status !== 'failed' || g?.error === undefined) return result
  return { ...result, evidence: `${result.evidence} (gate scenario stopped at ${g.error.step}: ${String(g.error.message).split('\n')[0]})` }
}

// Reading the gate scenario's observations.
const gRecords = (g, key) => g?.sessions?.[g?.tasks?.[key]?.sessionId] ?? []
const gStart = (g, key) => gRecords(g, key).find(r => r.type === 'session.start')
const gVersion = (g, key) => gStart(g, key)?.capabilityVersion
const gCandidate = (g, key) => g?.candidates?.[key]
const gTrials = (g, key) => Object.values(g?.trials ?? {}).filter(receipts => receipts[0]?.type === 'trial.start' && receipts[0].candidateId === gCandidate(g, key)?.id)
const gTrial = (g, key) => gTrials(g, key).at(-1) ?? []
const gRuns = receipts => receipts.filter(r => r.type === 'trial.run')
const gEnd = receipts => receipts.find(r => r.type === 'trial.end')
const gDecisions = (g, key) => (g?.decisions ?? []).filter(d => d.candidateId !== undefined && d.candidateId === gCandidate(g, key)?.id)
const gRevision = (g, decision) => (g?.activation ?? []).find(r => decision !== undefined && r.decisionId === decision.id)
const gResults = (g, key, name) => gRecords(g, key).filter(r => r.type === 'tool.result' && r.name === name)
const gOutcome = (g, key) => (g?.ledger ?? []).filter(r => r.type === 'task.outcome' && r.trialId === undefined && r.sessionId === g?.tasks?.[key]?.sessionId && r.memberId === 'main').at(-1)
const gTrialLedger = (g, trialId) => (g?.ledger ?? []).filter(r => trialId !== undefined && r.trialId === trialId)
const gCompleted = (g, key) => g?.tasks?.[key]?.reason?.kind === 'completed'
const short = version => (typeof version === 'string' ? version.slice(0, 12) : String(version))
const allPassed = outcome => (outcome?.checks ?? []).length > 0 && outcome.checks.every(c => c.passed === true)

/** Root `task.outcome` lines (memberId main) and the members' lines, per taskId. */
function outcomes(obs) {
  const all = (obs?.ledger ?? []).filter(r => r.type === 'task.outcome')
  return { roots: all.filter(r => r.memberId === 'main'), members: all.filter(r => r.memberId !== 'main') }
}

/** Draft and component records of task A. */
function taskAFacts(obs) {
  const sessionId = sessionOf(obs, 'taskA')
  const records = recordsOf(obs, sessionId)
  const drafts = records.filter(r => r.type === 'capability.draft')
  const tries = records.filter(r => r.type === 'capability.try')
  const draftOf = c => drafts.find(r => r.component?.kind === c.kind && r.component?.name === c.name)
  const tryOf = c => tries.find(r => r.component?.kind === c.kind && r.component?.name === c.name)
  return { sessionId, records, draftOf, tryOf, result: callId => resultOf(obs, sessionId, callId) }
}

export const JUDGES = {
  H01(obs) {
    if (!versionWritten(obs)) return pending(NO_VERSION)
    const sessionId = sessionOf(obs, 'baseline')
    const start = startOf(obs, sessionId)
    const lines = ledgerOf(obs, sessionId)
    const off = lines.filter(r => r.capabilityVersion !== 'baseline')
    return verdict([
      [completed(obs.phases?.baseline), `the baseline task completed (got ${obs.phases?.baseline?.reason?.kind})`],
      [start?.capabilityVersion === 'baseline', `session.start.capabilityVersion is baseline (got ${JSON.stringify(start?.capabilityVersion)})`],
      [lines.length > 0, `the baseline session has ledger records (got ${lines.length})`],
      [off.length === 0, `every ledger record of the baseline session carries capabilityVersion baseline (${off.length} do not: ${off.slice(0, 3).map(r => `${r.type}=${JSON.stringify(r.capabilityVersion)}`).join(', ')})`],
    ], `nothing adopted: the task completed; session.start and all ${lines.length} ledger records carry baseline`)
  },

  H02(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const a = taskAFacts(obs)
    const afterTry = requestsOn(obs, 'taskA').slice(2)
    const draftFiles = (obs.drafts ?? []).filter(path => path.startsWith(`${a.sessionId}/`))
    return verdict([
      [completed(obs.phases?.taskA), `task A completed (got ${obs.phases?.taskA?.reason?.kind})`],
      [ok(a.result('draft-fm')) && ok(a.result('draft-skill')), 'capability_draft of the function module and the skill succeeded'],
      [a.draftOf(FM) !== undefined && a.draftOf(SKILL) !== undefined, 'capability.draft records for both components'],
      [ok(a.result('try-fm')) && ok(a.result('try-skill')), 'capability_try of both succeeded'],
      [(a.tryOf(FM)?.tools ?? []).includes(FUNCTION_TOOL), `capability.try of the module lists ${FUNCTION_TOOL} (got ${JSON.stringify(a.tryOf(FM)?.tools)})`],
      [afterTry.length > 0 && afterTry.every(r => r.tools.includes(FUNCTION_TOOL)), `every later request of task A offers ${FUNCTION_TOOL}`],
      [ok(a.result('use-fm')), `the ${FUNCTION_TOOL} call succeeded${a.result('use-fm')?.isError ? ` (${String(a.result('use-fm').content).slice(0, 120)})` : ''}`],
      [ok(a.result('use-skill')), 'load_skill of the tried skill succeeded'],
      [refused(a.result('probe-read')), 'read_file into the draft area was refused'],
      [refused(a.result('probe-write')), 'write_file into the draft area was refused'],
      [draftFiles.includes(`${a.sessionId}/functions/${FM.name}/index.mjs`) && !draftFiles.some(p => p.endsWith('/extra.mjs')), `the draft area holds the host-written module and not the model's file (got ${draftFiles.join(', ') || 'nothing'})`],
    ], `task A drafted and tried the module and the skill, called ${FUNCTION_TOOL} and loaded the skill; file tools were refused in the draft area`)
  },

  H03(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const peer = sessionOf(obs, 'peer')
    const peerRequests = requestsOn(obs, 'peer')
    const taskATools = requestsOn(obs, 'taskA').some(r => r.tools.includes(FUNCTION_TOOL))
    return verdict([
      [completed(obs.phases?.peer), `the peer session completed (got ${obs.phases?.peer?.reason?.kind})`],
      [taskATools, `task A did have ${FUNCTION_TOOL} (otherwise this check proves nothing)`],
      [peerRequests.length > 0 && peerRequests.every(r => !r.tools.includes(FUNCTION_TOOL)), `no request of the peer session offers ${FUNCTION_TOOL}`],
      [peerRequests.every(r => !r.system.includes(SKILL.name)), `the peer session's system prompt does not list ${SKILL.name}`],
      [refused(resultOf(obs, peer, 'peer-skill')), `load_skill of ${SKILL.name} failed in the peer session`],
    ], 'a second root session, opened while task A was, saw neither the tried function nor the tried skill')
  },

  H04(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const a = taskAFacts(obs)
    const proposals = a.records.filter(r => r.type === 'capability.propose')
    const accepted = proposals.find(r => r.toolCallId === 'propose-good')
    const candidate = (obs.candidates ?? []).find(c => c.id === accepted?.candidateId)
    const names = (candidate?.record?.components ?? []).map(c => `${c.kind}/${c.name}`).sort()
    const proofs = (accepted?.proofs ?? []).map(p => `${p.kind}/${p.name}`).sort()
    const want = [`${FM.kind}/${FM.name}`, `${SKILL.kind}/${SKILL.name}`].sort()
    return verdict([
      [refused(a.result('propose-unused')) && String(a.result('propose-unused')?.content ?? '').includes(UNUSED_SKILL.name), `proposing the never-used ${UNUSED_SKILL.name} was refused, naming it`],
      [!proposals.some(r => r.toolCallId === 'propose-unused'), 'the refused proposal wrote no capability.propose record'],
      [ok(a.result('propose-good')), 'proposing the two used components succeeded'],
      [accepted !== undefined && proofs.join() === want.join(), `capability.propose has a proof for each component (got ${proofs.join(', ') || 'none'})`],
      [candidate !== undefined && candidate.record?.id === accepted?.candidateId, `candidates/${accepted?.candidateId}/candidate.json exists`],
      [names.join() === want.join(), `the candidate holds exactly the two components (got ${names.join(', ') || 'none'})`],
      [!(obs.candidates ?? []).some(c => (c.record?.components ?? []).some(x => x.name === UNUSED_SKILL.name)), 'no candidate holds the unused skill'],
    ], `the used components became candidate ${accepted?.candidateId}; the unused skill was refused`)
  },

  H05(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const bundle = obs.bundle
    const after = obs.bundleAfterB
    const sessionB = sessionOf(obs, 'taskB')
    const mismatched = (bundle?.files ?? []).filter(f => f.actual !== f.listed)
    return verdict([
      [obs.phases?.adopt?.error === undefined && bundle !== undefined, `a bundle was written and adopted${obs.phases?.adopt?.error ? ` (${obs.phases.adopt.error})` : ''}`],
      [bundle?.error === undefined, `the manifest reads${bundle?.error ? ` (${bundle.error})` : ''}`],
      [bundle?.recomputedVersion === bundle?.version, `the version is the SHA-256 of the canonical manifest (dir ${bundle?.version}, recomputed ${bundle?.recomputedVersion})`],
      [(bundle?.files ?? []).length >= 3 && mismatched.length === 0, `every listed file has its hash (${mismatched.length} differ of ${(bundle?.files ?? []).length})`],
      [(bundle?.unlisted ?? ['?']).length === 0, `no file outside the manifest (got ${(bundle?.unlisted ?? []).join(', ')})`],
      [refused(resultOf(obs, sessionB, 'probe-bundle')), 'write_file into the adopted bundle was refused'],
      [after !== undefined && JSON.stringify(after.files) === JSON.stringify(bundle?.files) && after.manifestText === bundle?.manifestText, 'the bundle is byte-identical after task B'],
    ], `bundle ${bundle?.version} matches its manifest hash, file hashes and listing; the model could not write into it`)
  },

  H07(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    if (!versionWritten(obs)) return pending(NO_VERSION)
    const version = obs.phases?.adopt?.version
    const phase = obs.phases?.taskB
    const sessionB = phase?.sessionId
    const lines = ledgerOf(obs, sessionB)
    const off = lines.filter(r => r.capabilityVersion !== version)
    const outcome = lines.filter(r => r.type === 'task.outcome').at(-1)
    const used = (outcome?.componentsUsed ?? []).find(c => c.kind === FM.kind && c.name === FM.name)
    const judged = obs.outputs?.[TASK_B.id] == null ? { pass: false, problems: ['no output'] } : judgeSummary(ordersCsv(TASK_B.month), obs.outputs[TASK_B.id])
    return verdict([
      [version !== undefined, `a version was adopted${obs.phases?.adopt?.error ? ` (${obs.phases.adopt.error})` : ''}`],
      [phase?.child?.exitCode === 0 && phase?.child?.pid !== undefined && phase.child.pid !== phase.parentPid, `task B ran in its own OS process (exit ${phase?.child?.exitCode})`],
      [phase?.child?.done?.reason?.kind === 'completed', `task B completed (got ${JSON.stringify(phase?.child?.done?.reason)})`],
      [startOf(obs, sessionB)?.capabilityVersion === version, `session.start of B carries the adopted version (got ${JSON.stringify(startOf(obs, sessionB)?.capabilityVersion)})`],
      [requestsOn(obs, 'taskB').length > 0 && requestsOn(obs, 'taskB').every(r => r.tools.includes(FUNCTION_TOOL)), `every request of B offers ${FUNCTION_TOOL} without a try`],
      [ok(resultOf(obs, sessionB, 'use-fm-b')), `B's ${FUNCTION_TOOL} call succeeded`],
      [lines.length > 0 && off.length === 0, `every ledger record of B carries the adopted version (${off.length} of ${lines.length} do not)`],
      [used !== undefined && used.version === version && used.calls >= 1 && used.errors === 0, `task.outcome.componentsUsed lists the module from the adopted version (got ${JSON.stringify(outcome?.componentsUsed)})`],
      [judged.pass, `B's summary passes the hidden check${judged.pass ? '' : ` (${judged.problems.slice(0, 3).join('; ')})`}`],
    ], `a new process loaded version ${version} by itself, called ${FUNCTION_TOOL}; B's ${lines.length} ledger records carry the version and componentsUsed lists the module`)
  },

  H10(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const version = obs.tampered?.version
    const before = obs.activationBeforeTamper ?? []
    const added = (obs.activation ?? []).slice(before.length)
    const rollback = added.find(r => r.type === 'rollback')
    const start = startOf(obs, sessionOf(obs, 'tamper'))
    const conditions = [
      [version !== undefined, 'an adopted bundle was tampered with'],
      [completed(obs.phases?.tamper), `the next session still worked (got ${obs.phases?.tamper?.reason?.kind})`],
      [rollback !== undefined && rollback.trigger === 'load-failure', `a rollback revision with trigger load-failure was appended (got ${JSON.stringify(added.map(r => ({ type: r.type, trigger: r.trigger })))})`],
      [rollback !== undefined && rollback.version !== version && rollback.from === version, `the rollback leaves ${version} for the previous version (got from ${rollback?.from} to ${rollback?.version})`],
      [rollback?.decisionId !== undefined, 'the rollback names its decision record'],
    ]
    if (!versionWritten(obs)) return partial(conditions, NO_VERSION, 'the activation chain rolled back on load failure')
    conditions.push([start?.capabilityVersion === rollback?.version, `the new session runs on the previous version (got ${JSON.stringify(start?.capabilityVersion)})`])
    return verdict(conditions, `tampering with ${version} made the next load roll back to ${rollback?.version}; the session ran on it`)
  },

  H06: gateItem((g) => {
    const receipts = gTrial(g, 'A0')
    const start = receipts[0]
    const runs = gRuns(receipts)
    const end = gEnd(receipts)
    const plan = start?.plan ?? {}
    const cases = [...(plan.selection ?? []).map(c => ['selection', c.caseId]), ...(plan.guard ?? []).map(c => ['guard', c.caseId])]
    const r = plan.repeats
    const missing = cases.flatMap(([set, caseId]) => Array.from({ length: r ?? 0 }, (_, i) => i + 1).flatMap(repeat => ['candidate', 'baseline']
      .filter(arm => !runs.some(x => x.set === set && x.caseId === caseId && x.repeat === repeat && x.arm === arm))
      .map(arm => `${set} ${caseId.slice(0, 8)}#${repeat} ${arm}`)))
    const candidateFirst = runs.every((run, index) => run.arm !== 'baseline' || runs.slice(0, index).some(x => x.arm === 'candidate' && x.caseId === run.caseId && x.repeat === run.repeat))
    const decision = gDecisions(g, 'A0').find(d => d.trialId === start?.trialId)
    const revision = gRevision(g, decision)
    const cost = decision?.cost ?? {}
    // The reviewer is asked only on a check tie: the plugin's trial (E) ties, so its opinion is recorded there.
    const tie = gTrial(g, 'E')
    const reviews = tie.filter(x => x.type === 'trial.review')
    const tieDecision = gDecisions(g, 'E').find(d => d.trialId === tie[0]?.trialId && d.trigger === 'gate')
    const reviewerRequests = gTrialLedger(g, tie[0]?.trialId).filter(x => x.type === 'llm.request.end' && x.arm === undefined)
    return verdict([
      [start !== undefined && typeof r === 'number' && r >= 2, `the good candidate's trial started with r = ${r} repeats per arm`],
      [cases.length > 0 && runs.length === cases.length * r * 2 && missing.length === 0, `each of the ${cases.length} cases ran r times on both arms (${runs.length} runs; missing ${missing.join(', ') || 'none'})`],
      [candidateFirst, 'the candidate arm ran before the baseline arm of each case and repeat'],
      [runs.every(x => x.status !== 'pass' && x.status !== 'fail' ? true : (x.checks ?? []).length > 0), 'every run that finished carries the checks run on its copy'],
      [end?.verdict?.outcome === 'adopt' && end.verdict.passRate?.candidate > end.verdict.passRate?.baseline, `the verdict is adopt on better checks (got ${JSON.stringify(end?.verdict)})`],
      [decision?.outcome === 'adopted' && decision.trigger === 'gate', `the decision is adopted by the gate (got ${decision?.outcome} / ${decision?.trigger})`],
      [revision?.type === 'adopt' && revision.trigger === 'gate' && revision.version === gCandidate(g, 'A0')?.version, `an adopt revision with trigger gate was appended for ${short(gCandidate(g, 'A0')?.version)} (got ${JSON.stringify(revision && [revision.type, revision.trigger, short(revision.version)])})`],
      [decision?.verdict?.passRate?.candidate !== undefined && decision.verdict.passRate.baseline !== undefined, 'the decision record carries both arms\' check pass rates'],
      [['candidate', 'baseline', 'review'].every(arm => typeof cost[arm]?.requestCount === 'number' && cost[arm].usage !== undefined), `and the cost of each arm and of the reviewer, separately (got ${Object.keys(cost).join(', ') || 'none'})`],
      [decision?.verdict?.decidedByReview === false && cost.review?.requestCount === 0 && !receipts.some(x => x.type === 'trial.review'), 'with a clear check result the reviewer was not asked, and the decision says so'],
      [reviews.length > 0 && reviews.every(x => ['candidate', 'baseline', 'tie'].includes(x.preference) && typeof x.reason === 'string' && x.reason !== '' && typeof x.model === 'string'), `on the tied trial the reviewer's opinions are their own receipt lines with preference, reason and model (got ${reviews.length})`],
      [tieDecision?.verdict?.decidedByReview === true && tieDecision.cost?.review?.requestCount === reviews.length, `the tied decision is marked decided by review, with the reviewer's cost apart (got ${JSON.stringify(tieDecision?.verdict)})`],
      [reviewerRequests.length === reviews.length, `the reviewer's ledger requests carry the trial id and no arm (${reviewerRequests.length} for ${reviews.length} opinions)`],
    ], `the good candidate ran ${runs.length} paired runs (r = ${r}); adopted by the gate with both arms' checks and costs; the reviewer, asked only on a tie, is recorded apart`)
  }),

  H08: gateItem((g) => {
    const receipts = gTrial(g, 'C')
    const end = gEnd(receipts)
    const decision = gDecisions(g, 'C').at(-1)
    const A = gCandidate(g, 'A0')?.version
    const used = (gOutcome(g, 'B2')?.componentsUsed ?? []).find(c => c.kind === FM.kind && c.name === FM.name)
    return verdict([
      [gCompleted(g, 'C') && gVersion(g, 'C') === A, 'the bad candidate was proposed from a task on the adopted version'],
      [end?.verdict?.outcome === 'reject' && ['quality-down', 'guard-regressed'].includes(end.verdict.reason), `the gate's verdict is reject on worse checks (got ${JSON.stringify(end?.verdict)})`],
      [decision?.outcome === 'rejected' && decision.trigger === 'gate' && typeof decision.detail === 'string' && decision.detail.length > 0, `a rejected decision with its reason is kept (got ${decision?.outcome}: ${String(decision?.detail ?? '').slice(0, 80)})`],
      [(g.candidateDirs ?? []).includes(gCandidate(g, 'C')?.id), 'the rejected candidate stays on disk'],
      [receipts.length > 0 && end !== undefined, 'its trial receipts stay on disk'],
      [gRevision(g, decision) === undefined && !(g.activation ?? []).some(r => r.version === gCandidate(g, 'C')?.version), 'no revision was written for it'],
      [gVersion(g, 'B2') === A, `the next task runs on the adopted version ${short(A)} (got ${short(gVersion(g, 'B2'))})`],
      [gResults(g, 'B2', FUNCTION_TOOL).length > 0 && gResults(g, 'B2', FUNCTION_TOOL).every(x => x.isError === false), `its ${FUNCTION_TOOL} call worked`],
      [used !== undefined && used.version === A && used.errors === 0, `its task.outcome lists the module from ${short(A)} (got ${JSON.stringify(gOutcome(g, 'B2')?.componentsUsed)})`],
      [allPassed(gOutcome(g, 'B2')), 'and its checks passed'],
    ], `the bad candidate was rejected (${end?.verdict?.reason}) and kept with its receipts; the next task used ${short(A)} as before`)
  }),

  H09: gateItem((g) => {
    const A = gCandidate(g, 'A0')?.version
    const decision = (g.decisions ?? []).find(d => d.outcome === 'rolled-back' && d.trigger === 'usage-regression')
    const revision = gRevision(g, decision)
    const failing = gResults(g, 'R', FUNCTION_TOOL)
    const observed = decision?.regression?.observations ?? []
    return verdict([
      [gVersion(g, 'R') === A, `the regressing task ran on the adopted version (got ${short(gVersion(g, 'R'))})`],
      [failing.length >= GATE.consecutiveErrors && failing.every(x => x.isError === true), `the adopted module failed ${failing.length} calls in a row`],
      [decision?.reason === 'component-errors' && decision.candidateId === gCandidate(g, 'A0')?.id, `a usage-regression decision names the candidate (got ${decision?.reason})`],
      [decision?.regression?.consecutiveErrors >= GATE.consecutiveErrors, `its evidence counts the errors in a row (got ${decision?.regression?.consecutiveErrors})`],
      [observed.length > 0 && observed.length <= GATE.windowTasks && observed.some(o => o.taskId === g.tasks?.R?.taskId), `within K = ${GATE.windowTasks} tasks on the version (observed ${observed.length}, including the failing task)`],
      [revision?.type === 'rollback' && revision.trigger === 'usage-regression' && revision.from === A && revision.version === 'baseline', `a rollback revision from ${short(A)} to the previous version was appended (got ${JSON.stringify(revision && [revision.type, revision.trigger, short(revision.from), short(revision.version)])})`],
      [gVersion(g, 'D') === 'baseline' && gCompleted(g, 'D'), `the next task runs on the previous version (got ${short(gVersion(g, 'D'))})`],
    ], `${failing.length} failed calls of the adopted module rolled ${short(A)} back to the baseline within ${observed.length} tasks; the next task ran on it`)
  }),

  H11: gateItem((g) => {
    const before = g.isolation?.before
    const after = g.isolation?.after
    const trialId = gTrial(g, 'A0')[0]?.trialId
    const lines = gTrialLedger(g, trialId)
    const ends = lines.filter(r => r.type === 'llm.request.end')
    const receipts = gRuns(gTrial(g, 'A0'))
    const counted = arm => receipts.filter(r => r.arm === arm).reduce((sum, r) => sum + (r.cost?.requestCount ?? 0), 0)
    const realSessions = new Set(Object.keys(g.sessions ?? {}))
    const diff = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(path => a?.[path] !== b?.[path])
    const fileDiff = diff(before?.files, after?.files)
    const sessionDiff = diff(before?.sessions, after?.sessions)
    return verdict([
      [before !== undefined && after !== undefined && Object.keys(before.files ?? {}).length > 0, 'the project was fingerprinted before and after the trial'],
      [fileDiff.length === 0, `the project's files, outputs included, are byte-identical after the trial (changed: ${fileDiff.slice(0, 4).join(', ') || 'none'})`],
      [sessionDiff.length === 0, `the project's sessions are unchanged: none added, none written (changed: ${sessionDiff.slice(0, 4).join(', ') || 'none'})`],
      [ends.length > 0 && ends.every(r => r.arm === 'candidate' || r.arm === 'baseline'), `every model request of the trial carries trialId and an arm (${ends.length} requests)`],
      [lines.every(r => r.arm === 'candidate' || r.arm === 'baseline'), `so does every other ledger record of the trial (${lines.length})`],
      [['candidate', 'baseline'].every(arm => ends.filter(r => r.arm === arm).length === counted(arm) && counted(arm) > 0), `per arm the ledger requests match the receipts (${ends.filter(r => r.arm === 'candidate').length}/${counted('candidate')} candidate, ${ends.filter(r => r.arm === 'baseline').length}/${counted('baseline')} baseline)`],
      [!lines.some(r => realSessions.has(r.sessionId)), 'no trial record belongs to a session of the project'],
    ], `the trial left the project's files and sessions untouched; its ${ends.length} requests carry trialId ${short(trialId)} and their arm`)
  }),

  H12: gateItem((g) => {
    const receipts = gTrial(g, 'D')
    const start = receipts[0]
    const end = gEnd(receipts)
    const runs = gRuns(receipts)
    const decision = gDecisions(g, 'D').at(-1)
    const requests = gTrialLedger(g, start?.trialId).filter(r => r.type === 'llm.request.end')
    const full = ((start?.plan?.selection ?? []).length + (start?.plan?.guard ?? []).length) * (start?.plan?.repeats ?? 0) * 2
    return verdict([
      [start?.plan?.budget?.maxRequests === GATE.budgetMaxRequests, `the trial froze the configured budget of ${GATE.budgetMaxRequests} requests (got ${JSON.stringify(start?.plan?.budget)})`],
      [runs.some(r => r.status === 'unknown' && r.reason === 'budget'), 'a run stopped on the budget and counts as unknown'],
      [runs.length < full, `the trial stopped early (${runs.length} of ${full} runs)`],
      [requests.length <= GATE.budgetMaxRequests, `the trial made at most the budget's requests (got ${requests.length})`],
      [end?.status === 'unknown' && end.verdict?.reason === 'budget-exhausted' && end.verdict.outcome === 'reject', `the conclusion is unknown / budget-exhausted (got ${end?.status} / ${end?.verdict?.reason})`],
      [decision?.outcome === 'rejected' && decision.reason === 'budget-exhausted' && gRevision(g, decision) === undefined, `nothing was adopted (decision ${decision?.outcome} / ${decision?.reason})`],
      [!(g.activation ?? []).some(r => r.version === gCandidate(g, 'D')?.version), 'no revision names the candidate'],
    ], `with a budget of ${GATE.budgetMaxRequests} requests the trial stopped after ${runs.length} runs: unknown, not adopted`)
  }),

  H13(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const sessionId = sessionOf(obs, 'extras')
    const records = recordsOf(obs, sessionId)
    const tried = name => records.some(r => r.type === 'capability.try' && r.component?.kind === 'context-policy' && r.component?.name === name)
    const conditions = [
      [completed(obs.phases?.extras), `the extras session completed (got ${obs.phases?.extras?.reason?.kind})`],
      [ok(resultOf(obs, sessionId, `draft-policy-${EXTRAS.goodPolicy}`)) && ok(resultOf(obs, sessionId, `try-policy-${EXTRAS.goodPolicy}`)) && tried(EXTRAS.goodPolicy), `the valid policy ${EXTRAS.goodPolicy} drafted and loaded (the control)`],
    ]
    for (const [name, field] of EXTRAS.badPolicies) {
      const draft = resultOf(obs, sessionId, `draft-policy-${name}`)
      const attempt = resultOf(obs, sessionId, `try-policy-${name}`)
      const refusal = refused(draft) ? draft : attempt
      conditions.push(
        [refused(draft) || refused(attempt), `${name} (with ${field}) was refused at draft or try`],
        [String(refusal?.content ?? '').includes(field), `the refusal of ${name} names ${field} (got ${JSON.stringify(String(refusal?.content ?? '').slice(0, 160))})`],
        [!tried(name), `${name} was never loaded (no capability.try record)`],
      )
    }
    return verdict(conditions, `the schema refused ${EXTRAS.badPolicies.length} context policies reaching ${EXTRAS.badPolicies.map(([, f]) => f).join(', ')}; the valid one loaded`)
  },

  H14(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const sessionId = sessionOf(obs, 'extras')
    const approvals = (obs.phases?.extras?.approvals ?? []).filter(a => String(a.request?.summary ?? '').includes(EXTRAS.plugin))
    const records = recordsOf(obs, sessionId)
    const conditions = [
      [ok(resultOf(obs, sessionId, 'draft-plugin')), `the plugin ${EXTRAS.plugin} drafted`],
      [approvals.length === 1, `trying it asked for approval exactly once (got ${approvals.length})`],
      [approvals[0]?.request?.risk === 'high', `the approval is high risk (got ${approvals[0]?.request?.risk})`],
      [approvals[0]?.answered === true, `the denial was accepted (got ${JSON.stringify(approvals[0]?.answered)})`],
      [refused(resultOf(obs, sessionId, 'try-plugin')), 'capability_try of the plugin failed after the denial'],
      [!records.some(r => r.type === 'capability.try' && r.component?.name === EXTRAS.plugin), 'no capability.try record for the plugin'],
      [obs.pluginRan === false, 'its module never ran (no marker file)'],
      [requestsOn(obs, 'extras').every(r => !r.tools.includes(EXTRAS.pluginTool)), `no request offers ${EXTRAS.pluginTool}`],
    ]
    if (obs.features?.gate !== true) return partial(conditions, 'approval of adoption and stopping at awaiting-approval after the gate need the gate (W3)', 'trying the plugin asked once; denied, nothing was imported or registered')
    const g = obs.gate
    if (g === undefined) return { status: 'failed', evidence: 'the gate is present, but the gate scenario did not run' }
    const asked = (g.approvals ?? []).filter(a => a.sessionId === g.tasks?.E?.sessionId)
    const gate = gDecisions(g, 'E').find(d => d.trigger === 'gate')
    const approval = gDecisions(g, 'E').find(d => d.trigger === 'approval')
    const revision = gRevision(g, approval)
    const E = gCandidate(g, 'E')?.version
    const offered = (g.requests ?? []).filter(r => r.kind === 'main' && r.task === 'F')
    conditions.push(
      [asked.length === 1 && asked[0].decision === 'allow' && String(asked[0].summary).includes(GATE.plugin), `the gate scenario's plugin try asked once and was allowed (got ${asked.length})`],
      [gResults(g, 'E', GATE.pluginTool).some(x => x.isError === false), `its tool ${GATE.pluginTool} ran in that session`],
      [gate?.outcome === 'awaiting-approval' && g.plugin?.awaiting === 'awaiting-approval', `after the gate the candidate waits for approval (decision ${gate?.outcome}, status ${g.plugin?.awaiting})`],
      [gRevision(g, gate) === undefined && g.plugin?.versionAwaiting === gVersion(g, 'E'), 'while it waits the adopted version is unchanged'],
      [approval?.outcome === 'adopted' && approval.reason === 'approved' && g.plugin?.approved === 'adopted', `capabilities.approve adopted it (got ${approval?.outcome} / ${g.plugin?.approved})`],
      [revision?.type === 'adopt' && revision.trigger === 'approval' && revision.version === E, `with an adopt revision, trigger approval (got ${JSON.stringify(revision && [revision.type, revision.trigger])})`],
      [gVersion(g, 'F') === E && offered.length > 0 && offered.every(r => r.tools.includes(GATE.pluginTool)), `the next session runs on it and offers ${GATE.pluginTool}`],
      [!(g.approvals ?? []).some(a => a.sessionId === g.tasks?.F?.sessionId), 'without asking again'],
    )
    return withGateStop(g, verdict(conditions, `trying a plugin asks once (denied: nothing ran; allowed: it ran); after its gate it waited at awaiting-approval until capabilities.approve adopted ${short(E)}`))
  },

  H15: gateItem((g) => {
    const w = g.waiting ?? {}
    const plan = gTrial(g, 'A0')[0]?.plan ?? {}
    const selection = (plan.selection ?? []).map(c => c.caseId)
    const guard = (plan.guard ?? []).map(c => c.caseId)
    const ids = key => g.tasks?.[key]?.taskId
    return verdict([
      [w.line?.status === 'waiting', `with one past task the gate process waited (got ${JSON.stringify(w.line)})`],
      [w.trials === 0 && w.decisions === 0 && !Object.keys(w.files ?? {}).some(name => name.endsWith('.attempt') || name.endsWith('.lock')), 'it wrote no receipt, attempt marker, lock or decision'],
      [w.trial?.code === 'tool/invalid-input' && /cannot run yet/.test(w.trial?.error ?? ''), `capabilities.trial refused to start (got ${JSON.stringify(w.trial)})`],
      [w.status === 'proposed', `the candidate stayed proposed (got ${w.status})`],
      [['trialing', 'adopted'].includes(g.retry?.sameApp?.status), `with enough history capabilities.trial started the gate in the same app (got ${JSON.stringify(g.retry?.sameApp)})`],
      [selection.length === GATE.selectionCases && guard.length === GATE.guardCases, `with enough history the plan has ${GATE.selectionCases} selection and ${GATE.guardCases} guard cases (got ${selection.length} + ${guard.length})`],
      [!selection.some(id => guard.includes(id)), 'selection and guard do not overlap'],
      [selection[0] === ids('A0'), 'the selection starts with the task that proposed the candidate'],
      [[ids('H1'), ids('H2')].includes(selection[1]), 'then a similar past task (a monthly summary)'],
      [guard[0] === ids('H3'), 'the guard holds the least similar one (the region table)'],
    ], `the gate waited with too little history; then selection ${selection.length} and guard ${guard.length}, disjoint`)
  }),

  H16: gateItem((g) => {
    const k = g.kill ?? {}
    const r = g.recovered ?? {}
    const F = gCandidate(g, 'F')
    const receipts = (g.trials ?? {})[k.trialId] ?? []
    const files = g.trialFiles ?? {}
    const decided = ['A0', 'C', 'D', 'E'].filter(key => gCandidate(g, key) !== undefined)
    const lastLine = key => (g.logs?.[key] ?? []).at(-1)
    return verdict([
      [Number.isInteger(k.pid) && k.aliveBefore === true && (k.receiptsBefore ?? []).includes('trial.start'), `a running trial held trials/<trialId>.lock naming a live gate process (pid ${k.pid})`],
      [k.deadAfter === true && !receipts.some(x => x.type === 'trial.end'), 'the gate process was killed before its trial ended'],
      [r.decision?.outcome === 'rejected' && r.decision.reason === 'interrupted' && r.decision.trialId === k.trialId, `after a restart the trial is recorded as interrupted (got ${r.decision?.outcome} / ${r.decision?.reason})`],
      [r.decision?.fromVersion === k.versionBefore && r.decision?.toVersion === k.versionBefore && gRevision(g, r.decision) === undefined, 'with no revision: the adopted version stays'],
      [!(`${k.trialId}.lock` in files), 'its lock file is gone'],
      [r.trialsOfF === 1 && r.trial?.code === 'tool/invalid-input' && r.status === 'rejected', `the candidate is not tried again (trials ${r.trialsOfF}, retry ${JSON.stringify(r.trial)})`],
      [F !== undefined && files[`${F.id}.attempt`]?.size === 0, 'its attempt marker stays'],
      [gVersion(g, 'G') === k.versionBefore && gCompleted(g, 'G') && allPassed(gOutcome(g, 'G')), `the next task ran on ${short(k.versionBefore)} and passed its checks`],
      [decided.every(key => files[`${gCandidate(g, key).id}.attempt`]?.size === 0), 'every tried candidate has an empty trials/<candidateId>.attempt'],
      [!Object.keys(files).some(name => name.endsWith('.lock')), 'no lock remains once the trials ended'],
      [decided.every(key => lastLine(key)?.status === 'decided' && lastLine(key)?.trialId === gTrial(g, key)[0]?.trialId), 'each finished gate printed its result as the last line of trials/<candidateId>.log'],
    ], `killing the gate left trial ${short(k.trialId)} open; the next start marked it interrupted, did not rerun it, and ${short(k.versionBefore)} kept working`)
  }),

  H17(obs) {
    if (obs?.features?.capabilityTools !== true) return pending(NO_TOOLS)
    const root = requestsOn(obs, 'peer')
    const member = requestsOn(obs, 'helper')
    const leaked = member.flatMap(r => r.tools.filter(name => CAPABILITY_TOOLS.includes(name) || name.startsWith('cap_')))
    return verdict([
      [root.length > 0 && root.every(r => CAPABILITY_TOOLS.every(name => r.tools.includes(name))), 'the root session offers all three capability tools'],
      [member.length > 0, `the member helper sent requests (got ${member.length})`],
      [member.every(r => /^Member: helper \(/m.test(r.system)), 'its requests carry the member line'],
      [leaked.length === 0, `the member sees none of them (got ${[...new Set(leaked)].join(', ')})`],
    ], `the root session has ${CAPABILITY_TOOLS.join(', ')}; the member's ${member.length} requests have none`)
  },

  H18(obs) {
    if (!versionWritten(obs)) return pending(NO_VERSION)
    const { roots, members } = outcomes(obs)
    const noFields = roots.filter(r => !Array.isArray(r.checks) || !Array.isArray(r.componentsUsed))
    const trees = roots.map(r => [r, members.filter(m => m.taskId === r.taskId)])
    const costless = trees.filter(([r, ms]) => ms.length > 0 && ms.some(m => !(r.memberCosts ?? []).some(c => c.memberId === m.memberId))).map(([r]) => r.sessionId.slice(0, 8))
    const outcomeB = roots.filter(r => r.sessionId === sessionOf(obs, 'taskB')).at(-1)
    const issues = obs.schemaIssues ?? ['not collected']
    return verdict([
      [roots.length >= 4 && noFields.length === 0, `every root task.outcome has checks and componentsUsed (${noFields.length} of ${roots.length} lack them)`],
      [roots.some(r => (r.checks ?? []).length > 0), 'at least one task has host-run checks'],
      [trees.some(([, ms]) => ms.length > 0) && costless.length === 0, `each root with members lists every member in memberCosts (missing in ${costless.join(', ') || 'none'})`],
      [(outcomeB?.componentsUsed ?? []).some(c => c.kind === FM.kind && c.name === FM.name), 'task B\'s outcome lists the adopted module'],
      [issues.length === 0, `every session record and ledger line passes the schema (${issues.slice(0, 3).join('; ')})`],
      [obs.export?.code === 0 && (obs.export?.files ?? []).length > 0, `nexgent export of task B ran and wrote files (exit ${obs.export?.code})`],
      [(obs.secretHits ?? ['?']).length === 0, `no file under .nexgent/ contains the test key (${(obs.secretHits ?? ['not scanned']).join(', ')})`],
      [(obs.exportSecretHits ?? ['?']).length === 0, `no export file contains the test key (${(obs.exportSecretHits ?? ['not scanned']).join(', ')})`],
    ], `${roots.length} root outcomes with checks, componentsUsed and memberCosts; all records pass the schema; the test key is in neither .nexgent/ nor the export`)
  },
}

/** The four items of the midterm checkpoint (partition §中期检查点). */
export const CHECKPOINT = [
  { id: 'CP1', title: '中期检查点 1：任务 A 写技能与函数模块，try 后调用成功，propose 生成候选；另一会话看不到', from: ['H02', 'H03', 'H04'] },
  { id: 'CP2', title: '中期检查点 2：经存储接口写采用修订后，新进程里的任务 B 自动加载并调用；账本带新版本，componentsUsed 列出它', from: ['H07'] },
  { id: 'CP3', title: '中期检查点 3：篡改采用版本的一个文件，下一次加载退回上一版本并留下记录', from: ['H10'] },
  { id: 'CP4', title: '中期检查点 4：任务结束时 task.outcome.checks 有宿主跑出的检查，任务开始时有快照' },
]

/** Checkpoint 4: the baseline task has a snapshot record, a checks record and host-run checks in task.outcome. */
export function checkpoint4(obs) {
  if (!versionWritten(obs)) return pending(NO_VERSION)
  const outcome = ledgerOf(obs, sessionOf(obs, 'baseline')).filter(r => r.type === 'task.outcome').at(-1)
  const taskId = outcome?.taskId
  const checks = outcome?.checks ?? []
  return verdict([
    [taskId !== undefined, 'the baseline task has a task.outcome with a taskId'],
    [(obs.snapshots ?? []).includes(`tasks/${taskId}.json`), `snapshots/tasks/${taskId}.json exists`],
    [(obs.snapshots ?? []).includes(`checks/${taskId}.json`), `snapshots/checks/${taskId}.json exists`],
    [checks.length > 0 && checks.every(c => typeof c.target === 'string'), `task.outcome.checks has host-run checks with targets (got ${checks.length})`],
    [checks.some(c => c.name === 'test-command' && c.passed === true), 'the test command the task ran is among them and passed'],
  ], `task ${taskId}: snapshot at start, ${checks.length} checks at the end`)
}

/** All checkpoint verdicts; CP1–CP3 follow the items they summarise. */
export function judgeCheckpoint(obs) {
  return CHECKPOINT.map((entry) => {
    if (entry.id === 'CP4') return { ...entry, ...safe(() => checkpoint4(obs)) }
    const results = entry.from.map(id => [id, judge(id, obs)])
    const failed = results.filter(([, r]) => r.status === 'failed')
    const open = results.filter(([, r]) => r.status === 'not-implemented')
    if (failed.length > 0) return { ...entry, status: 'failed', evidence: failed.map(([id, r]) => `${id}: ${r.evidence}`).join(' | ') }
    if (open.length > 0) return { ...entry, status: 'not-implemented', evidence: open.map(([id, r]) => `${id}: ${r.evidence}`).join(' | ') }
    return { ...entry, status: 'passed', evidence: entry.from.join(', ') + ' passed' }
  })
}

function safe(fn) {
  try {
    return fn()
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Judge one item; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judge(id, obs) {
  const fn = JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  return safe(() => fn(obs ?? {}))
}

