// Child process for the workflow hard-kill test: the root agent calls
// `workflow` with two sequential members; member `first` completes, and the
// process kills itself while member `second`'s model request is in flight.
// Prints `ids <root>` before the kill.
import { createApp, type Context, type Plugin } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { llmSessionText, routeByMember, scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { WorkflowPlugin } from '../../src/index.js'

const [root] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: workflow-crash-child <projectRoot>')

const script = "await agent('First part', { name: 'first' }); await agent('Second part', { name: 'second' }); return 'unreachable'"
let ids = ''
const llm = scriptedProvider([{ toolCalls: [{ name: 'workflow', arguments: { title: 'crash', script } }] }], {
  routeKey: routeByMember(llmSessionText),
  routes: {
    first: [{ content: 'first part done' }],
    second: [() => {
      process.stdout.write(`ids ${ids}\n`, () => process.kill(process.pid, 'SIGKILL'))
      return { content: 'never seen', chunkDelayMs: 60_000 }
    }],
  },
})

const registry: Record<string, Plugin> = {
  '@nexgent/llm': { name: 'test-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
  '@nexgent/session': SessionPlugin as unknown as Plugin,
  '@nexgent/workspace': WorkspacePlugin as unknown as Plugin,
}
const app = await createApp({ patches: [{ id: 'workspace', config: { root } }], registry })
await app.ctx.plugin(WorkflowPlugin)
const parent = await app.agents.create()
ids = parent.sessionId
await parent.run('run the workflow')
