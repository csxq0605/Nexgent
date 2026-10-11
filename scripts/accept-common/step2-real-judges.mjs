/**
 * The R judges of accept-step2: each decides one real-model checklist item
 * from the observations step2-real.mjs collected. Pure, like the H and D
 * judges; tested against a scripted run and broken copies of it
 * (packages/test-support/tests/accept-step2-real.spec.ts).
 */
import { partial, verdict } from './step2-judges.mjs'

const isKind = (reason, kind) => reason?.kind === kind
const events = (obs, phase) => obs.phases?.[phase]?.events ?? []
const calls = (obs, phases) => phases.flatMap((phase) => {
  const list = events(obs, phase)
  const results = new Map(list.filter(e => e.type === 'tool.result').map(e => [e.callId, e]))
  return list.filter(e => e.type === 'tool.start').map((start) => {
    let args = {}
    try {
      args = JSON.parse(start.arguments)
    } catch {
      args = {}
    }
    const result = results.get(start.callId)
    return { phase, name: start.name, path: args.path, ok: result !== undefined && result.isError === false }
  })
})
const ALL = ['first', 'feedback', 'resume']
const records = (obs, type) => (obs.records ?? []).filter(record => record.type === type)
const hasThinking = record => /"type":"(redacted_)?thinking"/.test(JSON.stringify(record.providerContent ?? null))

/** Add the scenario's error to a failing judge's evidence. */
function withScenario(obs, result) {
  if (result.status !== 'failed' || obs.error === undefined) return result
  return { ...result, evidence: `${result.evidence} (scenario stopped: ${String(obs.error).split('\n')[0]})` }
}

