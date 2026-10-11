/**
 * The H judges of accept-step3: each decides one checklist item from the
 * observations step3-headless.mjs collected. Judges are pure — they read
 * `obs` and the validators in `tools` (`validateSessionRecord`,
 * `validateLedgerRecord` from @nexgent/session), touch no files and start
 * nothing — so each is tested against a deliberately broken observation
 * (packages/test-support/tests/accept-step3-judges.spec.ts).
 *
 * Items with no judge stay out of {@link JUDGES} and are reported
 * `not-implemented` by the runner. A judge whose item depends on something
 * not built yet returns `not-implemented` via `partial`: what can be checked
 * is checked, and a defect found there is `failed`, never hidden.
 */
import { partial, verdict } from './step2-judges.mjs'
import { FILES, HISTORY_MARKER, MATERIAL, TASKS } from './step3-scenario.mjs'

/** Step-3 session record types (data-formats.md §会话 JSONL, ADR 0004). */
export const STEP3_RECORD_TYPES = ['fork.seed', 'subagent.start', 'subagent.end', 'team.member', 'team.task', 'team.message', 'workflow.start', 'workflow.phase', 'workflow.end']

/** Ledger record types that carry attribution from step 3 on (data-formats.md §账本：归属字段). */
const ATTRIBUTED = new Set(['llm.request.start', 'llm.request.end', 'tool.call', 'task.outcome'])
const ATTRIBUTION_KEYS = ['taskId', 'memberId', 'executionForm']
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const rootRecords = direct => direct?.sessions?.[direct?.sessionId]?.records ?? []
const attributed = direct => (direct?.ledger ?? []).filter(record => ATTRIBUTED.has(record.type))
/** Whether no ledger record carries any attribution field: the kernel does not write them yet (W1). */
const noAttributionAtAll = records => records.every(record => ATTRIBUTION_KEYS.every(key => record[key] === undefined))
const describeIssues = list => list.slice(0, 3).map(([record, issues]) => `${record.type}#${record.seq ?? ''}: ${issues.map(i => `${i.path} ${i.message}`).join(', ')}`).join('; ')

/**
 * Attribution conditions for the direct phase: every attributed record has
 * the same UUID `taskId`, `memberId: main`, `executionForm: direct`; the
 * root `task.outcome` has `formsUsed: ['direct']`.
 */
function directAttribution(direct) {
  const records = attributed(direct)
  const taskIds = new Set(records.map(record => record.taskId))
  const bad = records.filter(record => record.memberId !== 'main' || record.executionForm !== 'direct' || !UUID_V4.test(String(record.taskId)))
  const outcome = records.find(record => record.type === 'task.outcome' && record.sessionId === direct?.sessionId)
  return [
    [records.length > 0, 'the ledger has request, tool and outcome records'],
    [bad.length === 0, `every request, tool call and task.outcome has taskId (UUID v4), memberId main, executionForm direct (${bad.length} do not, e.g. ${bad.slice(0, 2).map(r => `${r.type} ${JSON.stringify(ATTRIBUTION_KEYS.map(k => r[k]))}`).join('; ')})`],
    [taskIds.size === 1, `one taskId for the whole turn (got ${taskIds.size})`],
    [JSON.stringify(outcome?.formsUsed) === '["direct"]', `the root task.outcome has formsUsed ["direct"] (got ${JSON.stringify(outcome?.formsUsed)})`],
  ]
}

