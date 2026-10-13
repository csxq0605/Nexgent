#!/usr/bin/env node
/**
 * Test job entry of the step-5 scripted layer: what the SDK's entry will do in
 * its `improve <projectRoot> <jobId>` mode once W4 wires it, with stages chosen
 * by `STEP5_JOB_STAGES`:
 *   pending  @nexgent/evolve's PENDING_STAGES: the job ends failed ("no runner")
 *   hold     the diagnose stage never returns: the job stays diagnosing until the
 *            process is killed (recovery, H15)
 * Prints `job-entry start <jobId> <pid>` once per run, so a rerun is visible in job.log.
 */
const [mode, root, jobId] = process.argv.slice(2)
if (mode !== 'improve' || root === undefined || jobId === undefined) {
  console.error('usage: step5-job-entry.mjs improve <projectRoot> <jobId>')
  process.exit(2)
}
const evolve = await import(new URL('../../packages/evolve/dist/index.js', import.meta.url).href)
const kernel = await import(new URL('../../packages/kernel/dist/index.js', import.meta.url).href)
console.log(`job-entry start ${jobId} ${process.pid}`)
const which = process.env.STEP5_JOB_STAGES ?? 'pending'
const hold = {
  ...evolve.PENDING_STAGES,
  diagnose: () => new Promise(() => setInterval(() => undefined, 60_000)),
}
const stages = which === 'hold' ? hold : evolve.PENDING_STAGES
const result = await evolve.runImprovementJob(kernel.resolveWorkspaceLayout(root), jobId, { stages })
console.log(`job-entry done ${result.jobs.map(job => `${job.id}:${job.status}`).join(' ')}${result.skipped ? ` skipped ${result.skipped}` : ''}`)
