#!/usr/bin/env node
/**
 * Child process of the step-5 concurrency phase (H15): opens the project through
 * `@nexgent/sdk` with the evolve row, submits one feedback on one deliverable,
 * waits for the feedback turn and for the plugin to count it, then exits.
 * Prints JSON lines. Scripted model server only.
 *
 * Usage: node step5-driver.mjs '<json spec>'
 *   spec: { root, home, baseUrl, key, sessionId, deliverableId, version, rating?, comment, stages, startAt }
 */
import { createStep5Sdk, improvementsPath, loadStep5Packages } from './step5-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const loaded = await loadStep5Packages()
if (!loaded.ok) {
  write({ type: 'driver.error', message: loaded.reason })
  process.exit(2)
}
const pkgs = loaded.pkgs
const sdk = createStep5Sdk(pkgs, { env: { NEXGENT_API_BASE_URL: spec.baseUrl, NEXGENT_API_KEY: spec.key, NEXGENT_HOME: spec.home }, home: spec.home, evolve: { stages: spec.stages } })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  const { projectId } = await sdk.call('projects.open', { root: spec.root })
  await sdk.openSession({ projectId, sessionId: spec.sessionId })
  write({ type: 'driver.ready', pid: process.pid })
  // Start together: both children wait for the same wall-clock instant.
  await sleep(Math.max(0, spec.startAt - Date.now()))
  let ended = false
  const off = sdk.onAgentEvent(event => { if (event.sessionId === spec.sessionId && event.type === 'turn.end') ended = true })
  await sdk.call('feedback.submit', { projectId, sessionId: spec.sessionId, deliverableId: spec.deliverableId, version: spec.version, ...(spec.rating === undefined ? {} : { rating: spec.rating }), comment: spec.comment })
  for (let i = 0; i < 600 && !(ended && !sdk.isRunning(projectId, spec.sessionId)); i += 1) await sleep(20)
  off()
  const listing = await sdk.call('feedback.list', { projectId, sessionId: spec.sessionId })
  const id = listing.find(entry => entry.comment === spec.comment)?.id
  // The plugin counts in the background when the turn starts: wait until this feedback is in `counted`.
  let counted = false
  for (let i = 0; i < 250 && !counted; i += 1) {
    const queue = await pkgs.evolve.readQueue(improvementsPath(spec.root)).catch(() => undefined)
    counted = (queue?.counted ?? []).includes(`feedback:${id}`)
    if (!counted) await sleep(20)
  }
  write({ type: 'driver.done', feedbackId: id, counted, turnEnded: ended })
} catch (error) {
  write({ type: 'driver.error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  await sdk.dispose()
}