/** H01: one turn completes and presents; no child session; the ledger says direct. */
function h01(obs) {
  const direct = obs.direct
  if (direct === undefined) return { status: 'failed', evidence: 'the direct phase did not run' }
  const records = rootRecords(direct)
  const start = records[0]
  const step3Types = records.filter(record => STEP3_RECORD_TYPES.includes(record.type)).map(record => record.type)
  const presented = records.filter(record => record.type === 'deliverable.presented')
  const conditions = [
    [direct.reason?.kind === 'completed', `the turn completed (got ${JSON.stringify(direct.reason)}${direct.error ? `; ${direct.error}` : ''})`],
    [(direct.toolCalls ?? []).map(c => `${c.name}:${c.isError}`).join(',') === 'write_file:false,present:false', `write_file then present both succeeded (got ${JSON.stringify(direct.toolCalls)})`],
    [presented.length === 1 && (direct.deliverables ?? []).length === 1 && direct.deliverables[0].versions.length === 1, `one deliverable.presented and one deliverable with v1 (got ${presented.length} records, ${(direct.deliverables ?? []).length} deliverables)`],
    [(direct.sessionFiles ?? []).length === 1 && direct.sessionFiles[0] === direct.sessionId, `exactly one session file, the root's (got ${(direct.sessionFiles ?? []).length})`],
    [start?.type === 'session.start' && start.parentSessionId === undefined && start.member === undefined, 'the session.start has no parentSessionId and no member'],
    [(direct.listed ?? []).length === 1 && direct.listed.every(s => s.parentSessionId === undefined && !s.childCount), 'sessions.list shows one top-level session with no children'],
    [step3Types.length === 0, `no subagent / team / workflow / fork records (got ${step3Types.join(', ')})`],
    [(direct.requests ?? []).length > 0 && direct.requests.every(r => r.route === null), 'every model request came from the root session (no member line)'],
  ]
  const ledger = attributed(direct)
  if (noAttributionAtAll(ledger)) {
    return partial(conditions, 'the kernel does not write executionForm / taskId / memberId to the ledger yet (W1)', 'turn completed and presented, one root session, no child sessions or collaboration records')
  }
  return verdict([...conditions, ...directAttribution(direct)], 'turn completed and presented, one root session, no child sessions; ledger: executionForm direct, memberId main, one taskId, formsUsed [direct]')
}

/** H10: attribution on every request, tool call and task.outcome, consistent with the form actually used. */
function h10(obs) {
  const direct = obs.direct
  if (direct === undefined) return { status: 'failed', evidence: 'the direct phase did not run' }
  const ledger = attributed(direct)
  if (noAttributionAtAll(ledger)) {
    return partial([[ledger.length > 0, 'the ledger has request, tool and outcome records']], 'the kernel does not write taskId / memberId / executionForm yet (W1)', `${ledger.length} ledger records, none attributed yet`)
  }
  // Only the direct form runs so far; delegated / team / workflow phases join in later rounds.
  return partial(directAttribution(direct), 'only the direct form is exercised yet (delegation, team and workflow phases come with their packages)', `direct: ${ledger.length} records attributed (taskId, memberId main, executionForm direct)`)
}

/** H22: seq continuous, every record valid (new types included), no test key in .nexgent/ or the export. */
function h22(obs, tools) {
  const direct = obs.direct
  if (direct === undefined) return { status: 'failed', evidence: 'the direct phase did not run' }
  const sessions = Object.entries(direct.sessions ?? {})
  const all = sessions.flatMap(([, s]) => s.records)
  const seqBroken = sessions.filter(([, s]) => s.records.length === 0 || !s.records.every((record, index) => record.seq === index + 1)).map(([id]) => id)
  const torn = sessions.filter(([, s]) => s.truncated !== null && s.truncated !== undefined).map(([id]) => id)
  const badRecords = all.map(record => [record, tools.validateSessionRecord(record)]).filter(([, issues]) => issues.length > 0)
  const badLedger = (direct.ledger ?? []).map(record => [record, tools.validateLedgerRecord(record)]).filter(([, issues]) => issues.length > 0)
  const exportFiles = Object.keys(direct.export?.files ?? {})
  const conditions = [
    [sessions.length > 0 && seqBroken.length === 0, `every session's seq is 1..n without gaps (broken: ${seqBroken.join(', ')})`],
    [torn.length === 0, `no session file has a torn tail (${torn.join(', ')})`],
    [badRecords.length === 0, `every session record passes the schema (${describeIssues(badRecords)})`],
    [badLedger.length === 0, `every ledger record passes the schema (${describeIssues(badLedger)})`],
    [direct.export?.code === 0 && exportFiles.length > 0, `nexgent export ran and wrote files (exit ${direct.export?.code})`],
    [(direct.secretHits ?? ['?']).length === 0, `no file under .nexgent/ contains the test key (${(direct.secretHits ?? ['?']).join(', ')})`],
    [(direct.exportSecretHits ?? ['?']).length === 0, `no export file contains the test key (${(direct.exportSecretHits ?? ['?']).join(', ')})`],
  ]
  const seenStep3 = [...new Set(all.map(record => record.type).filter(type => STEP3_RECORD_TYPES.includes(type)))]
  const checked = `${sessions.length} session file(s), ${all.length} records, seq continuous, schema ok; ${(direct.ledger ?? []).length} ledger lines ok; test key in none of .nexgent/ and ${exportFiles.length} export files`
  const missing = STEP3_RECORD_TYPES.filter(type => !seenStep3.includes(type))
  if (missing.length > 0) return partial(conditions, `step-3 record types not exercised yet: ${missing.join(', ')}`, checked)
  return verdict(conditions, `${checked}; all nine step-3 record types present`)
}