export const REAL_JUDGES = {
  R01(obs) {
    const hidden = obs.hidden ?? []
    const failedChecks = hidden.filter(check => !check.ok).map(check => check.name)
    const v1Ok = (obs.v1AtEnd ?? []).length > 0 && obs.v1AtEnd.every(file => file.actual === file.recorded)
      && JSON.stringify(obs.v1AtEnd) === JSON.stringify(obs.v1AtPresent)
    const versions = obs.deliverable?.versions ?? []
    return verdict([
      [hidden.length > 0 && failedChecks.length === 0, `hidden checks pass (failed: ${failedChecks.join('; ') || (hidden.length === 0 ? 'not run' : 'none')})`],
      [[1, 2, 3].every(v => versions.includes(v)), `the deliverable has v1, v2 and v3 (got ${JSON.stringify(versions)})`],
      [v1Ok, 'the v1 snapshot is unchanged since it was presented'],
    ], `hidden checks ${hidden.length}/${hidden.length} (values, columns, re-run in a fresh copy, README); versions ${JSON.stringify(versions)}; v1 snapshot unchanged`)
  },

  R02(obs) {
    const all = calls(obs, ALL)
    const existing = Object.keys(obs.phases?.feedback?.treeBefore ?? {})
    // The model may pass a path relative to the project or an absolute one inside it.
    const isExisting = (path) => {
      const p = String(path ?? '').replaceAll('\\', '/')
      return existing.some(file => p === file || p === `./${file}` || p.endsWith(`/${file}`))
    }
    const feedbackEdits = calls(obs, ['feedback']).filter(call => call.name === 'str_replace' && call.ok && isExisting(call.path))
    const shellEdits = calls(obs, ['feedback']).filter(call => (call.name === 'bash' || call.name === 'pwsh')).length
    return verdict([
      [all.some(call => call.name === 'write_file' && call.ok), 'at least one successful write_file'],
      [all.some(call => call.name === 'str_replace' && call.ok), 'at least one successful str_replace'],
      [feedbackEdits.length > 0, `the feedback round edits an existing file with str_replace (got ${feedbackEdits.map(c => c.path).join(', ') || 'none'})`],
    ], `write_file ${all.filter(c => c.name === 'write_file' && c.ok).length}, str_replace ${all.filter(c => c.name === 'str_replace' && c.ok).length}; feedback round str_replace on ${feedbackEdits.map(c => c.path).join(', ')} (shell calls in that round: ${shellEdits})`)
  },

  R03(obs) {
    const ledger = obs.ledger ?? []
    const taskStarts = ledger.filter(r => r.type === 'llm.request.start' && r.purpose === 'task')
    const resumeTurn = (obs.records ?? []).filter(r => r.type === 'turn.start').map(r => r.turn).at(-1)
    const history = records(obs, 'assistant.message').filter(r => r.turn !== resumeTurn)
    const bad = ledger.filter(r => r.type === 'llm.request.end' && r.httpStatus === 400)
    return verdict([
      [obs.config?.thinking === 'on' && taskStarts.length > 0 && taskStarts.every(r => r.thinking === 'on'), 'every task request asked for thinking'],
      [history.some(hasThinking), 'the session holds thinking blocks (providerContent) before the resume'],
      [isKind(obs.phases?.resume?.reason, 'completed'), 'the resumed turn completed'],
      [bad.length === 0, `no request was rejected with 400 (got ${bad.length})`],
    ], `${history.filter(hasThinking).length} assistant message(s) with thinking blocks replayed; resumed turn completed; no 400`)
  },

  R04(obs) {
    const kill = obs.phases?.kill ?? {}
    const killedId = kill.requestIds?.at(-1)
    const ledger = obs.ledger ?? []
    const start = ledger.find(r => r.type === 'llm.request.start' && r.requestId === killedId)
    const end = ledger.find(r => r.type === 'llm.request.end' && r.requestId === killedId)
    const openTurn = obs.phases?.resume?.openTurnBefore
    const closed = records(obs, 'turn.end').find(r => r.turn === openTurn)
    return verdict([
      [kill.streamed === true && kill.finishedBeforeKill === false, 'the process was killed while the model was streaming'],
      [kill.exit?.signal !== null || (kill.exit?.code ?? 0) !== 0, 'the process died from the kill'],
      [start !== undefined && (end === undefined || end.status === 'unknown'), `the killed request is in the ledger without a settled end (${killedId})`],
      [(obs.usage?.unknownRequestIds ?? []).includes(killedId), 'its usage is counted as unknown'],
      [typeof openTurn === 'number' && isKind(closed?.reason, 'interrupted'), 'the killed turn is closed as interrupted on resume'],
      [isKind(obs.phases?.resume?.reason, 'completed') && (obs.deliverable?.versions ?? []).includes(3), 'the new process finished the work (v3)'],
    ], `killed mid-stream in request ${killedId}; ledger start without end, usage unknown; turn ${openTurn} interrupted; resumed and presented v3`)
  },

  R05(obs) {
    const presented = records(obs, 'deliverable.presented')
    const feedback = records(obs, 'feedback')
    return verdict([
      [(obs.materials ?? []).length === 2, 'two materials added'],
      [presented.length >= 3, `present happened for v1, v2, v3 (got ${presented.length})`],
      [feedback.length === 1 && feedback[0].feedback?.version === 1, 'feedback on v1 recorded'],
      [(obs.deliverable?.versions ?? []).includes(2), 'v2 exists'],
      [obs.phases?.kill?.streamed === true, 'the kill happened'],
      [isKind(obs.phases?.resume?.reason, 'completed'), 'the resume happened and completed'],
    ], 'materials, present, feedback, v2, kill and resume all happened')
  },

  R06(obs) {
    if (obs.platform !== 'win32') return { status: 'not-implemented', evidence: `optional; runs only on Windows (this run: ${obs.platform})` }
    const shells = calls(obs, ALL).filter(call => call.name === 'bash' || call.name === 'pwsh').map(call => call.name)
    const results = ['R01', 'R02', 'R03', 'R04', 'R05'].map(id => [id, REAL_JUDGES[id](obs).status])
    return verdict([
      [results.every(([, status]) => status === 'passed'), `R01–R05 pass on Windows (${results.map(([id, s]) => `${id} ${s}`).join(', ')})`],
      [shells.length > 0 && shells.every(name => name === 'pwsh'), `the shell tool is pwsh (got ${[...new Set(shells)].join(', ') || 'none'})`],
    ], 'Windows: R01–R05 pass; shell tool pwsh')
  },

  R07(obs) {
    const usage = obs.usage
    const killed = new Set(obs.phases?.kill?.requestIds ?? [])
    const strayUnknown = (usage?.unknownRequestIds ?? []).filter(id => !killed.has(id))
    if (obs.realModel !== true && usage !== undefined && strayUnknown.length === 0 && typeof obs.runCapUsd === 'number' && usage.costUsd <= obs.runCapUsd && obs.stoppedForCost === undefined) {
      return partial([], 'not a real-model run (scripted stand-in)', `requests ${usage.callCount}, unknown ${usage.unknownCount}, estimate ${usage.costUsd} USD ≤ ${obs.runCapUsd} USD`)
    }
    return verdict([
      [usage !== undefined && usage.callCount > 0, 'requests were counted from the ledger'],
      [strayUnknown.length === 0, `only the killed request has unknown usage (also unknown: ${strayUnknown.join(', ') || 'none'})`],
      [typeof obs.runCapUsd === 'number' && typeof usage?.costUsd === 'number' && usage.costUsd <= obs.runCapUsd, `estimated cost ${usage?.costUsd} USD within the run cap ${obs.runCapUsd} USD`],
      [obs.stoppedForCost === undefined, 'the run was not stopped by the cost cap'],
      [obs.realModel === true, 'a real-model run'],
    ], `requests ${usage?.callCount}, tokens in ${usage?.known.input} / out ${usage?.known.output} / cache read ${usage?.known.cacheRead} / cache write ${usage?.known.cacheWrite}, unknown ${usage?.unknownCount}, estimate ${usage?.costUsd} USD ≤ ${obs.runCapUsd} USD`)
  },
}

/**
 * Judge one real-model item; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judgeReal(id, obs) {
  const fn = REAL_JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return withScenario(obs ?? {}, fn(obs ?? {}))
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
