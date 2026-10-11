#!/usr/bin/env node
/**
 * Child process for the step-2 kill checks (H15, H16): boots the step-2
 * runtime (step2-runtime.mjs), resumes one session, runs one turn and prints
 * its events as JSON lines (`tool.start` in the CLI's `--json` shape, so
 * test-support's `crashDuringTool` can wait for it). The acceptance script
 * kills this process part-way through.
 *
 * Usage: node step2-driver.mjs '<json spec>'
 *   spec: { root, sessionId, text, env, context? }
 */
import { bootStep2, eventLine, loadStep2Packages, runTurn } from './step2-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = line => process.stdout.write(`${line}\n`)

const loaded = await loadStep2Packages()
if (!loaded.ok) {
  write(JSON.stringify({ type: 'driver.error', message: loaded.reason }))
  process.exit(2)
}
const { app } = await bootStep2(loaded.pkgs, { root: spec.root, env: spec.env, context: spec.context ?? {} })
const agent = await app.agents.resume(spec.sessionId)
write(JSON.stringify({ type: 'driver.ready', pid: process.pid, sessionId: agent.sessionId }))
const { result, error } = await runTurn(agent, { text: spec.text }, {
  onEvent(event) {
    if (event.type === 'request.start') write(JSON.stringify({ type: 'request.start', requestId: event.requestId }))
    const line = eventLine(event)
    if (line !== undefined) write(line)
  },
})
write(JSON.stringify({ type: 'driver.done', reason: result?.reason, error: error === undefined ? undefined : String(error) }))
await agent.close()
await app.dispose()
