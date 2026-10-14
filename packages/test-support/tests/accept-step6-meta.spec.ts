/**
 * The H04–H17 judges of accept-step6 (step6-meta-judges.mjs) against a small
 * hand-made observation in the shape the meta-improvement scenario collects,
 * and copies broken one fact at a time. No model is called, no app is started.
 */
import { describe, expect, it } from 'vitest'
import { META_JUDGES, expectedOrigin, judgeOrigin } from '../../../scripts/accept-common/step6-meta-judges.mjs'
import type { MetaObservations } from '../../../scripts/accept-common/step6-meta-judges.mjs'

type Obs = MetaObservations
type Mutation = (o: Obs) => void

const h = (c: string): string => c.repeat(64)
const TREE = h('1')
const EPOCH = h('2')
const EPOCH2 = h('3')
const CHILD = h('c')
const KINDS = ['metaDiagnosis', 'change', 'comparison', 'improver', 'improverRevision', 'userQueue']
const PA = 'pa'
const PB = 'pb'
const T1 = '2026-01-01T00:00:01.000Z'
const T2 = '2026-01-01T00:00:02.000Z'
const T3 = '2026-01-01T00:00:03.000Z'
const T4 = '2026-01-01T00:00:04.000Z'
const T5 = '2026-01-01T00:00:05.000Z'

const state = () => ({ work: { 'a.txt': 'h1' }, capabilities: { c: 1 }, sessions: { s1: { purpose: 'chat' } }, deliverables: [], config: '{}' })
const records = () => ({ issues: [], fileIssues: [], secretHits: [], checked: { sessions: 1, ledger: 1, files: 1, kinds: KINDS, userConfig: true }, scopes: [{ id: 'job-n', improverScope: 'user' }] })
const originOf = (kind: string) => ({ kind, projectId: PA, sourceJobId: 'job-f', tree: TREE, feedbackIds: ['f1'], capabilityVersion: 'baseline', epoch: EPOCH })
const arm = (kind: string, status: string, cost: number, candidateId?: string) => ({ origin: originOf(kind), status, cost: { estimatedUsd: cost }, ...(candidateId === undefined ? {} : { candidateId }) })

/** One meta project: the source job `job-f` ended `sourceStatus` (adopted → feedback-version origin, rejected → unresolved). */
function project(kind: 'feedback-version' | 'unresolved', sourceStatus: string, adopted: boolean) {
  const sourceJob = { id: 'job-f', kind: 'capability', status: sourceStatus, createdAt: T1, updatedAt: T2, history: [{ status: 'queued', at: T1 }], baseVersion: 'baseline', feedbackIds: ['f1'], taskVersions: { t: 'baseline' }, baselineFeedbackPassRate: 0 }
  const verdict = adopted ? { outcome: 'adopt', reason: 'gate-passed' } : { outcome: 'reject', reason: 'no-offspring' }
  const comparison = {
    origin: originOf(kind),
    parent: arm(kind, 'rejected', 1, 'cand-p'),
    child: adopted ? { ...arm(kind, 'adopted', 1, 'cand-c'), improverVersion: CHILD } : arm(kind, 'rejected', 1),
    verdict,
  }
  return {
    meta: { id: 'job-m', status: adopted ? 'adopted' : 'rejected', files: { comparison, job: { id: 'job-m', status: adopted ? 'adopted' : 'rejected', createdAt: T5 }, change: { change: { op: 'set-diagnosis-paragraph' }, parentVersion: 'v0', childVersion: CHILD, attempts: 1 } } },
    before: state(),
    after: state(),
    origin: { jobs: [sourceJob], revisions: [], logLine: `${T4} compare: ${kind} origin, job job-f (${sourceStatus})` },
    tampered: { none: verdict.reason, sourceJobId: 'origin-mismatch', tree: 'origin-mismatch', feedbackIds: 'origin-mismatch', capabilityVersion: 'origin-mismatch', kind: 'origin-mismatch', epoch: 'epoch-mismatch' },
    records: records(),
    metaSessions: [{ phase: 'meta-diagnose', tools: ['improve_list_jobs', 'improve_report_meta_diagnosis'] }],
    newLedger: [{ comparisonArm: 'child', improvementPhase: adopted ? 'propose' : 'diagnose', improverVersion: CHILD, sessionId: 'arm-1', metaJobId: 'job-m', improvementId: 'job-a' }],
  }
}

