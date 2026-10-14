/**
 * Judges of accept-step5's headless items H01–H18 (docs/plan/step-5-work-partition.md
 * §`accept-step5` 检查项清单). Pure functions over the observations of the step-5 headless
 * scenario (step5-headless.mjs), which runs `@nexgent/sdk` as shipped; counterexamples in
 * packages/test-support/tests/accept-step5-judges.spec.ts. H19 (step 4's regression) is
 * judged in step5-checks.mjs.
 *
 * Observation shape (the scenario maps the product's files and SDK answers onto it):
 *
 *   features.shipped         the SDK answers `improvements.list` (else every evolve item fails)
 *   trigger.counting         FEEDBACK in order; after each: { key, rating?, comment, feedbackId,
 *                            queue: pending feedback ids, counted: signal keys, jobs: [jobView] }
 *   trigger.checkFailure     { queueBefore, queueAfter, jobs, failedChecks, runs: { corrupt, failing,
 *                            explore, fixed: { reason, taskId, specs, results, added } } }
 *   trigger.disabled         { autoImprove: false, submitted, recorded, counted, jobs }
 *   trigger.explicit         { autoImprove: false, queueBefore, jobsBefore, via: 'sdk', error?, job, candidates }
 *   main                     the improvement job of the feedback project and what followed it:
 *                            job, isolation, requests, diagnoseSessions, feedbackChecks, feedbackSession,
 *                            taskSessions, listedSessions, resume, detail (improvements.show), listing,
 *                            current, diagnosis, evidence, decisions, trials, next, firstUse, ledger,
 *                            configAfter, integrity, export, feedbackTaskId
 *   disabled                 explicit runs with autoImprove off: invalid, none, two, stopped, refused
 *                            ({ job } or { code, error }), config hashes, budget, candidatesAdded
 *   waiting                  parked, statusAfterHistory, job, trials, decisions, feedbackChecks,
 *                            diagnoseSessions, after (the next task), activation
 *   concurrency, recovery    H15
 *   turns                    H16
 *   jobView                  { jobId, trigger, status, feedbackIds, history, detail, candidateId,
 *                            trialId, decisionId, sessions, phases, firstUse }
 *
 * Evidence of a pass names what was seen; an unknown result is not a pass.
 */
import { countsTowardImprovement, THRESHOLD } from '../real-task/step5-orders.mjs'
import { verdict } from './step2-judges.mjs'
import { CONVENTION_SKILL, MAST } from './step5-fixtures.mjs'

const NOT_SHIPPED = 'the SDK as shipped did not answer improvements.list'
const missing = what => ({ status: 'failed', evidence: `${what} was not observed` })
/** The four tools of a diagnose session (kernel `IMPROVEMENT_DIAGNOSIS_TOOLS`). */
export const DIAGNOSIS_TOOLS = ['improve_read_session', 'improve_read_ledger', 'improve_list_feedback', 'improve_report_diagnosis']
/** Tools that write or execute; none may be offered to a diagnose session. */
const WRITE_TOOLS = ['write_file', 'str_replace', 'bash', 'pwsh', 'present', 'capability_draft', 'capability_try', 'capability_propose', 'delegate', 'workflow']
const PHASES = ['diagnose', 'propose', 'trial']

const at = (obs, path) => path.split('.').reduce((value, key) => value?.[key], obs)

