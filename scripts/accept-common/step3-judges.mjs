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
import { readWorkbook } from '../real-task/step3-restock/xlsx.mjs'
import { FILES, HISTORY_MARKER, MATERIAL, PAGE, SHEET, TASKS, TOOL_FILES, WF_CYCLE, WF_GRAPH, WF_MAX_CONCURRENT, WF_PARTS } from './step3-scenario.mjs'

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

/** The scenario's projects, in run order; each has `sessions` and `ledger`. */
export const PROJECTS = ['direct', 'delegation', 'readonly', 'tools', 'workflow']
/** Execution forms in `formsUsed` order (data-formats.md §账本). */
const FORM_ORDER = ['direct', 'delegated', 'team', 'workflow']

/**
 * Attribution across every project: roots say `main` / `direct`, members their session id and
 * the form of their `session.start.member`; one task tree per `taskId`; each root
 * `task.outcome` has `formsUsed` = the forms seen in its tree so far, in order.
 */
function treeAttribution(obs) {
  const problems = []
  const forms = new Set()
  let count = 0
  for (const key of PROJECTS) {
    const project = obs[key]
    if (project === undefined) continue
    const starts = Object.fromEntries(Object.entries(project.sessions ?? {}).map(([id, s]) => [id, s.records[0]]))
    const trees = new Map()
    for (const record of attributed(project)) {
      count += 1
      const start = starts[record.sessionId]
      const where = `${key} ${record.type} ${String(record.sessionId).slice(0, 8)}`
      if (!UUID_V4.test(String(record.taskId)) || typeof record.memberId !== 'string' || typeof record.executionForm !== 'string') { problems.push(`${where}: missing taskId / memberId / executionForm`); continue }
      if (start === undefined) { problems.push(`${where}: no session file for this session`); continue }
      const isRoot = start.parentSessionId === undefined
      const expected = isRoot ? ['main', 'direct'] : [record.sessionId, start.member?.executionForm]
      if (record.memberId !== expected[0] || record.executionForm !== expected[1]) problems.push(`${where}: memberId/executionForm ${record.memberId}/${record.executionForm}, expected ${expected.join('/')}`)
      forms.add(record.executionForm)
      const tree = trees.get(record.taskId) ?? { roots: new Set(), parents: new Set(), forms: new Set() }
      trees.set(record.taskId, tree)
      if (isRoot) tree.roots.add(record.sessionId)
      else tree.parents.add(start.parentSessionId)
      tree.forms.add(record.executionForm)
      if (isRoot && record.type === 'task.outcome') {
        const want = FORM_ORDER.filter(form => tree.forms.has(form))
        if (JSON.stringify(record.formsUsed) !== JSON.stringify(want)) problems.push(`${where}: formsUsed ${JSON.stringify(record.formsUsed)}, expected ${JSON.stringify(want)}`)
      }
    }
    for (const [taskId, tree] of trees) {
      const parents = [...tree.parents].filter(id => !tree.roots.has(id))
      if (tree.roots.size !== 1 || parents.length > 0) problems.push(`${key} task ${taskId.slice(0, 8)}: ${tree.roots.size} root sessions, members of other roots: ${parents.length}`)
    }
  }
  return { problems, forms, count }
}

/** H10: attribution on every request, tool call and task.outcome, consistent with the form actually used. */
function h10(obs) {
  const direct = obs.direct
  if (direct === undefined) return { status: 'failed', evidence: 'the direct phase did not run' }
  const ledger = attributed(direct)
  if (noAttributionAtAll(ledger)) {
    return partial([[ledger.length > 0, 'the ledger has request, tool and outcome records']], 'the kernel does not write taskId / memberId / executionForm yet (W1)', `${ledger.length} ledger records, none attributed yet`)
  }
  const { problems, forms, count } = treeAttribution(obs)
  const conditions = [
    ...directAttribution(direct),
    [problems.length === 0, `every attributed record matches its session and tree (${problems.length} problems, e.g. ${problems.slice(0, 3).join('; ')})`],
    [['direct', 'delegated', 'workflow'].every(form => forms.has(form)), `the direct, delegated and workflow forms all appear (got ${[...forms].join(', ')})`],
  ]
  const checked = `${count} records across ${PROJECTS.filter(k => obs[k]).length} projects: roots main/direct, members their session id and form, one root per taskId, formsUsed right (${FORM_ORDER.filter(f => forms.has(f)).join(', ')})`
  if (!forms.has('team')) return partial(conditions, 'the team form is not exercised yet', checked)
  return verdict(conditions, checked)
}

