/**
 * Judges of accept-step5's headless items that round 1 of `@nexgent/evolve`
 * covers (docs/plan/step-5-work-partition.md §`accept-step5` 检查项清单, §轮次):
 * H01–H04 (three triggers, the switch) and H15 (one job at a time, no double
 * count, interrupted jobs). Pure functions over the observations the step-5
 * headless scenario collects (step5-headless.mjs); counterexamples in
 * packages/test-support/tests/accept-step5-judges.spec.ts.
 *
 * Observation shape (the scenario maps the product's files and SDK answers onto it):
 *
 *   features.evolve          the SDK exposes the improvement flow (`improvements.*`; else every
 *                            judge here is not-implemented, never a pass)
 *   trigger.counting         autoImprove on; FEEDBACK submitted in order; after each one:
 *                            { key, rating?, comment, feedbackId, queue: ids counted so far,
 *                              jobs: [{ jobId, trigger, status, feedbackIds }] started since the
 *                              phase began }
 *   trigger.explicit         { autoImprove: false, queueBefore: [], job?: { trigger, status }, error? }
 *   trigger.checkFailure     { queueBefore, queueAfter, failedChecks: n, jobs: [] }
 *   trigger.disabled         { autoImprove: false, submitted: n, recorded: n, jobs: [] }
 *   concurrency              { submitted: [ids from two processes], queue: [...], maxRunning: n,
 *                              secondStart?: { refused: bool, reason } }
 *   recovery                 { jobId, statusAfterRestart, reruns: n, adoptedBefore, adoptedAfter }
 *
 * Evidence of a pass names what was seen; an unknown result is not a pass.
 */
import { countsTowardImprovement, THRESHOLD } from '../real-task/step5-orders.mjs'
import { verdict } from './step2-judges.mjs'

const NO_EVOLVE = 'the SDK does not expose the improvement flow yet (@nexgent/evolve is built by W2, but EvolvePlugin and improvements.* come with W4)'
const pending = evidence => ({ status: 'not-implemented', evidence })
const missing = what => ({ status: 'failed', evidence: `${what} was not observed` })

