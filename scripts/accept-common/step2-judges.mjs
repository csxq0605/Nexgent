/**
 * The H judges of accept-step2: each decides one checklist item from the
 * observations step2-headless.mjs collected. Judges are pure — they read
 * `obs` and the validators in `tools`, touch no files and start nothing —
 * so every judge is tested against a deliberately broken copy of a real run
 * (packages/test-support/tests/accept-step2-judges.spec.ts).
 *
 * `tools`: `validateSessionRecord`, `validateLedgerRecord`,
 * `validateMaterialMetadata`, `validateDeliverableVersion` (@nexgent/session,
 * each returning an issue list), `requestText`, `isAuxiliaryRequest`
 * (@nexgent/test-support).
 *
 * A judge returns `{ status, evidence }`: `passed` only when every condition
 * holds; `not-implemented` (via {@link partial}) when the item depends on
 * something that does not exist yet (its evidence still reports what could
 * be checked, and a defect found there is `failed`, never hidden).
 */
import { COMPACTION, FILES, MATERIALS, OFFICE_SKILL, STALL_TEXT, TASKS, outsideUserWordsText, userWordsSection } from './scenario-step2.mjs'

const SHELLS = new Set(['bash', 'pwsh'])

/** Evaluate `[ok, description]` conditions into a judge result. */
export function verdict(conditions, passEvidence) {
  const failed = conditions.filter(([ok]) => !ok).map(([, description]) => description)
  return failed.length === 0
    ? { status: 'passed', evidence: passEvidence }
    : { status: 'failed', evidence: `not satisfied: ${failed.join('; ')}` }
}

/** Like {@link verdict}, but a full pass is still `not-implemented` because of `missing`. */
export function partial(conditions, missing, checked) {
  const result = verdict(conditions, checked)
  return result.status === 'passed' ? { status: 'not-implemented', evidence: `${missing}; checked so far: ${checked}` } : result
}

const phase = (obs, name) => obs.phases?.[name] ?? {}
const events = (obs, name, type) => (phase(obs, name).events ?? []).filter(event => event.type === type)
const turnOf = (obs, name) => events(obs, name, 'turn.start')[0]?.turn
const recordsOf = (obs, turn, type) => (obs.records ?? []).filter(record => record.turn === turn && (type === undefined || record.type === type))
const isKind = (reason, kind, cause) => reason?.kind === kind && (cause === undefined || reason.cause === cause)

/** Tool calls of a phase with their results: `{ name, arguments, isError, content }`. */
export function toolCalls(obs, name) {
  const results = new Map(events(obs, name, 'tool.result').map(event => [event.callId, event]))
  return events(obs, name, 'tool.start').map((start) => {
    const result = results.get(start.callId)
    let args = {}
    try {
      args = typeof start.arguments === 'string' ? JSON.parse(start.arguments) : (start.arguments ?? {})
    } catch {
      args = {}
    }
    return { name: start.name, arguments: args, isError: result?.isError, content: result?.content ?? '', hasResult: result !== undefined }
  })
}

const succeeded = (calls, name) => calls.filter(call => call.name === name && call.hasResult && call.isError === false)
const systemText = (tools, body) => tools.requestText({ system: body?.system })

const userWordsOf = (tools, body) => userWordsSection(tools.requestText, body)
const outsideUserWords = (tools, body) => outsideUserWordsText(tools.requestText, body)

