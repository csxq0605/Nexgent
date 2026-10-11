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
export const JUDGES = { H01: h01, H10: h10, H22: h22, H23: h23 }

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