/** H22: seq continuous, every record valid (new types included), no test key in .nexgent/ or the export. */
function h22(obs, tools) {
  const direct = obs.direct
  if (direct === undefined) return { status: 'failed', evidence: 'the direct phase did not run' }
  const projects = PROJECTS.filter(key => obs[key] !== undefined)
  const sessions = projects.flatMap(key => Object.entries(obs[key].sessions ?? {}).map(([id, s]) => [`${key}/${id.slice(0, 8)}`, s]))
  const all = sessions.flatMap(([, s]) => s.records)
  const ledgerAll = projects.flatMap(key => obs[key].ledger ?? [])
  const seqBroken = sessions.filter(([, s]) => s.records.length === 0 || !s.records.every((record, index) => record.seq === index + 1)).map(([id]) => id)
  const torn = sessions.filter(([, s]) => s.truncated !== null && s.truncated !== undefined).map(([id]) => id)
  const badRecords = all.map(record => [record, tools.validateSessionRecord(record)]).filter(([, issues]) => issues.length > 0)
  const badLedger = ledgerAll.map(record => [record, tools.validateLedgerRecord(record)]).filter(([, issues]) => issues.length > 0)
  const exportFiles = Object.keys(direct.export?.files ?? {})
  const secretHits = projects.flatMap(key => (obs[key].secretHits ?? ['?']).map(hit => `${key}: ${hit}`))
  const conditions = [
    [sessions.length > 0 && seqBroken.length === 0, `every session's seq is 1..n without gaps (broken: ${seqBroken.join(', ')})`],
    [torn.length === 0, `no session file has a torn tail (${torn.join(', ')})`],
    [badRecords.length === 0, `every session record passes the schema (${describeIssues(badRecords)})`],
    [badLedger.length === 0, `every ledger record passes the schema (${describeIssues(badLedger)})`],
    [direct.export?.code === 0 && exportFiles.length > 0, `nexgent export ran and wrote files (exit ${direct.export?.code})`],
    [secretHits.length === 0, `no file under any project's .nexgent/ contains the test key (${secretHits.join(', ')})`],
    [(direct.exportSecretHits ?? ['?']).length === 0, `no export file contains the test key (${(direct.exportSecretHits ?? ['?']).join(', ')})`],
  ]
  const types = new Set(all.map(record => record.type))
  const seenStep3 = STEP3_RECORD_TYPES.filter(type => types.has(type))
  const checked = `${projects.length} projects, ${sessions.length} session files, ${all.length} records, seq continuous, schema ok; ${ledgerAll.length} ledger lines ok; test key in none of .nexgent/ and ${exportFiles.length} export files; step-3 types seen: ${seenStep3.join(', ')}`
  const missing = STEP3_RECORD_TYPES.filter(type => !seenStep3.includes(type))
  if (missing.length > 0) return partial(conditions, `step-3 record types not exercised yet: ${missing.join(', ')}`, checked)
  return verdict(conditions, `${checked}; all nine step-3 record types present`)
}

// ---- delegation (H02–H04, H12, H15, H16) ------------------------------------------------------

/**
 * Collaboration tools the root offers (kernel contracts/step3-tools.ts `STEP3_TOOLS` without
 * `run_code`; a test pins the copy). No delegated or workflow member may see any of them
 * (plan H15: "no delegate, team or workflow tools"); a teammate sees only its own
 * {@link TEAMMATE_TOOLS}.
 */