// ---- delegation (H02–H04, H12, H15, H16) ------------------------------------------------------

/** Tools a member must never see (kernel contracts/collaboration.ts `MEMBER_DENIED_TOOLS`; a test pins the copy). */
export const MEMBER_DENIED_TOOLS = ['delegate', 'spawn_teammate', 'wait_teammates', 'workflow']

const recordsOf = (phase, id) => phase?.sessions?.[id]?.records ?? []
/** The session id whose `session.start` names member `name`. */
const childOf = (phase, name) => Object.keys(phase?.sessions ?? {}).find(id => recordsOf(phase, id)[0]?.member?.name === name)
const rootOf = phase => recordsOf(phase, phase?.sessionId)
const subStart = (phase, name) => rootOf(phase).find(r => r.type === 'subagent.start' && r.name === name)
const subEnd = (phase, start) => start === undefined ? undefined : rootOf(phase).find(r => r.type === 'subagent.end' && r.childSessionId === start.childSessionId)
const toolResult = (records, callId) => records.find(r => r.type === 'tool.result' && r.toolCallId === callId)
const memberRequests = (phase, name) => (phase?.requests ?? []).filter(r => r.route === name)
const seedText = seed => JSON.stringify(seed?.messages ?? [])
const continuous = records => records.length > 0 && records.every((record, index) => record.seq === index + 1)
const missingPhase = name => ({ status: 'failed', evidence: `the ${name} phase did not run` })

/** Conditions shared by every delegated child: it exists, its parent is the root, its member line says delegated. */
function childConditions(phase, name, mode) {
  const id = childOf(phase, name)
  const start = recordsOf(phase, id)[0]
  const sub = subStart(phase, name)
  return [
    [id !== undefined, `a child session for member ${name} exists`],
    [start?.parentSessionId === phase?.sessionId, `${name}: session.start.parentSessionId is the root session (got ${String(start?.parentSessionId)})`],
    [start?.member?.executionForm === 'delegated', `${name}: session.start.member.executionForm is delegated (got ${String(start?.member?.executionForm)})`],
    [sub !== undefined && sub.childSessionId === id && sub.executionForm === 'delegated' && sub.mode === mode, `the root has subagent.start for ${name} with mode ${mode} and that child id (got ${JSON.stringify(sub && { mode: sub.mode, childSessionId: sub.childSessionId })})`],
  ]
}

/** H02: fresh delegation — parent id right; first member request carries the material, not the parent's history. */
function h02(obs) {
  const d = obs.delegation
  if (d === undefined) return missingPhase('delegation')
  const sub = subStart(d, 'analyst')
  const first = memberRequests(d, 'analyst')[0]
  const text = first?.text ?? ''
  const materialPath = `.nexgent/materials/${d.materialId}/${MATERIAL.name}`
  const leaked = [HISTORY_MARKER, TASKS.setup, TASKS.fresh].filter(needle => text.includes(needle))
  return verdict([
    [d.phases?.fresh?.reason?.kind === 'completed', `the fresh turn completed (got ${JSON.stringify(d.phases?.fresh?.reason)})`],
    ...childConditions(d, 'analyst', 'fresh'),
    [JSON.stringify(sub?.materialIds) === JSON.stringify([d.materialId]), `subagent.start.materialIds is [the stock.csv material] (got ${JSON.stringify(sub?.materialIds)})`],
    [recordsOf(d, childOf(d, 'analyst')).every(r => r.type !== 'fork.seed'), 'the fresh child has no fork.seed'],
    [first !== undefined, 'the analyst sent at least one model request'],
    [text.includes(materialPath), `the analyst's first request references the material (${materialPath})`],
    [leaked.length === 0, `the analyst's first request carries none of the parent's history (found: ${leaked.map(l => JSON.stringify(l.slice(0, 40))).join(', ')})`],
  ], `analyst child of the root (delegated, fresh); first request references ${MATERIAL.name} by its material path and carries no parent history`)
}