/** A minimal observation on which every judge passes. */
function good(): Obs {
  const adopt = project('feedback-version', 'adopted', true)
  const reject = project('unresolved', 'rejected', false)
  const trigger = {
    steps: [
      { name: 'off: explicit job 1' },
      { name: 'off: explicit job 2' },
      { name: 'off: explicit job 3', pendingAfter: 3 },
      { name: 'off: explicit meta job', result: { id: 'job-e', trigger: 'explicit', status: 'no-proposal', files: { metaDiagnosis: { proposal: 'none' } } }, metaJobs: [{ id: 'job-e', basis: ['j1', 'j2', 'j3'] }] },
      { name: 'on: cancelled job', result: { id: 'job-x', status: 'cancelled' }, pendingBefore: 0, pendingAfter: 0 },
      { name: 'on: interrupted job', result: { id: 'job-y', status: 'interrupted' }, pendingBefore: 0, pendingAfter: 0 },
      { name: 'on: counted job 2', pendingAfter: 2 },
      { name: 'on: counted job 3 (second project)', result: { id: 'j6', status: 'adopted' }, metaJobs: [{ trigger: 'job-count', basis: ['j4', 'j5', 'j6'], project: 'second', batch: [{ projectId: PA }, { projectId: PA }, { projectId: PB }] }] },
    ],
    offNoMeta: 0,
    metaSetting: { enabled: true, everyJobs: 3 },
    metaVia: 'user config',
    projectConfigMeta: null,
    projectIds: { trigger: PA, second: PB },
    afterSecond: 1,
    budget: { limit: 1, via: 'user config', stopped: { status: 'budget-exhausted' }, refused: { code: 'improvement/budget-exhausted' }, refusedSecond: { code: 'improvement/budget-exhausted' }, status: { exhausted: true } },
    h15: {
      metaJobId: 'job-h', slot: { jobId: 'job-h' }, secondMeta: { code: 'improvement/busy' }, ordinary: { id: 'job-o', status: 'adopted' }, statusDuringOrdinary: 'meta-diagnosing',
      statusBeforeKill: 'meta-diagnosing', killed: { pid: 9 }, statusAfter: 'interrupted', starts: 1, metaDiagnoseRequests: 1, slotAfter: null,
    },
    records: records(),
    secondRecords: records(),
  }
  Object.assign(adopt, {
    source: { id: 'job-f' },
    tempBefore: [],
    tempAfter: [],
    armSessions: [{ arm: 'child' }],
    show: { version: CHILD, change: { childVersion: CHILD } },
    projectIds: { origin: PA, meta: PA },
    improversBefore: { history: [], versions: [] },
    improvers: { current: { version: CHILD, jobId: 'job-m', trigger: 'meta-job' }, history: [{ revision: 1, version: CHILD, jobId: 'job-m', trigger: 'meta-job' }], versions: [CHILD] },
    next: { code: 0, pid: 2, parentPid: 1, improverVersion: CHILD, jobId: 'job-n' },
    jobs: [{ id: 'job-f', createdAt: T1 }, { id: 'job-n', improverVersion: CHILD, createdAt: T5 }],
    facts: { jobs: [{ jobId: 'job-n', improverScope: 'user' }], ledger: [{ improvementId: 'job-n', improverVersion: CHILD }], sessions: [{ jobId: 'job-n', improverVersion: CHILD }] },
    costs: { metaDiagnose: { requests: 1 }, metaPropose: { requests: 1 }, parentArm: { requests: 1 }, childArm: { requests: 1 }, source: { requests: 1 }, meta: { requests: 4 } },
  })
  Object.assign(adopt.meta.files, { metaDiagnosis: { proposal: 'change', findings: [{ jobIds: ['job-f'] }] } })
  Object.assign(adopt.newLedger[0] as object, { improvementId: 'job-a' })
  Object.assign(reject, {
    kept: [{ root: '/p', exists: true, hasProject: true, bytes: 5 }, { root: '/c', exists: true, hasProject: true, bytes: 6 }],
    projectIds: { origin: PA, meta: PB },
    metaFrom: 'other project',
    metaRecords: records(),
    improversBefore: { history: [], versions: [] },
    improvers: { current: { version: 'v0' }, history: [], versions: [] },
    next: { improverVersion: 'v0' },
    extra: {
      epochBefore: EPOCH, epochAfter: EPOCH2, epochAfterOther: EPOCH2, costRatioCap: { before: 1.2, after: 2 }, configBefore: '{}', configAfter: '{}',
      invalid: { status: 'failed', files: {} }, bounds: { status: 'failed', files: {} }, proposeRequests: 3, versionsBefore: ['v0.json'], versionsAfter: ['v0.json'],
      rules: { id: 'adr-0014', constant: 'adr-0014', epoch: EPOCH, epochAdr0008: h('5'), projectEpoch: EPOCH, sameEpoch: EPOCH, mixed: 'improvement/epoch-mismatch' },
    },
  })
  const rework = {
    shared: { probe: { outsideProjectId: 'px', insideProjectId: PA, toolResults: [{ projectId: 'px', isError: true, text: 'Project px is not one of this meta job\'s projects' }, { projectId: PA, isError: false, text: '[]' }] } },
    metaLiteral: { refusal: { isError: true, text: 'improver/instance-literal: 4321.09' } },
  }
  return { trigger, adopt, reject, rework, export: { code: 0, secretHits: [], files: ['a'] }, copyLimit: { status: 'too-large', exists: false, keepMaxBytes: 1 }, crossEpochProduct: { reason: 'epoch-mismatch' }, evaluatorKeysInImprovers: [] }
}

