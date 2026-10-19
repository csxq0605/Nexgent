#!/usr/bin/env node
/**
 * Child process of the step-5 real layer (R05): opens one session of the project
 * through `@nexgent/sdk` as shipped (evolve included), runs one turn against the
 * real API and prints tool calls and the result as JSON lines. It never saw the
 * improvement job or the gate: whatever version it runs on, it picked up itself.
 *
 * The key comes from this process's inherited environment, never from the command
 * line, and is never printed.
 *
 * Usage: node step5-real-driver.mjs '<json spec>'
 *   spec: { root, home, sessionId, text, timeoutMs }
 */
import { runTurn } from './step2-runtime.mjs'
import { loadStep5Packages } from './step5-runtime.mjs'

const spec = JSON.parse(process.argv[2] ?? '{}')
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)

const loaded = await loadStep5Packages()
if (!loaded.ok) {
  write({ type: 'driver.error', message: loaded.reason })
  process.exit(2)
}
const approvals = async request => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' })
const sdk = loaded.pkgs.sdk.createSdk({ appVersion: 'accept-step5-real', env: { ...process.env, NEXGENT_HOME: spec.home }, home: spec.home, approvalResponder: approvals })
try {
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
} catch (error) {
  write({ type: 'driver.error', message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  await sdk.dispose()
}
