/**
 * Judges of accept-step5's headless items whose product parts have landed
 * (docs/plan/step-5-work-partition.md §`accept-step5` 检查项清单): H01–H04 (three
 * triggers, the switch), H15 (one job at a time, no double count, interrupted jobs)
 * and H16 (per-turn snapshots and checks). Pure functions over the observations of
 * the step-5 headless scenario (step5-headless.mjs); counterexamples in
 * packages/test-support/tests/accept-step5-judges.spec.ts.
 *
 * Observation shape (the scenario maps the product's files and SDK answers onto it):
 *
 *   features.evolvePackage   `@nexgent/evolve` is built (else H01–H04, H15 are not-implemented)
 *   features.shipped         the SDK as shipped runs the flow (`improvements.list` answers); until it
 *                            does the scenario inserts the evolve row itself, and a judge whose
 *                            conditions all hold still reports not-implemented ("checked so far")
 *   trigger.counting         FEEDBACK in order; after each: { key, rating?, comment, feedbackId,
 *                            queue: pending feedback ids, counted: signal keys, jobs: [jobView] }
 *   trigger.explicit         { autoImprove: false, queueBefore: [], via: 'sdk' | 'host', sdkError?,
 *                            job?: { trigger, status }, error? }
 *   trigger.checkFailure     { failedChecks, queueBefore: keys, queueAfter: keys, jobs }
 *   trigger.disabled         { autoImprove: false, submitted, recorded, jobs }
 *   concurrency              { submitted: ids from two processes, queue: counted feedback ids,
 *                            allCounted, jobStarted, jobs, maxRunning, drivers }
 *   recovery                 { jobId, statusAfterRestart, starts, reruns, adoptedBefore, adoptedAfter }
 *   turns                    { taskId, feedbackTurns, before: files, after: files }; files:
 *                            { tasks: { <turn>: { sha } }, checks: { <turn>: { sha } }, legacy: { tasks, checks } }
 *
 * Evidence of a pass names what was seen; an unknown result is not a pass.
 */
import { countsTowardImprovement, THRESHOLD } from '../real-task/step5-orders.mjs'
import { partial, verdict } from './step2-judges.mjs'

const NO_EVOLVE = '@nexgent/evolve is not built in this workspace'
const NOT_SHIPPED = 'the SDK does not run the improvement flow yet (W4: EvolvePlugin row, job entry, improvements.*); the scenario inserted the evolve row itself'
const pending = evidence => ({ status: 'not-implemented', evidence })
const missing = what => ({ status: 'failed', evidence: `${what} was not observed` })