/** H03: fork delegation — the member's request has the parent history up to the previous turn; after a kill and resume the seed is still there. */
function h03(obs) {
  const d = obs.delegation
  if (d === undefined) return missingPhase('delegation')
  const forker = childOf(d, 'forker')
  const seed = recordsOf(d, forker)[1]
  const first = memberRequests(d, 'forker')[0]?.text ?? ''
  const kill = d.phases?.forkKill ?? {}
  const two = childOf(d.afterKill, 'forker-two')
  const seedAtKill = recordsOf(d.afterKill, two)[1]
  const seedAfter = recordsOf(d, two)[1]
  const twoStart = subStart(d, 'forker-two')
  const root = rootOf(d)
  const killTurnEnd = twoStart === undefined ? undefined : root.find(r => r.type === 'turn.end' && r.turn === twoStart.turn)
  const twoEnd = subEnd(d, twoStart)
  const conditions = [
    [d.phases?.fork?.reason?.kind === 'completed', `the fork turn completed (got ${JSON.stringify(d.phases?.fork?.reason)})`],
    ...childConditions(d, 'forker', 'fork'),
    [seed?.type === 'fork.seed' && seed.fromSessionId === d.sessionId, `forker: seq 2 is fork.seed from the root (got ${String(seed?.type)})`],
    [seedText(seed).includes(HISTORY_MARKER) && seedText(seed).includes(TASKS.fresh) && !seedText(seed).includes(TASKS.fork), 'forker: the seed holds the earlier turns (setup, fresh) and not the current turn'],
    [first.includes(HISTORY_MARKER) && first.includes(TASKS.fresh) && !first.includes(TASKS.fork), "forker: its first model request carries the parent's history up to the previous turn, not the current one"],
    [kill.ready === true && kill.streaming === true && kill.mainAlive === false, `the driver was killed while forker-two was streaming (ready ${kill.ready}, streaming ${kill.streaming}, alive after kill ${kill.mainAlive})`],
    ...childConditions(d, 'forker-two', 'fork'),
    [seedAtKill?.type === 'fork.seed' && seedText(seedAtKill).includes(HISTORY_MARKER) && !seedText(seedAtKill).includes(TASKS.forkKill), 'forker-two: right after the kill its file has the fork.seed with the parent history'],
    [JSON.stringify(seedAfter) === JSON.stringify(seedAtKill) && continuous(recordsOf(d, two)), 'forker-two: after resume the same fork.seed is still there and seq is continuous'],
    [killTurnEnd?.reason?.kind === 'interrupted', `the root closes the killed turn as interrupted on resume (got ${JSON.stringify(killTurnEnd?.reason)})`],
    [twoEnd === undefined || twoEnd.result?.status === 'interrupted', `a subagent.end for forker-two, if written, says interrupted (got ${String(twoEnd?.result?.status)})`],
    [d.phases?.resume?.reason?.kind === 'completed', `the resume turn completed (got ${JSON.stringify(d.phases?.resume?.reason)})`],
  ]
  const closing = twoEnd === undefined ? '; subagent.end interrupted not written yet (the host does not call closeInterruptedRuns, W6; not part of H03)' : '; subagent.end interrupted written'
  return verdict(conditions, `forker: fork.seed from the root through the previous turn, its request carries that history; forker-two killed mid-stream, its fork.seed survives the resume, root turn closed interrupted${closing}`)
}

