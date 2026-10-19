#!/usr/bin/env node
/**
 * Child process of the step-6 headless scenario, through `@nexgent/sdk` as shipped.
 * Prints JSON lines. Scripted model server only.
 *
 *   improve  (H11) opens the project in a process that never saw the meta job, starts
 *            one explicit improvement job on a session and waits until it settles
 *
 * Usage: node step6-driver.mjs '<json spec>'
 *   spec: { mode: 'improve', root, home, baseUrl, key, sessionId }
 */
import { registerHome } from './data-dir.mjs'
import { createStep5Sdk, loadStep5Packages, readImprovements } from './step5-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SETTLED = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled', 'waiting-history', 'awaiting-approval'])

const loaded = await loadStep5Packages()
if (!loaded.ok) {
  write({ type: 'driver.error', message: loaded.reason })
  process.exit(2)
}
const pkgs = loaded.pkgs
registerHome(spec.root, spec.home)
const sdk = createStep5Sdk(pkgs, { env: { NEXGENT_API_BASE_URL: spec.baseUrl, NEXGENT_API_KEY: spec.key, NEXGENT_HOME: spec.home }, home: spec.home })
try {
  const { projectId } = await sdk.call('projects.open', { root: spec.root })
  write({ type: 'driver.ready', pid: process.pid })
  const started = await sdk.call('improvements.run', { projectId, sessionId: spec.sessionId })
  let job
  for (let i = 0; i < 1_200; i += 1) {
    job = (await readImprovements(pkgs, spec.root)).jobs.find(entry => entry.id === started.id)
    if (job !== undefined && SETTLED.has(job.status)) break
    await sleep(200)
  }
  write({ type: 'driver.done', pid: process.pid, jobId: started.id, status: job?.status, improverVersion: job?.improverVersion })
} catch (error) {
  write({ type: 'driver.error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  await sdk.dispose()
}