export const COLLABORATION_TOOLS = ['delegate', 'spawn_teammate', 'send_message', 'wait_teammates', 'team_task_create', 'team_task_list', 'team_task_update', 'workflow']
/** The team tools a teammate has in its own scope (@nexgent/team README). */
export const TEAMMATE_TOOLS = ['send_message', 'team_task_list', 'team_task_update']
/** Tools a member of `form` must not see. */
export const forbiddenFor = form => COLLABORATION_TOOLS.filter(tool => form !== 'team' || !TEAMMATE_TOOLS.includes(tool))

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

/** The form of a member request: the `(form)` of its member line. */
const formOf = request => /^Member: [a-z][a-z0-9-]{0,31} \((delegated|team|workflow)\)$/m.exec(request.sessionText ?? '')?.[1]

/** H15: no member sees delegate, team or workflow tools (a teammate: only its own three team tools). */
function h15(obs) {
  const keys = ['delegation', 'readonly', 'workflow', 'team']
  const missing = keys.filter(key => key !== 'team' && obs[key] === undefined)
  if (missing.length > 0) return missingPhase(missing[0])
  const requests = keys.flatMap(key => obs[key]?.requests ?? [])
  const members = requests.filter(q => q.route !== null)
  const lead = requests.filter(q => q.route === null)
  const leaks = members.map(q => [q, q.tools.filter(t => forbiddenFor(formOf(q)).includes(t))]).filter(([, tools]) => tools.length > 0)
  const forms = new Set(members.map(formOf))
  const leakText = [...new Map(leaks.map(([q, tools]) => [`${formOf(q)} ${q.route}`, tools.join('/')])).entries()].slice(0, 4).map(([who, tools]) => `${who}: ${tools}`).join('; ')
  const conditions = [
    [members.length > 0 && members.every(q => formOf(q) !== undefined), `every member request has a member line (${members.length} requests from ${new Set(members.map(q => q.route)).size} members)`],
    [members.every(q => q.tools.length > 0), 'every member request offers tools'],
    [leaks.length === 0, `no member sees a collaboration tool it must not (${leaks.length} requests do, e.g. ${leakText})`],
    [lead.length > 0 && lead.every(q => COLLABORATION_TOOLS.every(t => q.tools.includes(t))), `every root request offers all of ${COLLABORATION_TOOLS.join(', ')}`],
  ]
  const checked = `${members.length} requests from members (${[...forms].join(', ')}); none sees a forbidden collaboration tool; the root offers all ${COLLABORATION_TOOLS.length}`
  if (!forms.has('team')) return partial(conditions, 'no teammate request is exercised yet', checked)
  return verdict(conditions, checked)
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

// ---- tools (H17–H19) ---------------------------------------------------------------------------

/** The root's `tool.result` record for one call id. */
const resultOf = (project, callId) => toolResult(rootOf(project), callId)
const textOf = result => (typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? ''))
const fileText = (project, path) => (project?.files?.[path] ? Buffer.from(project.files[path], 'base64').toString('utf8') : null)

