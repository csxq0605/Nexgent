// Child process for the member hard-kill test: a root agent completes one
// turn, forks a member, and the process kills itself while the member's model
// request is in flight. Prints `ids <root> <member>` before the kill.
import { mkdirSync } from 'node:fs'
import {
  createApp,
  resolveWorkspaceLayout,
  type Context,
  type LLMProvider,
  type LLMStreamEvent,
  type Plugin,
  type Workspace,
} from '@nexgent/kernel'
import { SessionPlugin } from '../../src/index.js'

const [root] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: member-crash-child <projectRoot>')

const layout = resolveWorkspaceLayout(root)
const workspace: Workspace = {
  root,
  layout,
  resolve: input => (input.startsWith('/') ? input : `${root}/${input}`),
  relative: absolute => absolute.slice(root.length + 1),
  sessionDir: id => `${layout.sessions}/${id}`,
  ensureLayout: async () => {
    mkdirSync(layout.sessions, { recursive: true })
  },
}

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
let ids = ''
const llm: LLMProvider = {
  info: { id: 'anthropic', endpoint: 'https://example.invalid', defaultModel: 'scripted-model' },
  complete: request => (async function* (): AsyncGenerator<LLMStreamEvent> {
    if ((request.messages[0]!.content as string).includes('Member: helper')) {
      process.stdout.write(`ids ${ids}\n`, () => process.kill(process.pid, 'SIGKILL'))
      await new Promise(() => {})
    }
    yield { type: 'text.delta', text: 'first answer' }
    yield { type: 'usage', usage }
    yield { type: 'done', finishReason: 'stop' }
  })(),
}

const registry: Record<string, Plugin> = {
  '@nexgent/llm': { name: 'test-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
  '@nexgent/session': SessionPlugin as unknown as Plugin,
  '@nexgent/workspace': { name: 'test-workspace', apply: (ctx: Context) => { ctx.provide('workspace', workspace) } },
}
const app = await createApp({ registry })
const parent = await app.agents.create()
await parent.run('turn one')
const member = await app.agents.create({
  child: { parentSessionId: parent.sessionId, member: { name: 'helper', executionForm: 'delegated' }, mode: 'fork' },
})
ids = `${parent.sessionId} ${member.sessionId}`
await member.run('member task')
