/**
 * Child process of the member recovery test (`members.spec.ts`): only the
 * SDK over a scripted model routed per member. A root session delegates to
 * `slow`, whose reply streams for a long time; once the member's text
 * arrives this prints `streaming <parentId> <childId>` and the parent kills
 * the process.
 *
 * argv: <projectRoot> <home>
 */
import type { Context } from '@nexgent/kernel'
import { llmSessionText, routeByMember, scriptedProvider } from '@nexgent/test-support'
import { createSdk } from '../../src/index.js'

const [root, home] = process.argv.slice(2) as [string, string]
const llm = scriptedProvider([
  { toolCalls: [{ name: 'delegate', arguments: { name: 'slow', task: 'Take your time' } }] },
], {
  routeKey: routeByMember(llmSessionText),
  routes: { slow: [{ content: Array.from({ length: 400 }, (_, i) => `part ${i} `), chunkDelayMs: 50 }] },
})
const sdk = createSdk({
  appVersion: '0.0.0-child',
  home,
  env: { NEXGENT_API_KEY: 'sk-test', NEXGENT_HOME: home },
  registry: { '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) } },
})
let said = false
sdk.subscribe(event => {
  if (!said && event.type === 'text.delta' && event.parentSessionId !== undefined) {
    said = true
    process.stdout.write(`streaming ${event.parentSessionId} ${event.sessionId}\n`)
  }
})
const project = await sdk.call('projects.open', { root, create: true })
const session = await sdk.call('sessions.create', { projectId: project.projectId })
await sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'Delegate it' })
// Killed while the member streams; keep the process alive until then.
await new Promise(() => undefined)