/** Wrap a judge over `path`: the SDK must ship the flow; a missing phase fails, naming the phase's error. */
const needs = (paths, fn) => (obs) => {
  if (obs?.features?.shipped !== true) return { status: 'failed', evidence: `${NOT_SHIPPED} (${obs?.features?.shippedNote ?? 'not probed'})` }
  for (const path of [].concat(paths)) {
    if (at(obs, path) !== undefined) continue
    const owner = { 'trigger.counting': 'main', recovery: 'concurrency' }[path]
    const phase = Object.keys(obs.errors ?? {}).find(name => name === owner || path.toLowerCase().includes(name.replace('-', '').toLowerCase()))
    return phase === undefined ? missing(path) : { status: 'failed', evidence: `${path}: phase ${phase} failed: ${String(obs.errors[phase]).split('\n')[0]}` }
  }
  const { conditions, evidence } = fn(...[].concat(paths).map(path => at(obs, path)), obs)
  return verdict(conditions, evidence)
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()
const feedbackKeys = keys => (keys ?? []).filter(key => key.startsWith('feedback:'))
const receiptsOf = main => main?.detail?.candidate?.receipts ?? []
const sum = values => values.reduce((total, value) => total + value, 0)

export const JUDGES = {
  // 计数触发：2 条计入的反馈不开始作业，第 3 条开始；不计入的反馈不加计数
  H01: needs('trigger.counting', (steps) => {
    const conditions = [[Array.isArray(steps) && steps.length > 0, 'no feedback was submitted']]
    const counted = []
    let started
    for (const [index, step] of (steps ?? []).entries()) {
      const counts = countsTowardImprovement(step)
      if (counts) counted.push(step.feedbackId)
      const jobs = step.jobs ?? []
      conditions.push([typeof step.feedbackId === 'string', `feedback ${step.key} has no id`])
      conditions.push([sameSet(feedbackKeys(step.counted), counted.map(id => `feedback:${id}`)), `after feedback ${step.key} the counted set is ${JSON.stringify(feedbackKeys(step.counted))}, expected ${counted.length} counted`])
      if (started === undefined && counted.length < THRESHOLD) {
        conditions.push([jobs.length === 0, `feedback ${step.key} (${index + 1}) started a job with ${counted.length} counted`])
        conditions.push([sameSet(step.queue ?? [], counted), `after feedback ${step.key} the queue holds ${JSON.stringify(step.queue)}, expected the counted ids ${JSON.stringify(counted)}`])
      } else if (started === undefined) {
        started = step
        conditions.push([jobs.length === 1, `feedback ${step.key}, the ${THRESHOLD}rd counted, started ${jobs.length} jobs, expected 1`])
        conditions.push([jobs[0]?.trigger === 'feedback-count', `the job's trigger is ${jobs[0]?.trigger}, expected feedback-count`])
        conditions.push([sameSet(jobs[0]?.feedbackIds ?? [], counted), `the job cites ${JSON.stringify(jobs[0]?.feedbackIds)}, expected ${JSON.stringify(counted)}`])
        conditions.push([(step.queue ?? []).length === 0, `the queue was not emptied when the job took the batch (${JSON.stringify(step.queue)})`])
      } else {
        conditions.push([jobs.length <= 1, `feedback ${step.key} after the job started another job`])
      }
    }
    conditions.push([started !== undefined, `no step reached ${THRESHOLD} counted feedbacks`])
    const uncounted = (steps ?? []).filter(step => !countsTowardImprovement(step)).length
    conditions.push([uncounted > 0, 'the phase had no uncounted feedback, so "does not count" was not tested'])
    return { conditions, evidence: `${counted.length} counted and ${uncounted} uncounted feedbacks; no job before the ${THRESHOLD}rd counted, one job (trigger feedback-count) at it citing exactly the counted ones, batch taken from the queue` }
  }),

  // 显式触发：“改进”动作在计数为 0 时立即开始作业；autoImprove 关时也能显式触发
  H02: needs('trigger.explicit', phase => ({
    conditions: [
      [phase.error === undefined && phase.via === 'sdk', `SDK improvements.run did not start a job: ${phase.error}`],
      [phase.autoImprove === false, 'autoImprove was not off during the explicit start'],
      [(phase.queueBefore ?? []).length === 0 && phase.jobsBefore === 0, `the queue was not empty or a job existed before (${JSON.stringify(phase.queueBefore)}, ${phase.jobsBefore} jobs)`],
      [phase.job?.trigger === 'explicit' && phase.job?.startedAs?.trigger === 'explicit', `the job's trigger is ${phase.job?.trigger}, expected explicit`],
      [(phase.job?.history ?? []).includes('diagnosing'), `the job never ran (history ${JSON.stringify(phase.job?.history)})`],
    ],
    evidence: `with autoImprove off and an empty queue, improvements.run on a deliverable started a job at once (trigger explicit), which ran: ${(phase.job?.history ?? []).join(' → ')}`,
  })),

  // 检查失败触发：根任务检查失败计一次（失败的测试命令也计入；探索性失败命令不计入）
  H03: needs('trigger.checkFailure', (phase) => {
    const runs = phase.runs ?? {}
    const tests = run => (run?.results ?? []).filter(result => result.name === 'test-command')
    const commands = run => (run?.specs ?? []).map(spec => String(spec.command ?? '')).filter(Boolean)
    const explored = run => commands(run).filter(command => !/^node --test checks\//.test(command))
    const signal = run => (run?.added ?? []).length === 1 && run.added[0] === `check:${run.taskId}:1`
    const before = phase.queueBefore ?? []
    const after = phase.queueAfter ?? []
    return {
      conditions: [
        [['corrupt', 'failing', 'explore', 'fixed'].every(key => runs[key]?.reason === 'completed'), `a task did not complete (${Object.entries(runs).map(([k, r]) => `${k} ${r?.reason}`).join(', ')})`],
        [tests(runs.corrupt).length === 1 && tests(runs.corrupt)[0].passed === false, 'the table broken after its passing test has no failed test check'],
        [signal(runs.corrupt), `the broken table counted ${JSON.stringify(runs.corrupt?.added)}, expected once (check:<taskId>:1)`],
        [tests(runs.failing).length === 1 && tests(runs.failing)[0].passed === false, 'the failing test run is not a failed test check (decision B)'],
        [signal(runs.failing), `the failing test run counted ${JSON.stringify(runs.failing?.added)}, expected once (decision B)`],
        [tests(runs.explore).length === 1 && tests(runs.explore)[0].passed === true, 'beside failing exploratory commands, the passing test is not the one passing test check'],
        [(runs.explore?.added ?? []).length === 0, `failing exploratory commands counted (${JSON.stringify(runs.explore?.added)})`],
        [explored(runs.explore).length === 0 && explored(runs.failing).length === 0, `an exploratory command became a check (${[...explored(runs.explore), ...explored(runs.failing)].join('; ')})`],
        [tests(runs.fixed).length === 1 && tests(runs.fixed)[0].passed === true && (runs.fixed?.added ?? []).length === 0, 'a test that failed and was fixed counted (the turn-end re-run decides)'],
        [after.length === before.length + 2 && before.every(key => after.includes(key)), `the queue went from ${before.length} to ${after.length}, expected +2`],
        [(phase.jobs ?? []).length === 0, 'a job started below the threshold'],
      ],
      evidence: 'a test passing then the file broken before present: one count; a failing test presented anyway: one count; failing exploratory commands beside a passing test: no count, not checks; a test failing then fixed: no count (re-run passes)',
    }
  }),

  // 开关：autoImprove 关时反馈照常记录，不开始作业
  H04: needs('trigger.disabled', phase => ({
    conditions: [
      [phase.autoImprove === false, 'autoImprove was not off'],
      [phase.submitted >= THRESHOLD, `only ${phase.submitted} feedbacks were submitted; the threshold is ${THRESHOLD}`],
      [phase.recorded === phase.submitted, `${phase.recorded} of ${phase.submitted} feedbacks were recorded`],
      [(phase.jobs ?? []).length === 0, `${(phase.jobs ?? []).length} jobs started with autoImprove off`],
    ],
    evidence: `autoImprove off: ${phase.recorded} feedbacks recorded (${feedbackKeys(phase.counted).length} counted), no job started`,
  })),

  // 诊断：合 schema（MAST 标签、证据指向真实记录、memberCosts 与账本一致）；不合 schema 3 次后 failed
  H05: needs(['main', 'disabled'], (main, disabled) => {
    const d = main.diagnosis
    const failures = d?.failureTypes ?? []
    const evidence = main.evidence ?? []
    const records = (main.ledger ?? []).filter(r => r.taskId === main.feedbackTaskId && r.trialId === undefined && r.improvementId === undefined)
    const requests = records.filter(r => r.type === 'llm.request.end')
    const cost = (d?.memberCosts ?? []).find(c => c.memberId === 'main')
    const invalid = disabled.invalid?.job
    const schemaIssues = (main.integrity?.issues ?? []).filter(issue => issue.includes('diagnosis.json'))
    return {
      conditions: [
        [d !== undefined && d.jobId === main.job?.jobId, 'the job wrote no diagnosis.json'],
        [schemaIssues.length === 0 && (main.integrity?.files?.diagnosis ?? 0) > 0, `the diagnosis fails the contract schema (${schemaIssues.join('; ')})`],
        [failures.length > 0 && failures.every(f => MAST.includes(f.category) && (f.evidence ?? []).length > 0), `failure types ${JSON.stringify(failures.map(f => f.category))} are not MAST categories with evidence`],
        [evidence.length > 0 && evidence.every(ref => ref.found && ref.turnMatches), `a cited record does not exist (${JSON.stringify(evidence.filter(ref => !ref.found || !ref.turnMatches))})`],
        [cost !== undefined && cost.requestCount === requests.length && cost.toolCallCount === records.filter(r => r.type === 'tool.call').length && cost.usage?.inputTokens === sum(requests.map(r => r.usage?.inputTokens ?? 0)) && cost.usage?.outputTokens === sum(requests.map(r => r.usage?.outputTokens ?? 0)), `memberCosts main ${JSON.stringify(cost && { requests: cost.requestCount, tools: cost.toolCallCount, input: cost.usage?.inputTokens })} differ from the ledger (${requests.length} requests, ${sum(requests.map(r => r.usage?.inputTokens ?? 0))} input tokens)`],
        [invalid?.status === 'failed' && /No acceptable diagnosis after 3 attempts/.test(invalid?.detail ?? ''), `a job whose reports were refused three times ended ${invalid?.status} (${invalid?.detail ?? disabled.invalid?.error})`],
        [disabled.invalid?.diagnosis === undefined && invalid?.candidateId === undefined && !(invalid?.history ?? []).includes('proposing'), 'the refused diagnosis left a diagnosis file, a candidate or a proposal'],
      ],
      evidence: `diagnosis: ${failures.map(f => f.category).join(', ')}, ${evidence.length} cited record(s) found, memberCosts main = ledger (${requests.length} requests, ${cost?.usage?.inputTokens} input tokens); three refused reports: failed (${invalid?.detail})`,
    }
  }),

  // 改进会话只读：写文件、执行命令类工具不在工具列表里；不出现在对话列表里
  H06: needs('main', (main) => {
    const sessions = main.diagnoseSessions ?? []
    const offered = [...new Set(sessions.flatMap(s => s.tools ?? []))]
    const ids = Object.values(main.job?.sessions ?? {})
    const listed = main.listedSessions ?? []
    return {
      conditions: [
        [sessions.length > 0, 'no diagnose session sent a request'],
        [offered.every(name => DIAGNOSIS_TOOLS.includes(name)) && offered.length === DIAGNOSIS_TOOLS.length, `the diagnose session offered ${offered.join(', ')}`],
        [!offered.some(name => WRITE_TOOLS.includes(name)), `a write or execute tool was offered (${offered.filter(name => WRITE_TOOLS.includes(name)).join(', ')})`],
        [ids.length >= 2 && ids.every(id => !listed.includes(id)), `an improvement session is in sessions.list (${ids.filter(id => listed.includes(id)).join(', ')})`],
        [(main.taskSessions ?? []).length > 0 && main.taskSessions.every(t => listed.includes(t.sessionId)), 'the user\'s task sessions are missing from sessions.list'],
        [Object.keys(main.resume ?? {}).length === ids.length && Object.values(main.resume ?? {}).every(r => r.code === 'tool/denied'), `resuming an improvement session was not refused (${JSON.stringify(main.resume)})`],
      ],
      evidence: `diagnose offered only ${offered.join(', ')}; the diagnose and propose sessions are not in sessions.list and resuming them is refused (tool/denied)`,
    }
  }),

  // 提案：恰好一个组件、合 schema；碰受保护字段、多于一个组件被拒；proposalKind: none 时 no-proposal
  H07: needs(['main', 'disabled', 'trigger.explicit'], (main, disabled, explicit) => {
    const record = main.detail?.candidate?.record
    const components = record?.components ?? []
    const files = components.flatMap(c => (c.files ?? []).map(f => f.path))
    const candidateIssues = (main.integrity?.issues ?? []).filter(issue => issue.startsWith('candidate '))
    const two = disabled.two?.job
    const none = disabled.none
    const broken = explicit.job
    return {
      conditions: [
        [components.length === 1 && components[0].kind === CONVENTION_SKILL.kind && components[0].name === CONVENTION_SKILL.name, `the candidate has ${JSON.stringify(components.map(c => `${c.kind}:${c.name}`))}, expected the one convention skill`],
        [record?.origin === 'improvement' && record?.jobId === main.job?.jobId, 'the candidate is not marked as the job\'s (origin improvement, jobId)'],
        [candidateIssues.length === 0 && (main.integrity?.files?.candidate ?? 0) > 0, `the candidate fails the schema (${candidateIssues.join('; ')})`],
        [files.length > 0 && files.every(path => path === 'SKILL.md') && main.isolation?.configBefore === main.configAfter, `the candidate carries more than its component (${files.join(', ')}) or config.json changed`],
        [two?.status === 'failed' && /exactly one/.test(two?.detail ?? '') && disabled.candidatesAdded === 0, `two components: ${two?.status} (${two?.detail}), ${disabled.candidatesAdded} candidates`],
        [none?.job?.status === 'no-proposal' && none?.diagnosis?.proposalKind === 'none' && !(none?.job?.history ?? []).includes('proposing'), `proposalKind none: ${none?.job?.status}`],
        [['no-proposal', 'failed'].includes(broken?.status) && explicit.candidates === 0 && broken?.candidateId === undefined, `a component never used successfully: ${broken?.status}, ${explicit.candidates} candidates`],
      ],
      evidence: `one component (skill ${components[0]?.name}, SKILL.md only), schema-valid, the job's; two components → failed (${two?.detail}); proposalKind none → no-proposal; a throwing module → ${broken?.status} without a candidate`,
    }
  }),

  // 提案隔离：提案阶段在快照副本里运行，真实项目的文件、会话与成果不变
  H08: needs('main', (main) => {
    const iso = main.isolation ?? {}
    const before = iso.treeBefore ?? {}
    const after = iso.treeAfter ?? {}
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path])
    const jobSessions = Object.values(main.job?.sessions ?? {})
    const proposals = (main.requests ?? []).filter(r => r.kind === 'propose')
    return {
      conditions: [
        [proposals.length > 0, 'the propose session sent no request'],
        [Object.keys(before).length > 0 && changed.length === 0, `project files changed while the job ran (${changed.join(', ')})`],
        [(iso.sessionsChanged ?? ['?']).length === 0 && iso.sessionsBefore > 0, `the user's sessions changed (${(iso.sessionsChanged ?? []).join(', ')})`],
        [iso.feedbackSessionExtra === 0, `the job wrote ${iso.feedbackSessionExtra} records into the feedback session`],
        [JSON.stringify(iso.deliverablesBefore) === JSON.stringify(iso.deliverablesAfter) && (iso.deliverablesBefore ?? []).length > 0, 'deliverables changed'],
        [sameSet(iso.newSessions ?? [], jobSessions), `new sessions ${JSON.stringify(iso.newSessions)} are not exactly the job's diagnose and propose sessions`],
      ],
      evidence: `the propose session ran ${proposals.length} steps in the snapshot copy; ${Object.keys(before).length} project files, ${iso.sessionsBefore} sessions and ${(iso.deliverablesBefore ?? []).length} deliverables unchanged; only the job's two sessions were added`,
    }
  }),

  // 门控回放集：selection 含反馈任务，guard 是其他历史任务，不重叠；回放里没有反馈轮的文字
  H09: needs('main', (main) => {
    const start = receiptsOf(main).find(r => r.type === 'trial.start')
    const selection = start?.plan?.selection ?? []
    const guard = start?.plan?.guard ?? []
    const idOf = sessionId => (main.taskSessions ?? []).find(t => t.sessionId === sessionId)?.id
    const replays = (main.requests ?? []).filter(r => r.phase === 'job' && r.kind === 'task')
    const overlap = guard.filter(g => selection.some(s => s.sessionId === g.sessionId || s.caseId === g.caseId))
    return {
      conditions: [
        [start !== undefined, 'the job\'s trial has no trial.start receipt'],
        [selection[0]?.sessionId === main.feedbackSession && selection[0]?.throughTurn === 1, `selection starts with ${idOf(selection[0]?.sessionId)} (through turn ${selection[0]?.throughTurn}), expected the feedback task through turn 1`],
        [sameSet(selection[0]?.feedbackIds ?? [], main.job?.feedbackIds ?? []), 'the feedback case does not carry the job\'s feedback ids'],
        [guard.length > 0 && guard.every(g => idOf(g.sessionId) !== undefined && g.sessionId !== main.feedbackSession), `guard ${JSON.stringify(guard.map(g => idOf(g.sessionId)))} is not other history tasks`],
        [overlap.length === 0, 'selection and guard overlap'],
        [replays.length > 0 && replays.every(r => !r.quotesFeedback), `${replays.filter(r => r.quotesFeedback).length} of ${replays.length} replay requests quote the feedback`],
      ],
      evidence: `selection ${selection.map(s => idOf(s.sessionId)).join(', ')} (feedback task first, through turn 1), guard ${guard.map(g => idOf(g.sessionId)).join(', ')}; ${replays.length} replay requests, none with the feedback text`,
    }
  }),

  // 反馈检查：两侧各有一条反馈检查，证据里与确定性检查分开标记；unknown 时不采用
  H10: needs(['main', 'waiting'], (main, waiting) => {
    const feedback = receiptsOf(main).filter(r => r.type === 'trial.feedback')
    const end = receiptsOf(main).find(r => r.type === 'trial.end')
    const decision = (main.decisions ?? []).find(d => d.id === main.job?.decisionId)
    const unknown = waiting.job
    const unknownDecision = (waiting.decisions ?? []).find(d => d.id === unknown?.decisionId)
    return {
      conditions: [
        [['candidate', 'baseline'].every(arm => feedback.some(r => r.arm === arm && (r.feedbackIds ?? []).length > 0)), `feedback checks by arm: ${JSON.stringify(feedback.map(r => r.arm))}`],
        [feedback.some(r => r.arm === 'candidate' && r.status === 'pass') && feedback.some(r => r.arm === 'baseline' && r.status === 'fail'), 'the feedback checks did not tell the arms apart'],
        [(main.feedbackChecks ?? []).length > 0 && main.feedbackChecks.every(c => c.quotesFeedback), 'a feedback check request did not carry the feedback text'],
        [end?.verdict?.feedbackPassRate !== undefined && end?.verdict?.passRate !== undefined, 'the verdict does not report the feedback pass rate apart from the pass rate'],
        [/Feedback checks/.test(decision?.detail ?? '') && /Quality/.test(decision?.detail ?? ''), `the decision does not list the feedback checks separately (${decision?.detail})`],
        [(waiting.feedbackChecks ?? []).length > 0 && waiting.feedbackChecks.every(c => c.solved === null), 'the unknown case did not answer null'],
        [unknown?.status === 'rejected' && unknownDecision?.reason === 'unknown-runs', `with unknown feedback checks the job ended ${unknown?.status} (${unknownDecision?.reason})`],
        [(waiting.activation ?? []).length === 0, 'something was adopted with unknown feedback checks'],
      ],
      evidence: `${feedback.length} feedback checks (pass on candidate, fail on baseline), feedbackPassRate ${JSON.stringify(end?.verdict?.feedbackPassRate)} beside passRate; the decision lists them on their own line; null answers → rejected (unknown-runs), nothing adopted`,
    }
  }),

  // 采用与使用：新 OS 进程中的下一次任务自动加载新版本并调用组件，账本可证；作业记录“首次被使用”指向这个任务
  H11: needs('main', (main) => {
    const next = main.next ?? {}
    const adopted = main.current?.version
    const outcome = (main.ledger ?? []).filter(r => r.type === 'task.outcome' && r.sessionId === next.sessionId && r.trialId === undefined && (r.memberId ?? 'main') === 'main').at(-1)
    const used = (outcome?.componentsUsed ?? []).find(c => c.kind === CONVENTION_SKILL.kind && c.name === CONVENTION_SKILL.name)
    return {
      conditions: [
        [main.job?.status === 'adopted' && typeof adopted === 'string' && adopted !== 'baseline', `the job ended ${main.job?.status}; current version ${adopted}`],
        [typeof next.pid === 'number' && next.pid !== next.parentPid && next.code === 0 && next.reason?.kind === 'completed', `the next task in a new process did not complete (${next.error ?? next.reason?.kind})`],
        [next.version === adopted, `the new process ran on ${next.version}, not the adopted ${adopted}`],
        [outcome?.capabilityVersion === adopted && used !== undefined && used.calls > 0 && used.errors === 0, `the ledger does not show the skill used on the adopted version (${JSON.stringify(outcome?.componentsUsed)})`],
        [next.judged?.pass === true, `the next table still has the problem the feedback named (${(next.judged?.problems ?? []).join('; ')})`],
        [main.firstUse?.taskId === outcome?.taskId && main.firstUse?.version === adopted && typeof main.firstUse?.at === 'string', `the job's firstUse ${JSON.stringify(main.firstUse)} does not point at the next task (${outcome?.taskId})`],
      ],
      evidence: `adopted ${String(adopted).slice(0, 12)}; the next task in process ${next.pid} (parent ${next.parentPid}) loaded the skill (${used?.calls} call, ledger task.outcome), its table has the column; job.firstUse → that task at ${main.firstUse?.at}`,
    }
  }),

  // 拒绝：拒绝原因、候选、回执保留，原版本照常可用
  H12: needs('waiting', (waiting) => {
    const job = waiting.job
    const decision = (waiting.decisions ?? []).find(d => d.id === job?.decisionId)
    const after = waiting.after ?? {}
    return {
      conditions: [
        [job?.status === 'rejected' && typeof decision?.reason === 'string' && /reject/.test(decision?.detail ?? ''), `the job ended ${job?.status} with decision ${decision?.reason}`],
        [after.candidate?.status === 'rejected' && after.candidate?.decision?.reason === decision?.reason, `the candidate is ${after.candidate?.status} (${after.candidate?.decision?.reason})`],
        [(after.receipts ?? []).includes('trial.start') && (after.receipts ?? []).includes('trial.end'), `the trial's receipts are not kept (${JSON.stringify(after.receipts)})`],
        [(after.version ?? 'baseline') === 'baseline' && (waiting.activation ?? []).length === 0, `the version changed to ${after.version}`],
        [after.reason === 'completed' && after.judged !== undefined && after.judged.problems.every(p => /avg_order_value/.test(p)), `the next task on the old version did not complete normally (${after.reason}; ${(after.judged?.problems ?? []).join('; ')})`],
      ],
      evidence: `rejected (${decision?.reason}); candidate, decision and ${(after.receipts ?? []).length} receipts kept; the next task ran on ${after.version ?? 'baseline'} as before`,
    }
  }),

  // 历史不足：作业停在 waiting-history；补足历史后继续，不降门槛
  H13: needs('waiting', (waiting) => {
    const parked = waiting.parked
    const history = waiting.job?.history ?? []
    const start = Object.values(waiting.trials ?? {}).flat().find(r => r.type === 'trial.start')
    const wanted = /needs (\d+) selection and (\d+) guard/.exec(parked?.detail ?? '')
    const resumed = history.indexOf('waiting-history')
    return {
      conditions: [
        [parked?.status === 'waiting-history' && parked?.candidate === true && parked?.trials === 0, `with one past task the job is ${parked?.status} (candidate ${parked?.candidate}, ${parked?.trials} trials)`],
        [wanted !== null, `the waiting job does not say what history it needs (${parked?.detail})`],
        [waiting.statusAfterHistory === 'waiting-history' || history.includes('trialing'), `after the history tasks the job is ${waiting.statusAfterHistory}`],
        [resumed >= 0 && history.slice(resumed + 1).includes('trialing') && ['adopted', 'rejected'].includes(waiting.job?.status), `the job did not continue to a gate decision (${history.join(' → ')})`],
        [waiting.diagnoseSessions === 1 && (history.filter(s => s === 'diagnosing').length === 1), 'the job was diagnosed again instead of continuing'],
        [wanted !== null && start?.plan?.selection?.length === Number(wanted[1]) && start?.plan?.guard?.length === Number(wanted[2]), `the gate ran ${start?.plan?.selection?.length} selection and ${start?.plan?.guard?.length} guard cases, not the ${wanted?.[1]} and ${wanted?.[2]} it waited for`],
      ],
      evidence: `parked waiting-history (${parked?.detail}); after two more tasks and a restart it continued at the same size (${start?.plan?.selection?.length} selection, ${start?.plan?.guard?.length} guard): ${history.join(' → ')}`,
    }
  }),

  // 预算：用尽即停，记 budget-exhausted；改进费用带 improvementId 与阶段，与正常任务分开可查
  H14: needs(['main', 'disabled'], (main, disabled) => {
    const stopped = disabled.stopped?.job
    const records = (main.ledger ?? []).filter(r => r.type === 'llm.request.end' && r.improvementId === main.job?.jobId)
    const phases = [...new Set(records.map(r => r.improvementPhase))]
    const userSessions = new Set((main.taskSessions ?? []).map(t => t.sessionId))
    const leaked = (main.ledger ?? []).filter(r => userSessions.has(r.sessionId) && r.trialId === undefined && r.improvementId !== undefined)
    const tokens = Object.values(main.detail?.view?.tokens ?? {})
    return {
      conditions: [
        [disabled.budget?.settingsLimit === disabled.budget?.limit, `the budget set through settings reads ${disabled.budget?.settingsLimit}, expected ${disabled.budget?.limit}`],
        [stopped?.status === 'budget-exhausted' && Object.keys(stopped?.phases ?? {}).join() === 'diagnose' && /budget/i.test(stopped?.detail ?? ''), `the job over budget ended ${stopped?.status} after ${Object.keys(stopped?.phases ?? {}).join(', ')}`],
        [disabled.refused?.code === 'improvement/budget-exhausted', `a run with the budget spent was not refused (${disabled.refused?.code ?? disabled.refused?.job?.status})`],
        [PHASES.every(phase => phases.includes(phase)) && phases.every(phase => PHASES.includes(phase)), `the job's ledger records have phases ${JSON.stringify(phases)}`],
        [leaked.length === 0, `${leaked.length} records of the user's tasks carry an improvementId`],
        [tokens.length === 3 && main.listing?.budget?.usedTokens === sum(tokens.map(t => (typeof t === 'number' ? t : Number.NaN))), `the budget window (${main.listing?.budget?.usedTokens}) is not the job's phases (${JSON.stringify(main.detail?.view?.tokens)})`],
      ],
      evidence: `over budget: ${stopped?.status} before proposing (${stopped?.detail}); the next run refused; ${records.length} requests of the job with improvementId and phases ${phases.join(', ')}, none on the user's tasks; window ${main.listing?.budget?.usedTokens} tokens`,
    }
  }),

  // 并发与恢复：同一项目同时只有一个作业；两进程同时提交反馈不重计；作业进程被强杀后下次启动标为中断，不重跑
  H15: needs(['concurrency', 'recovery'], (phase, recovery) => {
    const submitted = phase.submitted ?? []
    const queue = phase.queue ?? []
    return {
      conditions: [
        [submitted.length >= 2, `fewer than two concurrent submissions succeeded (${(phase.drivers ?? []).map(d => d.error).filter(Boolean).join('; ')})`],
        [new Set(queue).size === queue.length, `the counted set has an id twice (${JSON.stringify(queue)})`],
        [phase.allCounted === true && submitted.every(id => queue.includes(id)), 'a concurrent feedback was lost'],
        [phase.jobStarted === true && (phase.jobs ?? []).length === 1, `${(phase.jobs ?? []).length} jobs were created, expected 1`],
        [phase.maxRunning === 1, `${phase.maxRunning} jobs ran at once in one project`],
        [recovery.killError === undefined && recovery.statusBeforeKill === 'diagnosing', `the job process was not killed while running (${recovery.killError ?? recovery.statusBeforeKill})`],
        [recovery.statusAfterRestart === 'interrupted', `after the kill the job is ${recovery.statusAfterRestart}, expected interrupted`],
        [recovery.reruns === 0 && recovery.starts === 1 && recovery.jobsAfterRestart === 1, `the interrupted job ran again (${recovery.starts} starts, ${recovery.jobsAfterRestart} jobs)`],
        [recovery.adoptedBefore !== undefined && recovery.adoptedBefore === recovery.adoptedAfter, `the adopted version changed across the kill (${recovery.adoptedBefore} → ${recovery.adoptedAfter})`],
      ],
      evidence: `${submitted.length} feedbacks from two processes at once, each counted once; one job, at most one running; killed in ${recovery.statusBeforeKill}, interrupted after restart, started once; version ${recovery.adoptedAfter} kept`,
    }
  }),

  // 每轮记录：反馈轮的检查与快照不覆盖原轮
  H16: (obs) => {
    const turns = obs?.turns
    if (turns === undefined) return obs?.errors?.main === undefined ? missing('turns') : { status: 'failed', evidence: `main phase failed: ${String(obs.errors.main).split('\n')[0]}` }
    const before = turns.before ?? {}
    const after = turns.after ?? {}
    const n = turns.feedbackTurns ?? 0
    const laterTurns = Array.from({ length: n }, (_, i) => String(i + 2))
    return verdict([
      [typeof turns.taskId === 'string', 'the feedback task\'s snapshot was not found'],
      [n > 0, 'no feedback turns ran'],
      [before.tasks?.['1']?.sha !== undefined && before.tasks['1'].sha === after.tasks?.['1']?.sha, 'the first turn\'s snapshot changed after the feedback turns'],
      [before.checks?.['1']?.sha !== undefined && before.checks['1'].sha === after.checks?.['1']?.sha, 'the first turn\'s checks changed after the feedback turns'],
      [laterTurns.every(t => after.tasks?.[t] !== undefined), `feedback turns lack their own snapshot (have ${Object.keys(after.tasks ?? {}).join(',')})`],
      [laterTurns.every(t => after.checks?.[t] !== undefined), `feedback turns lack their own checks (have ${Object.keys(after.checks ?? {}).join(',')})`],
      [before.legacy?.tasks !== undefined && before.legacy.tasks === after.legacy?.tasks, 'the step-4 snapshot file (first snapshot) was overwritten'],
    ], `turn 1's snapshot and checks unchanged after ${n} feedback turns; turns 2–${n + 1} each have their own snapshot and checks; the step-4 file keeps the first snapshot`)
  },

  // 不改配置：.nexgent/config.json 只在经 SDK 改设置时变化；改进作业与候选改不到开关、预算与门控字段
  H17: needs(['main', 'disabled'], (main, disabled) => {
    const config = disabled.config ?? {}
    const file = disabled.configFile ?? {}
    const files = (main.detail?.candidate?.record?.components ?? []).flatMap(c => (c.files ?? []).map(f => f.path))
    return {
      conditions: [
        [typeof main.isolation?.configBefore === 'string' && main.isolation.configBefore === main.configAfter, 'config.json changed during the job, the gate, the adoption or the next task'],
        [typeof config.start === 'string' && config.start === config.afterJobs, 'config.json changed during three explicit jobs'],
        [config.afterSettings !== config.afterJobs && config.end === config.afterSettings, 'config.json did not change on settings.update only'],
        [file.autoImprove === false && file.improvement?.budget?.maxTokens === disabled.budget?.limit, `after the settings call the switch is ${file.autoImprove} and the budget ${file.improvement?.budget?.maxTokens}`],
        [files.length > 0 && !files.some(path => /config|\.nexgent/i.test(path)), `the candidate carries ${files.join(', ')}`],
      ],
      evidence: `config.json unchanged through the job, the gate, adoption and the next task, and through three explicit jobs; it changed once, on settings.update (budget ${disabled.budget?.limit}); the candidate carries only ${files.join(', ')}`,
    }
  }),

  // 账本完整：新记录与字段全部通过 schema；.nexgent/ 与导出物中搜不到测试密钥
  H18: needs('main', (main) => {
    const integrity = main.integrity ?? {}
    const files = integrity.files ?? {}
    const exported = main.export ?? {}
    // ADR 0012: the user's queue is a record kind too; jobs that pinned an improver say improverScope user.
    const kinds = ['queue', 'job', 'diagnosis', 'candidate', 'trialReceipt', 'decision', 'userQueue']
    const scopes = integrity.scopes ?? []
    return {
      conditions: [
        [scopes.length > 0 && scopes.every(job => job.improverScope === 'user'), `pinned jobs' improverScope: ${scopes.length === 0 ? 'no pinned job' : scopes.map(job => job.improverScope ?? 'absent').join(', ')} (want user)`],
        [(integrity.issues ?? ['not collected']).length === 0, `schema issues: ${(integrity.issues ?? ['not collected']).slice(0, 3).join('; ')}`],
        [integrity.sessions > 0 && integrity.ledger > 0 && kinds.every(kind => files[kind] > 0), `not every kind of record was checked (${JSON.stringify(files)})`],
        [(main.ledger ?? []).some(r => r.type === 'improvement.end' && r.improvementId === main.job?.jobId), 'the ledger has no improvement.end record for the job'],
        [(integrity.secretHits ?? ['?']).length === 0, `files under .nexgent/ contain the test key (${(integrity.secretHits ?? ['not scanned']).join(', ')})`],
        [exported.code === 0 && (exported.files ?? []).length > 0, `nexgent export of the feedback task failed (exit ${exported.code}: ${exported.stderr})`],
        [(exported.secretHits ?? ['?']).length === 0, `export files contain the test key (${(exported.secretHits ?? ['not scanned']).join(', ')})`],
      ],
      evidence: `${integrity.sessions} sessions, ${integrity.ledger} ledger lines and ${kinds.map(kind => `${files[kind]} ${kind}`).join(', ')} pass the schema; ${scopes.length} pinned job.json say improverScope user; the test key is in neither .nexgent/ nor the export (${(exported.files ?? []).length} files)`,
    }
  }),
}