/** H04: what the member presented comes back in the tool result and subagent.end; the parent's final deliverable includes the member's file. */
function h04(obs) {
  const d = obs.delegation
  if (d === undefined) return missingPhase('delegation')
  const start = subStart(d, 'analyst')
  const end = subEnd(d, start)
  const delivered = (end?.result?.deliverables ?? []).find(ref => (ref.files ?? []).some(f => f.path === FILES.summary.path))
  const memberFile = delivered?.files?.find(f => f.path === FILES.summary.path)
  const result = start === undefined ? undefined : toolResult(rootOf(d), start.toolCallId)
  const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '')
  const final = rootOf(d).find(r => r.type === 'deliverable.presented' && r.seq > (result?.seq ?? Infinity) && (r.deliverable?.files ?? []).some(f => f.path === FILES.summary.path))
  const finalFile = final?.deliverable?.files?.find(f => f.path === FILES.summary.path)
  const memberDeliverable = (d.deliverables ?? []).find(x => x.deliverableId === delivered?.deliverableId)
  return verdict([
    [end?.result?.status === 'completed', `subagent.end for the analyst is completed (got ${String(end?.result?.status)})`],
    [delivered !== undefined && delivered.memberName === 'analyst', `subagent.end lists the analyst's deliverable with ${FILES.summary.path} (got ${JSON.stringify(end?.result?.deliverables?.map(x => x.files?.map(f => f.path)))})`],
    [memberDeliverable !== undefined && memberDeliverable.versions.every(v => v.sessionId === start?.childSessionId), 'deliverables.list has that deliverable, presented from the analyst session'],
    [result !== undefined && result.isError === false && content.includes(String(delivered?.deliverableId)) && content.includes(FILES.summary.path), "the root's delegate tool.result succeeded and names the deliverable id and its file"],
    [final !== undefined, `a later root deliverable.presented includes ${FILES.summary.path}`],
    [finalFile !== undefined && finalFile.sha256 === memberFile?.sha256, "the root's final deliverable has the analyst's file as presented (same SHA-256)"],
  ], `analyst presented ${FILES.summary.path}; it is in subagent.end and the delegate tool result; the root's final deliverable carries the same file`)
}

/** H12: a read-only parent refuses a wider member; a preset's denied tool is invisible to the member. */
function h12(obs) {
  const r = obs.readonly
  if (r === undefined) return missingPhase('read-only')
  const root = rootOf(r)
  const wide = toolResult(root, 'call-wide')
  const quietId = childOf(r, 'quiet')
  const quietStart = recordsOf(r, quietId)[0]
  const quiet = memberRequests(r, 'quiet')
  const lead = (r.requests ?? []).filter(q => q.route === null)
  return verdict([
    [r.reason?.kind === 'completed', `the read-only turn completed (got ${JSON.stringify(r.reason)})`],
    [root[0]?.sandboxMode === 'read-only', `the root session runs read-only (got ${String(root[0]?.sandboxMode)})`],
    [wide?.isError === true && wide.error?.code === 'sandbox/denied', `delegating with the wider preset fails with sandbox/denied (got ${JSON.stringify(wide && { isError: wide.isError, code: wide.error?.code })})`],
    [childOf(r, 'wide-one') === undefined && subStart(r, 'wide-one') === undefined && memberRequests(r, 'wide-one').length === 0, 'the refused member has no session, no subagent.start and no request'],
    ...childConditions(r, 'quiet', 'fresh'),
    [quietStart?.sandboxMode === 'read-only' && quietStart?.member?.preset === 'noshell', `quiet runs read-only with preset noshell (got ${String(quietStart?.sandboxMode)}, ${String(quietStart?.member?.preset)})`],
    [lead.length > 0 && lead.every(q => q.tools.includes(r.shell)), `the root's requests offer ${r.shell}`],
    [quiet.length > 0 && quiet.every(q => !q.tools.includes(r.shell)), `quiet's requests do not offer ${r.shell} (got ${JSON.stringify(quiet.map(q => q.tools))})`],
  ], `read-only root: the workspace-write preset is refused (sandbox/denied, no member); the noshell member runs read-only without ${r.shell}`)
}

/** H15: no member ever sees delegate, team or workflow tools. */
function h15(obs) {
  const phases = [obs.delegation, obs.readonly].filter(Boolean)
  if (phases.length < 2) return missingPhase(obs.delegation === undefined ? 'delegation' : 'read-only')
  const requests = phases.flatMap(p => p.requests ?? [])
  const members = requests.filter(q => q.route !== null)
  const lead = requests.filter(q => q.route === null)
  const leaks = members.filter(q => q.tools.some(t => MEMBER_DENIED_TOOLS.includes(t)))
  const names = [...new Set(members.map(q => q.route))]
  const conditions = [
    [members.length > 0 && names.length >= 5, `requests from several members were seen (${names.join(', ')})`],
    [members.every(q => q.tools.length > 0), 'every member request offers tools'],
    [leaks.length === 0, `no member request offers ${MEMBER_DENIED_TOOLS.join(', ')} (leaks: ${leaks.map(q => `${q.route}: ${q.tools.filter(t => MEMBER_DENIED_TOOLS.includes(t)).join('/')}`).join('; ')})`],
    [lead.length > 0 && lead.every(q => q.tools.includes('delegate')), 'every root request offers delegate'],
  ]
  const checked = `${members.length} requests from ${names.length} members, none offers ${MEMBER_DENIED_TOOLS.join(', ')}; the root offers delegate`
  const absent = MEMBER_DENIED_TOOLS.filter(t => t !== 'delegate' && !lead.some(q => q.tools.includes(t)))
  if (absent.length > 0) return partial(conditions, `the root does not offer ${absent.join(', ')} yet (team and workflow tools come with their packages)`, checked)
  return verdict(conditions, `${checked}, ${MEMBER_DENIED_TOOLS.slice(1).join(', ')}`)
}