export const JUDGES = {
  H01(obs) {
    const layout = obs.init?.layout ?? {}
    return verdict([
      [obs.init?.configExists === true, '.nexgent/config.json exists'],
      [['sessions', 'materials', 'outputs', 'ledgers'].every(name => layout[name] === true), `layout directories in the data dir ${obs.init?.dataDir} (${JSON.stringify(layout)})`],
      [Array.isArray(obs.init?.strayInProject) && obs.init.strayInProject.length === 0, `<root>/.nexgent holds no per-project data (${JSON.stringify(obs.init?.strayInProject)})`],
      [(obs.init?.recent ?? []).includes(obs.init?.realRoot), `projects.recent lists the project (${JSON.stringify(obs.init?.recent)})`],
    ], `layout and config.json present; projects.recent lists ${obs.init?.realRoot}`)
  },

  H02(obs, tools) {
    const materials = obs.materials ?? []
    const kinds = materials.map(m => m.kind).sort().join(',')
    const conditions = [[kinds === 'csv,xlsx', `one .csv and one .xlsx material (got ${kinds || 'none'})`]]
    for (const m of materials) {
      const issues = tools.validateMaterialMetadata(m.meta)
      const name = m.meta?.originalName
      conditions.push(
        [issues.length === 0, `${name}: metadata passes the schema (${issues.map(i => `${i.path}: ${i.message}`).join('; ')})`],
        [typeof m.meta?.path === 'string' && m.meta.path.startsWith(`.nexgent/materials/${m.meta.id}/`), `${name}: copied under materials/<id>/ (${m.meta?.path})`],
        [m.copySha !== null && m.copySha === m.meta?.sha256 && m.copySha === m.sourceShaBefore, `${name}: copy, metadata and source SHA-256 agree`],
        [m.sourceShaAfter === m.sourceShaBefore, `${name}: original file unchanged`],
      )
    }
    return verdict(conditions, materials.map(m => `${m.meta?.originalName} → ${m.meta?.path} (sha256 ${String(m.meta?.sha256).slice(0, 12)}…)`).join('; '))
  },

  H03(obs, tools) {
    const first = phase(obs, 'first').requests?.[0]
    const text = tools.requestText(first ?? {})
    // The record keeps the logical path `.nexgent/materials/<id>/<name>`; the model is shown the absolute copy in the data dir.
    const paths = (obs.materials ?? []).map(m => m.meta.path)
    const tails = paths.map(path => path.replace(/^\.nexgent\//, ''))
    const flat = text.replace(/\\+/g, '/')
    const refused = toolCalls(obs, 'first').filter(call => call.name === 'write_file' && /materials[\\/]/.test(String(call.arguments.path ?? '')))
    return verdict([
      [first !== undefined, 'a first request was made'],
      [paths.length === 2 && tails.every(tail => flat.includes(tail)), 'the first request references both materials by path (data-dir copies)'],
      [refused.length > 0, 'the model tried to write into materials/'],
      [refused.every(call => call.isError === true && /SANDBOX_DENIED|denied|write-prot/i.test(call.content)), 'every write into materials/ was refused'],
      [(obs.materials ?? []).every(m => m.copySha === m.meta.sha256), 'material copies unchanged'],
    ], `first request carries ${paths.length} material paths; materials/ write refused: ${refused[0]?.content.slice(0, 80)}`)
  },

  H04(obs) {
    const calls = toolCalls(obs, 'first')
    const skill = succeeded(calls, 'load_skill').filter(call => call.arguments.name === OFFICE_SKILL)
    const read = succeeded(calls, 'read_document').filter(call => String(call.arguments.path ?? '').endsWith(MATERIALS.xlsx))
    return verdict([
      [skill.length > 0, `load_skill(${OFFICE_SKILL}) succeeded`],
      [read.length > 0, `read_document on ${MATERIALS.xlsx} succeeded`],
      [read.some(call => /## Sheet:/.test(call.content)), 'read_document returned sheet content'],
    ], `load_skill(${OFFICE_SKILL}) and read_document(${MATERIALS.xlsx}) → ${read[0]?.content.split('\n')[0]}`)
  },

  H05(obs, tools) {
    const first = phase(obs, 'first').requests?.[0]
    return verdict([
      [first !== undefined && systemText(tools, first).includes('AGENTS-MD-MARKER'), 'AGENTS.md content in the first request\'s system prompt'],
    ], 'AGENTS.md marker found in the system prompt')
  },

  H06(obs) {
    const calls = toolCalls(obs, 'first')
    return verdict([
      [isKind(phase(obs, 'first').reason, 'completed'), `first turn completed (got ${JSON.stringify(phase(obs, 'first').reason)})`],
      [succeeded(calls, 'write_file').length > 0, 'a successful write_file'],
      [succeeded(calls, 'str_replace').length > 0, 'a successful str_replace'],
    ], `completed; write_file ×${succeeded(calls, 'write_file').length}, str_replace ×${succeeded(calls, 'str_replace').length}`)
  },

  H07(obs, tools) {
    const turn = turnOf(obs, 'first')
    const presented = recordsOf(obs, turn, 'deliverable.presented')
    const v1 = obs.deliverableAfterFirst?.versions?.[0]
    const issues = v1 === undefined ? [] : tools.validateDeliverableVersion(v1)
    const files = obs.v1Files ?? []
    return verdict([
      [presented.length === 1, `one deliverable.presented in the first turn (got ${presented.length})`],
      [v1?.version === 1, 'the deliverable has version 1'],
      [v1 !== undefined && issues.length === 0, `deliverable metadata passes the schema (${issues.map(i => `${i.path}: ${i.message}`).join('; ')})`],
      [files.length > 0 && files.every(file => file.afterV1 !== null && file.afterV1 === file.recorded), 'every outputs/<id>/v1/ snapshot hashes to its recorded SHA-256'],
    ], `v1 of ${v1?.deliverableId} with ${files.length} file(s); snapshot hashes match`)
  },

  H08(obs) {
    const turn = turnOf(obs, 'first')
    const record = recordsOf(obs, turn, 'turn.files')[0]
    const before = phase(obs, 'first').treeBefore ?? {}
    const after = phase(obs, 'first').treeAfter ?? {}
    const actual = []
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(path in before)) actual.push(`${path}:added`)
      else if (!(path in after)) actual.push(`${path}:deleted`)
      else if (before[path] !== after[path]) actual.push(`${path}:modified`)
    }
    const recorded = (record?.changes ?? []).map(change => `${change.path}:${change.change}`)
    const same = actual.length === recorded.length && actual.every(entry => recorded.includes(entry))
    return verdict([
      [record !== undefined, 'a turn.files record for the first turn'],
      [same, `turn.files ${JSON.stringify(recorded.sort())} equals the actual changes ${JSON.stringify(actual.sort())}`],
      [recorded.some(entry => entry.startsWith(`${FILES.shellNote.path}:`)), `the shell-written ${FILES.shellNote.path} is listed`],
    ], `turn.files = actual changes: ${recorded.join(', ')}`)
  },

  H09(obs) {
    const turn = turnOf(obs, 'feedback')
    const feedback = recordsOf(obs, turn, 'feedback')[0]?.feedback
    const message = recordsOf(obs, turn, 'user.message').find(record => record.source === 'feedback')
    const v1 = obs.deliverableAfterFirst?.versions?.[0]
    return verdict([
      [feedback !== undefined, 'a feedback record in the feedback turn'],
      [feedback?.deliverableId === v1?.deliverableId && feedback?.version === 1, 'the feedback is linked to v1'],
      [typeof feedback?.rating === 'number' && feedback.comment === TASKS.feedback, 'the feedback carries the rating and the comment'],
      [message !== undefined && String(message.content).includes(TASKS.feedback), 'a user message with source: feedback carrying the comment'],
    ], `feedback ${feedback?.id} on v1 (rating ${feedback?.rating}) and its source: feedback user message`)
  },

  H10(obs) {
    const versions = obs.deliverableAfterFeedback?.versions ?? []
    const files = obs.v1Files ?? []
    const changed = (obs.diff?.files ?? []).filter(file => file.change !== 'unchanged').map(file => file.path)
    const expected = [FILES.summary.path]
    return verdict([
      [versions.map(v => v.version).join(',') === '1,2', `the deliverable has v1 and v2 (got ${versions.map(v => v.version).join(',') || 'none'})`],
      [versions.length === 2 && versions[1].deliverableId === versions[0].deliverableId, 'v2 belongs to the same deliverable'],
      [files.length > 0 && files.every(file => file.atEnd === file.recorded), 'v1 snapshot hashes unchanged after v2'],
      [changed.length > 0, `the v1→v2 diff is non-empty${obs.diffError === undefined ? '' : ` (${obs.diffError})`}`],
      [changed.every(path => expected.includes(path)), `the diff touches only ${expected.join(', ')} (got ${changed.join(', ')})`],
    ], `v1 → v2 diff touches ${changed.join(', ')}; v1 snapshots unchanged`)
  },

  H11(obs, tools) {
    const set = (obs.records ?? []).find(record => record.type === 'goal.set')
    const update = (obs.records ?? []).find(record => record.type === 'goal.update')
    const request = phase(obs, 'goal').requests?.[0]
    return verdict([
      [set?.goal?.text === TASKS.goalText && set.goal.status === 'active', 'a goal.set record with the goal, active'],
      // K2: the goal is injected as a message before the turn's own message, not part of the system prompt.
      [request !== undefined && tools.requestText({ messages: request.messages }).includes(TASKS.goalText), 'the active goal is in the next request\'s messages'],
      [update?.goalId === set?.goal?.id && update?.status === 'completed', 'a goal.update record marking it completed'],
      [obs.goalAtEnd?.status === 'completed', 'the stored goal is completed'],
    ], `goal ${set?.goal?.id} set, shown to the model, then completed`)
  },

  H12(obs) {
    const stream = phase(obs, 'cancelStream')
    const tool = phase(obs, 'cancelTool')
    const kept = recordsOf(obs, turnOf(obs, 'cancelStream'), 'assistant.message').some(record => JSON.stringify(record).includes(STALL_TEXT.cancel))
    return verdict([
      [isKind(stream.reason, 'cancelled', 'user'), `mid-stream cancel ends cancelled (got ${JSON.stringify(stream.reason)})`],
      [String(stream.streamed ?? '').includes(STALL_TEXT.cancel), 'text was streamed before the cancel'],
      [kept, 'the streamed text is kept in the session'],
      [isKind(tool.reason, 'cancelled', 'user'), `mid-tool cancel ends cancelled (got ${JSON.stringify(tool.reason)})`],
      [(tool.descendantsBefore ?? []).length > 0, 'the shell command was running (descendants seen)'],
      [(tool.survivors ?? ['?']).length === 0, `no descendant survives the cancel (survivors ${JSON.stringify(tool.survivors)})`],
    ], `stream cancel keeps "${STALL_TEXT.cancel}"; tool cancel killed ${tool.descendantsBefore?.length} process(es), none left`)
  },

  H13(obs) {
    const calls = toolCalls(obs, 'approvals')
    const outside = calls.filter(call => call.name === 'write_file' && call.arguments.path === FILES.outside.path)
    const asked = (obs.approvals?.log ?? []).filter(entry => entry.summary.includes('outside-the-project'))
    // ADR 0022 decision 2: a path outside the project asks (medium risk, once or this directory for the session); the user said no.
    return verdict([
      [outside.length === 1, 'the model tried one write outside the project'],
      [asked.length === 1 && asked[0].risk === 'medium' && JSON.stringify(asked[0].options) === '["once","session"]' && /\/\*\*$/.test(asked[0].pattern ?? ''), `one approval was requested for it, offering once or the directory for the session (got ${JSON.stringify(asked)})`],
      [asked[0]?.decision === 'deny', 'the user denied it'],
      [outside.every(call => call.isError === true && /not approved/.test(call.content)), 'the tool result says it was not approved'],
      [obs.approvals?.outsideExists === false, 'nothing was written outside the project'],
    ], `outside write asked, denied, nothing written: ${outside[0]?.content.slice(0, 80)}`)
  },

  H14(obs, tools) {
    const ok = phase(obs, 'compact')
    const fail = phase(obs, 'compactFail')
    const compaction = recordsOf(obs, turnOf(obs, 'compact'), 'compaction')
    const failure = recordsOf(obs, turnOf(obs, 'compactFail'), 'error')
    const [, summaryRequest, nextRequest] = ok.requests ?? []
    const [, , afterFailure] = fail.requests ?? []
    return verdict([
      [compaction.length === 1, `one compaction record (got ${compaction.length})`],
      [summaryRequest !== undefined && tools.isAuxiliaryRequest(summaryRequest), 'the summary request carries no tools'],
      [nextRequest !== undefined && tools.requestText(nextRequest).includes(COMPACTION.summary) && !outsideUserWords(tools, nextRequest).includes(TASKS.first), 'the next request carries the summary and not the early turns'],
      [nextRequest !== undefined && userWordsOf(tools, nextRequest).includes(TASKS.first), "the user's early words are kept verbatim after the summary"],
      [isKind(ok.reason, 'completed'), 'the compacting turn completed'],
      [failure.some(record => record.fatal === false && /compaction failed/.test(record.error?.message ?? '')), 'a failed summary request is a non-fatal error record'],
      [afterFailure !== undefined && tools.requestText(afterFailure).includes(TASKS.first), 'after the failure the request carries the full history'],
      [isKind(fail.reason, 'completed'), 'the turn with the failed compaction still completed'],
    ], 'compaction recorded, next request = summary + recent turns; a failed summary request leaves the history whole and the turn completes')
  },

  H15(obs) {
    const kill = phase(obs, 'streamKill')
    return verdict([
      [kill.sawText === true, 'the model was streaming when the kill came'],
      [kill.exit?.signal !== null || (kill.exit?.code ?? 0) !== 0, 'the process died from the kill'],
      [kill.mainAlive === false, 'the main process is gone'],
      [(kill.survivors ?? ['?']).length === 0, `the whole tree is gone (survivors ${JSON.stringify(kill.survivors)})`],
    ], `killed mid-stream (${JSON.stringify(kill.exit)}), no process left`)
  },

  H16(obs) {
    const crash = phase(obs, 'toolKill').crash ?? {}
    const turn = phase(obs, 'resumeAfterTool').openTurnBefore
    const conditions = [
      [SHELLS.has(crash.tool), `a shell tool was running (got ${crash.tool})`],
      [crash.exit?.signal !== null || (crash.exit?.code ?? 0) !== 0, 'the process died from the kill'],
      [(crash.descendantsBefore ?? []).length > 0, 'the tool had started its command'],
      [turn !== undefined && (phase(obs, 'resumeAfterTool').toolResultsBefore ?? recordsOf(obs, turn, 'tool.result').length) === 0, 'the killed turn has no tool result (as the kill left it)'],
    ]
    // Windows: libuv's kill-on-close job takes a Node process's children with it.
    if (obs.platform === 'win32') conditions.push([(crash.survivors ?? ['?']).length === 0, `no orphan on Windows (survivors ${JSON.stringify(crash.survivors)})`])
    return verdict(conditions, `killed during ${crash.tool}; orphans ${JSON.stringify(crash.survivors)}${obs.platform === 'win32' ? '' : ' (POSIX: reported, then removed)'}`)
  },

  H17(obs, tools) {
    const conditions = []
    for (const name of ['resumeAfterStream', 'resumeAfterTool']) {
      const p = phase(obs, name)
      const end = (obs.records ?? []).find(record => record.type === 'turn.end' && record.turn === p.openTurnBefore)
      const request = p.requests?.[0]
      const thinking = (request?.messages ?? []).some(message => message.role === 'assistant' && Array.isArray(message.content)
        && message.content.some(block => block.type === 'thinking' && String(block.signature ?? '').startsWith('scripted-signature-')))
      const text = request === undefined ? '' : tools.requestText(request)
      conditions.push(
        [typeof p.openTurnBefore === 'number', `${name}: the killed turn was left open`],
        [isKind(end?.reason, 'interrupted'), `${name}: the killed turn is closed as interrupted`],
        [text.includes(COMPACTION.summary) && text.includes(TASKS.approvals), `${name}: the request carries the history (summary and later turns)`],
        [thinking, `${name}: the request replays the earlier thinking block (providerContent)`],
        [isKind(p.reason, 'completed'), `${name}: the resumed turn completed`],
      )
    }
    return verdict(conditions, `turns ${phase(obs, 'resumeAfterStream').openTurnBefore} and ${phase(obs, 'resumeAfterTool').openTurnBefore} interrupted; resumed requests carry history and replay thinking blocks`)
  },

  H18(obs) {
    const before = obs.viewBeforeKills
    const after = obs.viewAfterKills
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const prefix = before !== undefined && after !== undefined && same(after.items.slice(0, before.items.length), before.items)
    const userTexts = (after?.items ?? []).filter(item => item.kind === 'user').map(item => item.text)
    return verdict([
      [before !== undefined && after !== undefined, 'SDK views before and after the kills'],
      [prefix, 'the history after the kills starts with the whole history before them'],
      [userTexts.includes(TASKS.resumeAfterStream) && userTexts.includes(TASKS.resumeAfterTool), 'the resumed turns are in the history'],
      [(after?.materials ?? []).length === 2 && same(after?.materials, before?.materials), 'both materials, unchanged'],
      [same(after?.deliverables, before?.deliverables) && after?.deliverables?.[0]?.versions?.length === 2, 'v1 and v2, unchanged'],
      [(after?.feedback ?? []).length === 1 && same(after?.feedback, before?.feedback), 'the feedback, unchanged'],
      [after?.goal?.status === 'completed' && same(after?.goal, before?.goal), 'the goal, unchanged'],
    ], `through the SDK after two kills: ${after?.items?.length} history items (${before?.items?.length} before, kept), 2 materials, v1/v2, 1 feedback, goal completed`)
  },

  H19(obs, tools) {
    const records = obs.records ?? []
    const seqOk = records.every((record, index) => record.seq === index + 1)
    const badRecords = records.map(record => [record, tools.validateSessionRecord(record)]).filter(([, issues]) => issues.length > 0)
    const ledger = obs.ledger ?? []
    const badLedger = ledger.map(record => [record, tools.validateLedgerRecord(record)]).filter(([, issues]) => issues.length > 0)
    const starts = new Set(ledger.filter(r => r.type === 'llm.request.start').map(r => r.requestId))
    const ends = new Set(ledger.filter(r => r.type === 'llm.request.end').map(r => r.requestId))
    const killed = new Set(phase(obs, 'streamKill').requestIds ?? [])
    const openStarts = [...starts].filter(id => !ends.has(id))
    const orphanEnds = [...ends].filter(id => !starts.has(id))
    const outcomes = ledger.filter(r => r.type === 'task.outcome' && r.sessionId === obs.sessionId).length
    // One task.outcome per turn that ended in a live process; a killed turn (closed as interrupted on resume) has none.
    const finished = records.filter(r => r.type === 'turn.end' && r.reason?.kind !== 'interrupted').length
    const describe = list => list.slice(0, 3).map(([record, issues]) => `${record.type}#${record.seq ?? ''}: ${issues.map(i => `${i.path} ${i.message}`).join(', ')}`).join('; ')
    return verdict([
      [records.length > 0 && seqOk, 'session seq is 1..n without gaps'],
      [badRecords.length === 0, `every session record passes the schema (${describe(badRecords)})`],
      [obs.recordsTruncated === null || obs.recordsTruncated === undefined, 'the session file has no torn tail'],
      [badLedger.length === 0, `every ledger record passes the schema (${describe(badLedger)})`],
      [openStarts.every(id => killed.has(id)), `every request start has an end, except the one killed mid-stream (open: ${openStarts.join(', ')})`],
      [orphanEnds.length === 0, 'no request end without a start'],
      [outcomes === finished && finished > 0, `one task.outcome per finished turn (${outcomes} outcomes, ${finished} turns)`],
    ], `${records.length} records, seq continuous, schema ok; ${starts.size} requests paired except ${openStarts.length} killed; ${outcomes} task.outcome for ${finished} finished turns`)
  },

  H20(obs) {
    const hits = obs.secretHits ?? ['?']
    const exportHits = obs.exportSecretHits ?? ['?']
    return verdict([
      [hits.length === 0, `no file under .nexgent/ or the data dir contains the test key (${hits.join(', ')})`],
      [Object.keys(obs.export?.files ?? {}).length > 0, 'there is an export to search'],
      [exportHits.length === 0, `no export file contains the test key (${exportHits.join(', ')})`],
    ], `test key found in none of .nexgent/, the data dir and the ${Object.keys(obs.export?.files ?? {}).length} export files`)
  },

  H21(obs) {
    const budget = obs.budget ?? {}
    const [first, second] = budget.turns ?? []
    const error = (second?.records ?? []).find(record => record.type === 'error')
    const outcome = (budget.ledger ?? []).find(record => record.type === 'task.outcome' && record.sessionId === second?.sessionId)
    return verdict([
      [isKind(first?.reason, 'completed'), 'the first session\'s turn completed'],
      [isKind(second?.reason, 'cancelled', 'cost-cap'), `the second session ends cancelled by cost-cap (got ${JSON.stringify(second?.reason)})`],
      [(budget.requests ?? []).length === 1, `no request after the cap (requests ${(budget.requests ?? []).length})`],
      [error?.error?.code === 'budget/exhausted' && error.fatal === false && error.error.details?.scope === 'project', 'a non-fatal budget/exhausted error record with scope project'],
      [outcome?.error?.code === 'budget/exhausted', 'the ledger task.outcome carries budget/exhausted'],
    ], 'perProject cap of 1 request: second session stopped before any request, budget/exhausted in session and ledger')
  },

  H22(obs) {
    const exp = obs.export ?? {}
    const files = exp.files ?? {}
    const lines = text => String(text ?? '').split('\n').filter(line => line.trim() !== '')
    const parse = text => { try { return JSON.parse(text) } catch { return undefined } }
    const sessionLines = lines(files['session.jsonl']).map(parse)
    const ledgerLines = lines(files['ledger.jsonl']).map(parse)
    const ownLedger = (obs.ledger ?? []).filter(record => record.sessionId === obs.sessionId)
    const materials = parse(files['materials.json'] ?? '')
    const versions = parse(files['deliverables.json'] ?? '')
    const manifest = parse(files['manifest.json'] ?? '')
    return verdict([
      [exp.code === 0, `nexgent export exited 0 (got ${exp.code}; ${String(exp.stderr ?? '').slice(0, 120)})`],
      [sessionLines.length === (obs.records ?? []).length && sessionLines.every((record, index) => record?.seq === obs.records[index].seq), `session.jsonl holds the session (${sessionLines.length} of ${(obs.records ?? []).length} records)`],
      [ledgerLines.length === ownLedger.length && ledgerLines.length > 0 && ledgerLines.every(record => record?.sessionId === obs.sessionId), `ledger.jsonl holds this session's ledger lines only (${ledgerLines.length} of ${ownLedger.length})`],
      [Array.isArray(materials) && materials.length === (obs.materials ?? []).length, 'materials.json lists the materials'],
      [Array.isArray(versions) && versions.map(v => v.version).sort().join(',') === '1,2', 'deliverables.json lists v1 and v2'],
      [manifest?.sessionId === obs.sessionId, 'manifest.json names the session'],
    ], `export: ${sessionLines.length} session records, ${ledgerLines.length} ledger lines, ${materials?.length} materials, ${versions?.length} versions, manifest`)
  },

  H23(obs) {
    const calls = toolCalls(obs, 'approvals')
    const log = (obs.approvals?.log ?? []).filter(entry => entry.summary.includes(FILES.env.path))
    const turn = turnOf(obs, 'approvals')
    return verdict([
      [log.length === 2 && (obs.approvals?.log ?? []).filter(entry => !entry.summary.includes('outside-the-project')).length === 2, `exactly two approval requests besides the outside write, both for ${FILES.env.path} (got ${(obs.approvals?.log ?? []).length})`],
      [log[0]?.decision === 'allow' && log[0]?.scope === 'once', 'the first is allowed once'],
      [log[1]?.decision === 'deny', 'the second write asks again (once is spent) and is denied'],
      [obs.approvals?.envContent === FILES.env.allowed, `${FILES.env.path} holds only the allowed write`],
      [calls.filter(call => call.name === 'write_file' && call.arguments.path === FILES.env.path).map(call => call.isError).join(',') === 'false,true', 'the denied write returns an error result'],
      [recordsOf(obs, turn, 'approval.request').length === 3 && recordsOf(obs, turn, 'approval.decision').length === 3, 'three approval.request and three approval.decision records (the outside write and two .env writes)'],
    ], `${FILES.env.path}: approval asked, allowed once, asked again, denied; file unchanged`)
  },
}

/**
 * Judge one item; a judge that throws is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judge(id, obs, tools) {
  const fn = JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return fn(obs, tools)
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
