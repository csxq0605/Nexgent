#!/usr/bin/env node
/**
 * Child process for the step-3 kill checks (H03): opens one session through
 * `@nexgent/sdk` with the step-3 rows, runs one turn and prints its events
 * as JSON lines. The acceptance script kills this process part-way through.
 *
 * Usage: node step3-driver.mjs '<json spec>'   spec: { root, home, sessionId, text, env }
 */
import { eventLine, runTurn } from './step2-runtime.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = line => process.stdout.write(`${line}\n`)

const loaded = await loadStep3Packages()
if (!loaded.ok) {
  write(JSON.stringify({ type: 'driver.error', message: loaded.reason }))
  process.exit(2)
}
const sdk = createStep3Sdk(loaded.pkgs, { env: spec.env, home: spec.home })
const project = await sdk.call('projects.open', { root: spec.root })
await sdk.openSession({ projectId: project.projectId, sessionId: spec.sessionId })
write(JSON.stringify({ type: 'driver.ready', pid: process.pid, sessionId: spec.sessionId }))
const { result, error } = await runTurn(sdk, { projectId: project.projectId, sessionId: spec.sessionId, text: spec.text }, {
  onEvent(event) {
    const line = eventLine(event)
    if (line !== undefined) write(line)
  },
})
write(JSON.stringify({ type: 'driver.done', reason: result?.reason, error: error === undefined ? undefined : String(error) }))
await sdk.dispose()