function safe(run) {
  try {
    return run()
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

/**
 * The feedback project fixture is what every improvement job starts from: recorded as a
 * named check (not a checklist item) so a broken fixture is visible on its own.
 * @param project - `runFeedbackProject`'s observations.
 */
export function judgeFeedbackProject(project, { judgeTable, csvOf }) {
  if (project === undefined) return { status: 'failed', evidence: 'the feedback project did not run' }
  const tasks = project.tasks ?? []
  const last = tasks.at(-1)
  const feedback = project.feedback ?? []
  const counted = feedback.filter(entry => entry.counted)
  const listed = project.listing ?? []
  const table = last === undefined ? undefined : judgeTable(csvOf(last), last.output)
  return verdict([
    [tasks.length >= 4, `${tasks.length} tasks ran, expected the history tasks and the feedback task`],
    ...tasks.map(task => [task.reason?.kind === 'completed', `${task.id} ended ${task.reason?.kind ?? task.error ?? 'without a reason'}`]),
    ...tasks.map(task => [task.check?.passed === true, `${task.id}'s check failed: ${task.check?.stdout}`]),
    [project.deliverable !== undefined, 'the feedback task presented no deliverable'],
    [table?.missingConvention === true, `the feedback task's table should lack only the convention column (${table?.problems?.join('; ')})`],
    [feedback.length > 0 && feedback.every(entry => entry.reason?.kind === 'completed'), 'a feedback turn did not complete'],
    [feedback.length > 0 && feedback.every(entry => typeof entry.id === 'string' && listed.some(l => l.id === entry.id)), 'a submitted feedback is not in feedback.list'],
    [counted.length === THRESHOLD, `${counted.length} feedbacks count, expected ${THRESHOLD}`],
    [feedback.length > counted.length, 'no uncounted feedback in the fixture'],
  ], `${tasks.length} tasks completed with passing checks; the feedback task's table lacks only the convention column; ${feedback.length} feedbacks recorded (${counted.length} count)`)
}
