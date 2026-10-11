#!/usr/bin/env node
/**
 * Child process for the step-2 kill checks (H15, H16): opens one session
 * through `@nexgent/sdk`, runs one turn and prints its events as JSON lines
 * (`tool.start` in the CLI's `--json` shape, so test-support's
 * `crashDuringTool` can wait for it). The acceptance script kills this
 * process part-way through.
 *
 * Usage: node step2-driver.mjs '<json spec>'
 *   spec: { root, home, sessionId, text, env }
 */
import { createStep2Sdk, eventLine, loadStep2Packages, runTurn } from './step2-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = line => process.stdout.write(`${line}\n`)

const loaded = await loadStep2Packages()
if (!loaded.ok) {
  write(JSON.stringify({ type: 'driver.error', message: loaded.reason }))
  process.exit(2)
}
const sdk = createStep2Sdk(loaded.pkgs, { env: spec.env, home: spec.home })
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