/** H16: two members presenting the same path get one deliverable each, one version each. */
function h16(obs) {
  const d = obs.delegation
  if (d === undefined) return missingPhase('delegation')
  const a = childOf(d, 'writer-a')
  const b = childOf(d, 'writer-b')
  const shared = (d.deliverables ?? []).filter(x => x.versions.some(v => (v.files ?? []).includes(FILES.shared.path)))
  const bySession = id => shared.filter(x => x.versions.some(v => v.sessionId === id))
  const ends = ['writer-a', 'writer-b'].map(name => subEnd(d, subStart(d, name)))
  const refs = ends.map(end => (end?.result?.deliverables ?? []).find(ref => (ref.files ?? []).some(f => f.path === FILES.shared.path)))
  return verdict([
    [d.phases?.sameName?.reason?.kind === 'completed', `the same-name turn completed (got ${JSON.stringify(d.phases?.sameName?.reason)})`],
    ...childConditions(d, 'writer-a', 'fresh'),
    ...childConditions(d, 'writer-b', 'fresh'),
    [ends.every(end => end?.result?.status === 'completed'), 'both members completed'],
    [shared.length === 2, `two deliverables contain ${FILES.shared.path} (got ${shared.length})`],
    [shared.every(x => x.versions.length === 1), `each has exactly one version (got ${shared.map(x => x.versions.length).join(', ')})`],
    [bySession(a).length === 1 && bySession(b).length === 1 && bySession(a)[0] !== bySession(b)[0], 'one belongs to writer-a, the other to writer-b'],
    [refs.every(ref => ref?.version === 1) && refs[0]?.deliverableId !== refs[1]?.deliverableId, `the two subagent.end results name different deliverables, each v1 (got ${JSON.stringify(refs.map(ref => ref && [ref.deliverableId, ref.version]))})`],
  ], `writer-a and writer-b both presented ${FILES.shared.path}: two deliverables, one version each, one per member`)
}

/** Top-level paths the old Python products used (plan W7, check H23). */
export const FORBIDDEN_TOP_LEVEL = ['nexgent', 'tests', 'config.py', 'runtime']
const isForbidden = path => {
  const top = path.split('/')[0] ?? ''
  return FORBIDDEN_TOP_LEVEL.includes(top) || /^stage-/.test(top)
}

/** H23: no Python file and none of the old top-level directories in the repository's tracked files. */
function h23(obs) {
  const files = obs.repo?.files
  if (!Array.isArray(files) || files.length === 0) return { status: 'failed', evidence: 'no repository file list was collected' }
  const python = files.filter(path => /\.py$/i.test(path))
  const old = [...new Set(files.filter(isForbidden).map(path => path.split('/')[0]))]
  return verdict([
    [python.length === 0, `${python.length} Python file(s), e.g. ${python.slice(0, 3).join(', ')}`],
    [old.length === 0, `old top-level paths present: ${old.join(', ')}`],
  ], `${files.length} tracked files (${obs.repo.source}); no *.py, no ${FORBIDDEN_TOP_LEVEL.join(', ')}, stage-*`)
}

/** Judges by checklist id. */
export const JUDGES = { H01: h01, H02: h02, H03: h03, H04: h04, H10: h10, H12: h12, H15: h15, H16: h16, H22: h22, H23: h23 }

/** Run one judge; a throw is a failure, a missing judge is not-implemented. */
export function judge(id, obs, tools) {
  const fn = JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return fn(obs ?? {}, tools)
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