/** Wrap an evolve judge: not-implemented without the package; a missing phase fails; a pass without the shipped SDK is partial. */
const needs = (path, fn) => (obs) => {
  if (obs?.features?.evolvePackage !== true) return pending(NO_EVOLVE)
  const value = path.split('.').reduce((at, key) => at?.[key], obs)
  if (value === undefined) {
    const phase = Object.keys(obs.errors ?? {}).find(name => path.toLowerCase().includes(name.replace('-', '').toLowerCase()))
    return phase === undefined ? missing(path) : { status: 'failed', evidence: `${path}: phase ${phase} failed: ${String(obs.errors[phase]).split('\n')[0]}` }
  }
  const { conditions, evidence, extraMissing } = fn(value, obs)
  if (obs.features.shipped === true && extraMissing === undefined) return verdict(conditions, evidence)
  return partial(conditions, [obs.features.shipped === true ? undefined : NOT_SHIPPED, extraMissing].filter(Boolean).join('; '), evidence)
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()
const feedbackKeys = keys => (keys ?? []).filter(key => key.startsWith('feedback:'))

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
    return { conditions, evidence: `${counted.length} counted and ${uncounted} uncounted feedbacks; no job before the ${THRESHOLD}rd counted, one job (trigger feedback-count, status ${started?.jobs?.[0]?.status}) at it citing exactly the counted ones, batch taken from the queue` }
  }),

  // 显式触发：“改进”动作在计数为 0 时立即开始作业；autoImprove 关时也能显式触发
  H02: needs('trigger.explicit', phase => ({
    conditions: [
      [phase.error === undefined, `the explicit start failed: ${phase.error}`],
      [phase.autoImprove === false, 'autoImprove was not off during the explicit start'],
      [(phase.queueBefore ?? []).length === 0, `the queue was not empty before (${JSON.stringify(phase.queueBefore)})`],
      [phase.job?.trigger === 'explicit', `the job's trigger is ${phase.job?.trigger}, expected explicit`],
      [typeof phase.job?.status === 'string', 'the job has no status'],
    ],
    evidence: `with autoImprove off and an empty queue, an explicit run started a job (trigger explicit, status ${phase.job?.status}) via ${phase.via}`,
    extraMissing: phase.via === 'sdk' ? undefined : `SDK improvements.run refused (${phase.sdkError ?? 'no answer'}); the job was started through the plugin's host`,
  })),

  // 检查失败触发：根任务检查失败计一次
  H03: needs('trigger.checkFailure', (phase) => {
    const before = phase.queueBefore ?? []
    const after = phase.queueAfter ?? []
    const added = after.filter(key => !before.includes(key))
    return {
      conditions: [
        [phase.failedChecks > 0, 'the root task had no failed check'],
        [after.length === before.length + 1, `the queue went from ${before.length} to ${after.length}, expected +1`],
        [added.length === 1 && added[0].startsWith('check:'), `the added signal is ${JSON.stringify(added)}, expected one check:<taskId>:<turn>`],
        [before.every(key => after.includes(key)), 'earlier queue entries were lost'],
        [before.length + 1 < THRESHOLD, `the phase must stay below the threshold to see the count (queue was ${before.length})`],
        [(phase.jobs ?? []).length === 0, 'a job started below the threshold'],
      ],
      evidence: `a root task with ${phase.failedChecks} failed check(s) counted once (${added[0]})`,
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

  // 并发与恢复：同一项目同时只有一个作业；两进程同时提交反馈不重计；作业进程被强杀后下次启动标为中断，不重跑
  H15: needs('concurrency', (phase, obs) => {
    const recovery = obs.recovery
    const submitted = phase.submitted ?? []
    const queue = phase.queue ?? []
    return {
      conditions: [
        [submitted.length >= 2, `fewer than two concurrent submissions succeeded (${(phase.drivers ?? []).map(d => d.error).filter(Boolean).join('; ')})`],
        [new Set(queue).size === queue.length, `the counted set has an id twice (${JSON.stringify(queue)})`],
        [phase.allCounted === true && submitted.every(id => queue.includes(id)), 'a concurrent feedback was lost'],
        [phase.jobStarted === true && (phase.jobs ?? []).length === 1, `${(phase.jobs ?? []).length} jobs were created, expected 1`],
        [phase.maxRunning === 1, `${phase.maxRunning} jobs ran at once in one project`],
        [recovery !== undefined && recovery.killError === undefined, `the job process was not killed (${recovery?.killError})`],
        [recovery?.statusAfterRestart === 'interrupted', `after the kill the job is ${recovery?.statusAfterRestart}, expected interrupted`],
        [recovery?.reruns === 0, `the interrupted job ran again ${recovery?.reruns} time(s)`],
        [recovery !== undefined && recovery.adoptedBefore !== undefined && recovery.adoptedBefore === recovery.adoptedAfter, `the adopted version changed across the kill (${recovery?.adoptedBefore} → ${recovery?.adoptedAfter})`],
      ],
      evidence: `${submitted.length} feedbacks from two processes at once, each counted once; one job, at most one running; killed in ${recovery?.statusBeforeKill}, interrupted after restart, not rerun; version ${recovery?.adoptedAfter} kept`,
    }
  }),

  // 每轮记录：反馈轮的检查与快照不覆盖原轮
  H16: (obs) => {
    const turns = obs?.turns
    if (turns === undefined) return obs?.errors?.counting === undefined ? missing('turns') : { status: 'failed', evidence: `counting phase failed: ${String(obs.errors.counting).split('\n')[0]}` }
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