const mutated = (fn: Mutation): Obs => {
  const o = structuredClone(good())
  fn(o)
  return o
}
const step = (o: Obs, name: string) => o.trigger.steps.find((s: { name: string }) => s.name === name)

type Case = readonly [name: string, mutate: Mutation, phrase: string]
const COUNTERS: Record<keyof typeof META_JUDGES, readonly Case[]> = {
  H04: [
    ['a meta job exists after the 2nd counted job', o => { o.trigger.afterSecond = 2 }, 'meta jobs exist'],
    ['a cancelled job is counted', o => { step(o, 'on: cancelled job').pendingAfter = 1 }, 'on: cancelled job: counted'],
    ['an interrupted job is counted', o => { step(o, 'on: interrupted job').pendingAfter = 1 }, 'on: interrupted job: counted'],
    ['no meta job starts after the 3rd counted job', o => { step(o, 'on: counted job 3 (second project)').metaJobs = [] }, 'no meta job started by itself'],
    ['the automatic basis includes the cancelled job', o => { step(o, 'on: counted job 3 (second project)').metaJobs[0].basis = ['j4', 'j5', 'job-x'] }, 'the basis includes a cancelled or interrupted job'],
    ['a meta job starts on its own with meta off', o => { o.trigger.offNoMeta = 1 }, 'meta job(s) started on their own'],
    ['the explicit meta job basis misses a counted job', o => { step(o, 'off: explicit meta job').metaJobs[0].basis = ['j1'] }, 'the explicit meta job\'s basis has 1 jobs'],
    ['meta was turned on in the project config', o => { o.trigger.metaVia = 'project config' }, 'meta was not turned on in the user config'],
    ['the project config carries the meta field', o => { o.trigger.projectConfigMeta = { enabled: true } }, 'the project config carries improvement.meta'],
    ['the automatic meta job lives in the first project', o => { step(o, 'on: counted job 3 (second project)').metaJobs[0].project = 'trigger' }, 'lives in the trigger project'],
    ['the batch names only one project', o => { step(o, 'on: counted job 3 (second project)').metaJobs[0].batch = [{ projectId: PA }] }, 'the batch\'s project ids are not the two projects\''],
    ['the basis lacks the second project\'s job', o => { step(o, 'on: counted job 3 (second project)').metaJobs[0].basis = ['j3', 'j4', 'j5'] }, 'the basis lacks the second project\'s job'],
    ['the second project\'s job did not run', o => { step(o, 'on: counted job 3 (second project)').result = { code: 'improvement/busy' } }, 'the second project\'s job did not run'],
  ],
  H05: [
    ['a meta-diagnose session is offered a write tool', o => { o.adopt.metaSessions[0].tools.push('improve_propose_change') }, 'was offered improve_propose_change'],
    ['a meta-diagnose session lacks the report tool', o => { o.adopt.metaSessions[0].tools = ['improve_list_jobs'] }, 'lacked the report tool'],
    ['the diagnosis cites a job that is not the project\'s', o => { o.adopt.meta.files.metaDiagnosis.findings[0].jobIds = ['job-zz'] }, 'which is not a job of the project'],
    ['the diagnosis cites its own job', o => { o.adopt.jobs.push({ id: 'job-m' }); o.adopt.meta.files.metaDiagnosis.findings[0].jobIds.push('job-m') }, 'cites its own job'],
    ['the diagnosis breaks the schema', o => { o.adopt.records.fileIssues.push({ kind: 'metaDiagnosis', message: 'bad', path: 'p' }) }, 'meta-diagnosis.json breaks the schema'],
    ['a diagnosis refused three times does not end failed', o => { o.reject.extra.invalid.status = 'adopted' }, 'refused three times ended adopted'],
    ['the outside-the-batch read was not tried', o => { delete o.rework.shared }, 'the outside-the-batch read was not tried'],
    ['a project outside the batch is answered', o => { o.rework.shared.probe.toolResults[0] = { projectId: 'px', isError: false, text: '[]' } }, 'improve_list_jobs on a project outside the batch: answered'],
    ['the batch\'s own project is refused', o => { o.rework.shared.probe.toolResults[1] = { projectId: PA, isError: true, text: 'nope' } }, 'improve_list_jobs on the batch\'s project: nope'],
    ['a none diagnosis still produces a change', o => { step(o, 'off: explicit meta job').result.files.change = {} }, 'still produced a change'],
  ],
  H06: [
    ['an out-of-bounds proposal is accepted', o => { o.reject.extra.bounds.status = 'adopted' }, 'three refused proposals'],
    ['a refused proposal writes change.json', o => { o.reject.extra.bounds.files.change = {} }, 'a refused proposal wrote change.json'],
    ['a refused proposal stores an improver', o => { o.reject.extra.versionsAfter.push('x.json') }, 'a refused proposal stored an improver'],
    ['the valid change takes two proposals', o => { o.adopt.meta.files.change.attempts = 2 }, 'the valid change took 2 proposals'],
    ['the change has another op', o => { o.adopt.meta.files.change.change.op = 'other' }, 'change.json op other'],
    ['improvers.show does not return the child', o => { o.adopt.show.version = 'v0' }, 'improvers.show does not return the stored child'],
    ['fewer than three refused proposals were made', o => { o.reject.extra.proposeRequests = 2 }, 'only 2 refused proposals'],
    ['a change carrying a batch value is accepted', o => { o.rework.metaLiteral.refusal = { isError: false, text: 'stored' } }, 'a change carrying a concrete value of the batch was not refused (stored)'],
    ['the literal change was not tried', o => { delete o.rework.metaLiteral }, 'not tried'],
  ],
  H07: [
    ['an unresolved job exists but the kind is feedback-version', o => { o.adopt.origin.jobs.push({ id: 'job-u', kind: 'capability', status: 'rejected', createdAt: T3, updatedAt: T4, history: [], baseVersion: 'baseline', feedbackIds: ['f2'], baselineFeedbackPassRate: 0 }) }, 'ADR 0009 gives unresolved job'],
    ['the child arm origin kind differs', o => { o.adopt.meta.files.comparison.child.origin.kind = 'unresolved' }, 'the child arm\'s kind differs from the origin'],
    ['the parent arm origin tree differs', o => { o.reject.meta.files.comparison.parent.origin.tree = h('9') }, 'the parent arm\'s tree differs from the origin'],
    ['the origin kind is not one ADR 0009 names', o => { o.adopt.meta.files.comparison.origin.kind = 'custom' }, 'origin kind custom'],
    ['the tampered kind is not origin-mismatch', o => { o.adopt.tampered.kind = 'gate-passed' }, 'the child\'s origin with another kind → gate-passed'],
    ['the tampered epoch is not epoch-mismatch', o => { o.reject.tampered.epoch = 'origin-mismatch' }, 'in another epoch'],
    ['the recorded decision differs from the verdict', o => { o.reject.tampered.none = 'quality-up' }, 'decideImprover on the records as written gives quality-up'],
    ['the job.log line is missing', o => { o.adopt.origin.logLine = '' }, 'job.log does not name the origin kind and job'],
    ['the arms start on another version than ADR 0009 gives', o => { o.adopt.meta.files.comparison.origin.capabilityVersion = 'v9' }, 'the arms start on v9'],
    ['the origin\'s feedback set is not the source job\'s', o => { o.adopt.meta.files.comparison.origin.feedbackIds = ['f9'] }, 'the origin\'s feedback set is not the source job\'s'],
    ['the project has no feedback job', o => { o.adopt.origin.jobs = [] }, 'no finished feedback job'],
    ['the origin facts are missing', o => { delete o.reject.origin }, 'reject: comparison.json, the meta job or the origin facts are missing'],
    ['the origin names the meta project instead of the feedback project', o => { o.reject.meta.files.comparison.origin.projectId = PB }, 'reject: the origin names project pb, not the feedback project'],
    ['the meta job from another project lives in the origin project', o => { o.reject.projectIds.meta = PA }, 'the meta job was meant to live in another project'],
    ['the arms\' ledger is not in the origin project', o => { o.reject.newLedger = [] }, 'the arms\' ledger records are not in the origin project'],
    ['no comparison had its origin in another project', o => { delete o.reject.metaFrom }, 'no comparison had its origin in another project'],
  ],
  H08: [
    ['a working file hash changed', o => { o.adopt.after.work['a.txt'] = 'h2' }, 'the meta job changed file a.txt'],
    ['a working file was added', o => { o.reject.after.work['b.txt'] = 'h3' }, 'reject: the meta job changed file b.txt'],
    ['a capability file changed', o => { o.adopt.after.capabilities.c = 2 }, 'changed capabilities c'],
    ['a new ordinary session appeared', o => { o.adopt.after.sessions.s9 = { purpose: 'chat' } }, 'changed session s9'],
    ['config.json changed', o => { o.reject.after.config = '{"x":1}' }, 'config.json'],
    ['deliverables changed', o => { o.adopt.after.deliverables = ['x'] }, 'deliverables'],
    ['an arm session is in the real project', o => { o.adopt.after.sessions['arm-1'] = { purpose: 'improvement', phase: 'diagnose' } }, 'is in the real project\'s sessions'],
    ['no arm records were written', o => { o.reject.newLedger = [] }, 'no arm records'],
    ['the before state is missing', o => { delete o.adopt.before }, 'project state before / after the meta job missing'],
    ['the user line before is missing', o => { delete o.adopt.improversBefore }, 'adopt: the user-level improver line before / after is missing'],
    ['an arm added a revision to the user line', o => { o.reject.improvers.history.push({ revision: 1, trigger: 'meta-job', jobId: 'job-m', version: CHILD }) }, 'reject: 1 revision(s) added to the user\'s improver line'],
    ['the adoption is not the meta job\'s', o => { o.adopt.improvers.history[0].jobId = 'job-arm' }, 'is not the meta job\'s adoption of its child'],
    ['an earlier revision changed', o => { o.adopt.improversBefore.history = [{ revision: 0, version: 'v0' }]; o.adopt.improvers.history.unshift({ revision: 0, version: 'v9' }) }, 'earlier revisions of the user\'s improver line changed'],
    ['a stray improver is stored in the user line', o => { o.reject.improvers.versions = ['h-stray'] }, 'improvers other than the child stored in the user\'s line'],
  ],
  H09: [
    ['the adopted child has no offspring', o => { delete o.adopt.meta.files.comparison.child.candidateId }, 'without offspring'],
    ['the child arm did not run on the child improver', o => { o.adopt.meta.files.comparison.child.improverVersion = 'v0' }, 'did not run on the child improver'],
    ['no child propose request in the ledger', o => { o.adopt.newLedger = [] }, 'no child-arm propose request'],
    ['the child arm opened no diagnose session', o => { o.adopt.armSessions = [] }, 'opened no diagnose session'],
    ['a child without offspring was not rejected as no-offspring', o => { o.reject.meta.files.comparison.verdict.reason = 'no-improvement' }, 'want reject (no-offspring)'],
    ['the rejected child has offspring', o => { o.reject.meta.files.comparison.child.candidateId = 'cand-c' }, 'reject: the child arm has offspring'],
    ['the rejected child did not run its diagnosis', o => { o.reject.newLedger = [] }, 'reject: the child arm did not run its diagnosis'],
    ['the improver in force is not v0 after the reject', o => { o.reject.improvers.current.version = CHILD }, 'reject: improver in force'],
    ['a comparison.json is missing', o => { delete o.reject.meta.files.comparison }, 'comparison.json of the adopt and reject meta jobs is missing'],
  ],
  H10: [
    ['the product verdict differs from the recomputation', o => { o.adopt.meta.files.comparison.verdict = { outcome: 'adopt', reason: 'quality-up' } }, 'recomputed adopt (gate-passed)'],
    ['the product adopts where the rule rejects', o => { o.reject.meta.files.comparison.verdict = { outcome: 'adopt', reason: 'gate-passed' } }, 'recomputed reject (no-offspring)'],
    ['an arm\'s cost is unknown', o => { o.adopt.meta.files.comparison.child.cost.estimatedUsd = 'unknown' }, 'an arm\'s cost is not known'],
    ['the rule grid disagrees', o => { o.ruleGrid = { disagreements: 2 } }, 'the rule grid disagrees with decideImprover in 2 cases'],
    ['comparison.json is missing', o => { delete o.reject.meta.files.comparison }, 'reject: no comparison.json'],
  ],
  H11: [
    ['the next job pinned v0', o => { o.adopt.next.improverVersion = 'v0' }, 'the next job pinned v0'],
    ['the next job has the parent\'s pid', o => { o.adopt.next.pid = o.adopt.next.parentPid }, 'not started from a new OS process'],
    ['the next job failed', o => { o.adopt.next.code = 1 }, 'the next job\'s process: exit 1'],
    ['the improver in force is not the child', o => { o.adopt.improvers.current.version = 'v0' }, 'improver in force after the meta job'],
    ['the revision was not made by the meta job', o => { o.adopt.improvers.current.trigger = 'manual' }, 'trigger manual'],
    ['a ledger record is on another version', o => { o.adopt.facts.ledger.push({ improvementId: 'job-n', improverVersion: 'v0' }) }, 'ledger records are not all on the child'],
    ['the next job has no ledger records', o => { o.adopt.facts.ledger = [] }, 'the next job has no ledger records'],
    ['a session header is not on the child', o => { o.adopt.facts.sessions[0].improverVersion = 'v0' }, 'session headers are not on the child'],
    ['another job ran on the child first', o => { o.adopt.jobs.push({ id: 'job-early', improverVersion: CHILD, createdAt: T3 }) }, 'the first real job on the child is job-early'],
    ['the next job\'s scope is project', o => { o.adopt.facts.jobs[0].improverScope = 'project' }, 'improverScope project (want user)'],
    ['the next job\'s job.json has no scope', o => { o.adopt.facts.jobs = [] }, 'improverScope absent (want user)'],
  ],
  H12: [
    ['an improver revision exists after the reject', o => { o.reject.improvers.history.push({ revision: 1 }) }, 'with 1 revisions'],
    ['the improver in force is not v0', o => { o.reject.improvers.current.version = CHILD }, 'the improver in force is'],
    ['the meta job did not end rejected', o => { o.reject.meta.status = 'failed' }, 'the meta job ended failed'],
    ['the reason is lost', o => { delete o.reject.meta.files.comparison.verdict.reason }, 'comparison.json keeps no reason'],
    ['change.json is gone', o => { delete o.reject.meta.files.change }, 'change.json is gone'],
    ['an arm result is lost', o => { delete o.reject.meta.files.comparison.child.status }, 'comparison.json keeps no child arm result'],
    ['job.json does not say rejected', o => { o.reject.meta.files.job.status = 'adopted' }, 'job.json says adopted'],
    ['the next job pinned the child', o => { o.reject.next.improverVersion = CHILD }, 'not v0'],
  ],
  H13: [
    ['the epoch is unchanged after the costRatioCap edit', o => { o.reject.extra.epochAfter = EPOCH; o.reject.extra.epochAfterOther = EPOCH }, 'the epoch did not change with an evaluator setting'],
    ['costRatioCap was not changed', o => { o.reject.extra.costRatioCap.after = 1.2 }, 'costRatioCap was not changed in config.json'],
    ['a non-evaluator setting changed the epoch', o => { o.reject.extra.epochAfterOther = h('4') }, 'non-evaluator setting'],
    ['a stored improver names an evaluator key', o => { o.evaluatorKeysInImprovers = ['costApprovalRatio'] }, 'a stored improver names evaluator fields: costApprovalRatio'],
    ['an evaluator-field proposal was not refused', o => { o.reject.extra.bounds.status = 'adopted' }, 'naming an evaluator field was not refused'],
    ['a meta job changed config.json', o => { o.reject.extra.configAfter = '{"x":1}' }, 'a meta job changed config.json'],
    ['the comparison ran in another epoch', o => { o.reject.meta.files.comparison.origin.epoch = EPOCH2 }, 'the comparison did not run in the project\'s epoch'],
    ['decideImprover accepts arms from two epochs', o => { o.crossEpochProduct = { reason: 'no-improvement' } }, 'decideImprover on arms from two epochs: no-improvement'],
    ['there is no epoch before', o => { o.reject.extra.epochBefore = 'x' }, 'no epoch before'],
    ['the rules id is still adr-0008', o => { o.reject.extra.rules.id = 'adr-0008' }, 'the evaluator rules id is adr-0008'],
    ['the rules id is the superseded adr-0013', o => { o.reject.extra.rules.id = 'adr-0013'; o.reject.extra.rules.constant = 'adr-0013' }, 'the evaluator rules id is adr-0013 (want adr-0014)'],
    ['the epoch did not move with the rules id', o => { o.reject.extra.rules.epochAdr0008 = EPOCH }, 'equals the one the same settings had under adr-0008'],
    ['the project\'s epoch is another one', o => { o.reject.extra.rules.projectEpoch = EPOCH2 }, 'the project\'s epoch is not the one computed'],
    ['trials of one epoch cannot be compared', o => { o.reject.extra.rules.sameEpoch = 'improvement/epoch-mismatch' }, 'two trials of one epoch could not be compared'],
    ['trials of two rule ids are compared', o => { o.reject.extra.rules.mixed = EPOCH }, 'trials of the adr-0014 and adr-0008 epochs'],
  ],
  H14: [
    ['the stopped meta job is not budget-exhausted', o => { o.trigger.budget.stopped.status = 'failed' }, 'a meta job over the meta budget ended failed'],
    ['the next meta job is not refused', o => { o.trigger.budget.refused = { code: 'improvement/busy' } }, 'the next meta job was improvement/busy'],
    ['meta requests differ from the sum of parts', o => { o.adopt.costs.meta.requests = 5 }, 'metaJobId requests 5'],
    ['a part has no requests', o => { o.adopt.costs.childArm.requests = 0 }, 'no childArm requests found by attribution'],
    ['an arm record names another meta job', o => { o.adopt.newLedger[0].metaJobId = 'job-other' }, 'does not name the meta job as metaJobId'],
    ['the meta job wrote records under the source job', o => { o.adopt.newLedger.push({ improvementId: 'job-f' }) }, 'wrote records under the source job'],
    ['a meta job record carries another phase', o => { o.adopt.newLedger.push({ improvementId: 'job-m', improvementPhase: 'diagnose', type: 'request' }) }, 'carries another phase'],
    ['the cost observations are missing', o => { delete o.adopt.costs }, 'the budget or cost observations are missing'],
    ['the budget is set in the project config', o => { o.trigger.budget.via = 'project config' }, 'the meta budget was not set in the user config'],
    ['the second project still runs a meta job', o => { o.trigger.budget.refusedSecond = { status: 'meta-diagnosing' } }, 'a meta job from the second project of the same user was started'],
    ['the user\'s budget status is not exhausted', o => { o.trigger.budget.status = { exhausted: false } }, 'the user\'s meta budget status is not exhausted'],
  ],
  H15: [
    ['the meta diagnosis was asked twice', o => { o.trigger.h15.metaDiagnoseRequests = 2 }, 'asked 2 times'],
    ['a second meta job of the same user was started', o => { o.trigger.h15.secondMeta = { id: 'job-2', status: 'meta-diagnosing' } }, 'a second meta job of the same user (other project) was started'],
    ['an ordinary job during the meta job was refused', o => { o.trigger.h15.ordinary = { code: 'improvement/busy' } }, 'an ordinary job during the meta job was improvement/busy'],
    ['the ordinary job did not finish', o => { o.trigger.h15.ordinary.status = 'diagnosing' }, 'the ordinary job ended diagnosing'],
    ['the meta job was not running while the ordinary job ran', o => { o.trigger.h15.statusDuringOrdinary = 'queued' }, 'the meta job was queued while the ordinary job ran'],
    ['the meta slot held another job', o => { o.trigger.h15.slot = { jobId: 'job-o' } }, 'the user\'s meta slot held job-o'],
    ['the meta slot is still held after recovery', o => { o.trigger.h15.slotAfter = { jobId: 'job-h' } }, 'still held job-h after recovery'],
    ['the killed meta job is not interrupted', o => { o.trigger.h15.statusAfter = 'meta-diagnosing' }, 'after the next start the meta job is meta-diagnosing'],
    ['the meta job process started twice', o => { o.trigger.h15.starts = 2 }, 'started 2 times'],
    ['the meta job was not diagnosing when killed', o => { o.trigger.h15.statusBeforeKill = 'comparing' }, 'was comparing when killed'],
    ['killing the process failed', o => { o.trigger.h15.killed = { error: 'ESRCH' } }, 'killing the meta job\'s process: ESRCH'],
  ],
  H16: [
    ['an over-limit copy is still on disk', o => { o.copyLimit.exists = true }, 'still on disk'],
    ['the over-limit copy was not too-large', o => { o.copyLimit.status = 'ok' }, 'a copy over the limit: ok'],
    ['the over-limit case was not tried', o => { delete o.copyLimit }, 'the over-limit copy was not tried'],
    ['keepCopies registered one copy', o => { o.reject.kept.pop() }, 'registered 1 copies'],
    ['a kept copy has no project', o => { o.reject.kept[0].hasProject = false }, 'is not there with its project'],
    ['the default job left a copy in the temp directory', o => { o.adopt.tempAfter = ['/tmp/copy'] }, 'left 1 copies'],
    ['the default job registered kept copies', o => { o.adopt.meta.files.comparison.kept = [] }, 'registered kept copies'],
  ],
  H17: [
    ['a schema issue in the ledger', o => { o.adopt.records.issues = ['bad record'] }, '1 schema issues, first bad record'],
    ['a schema issue in an improvement file', o => { o.reject.records.fileIssues = [{ path: 'comparison.json', message: 'nope' }] }, 'improvement-file issues, first comparison.json: nope'],
    ['the test key is in .nexgent/', o => { o.trigger.records.secretHits = ['.nexgent/x'] }, 'the test key is in .nexgent/x'],
    ['the test key is in the export', o => { o.export.secretHits = ['a'] }, 'the test key is in the export: a'],
    ['the export failed', o => { o.export = { code: 1, stderr: 'boom' } }, 'the export of the meta project failed'],
    ['no comparison file was checked', o => { for (const r of [o.trigger.records, o.trigger.secondRecords, o.adopt.records, o.reject.records, o.reject.metaRecords]) r.checked.kinds = KINDS.filter(k => k !== 'comparison') }, 'no comparison file was checked'],
    ['nothing was checked', o => { o.reject.records.checked = { sessions: 0, ledger: 0, files: 0, kinds: [] } }, 'reject: nothing checked'],
    ['a records block is missing', o => { delete o.adopt.records }, 'adopt: records missing'],
    ['the second project\'s records are missing', o => { delete o.trigger.secondRecords }, 'trigger second: records missing'],
    ['the reject meta project\'s records are missing', o => { delete o.reject.metaRecords }, 'reject meta project: records missing'],
    ['a pinned job says project scope', o => { o.adopt.records.scopes = [{ id: 'job-n', improverScope: 'project' }] }, 'adopt: job job-n improverScope project'],
    ['no user queue was checked', o => { for (const p of ['trigger', 'adopt', 'reject']) o[p].records.checked.kinds = KINDS.filter(k => k !== 'userQueue'); o.trigger.secondRecords.checked.kinds = []; o.reject.metaRecords.checked.kinds = [] }, 'no userQueue file was checked'],
    ['no user config was checked', o => { for (const r of [o.trigger.records, o.trigger.secondRecords, o.adopt.records, o.reject.records, o.reject.metaRecords]) r.checked.userConfig = false }, 'no user config was checked'],
  ],
}