/** H17: run_code reads and writes project files; sees no environment; is refused outside; is stopped at its timeout with no process left. */
function h17(obs) {
  const t = obs.tools
  if (t === undefined) return missingPhase('tools')
  const ptc = t.phases?.ptc ?? {}
  const files = resultOf(t, 'call-ptc-files')
  const outside = resultOf(t, 'call-ptc-outside')
  const timeout = resultOf(t, 'call-ptc-timeout')
  return verdict([
    [ptc.reason?.kind === 'completed', `the run_code turn completed (got ${JSON.stringify(ptc.reason)})`],
    [files?.isError === false && textOf(files).includes(JSON.stringify(TOOL_FILES.input.content)), 'run_code read data/input.txt through readFile and returned it'],
    [fileText(t, TOOL_FILES.output) === TOOL_FILES.input.content.toUpperCase(), `run_code wrote ${TOOL_FILES.output} with the upper-cased text (got ${JSON.stringify(fileText(t, TOOL_FILES.output))})`],
    [/"envKeys": \[\]/.test(textOf(files)), 'process.env inside the program is empty'],
    [outside?.isError === true && textOf(outside).includes('sandbox/denied') && !textOf(outside).includes('OUTSIDE-SECRET'), `reading a file outside the project fails with sandbox/denied and returns nothing of it (got ${JSON.stringify(textOf(outside).slice(0, 120))})`],
    [timeout?.isError === true && /Timed out/.test(textOf(timeout)), `the endless loop is stopped at its 1 s timeout (got ${JSON.stringify(textOf(timeout).slice(0, 80))})`],
    [Number.isInteger(ptc.timeoutPid) && ptc.timeoutPidAlive === false, `the timed-out program's process (pid ${ptc.timeoutPid}) is gone once the tool returned`],
  ], 'run_code read and wrote project files, saw an empty process.env, was refused outside the project (sandbox/denied), and was stopped at 1 s with its process gone')
}

/** H18: write_spreadsheet writes formulas with correct cached values; refuses external references, unknown functions, #DIV/0! and over-limit input, writing nothing. */
function h18(obs) {
  const t = obs.tools
  if (t === undefined) return missingPhase('tools')
  const ok = resultOf(t, 'call-sheet-ok')
  let cells
  let readError
  try {
    const bytes = t.files?.[TOOL_FILES.sheet]
    cells = bytes ? readWorkbook(Buffer.from(bytes, 'base64')).sheets.find(sheet => sheet.name === 'Plan')?.cells : undefined
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }
  const wrong = Object.entries(SHEET.formulas).filter(([ref, formula]) => cells?.get(ref)?.formula !== formula || cells?.get(ref)?.value !== SHEET.values[ref])
  const inputsKept = cells?.get('B2')?.value === SHEET.rows[1][1] && cells?.get('C3')?.value === SHEET.rows[2][2] && cells?.get('A4')?.value === 'Total'
  const refusals = [
    ['call-sheet-external', 'external reference', 'tool/failed', 'formula'],
    ['call-sheet-unknown', 'unknown function', 'tool/failed', 'formula'],
    ['call-sheet-divzero', 'division by zero', 'tool/failed', 'formula'],
    ['call-sheet-limit', '33 sheets', 'tool/invalid-input', undefined],
  ]
  return verdict([
    [t.phases?.sheet?.reason?.kind === 'completed', `the spreadsheet turn completed (got ${JSON.stringify(t.phases?.sheet?.reason)})`],
    [ok?.isError === false, 'write_spreadsheet of the plan succeeded'],
    [cells !== undefined, `${TOOL_FILES.sheet} reads back with a Plan sheet${readError ? ` (${readError})` : ''}`],
    [cells !== undefined && wrong.length === 0, `D2:D4 are formula cells with correct cached values (wrong: ${wrong.map(([ref]) => `${ref} ${JSON.stringify(cells?.get(ref))}`).join(', ')})`],
    [inputsKept, 'the input cells are written as given'],
    ...refusals.map(([id, label, code, reason], index) => [
      resultOf(t, id)?.isError === true && resultOf(t, id)?.error?.code === code && (reason === undefined || resultOf(t, id)?.error?.details?.reason === reason) && t.files?.[TOOL_FILES.rejected[index]] === null,
      `${label}: refused with ${code}${reason ? ` (${reason})` : ''} and no file written (got ${JSON.stringify(resultOf(t, id)?.error?.code)}, file ${t.files?.[TOOL_FILES.rejected[index]] === null ? 'absent' : 'present'})`,
    ]),
  ], `formulas ${Object.values(SHEET.formulas).join(', ')} with cached ${Object.values(SHEET.values).join(', ')}; external reference, unknown function, #DIV/0! and 33 sheets refused, nothing written`)
}

