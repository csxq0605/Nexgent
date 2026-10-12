/**
 * Judges of accept-step4 (round 2: H01–H05, H07, H10, H17 and the four items
 * of the midterm checkpoint), each a pure function of the observations
 * step4-headless.mjs collected. Each is tested against observations made
 * wrong on purpose (packages/test-support/tests/accept-step4-judges.spec.ts).
 *
 * An item whose product part has not landed yet reports `not-implemented`
 * with the reason, never a pass: the capability tools (W2 part 2) decide
 * H02–H05, H07, H10, H17; `capabilityVersion` in sessions and the ledger
 * (W1) decides H01, H07 and checkpoint 4.
 */
import { judgeSummary, ordersCsv } from '../real-task/step4-orders.mjs'
import { verdict, partial } from './step2-judges.mjs'
import { COMPONENTS, TASK_B, UNUSED_SKILL } from './step4-fixtures.mjs'

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
const pending = evidence => ({ status: 'not-implemented', evidence })

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