// The declared CheckResult ({ pass }) does not match what the judges return ({ status }); read them as returned.
type Verdict = { readonly status: 'passed' | 'failed'; readonly evidence: string }
const run = (judge: (obs: Obs | undefined) => Verdict, obs: Obs | undefined): Verdict => judge(obs)
const failed = (evidence: unknown) => ({ status: 'failed', evidence })

describe('step 6 meta-improvement judges', () => {
  describe('the good observation', () => {
    it.each(Object.entries(META_JUDGES))('%s passes', (_id, judge) => {
      const r = run(judge, good())
      expect(r.status, r.evidence).toBe('passed')
    })

    it.each(Object.entries(META_JUDGES))('%s fails on undefined and on an empty observation', (_id, judge) => {
      expect(run(judge, undefined).status).toBe('failed')
      expect(run(judge, {}).status).toBe('failed')
    })

    it('has a counterexample list for every judge', () => {
      expect(Object.keys(COUNTERS).sort()).toEqual(Object.keys(META_JUDGES).sort())
    })
  })

  for (const [id, cases] of Object.entries(COUNTERS)) {
    describe(`${id} counterexamples`, () => {
      it.each(cases)('fails when %s', (_name, mutate, phrase) => {
        const judge = META_JUDGES[id as keyof typeof META_JUDGES]
        expect(run(judge, mutated(mutate))).toEqual(failed(expect.stringContaining(phrase)))
      })
    })
  }

  describe('H07 expectedOrigin', () => {
    const meta = { id: 'job-m', createdAt: T5 }
    const job = (id: string, status: string, extra: object = {}) => ({ id, kind: 'capability', status, createdAt: T1, updatedAt: T2, history: [], feedbackIds: ['f1'], taskVersions: { t: 'v-task' }, ...extra })

    it('prefers an unresolved job over a later adopted one', () => {
      const facts = { jobs: [job('a', 'rejected', { baseVersion: 'v-base', baselineFeedbackPassRate: 0 }), job('b', 'adopted', { updatedAt: T4 })] }
      expect(expectedOrigin(facts, meta)).toEqual({ kind: 'unresolved', jobId: 'a', versions: ['v-base'], feedbackIds: ['f1'] })
    })

    it.each(['failed', 'no-proposal'])('counts a %s job as unresolved', status => {
      expect(expectedOrigin({ jobs: [job('a', status, { baseVersion: 'v-base' })] }, meta)?.kind).toBe('unresolved')
    })

    it('skips an unresolved job whose baseline already passed every feedback check', () => {
      const facts = { jobs: [job('a', 'rejected', { baselineFeedbackPassRate: 1, baseVersion: 'v-base' })] }
      expect(expectedOrigin(facts, meta)).toEqual({ kind: 'feedback-version', jobId: 'a', versions: ['v-task'], feedbackIds: ['f1'] })
    })

    it('takes the latest finished feedback job on the versions its tasks ran on', () => {
      const facts = { jobs: [job('a', 'adopted', { updatedAt: T2, taskVersions: { t: 'v1' } }), job('b', 'adopted', { updatedAt: T4, taskVersions: { t: 'v2', u: 'v2', w: 'v3' } })] }
      expect(expectedOrigin(facts, meta)).toEqual({ kind: 'feedback-version', jobId: 'b', versions: ['v2', 'v3'], feedbackIds: ['f1'] })
    })

    it('takes the version in force when the job left the queue from the revisions', () => {
      const facts = {
        jobs: [job('a', 'rejected', { createdAt: T1, history: [{ status: 'queued', at: T1 }, { status: 'diagnosing', at: T3 }] })],
        revisions: [{ committedAt: T2, version: 'r1' }, { committedAt: T4, version: 'r2' }],
      }
      expect(expectedOrigin(facts, meta)?.versions).toEqual(['r1'])
    })

    it('falls back to the baseline when no revision was committed yet', () => {
      const facts = { jobs: [job('a', 'rejected')], revisions: [{ committedAt: T4, version: 'r2' }] }
      expect(expectedOrigin(facts, meta)?.versions).toEqual(['baseline'])
    })

    it('returns undefined without a feedback job', () => {
      expect(expectedOrigin({ jobs: [] }, meta)).toBeUndefined()
      expect(expectedOrigin(undefined, meta)).toBeUndefined()
      expect(expectedOrigin({ jobs: [job('a', 'adopted', { feedbackIds: [] })] }, meta)).toBeUndefined()
    })

    it('ignores meta jobs, arm jobs, unfinished jobs, later jobs and the meta job itself', () => {
      const facts = {
        jobs: [
          job('m1', 'rejected', { kind: 'meta' }),
          job('arm', 'rejected', { arm: 'child' }),
          job('run', 'trialing'),
          job('late', 'rejected', { createdAt: '2026-01-01T00:00:09.000Z' }),
          job('job-m', 'rejected'),
        ],
      }
      expect(expectedOrigin(facts, meta)).toBeUndefined()
    })
  })

  it('H07 fails when both projects start from the same origin kind', () => {
    const o = mutated(x => { x.reject.origin.jobs[0].status = 'adopted' })
    // The reject project now gives feedback-version, so its unresolved origin is wrong and no unresolved comparison remains.
    expect(run(judgeOrigin, o)).toEqual(failed(expect.stringContaining('reject: origin unresolved job job-f, ADR 0009 gives feedback-version')))
  })
})