/** H19: a local page becomes Markdown; loopback, private and redirect-to-loopback addresses are refused, by the shipped plugin too. */
function h19(obs) {
  const t = obs.tools
  const r = obs.readonly
  if (t === undefined) return missingPhase('tools')
  if (r === undefined) return missingPhase('read-only')
  const page = resultOf(t, 'call-web-page')
  const text = textOf(page)
  const blocked = id => resultOf(t, id)?.isError === true && resultOf(t, id)?.error?.code === 'tool/denied' && resultOf(t, id)?.error?.details?.reason === 'blocked-address'
  const shipped = resultOf(r, 'call-web-shipped')
  return verdict([
    [t.phases?.web?.reason?.kind === 'completed', `the web turn completed (got ${JSON.stringify(t.phases?.web?.reason)})`],
    [page?.isError === false && text.includes(PAGE.heading) && text.includes(PAGE.marker) && /\| SKU \| On hand \|/.test(text), 'the local page came back as Markdown (heading, body, table)'],
    [PAGE.hidden.every(needle => !text.includes(needle)), 'scripts and hidden elements are dropped'],
    [blocked('call-web-loopback'), 'http://127.0.0.1 is refused (tool/denied, blocked-address)'],
    [blocked('call-web-private'), 'a private address (10.0.0.1) is refused'],
    [blocked('call-web-redirect'), 'a redirect from the page server to 127.0.0.1 is refused'],
    [t.webHits?.['/stock.html'] === 1 && t.webHits?.['/redirect'] === 1, `the page server saw exactly the allowed page fetch and the redirect (got ${JSON.stringify(t.webHits)})`],
    [shipped?.isError === true && shipped.error?.code === 'tool/denied' && shipped.error?.details?.reason === 'blocked-address', 'the shipped @nexgent/web refuses the same local page (loopback), sending no request'],
  ], 'local page converted to Markdown (test row: the shipped tool plus one allowed address, 127.0.0.2); 127.0.0.1, 10.0.0.1 and a redirect to 127.0.0.1 refused; the shipped plugin refuses the loopback page')
}

// ---- workflow (H07–H09) ------------------------------------------------------------------------

/** Workflow records of one workflow (by its tool call). */
function workflowOf(project, callId) {
  const root = rootOf(project)
  const start = root.find(r => r.type === 'workflow.start' && r.toolCallId === callId)
  const id = start?.workflowId
  return {
    start,
    phases: root.filter(r => r.type === 'workflow.phase' && r.workflowId === id).map(r => r.phase),
    end: root.find(r => r.type === 'workflow.end' && r.workflowId === id),
    starts: root.filter(r => r.type === 'subagent.start' && r.workflowId === id),
    ends: root.filter(r => r.type === 'subagent.end' && root.some(s => s.type === 'subagent.start' && s.workflowId === id && s.childSessionId === r.childSessionId)),
  }
}

/** Most members running at once, from the order of subagent.start / subagent.end records. */
function maxConcurrent(wf) {
  const events = [...wf.starts.map(r => [r.seq, 1]), ...wf.ends.map(r => [r.seq, -1])].sort((a, b) => a[0] - b[0])
  let running = 0
  let most = 0
  for (const [, delta] of events) most = Math.max(most, (running += delta))
  return most
}

/** Every workflow member child: parent is the root, form workflow. */
function workflowChildren(project, names) {
  return names.map(name => {
    const id = childOf(project, name)
    const start = recordsOf(project, id)[0]
    return [id !== undefined && start?.parentSessionId === project.sessionId && start?.member?.executionForm === 'workflow', `${name}: a child session of the root with member form workflow`]
  })
}

