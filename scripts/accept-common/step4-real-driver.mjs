#!/usr/bin/env node
/**
 * Child process for the step-4 real layer (R04): opens one session of the
 * project through `@nexgent/sdk` with the step-3 rows, runs one turn against
 * the real API and prints tool calls and the result as JSON lines.
 *
 * The key is read from this process's inherited environment (the variable
 * named by `keySource`), never from the command line, and never printed.
 *
 * Usage: node step4-real-driver.mjs '<json spec>'
 *   spec: { root, home, sessionId, text, keySource, baseUrl?, realModel, timeoutMs }
 */
import { runTurn } from './step2-runtime.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)

const loaded = await loadStep3Packages()
if (!loaded.ok) {
  write({ type: 'driver.error', message: loaded.reason })
  process.exit(2)
}
const env = {
  NEXGENT_API_KEY: process.env[spec.keySource] ?? '',
  NEXGENT_HOME: spec.home,
  ...(spec.baseUrl === undefined ? {} : { NEXGENT_API_BASE_URL: spec.baseUrl }),
}
const approvals = async request => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' })
const sdk = createStep3Sdk(loaded.pkgs, { env, home: spec.home, approvals, realModel: spec.realModel === true })
const project = await sdk.call('projects.open', { root: spec.root })
await sdk.openSession({ projectId: project.projectId, sessionId: spec.sessionId })
write({ type: 'driver.ready', pid: process.pid, sessionId: spec.sessionId })
const timer = setTimeout(() => {
  write({ type: 'driver.timeout', timeoutMs: spec.timeoutMs })
  sdk.cancelTurn({ projectId: project.projectId, sessionId: spec.sessionId }).catch(() => undefined)
}, spec.timeoutMs ?? 30 * 60_000)
const { result, error } = await runTurn(sdk, { projectId: project.projectId, sessionId: spec.sessionId, text: spec.text }, {
  onEvent(event) {
    if (event.type === 'tool.start') write({ type: 'tool.start', name: event.call.name, arguments: String(JSON.stringify(event.call.arguments)).slice(0, 600) })
    else if (event.type === 'tool.result') write({ type: 'tool.result', name: event.result.name, isError: event.result.isError, content: String(event.result.content).slice(0, 300) })
  },
})
clearTimeout(timer)
write({ type: 'driver.done', reason: result?.reason, error: error === undefined ? undefined : String(error instanceof Error ? error.message : error) })
await sdk.dispose()