/** Wrap a judge: not-implemented without evolve; a missing phase fails. */
const needs = (path, fn) => (obs) => {
  if (obs?.features?.evolve !== true) return pending(NO_EVOLVE)
  const value = path.split('.').reduce((at, key) => at?.[key], obs)
  if (value === undefined) return missing(path)
  return fn(value, obs)
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

export const JUDGES = {
  // 计数触发：2 条计入的反馈不开始作业，第 3 条开始；不计入的反馈不加计数
  H01: needs('trigger.counting', (steps) => {
    if (!Array.isArray(steps) || steps.length === 0) return missing('the counting phase')
    const conditions = []
    const counted = []
    let started
    for (const [index, step] of steps.entries()) {
      const counts = countsTowardImprovement(step)
      if (counts) counted.push(step.feedbackId)
      const jobs = step.jobs ?? []
      if (started === undefined && counted.length < THRESHOLD) {
        conditions.push([jobs.length === 0, `feedback ${step.key} (${index + 1}) started a job with ${counted.length} counted`])
        conditions.push([sameSet(step.queue ?? [], counted), `after feedback ${step.key} the queue holds ${JSON.stringify(step.queue)}, expected the counted ids ${JSON.stringify(counted)}`])
      } else if (started === undefined) {
        started = step
        conditions.push([jobs.length === 1, `feedback ${step.key}, the ${THRESHOLD}rd counted, started ${jobs.length} jobs, expected 1`])
        conditions.push([jobs[0]?.trigger === 'feedback', `the job's trigger is ${jobs[0]?.trigger}, expected feedback`])
        conditions.push([sameSet(jobs[0]?.feedbackIds ?? [], counted), `the job cites ${JSON.stringify(jobs[0]?.feedbackIds)}, expected ${JSON.stringify(counted)}`])
        conditions.push([(step.queue ?? []).length === 0, `the queue was not cleared when the job started (${JSON.stringify(step.queue)})`])
      } else {
        conditions.push([(step.jobs ?? []).length <= 1, `feedback ${step.key} after the job started another job`])
      }
    }
    conditions.push([started !== undefined, `no step reached ${THRESHOLD} counted feedbacks`])
    const uncounted = steps.filter(step => !countsTowardImprovement(step)).length
    conditions.push([uncounted > 0, 'the phase had no uncounted feedback, so "does not count" was not tested'])
    return verdict(conditions, `${counted.length} counted and ${uncounted} uncounted feedbacks; no job before the ${THRESHOLD}rd counted, one job (trigger feedback) at it, queue cleared`)
  }),

  // 显式触发：“改进”在计数为 0 时立即开始作业；autoImprove 关时也能显式触发
  H02: needs('trigger.explicit', (phase) => verdict([
    [phase.error === undefined, `the explicit start failed: ${phase.error}`],
    [phase.autoImprove === false, 'autoImprove was not off during the explicit start'],
    [(phase.queueBefore ?? []).length === 0, `the queue was not empty before (${JSON.stringify(phase.queueBefore)})`],
    [phase.job?.trigger === 'explicit', `the job's trigger is ${phase.job?.trigger}, expected explicit`],
    [typeof phase.job?.status === 'string', 'the job has no status'],
  ], `with autoImprove off and an empty queue, "改进" started job (trigger explicit, status ${phase.job?.status})`)),

  // 检查失败触发：根任务检查失败计一次
  H03: needs('trigger.checkFailure', (phase) => {
    const before = phase.queueBefore ?? []
    const after = phase.queueAfter ?? []
    return verdict([
      [phase.failedChecks > 0, 'the root task had no failed check'],
      [after.length === before.length + 1, `the queue went from ${before.length} to ${after.length}, expected +1`],
      [before.every(id => after.includes(id)), 'earlier queue entries were lost'],
      [before.length + 1 < THRESHOLD, `the phase must stay below the threshold to see the count (queue was ${before.length})`],
      [(phase.jobs ?? []).length === 0, 'a job started below the threshold'],
    ], `a root task with ${phase.failedChecks} failed check(s) counted once (queue ${before.length} → ${after.length})`)
  }),

  // 开关：autoImprove 关时反馈照常记录，不开始作业
  H04: needs('trigger.disabled', (phase) => verdict([
    [phase.autoImprove === false, 'autoImprove was not off'],
    [phase.submitted >= THRESHOLD, `only ${phase.submitted} feedbacks were submitted; the threshold is ${THRESHOLD}`],
    [phase.recorded === phase.submitted, `${phase.recorded} of ${phase.submitted} feedbacks were recorded`],
    [(phase.jobs ?? []).length === 0, `${(phase.jobs ?? []).length} jobs started with autoImprove off`],
  ], `autoImprove off: ${phase.recorded} feedbacks recorded, no job started`)),

  // 并发与恢复：同一项目同时只有一个作业；两进程同时提交反馈不重计；作业进程被强杀后下次启动标为中断，不重跑
  H15: needs('concurrency', (phase, obs) => {
    const recovery = obs.recovery
    const submitted = phase.submitted ?? []
    const queue = phase.queue ?? []
    return verdict([
      [submitted.length >= 2, 'fewer than two concurrent submissions'],
      [new Set(queue).size === queue.length, `the queue counts an id twice (${JSON.stringify(queue)})`],
      [submitted.every(id => queue.includes(id)) || phase.jobStarted === true, 'a concurrent feedback was lost from the queue'],
      [phase.maxRunning === 1, `${phase.maxRunning} jobs ran at once in one project`],
      [phase.secondStart === undefined || phase.secondStart.refused === true, 'a second job started while one was running'],
      [recovery !== undefined, 'the kill-and-restart phase was not observed'],
      [recovery?.statusAfterRestart === 'interrupted', `after the kill the job is ${recovery?.statusAfterRestart}, expected interrupted`],
      [recovery?.reruns === 0, `the interrupted job ran again ${recovery?.reruns} time(s)`],
      [recovery !== undefined && recovery.adoptedBefore === recovery.adoptedAfter, 'the adopted version changed across the kill'],
    ], `${submitted.length} concurrent submissions counted once each; at most one job ran; the killed job is interrupted and not rerun`)
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
 * named check (not a checklist item) so a broken fixture is visible before evolve lands.
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