/** H07: parallel members within the cap, then a pipeline summariser that presents the result. */
function h07(obs) {
  const w = obs.workflow
  if (w === undefined) return missingPhase('workflow')
  const wf = workflowOf(w, 'call-wf-script')
  const names = wf.starts.map(r => r.name)
  const summariserStart = wf.starts.find(r => r.name === 'summariser')
  const partEnds = wf.ends.filter(r => wf.starts.some(s => s.childSessionId === r.childSessionId && WF_PARTS.includes(s.name)))
  const summariserEnd = wf.ends.find(r => r.childSessionId === summariserStart?.childSessionId)
  const presented = (summariserEnd?.result?.deliverables ?? []).find(ref => (ref.files ?? []).some(f => f.path === 'final/summary.md'))
  const listed = (w.deliverables ?? []).find(d => d.deliverableId === presented?.deliverableId)
  const most = maxConcurrent(wf)
  const result = resultOf(w, 'call-wf-script')
  return verdict([
    [w.phases?.wfScript?.reason?.kind === 'completed', `the workflow turn completed (got ${JSON.stringify(w.phases?.wfScript?.reason)})`],
    [wf.start?.kind === 'script' && wf.end?.status === 'completed' && wf.end?.members === WF_PARTS.length + 1, `workflow.start (script) and workflow.end completed with ${WF_PARTS.length + 1} members (got ${JSON.stringify(wf.end && { status: wf.end.status, members: wf.end.members })})`],
    [JSON.stringify(wf.phases) === '["count","summarise"]', `workflow.phase records count, summarise (got ${JSON.stringify(wf.phases)})`],
    [JSON.stringify([...names].sort()) === JSON.stringify([...WF_PARTS, 'summariser'].sort()) && wf.starts.every(r => r.executionForm === 'workflow'), `subagent.start for ${WF_PARTS.join(', ')}, summariser, all executionForm workflow (got ${names.join(', ')})`],
    ...workflowChildren(w, [...WF_PARTS, 'summariser']),
    [wf.ends.every(r => r.result?.status === 'completed') && wf.ends.length === wf.starts.length, 'every member completed'],
    [most >= 2 && most <= WF_MAX_CONCURRENT, `members ran in parallel within the cap of ${WF_MAX_CONCURRENT} (most at once: ${most})`],
    [summariserStart !== undefined && partEnds.length === WF_PARTS.length && partEnds.every(r => r.seq < summariserStart.seq), 'the summariser started only after every parallel member ended'],
    [presented !== undefined && listed !== undefined && listed.versions.every(v => v.sessionId === summariserStart?.childSessionId), 'the summariser presented final/summary.md (deliverable from its session)'],
    [result?.isError === false, 'the workflow tool result is not an error'],
  ], `${WF_PARTS.length} parallel members (at most ${most} at once, cap ${WF_MAX_CONCURRENT}), then the summariser presented final/summary.md; workflow completed`)
}

/** H08: a three-node graph runs in dependency order; a graph with a cycle is refused with a readable error. */
function h08(obs) {
  const w = obs.workflow
  if (w === undefined) return missingPhase('workflow')
  const wf = workflowOf(w, 'call-wf-graph')
  const seqOf = (name, list) => list.find(r => r.name === name || wf.starts.some(s => s.childSessionId === r.childSessionId && s.name === name))?.seq ?? NaN
  const order = WF_GRAPH.nodes.flatMap(node => node.dependencies.map(dep => [dep, node.id]))
  const cycle = resultOf(w, 'call-wf-cycle')
  const cycleNames = WF_CYCLE.nodes.map(n => n.id)
  return verdict([
    [w.phases?.wfGraph?.reason?.kind === 'completed', `the graph turn completed (got ${JSON.stringify(w.phases?.wfGraph?.reason)})`],
    [wf.start?.kind === 'graph' && wf.end?.status === 'completed' && wf.end?.members === WF_GRAPH.nodes.length, `workflow.start (graph) and workflow.end completed with ${WF_GRAPH.nodes.length} members (got ${JSON.stringify(wf.end && { status: wf.end.status, members: wf.end.members })})`],
    ...workflowChildren(w, WF_GRAPH.nodes.map(n => n.id)),
    [order.every(([dep, node]) => seqOf(dep, wf.ends) < seqOf(node, wf.starts)), `every node started after its dependencies ended (${order.map(([d, n]) => `${d}→${n}`).join(', ')})`],
    [(w.architectures ?? []).length === 1 && textOf(resultOf(w, 'call-wf-graph')).includes(`.nexgent/architectures/${w.architectures[0]}`), 'the graph was saved under .nexgent/architectures/ and the result names it'],
    [cycle?.isError === true && cycle.error?.code === 'tool/invalid-input' && /graph: .*cycle/.test(textOf(cycle)) && cycleNames.every(n => textOf(cycle).includes(n)), `the cyclic graph is refused with tool/invalid-input naming the cycle (got ${JSON.stringify(textOf(cycle).slice(0, 100))})`],
    [!rootOf(w).some(r => r.type === 'workflow.start' && r.toolCallId === 'call-wf-cycle') && cycleNames.every(n => childOf(w, n) === undefined), 'the cyclic graph started nothing'],
  ], `graph ${WF_GRAPH.nodes.map(n => n.id).join(' → ')} ran in dependency order and was saved; the cycle ${cycleNames.join('/')} was refused (tool/invalid-input) before anything ran`)
}

