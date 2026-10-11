// Child process for the team hard-kill test. The Lead creates two tasks,
// spawns bob (who finishes), then alice; alice claims t1, mails bob and the
// Lead, and the process kills itself on alice's next model request, while
// both messages are queued and not yet delivered. The Lead is meanwhile in a
// model request, so nothing wakes bob first. Prints `ids <lead>` before the kill.
import { writeSync } from 'node:fs'
import { ContextPlugin } from '@nexgent/context'
import { createApp, type Context, type LLMRequest } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { TaskingPlugin } from '@nexgent/tasking'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { TeamPlugin } from '../../src/index.js'

const [root] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: team-crash-child <projectRoot>')

function memberOf(request: LLMRequest): string | undefined {
  const system = request.messages.find(message => message.role === 'system')
  const text = typeof system?.content === 'string' ? system.content : ''
  return /^Member: ([a-z][a-z0-9-]*) \(/m.exec(text)?.[1]
}

let leadId = ''
const llm = scriptedProvider([
  { toolCalls: [
    { id: 'c1', name: 'team_task_create', arguments: { title: 'Collect' } },
    { id: 'c2', name: 'team_task_create', arguments: { title: 'Report', dependsOn: ['t1'] } },
    { id: 's1', name: 'spawn_teammate', arguments: { name: 'bob', task: 'Say you are ready.' } },
  ] },
  { toolCalls: [{ id: 'w1', name: 'wait_teammates', arguments: {} }] },
  { toolCalls: [{ id: 's2', name: 'spawn_teammate', arguments: { name: 'alice', task: 'Collect, then tell bob and the lead.' } }] },
  { content: 'thinking', chunkDelayMs: 60_000 },
], {
  routeKey: memberOf,
  routes: {
    bob: [{ content: 'bob ready' }],
    alice: [
      { toolCalls: [{ id: 'a1', name: 'team_task_update', arguments: { id: 't1', status: 'in_progress' } }] },
      { toolCalls: [
        { id: 'a2', name: 'send_message', arguments: { to: 'bob', text: 'collected for bob' } },
        { id: 'a3', name: 'send_message', arguments: { to: 'lead', text: 'collected for lead' } },
      ] },
      () => {
        writeSync(1, `ids ${leadId}\n`)
        process.kill(process.pid, 'SIGKILL')
        return { content: 'unreachable' }
      },
    ],
  },
})

const app = await createApp({
  patches: [{ id: 'workspace', config: { root } }],
  registry: {
    '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
    '@nexgent/session': SessionPlugin,
    '@nexgent/workspace': WorkspacePlugin,
  },
})
await app.ctx.plugin(TaskingPlugin)
await app.ctx.plugin(ContextPlugin)
await app.ctx.plugin(TeamPlugin)
const lead = await app.agents.create()
leadId = lead.sessionId
await lead.run('Run the team.')