/** H09: after a kill mid-workflow and a resume, the completed member does not run again; unfinished ones are marked interrupted. */
function h09(obs) {
  const w = obs.workflow
  if (w === undefined) return missingPhase('workflow')
  const kill = w.phases?.wfKill ?? {}
  const wf = workflowOf(w, 'call-wf-kill')
  const early = wf.starts.find(r => r.name === 'early')
  const late = wf.starts.find(r => r.name === 'late')
  const endOf = start => wf.ends.find(r => r.childSessionId === start?.childSessionId)
  const killTurnEnd = rootOf(w).find(r => r.type === 'turn.end' && r.turn === wf.start?.turn)
  const rerun = (w.requests ?? []).filter(q => q.phase === 'wfResume' && q.route !== null)
  const conditions = [
    [kill.ready === true && kill.streaming === true && kill.mainAlive === false, `the driver was killed while late was streaming (ready ${kill.ready}, streaming ${kill.streaming}, alive after kill ${kill.mainAlive})`],
    [kill.settled === true && (kill.survivors ?? ['?']).length === 0, `no process of the killed driver survived (survivors: ${JSON.stringify(kill.survivors)})`],
    [wf.start !== undefined && early !== undefined && endOf(early)?.result?.status === 'completed', 'early completed before the kill'],
    [late !== undefined && endOf(late)?.result?.status !== 'completed', 'late had started and not completed'],
    [killTurnEnd?.reason?.kind === 'interrupted', `the root closes the killed turn as interrupted on resume (got ${JSON.stringify(killTurnEnd?.reason)})`],
    [rerun.length === 0 && w.phases?.wfResume?.reason?.kind === 'completed', `the resume turn completed and no member ran again (member requests after resume: ${rerun.map(q => q.route).join(', ')})`],
    [endOf(late) === undefined || endOf(late).result?.status === 'interrupted', `late's subagent.end, if written, says interrupted (got ${String(endOf(late)?.result?.status)})`],
    [wf.end === undefined || wf.end.status === 'interrupted', `workflow.end, if written, says interrupted (got ${String(wf.end?.status)})`],
  ]
  const checked = 'killed mid-workflow with no surviving process; early completed and did not run again; root turn closed interrupted; resume completed'
  if (endOf(late) === undefined || wf.end === undefined) return partial(conditions, 'unfinished members and the workflow are not marked interrupted yet: the host does not call recoverWorkflows (W6)', checked)
  return verdict(conditions, `${checked}; late and the workflow marked interrupted`)
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
export const JUDGES = { H01: h01, H02: h02, H03: h03, H04: h04, H07: h07, H08: h08, H09: h09, H10: h10, H12: h12, H15: h15, H16: h16, H17: h17, H18: h18, H19: h19, H22: h22, H23: h23 }

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
