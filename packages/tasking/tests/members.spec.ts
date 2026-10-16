/**
 * Step 3 members in the real loop (scripted model, real session, workspace
 * and tasking): `present` appends only within one session and stamps the
 * member on the version; a parent cancel stops a member's shell process tree.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  createApp,
  type Agent,
  type Context,
  type LLMRequest,
  type NexgentApp,
  type Tool,
} from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskingPlugin, type LocalTaskingService } from '../src/index.js'
import { tempDir } from './helpers.js'

const apps: NexgentApp[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
})

async function boot(root: string, script: ScriptEntry<LLMRequest>[]): Promise<{ app: NexgentApp; tasking: LocalTaskingService }> {
  const llm = scriptedProvider(script)
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
  apps.push(app)
  await app.ctx.plugin(TaskingPlugin)
  return { app, tasking: app.ctx.get('tasking') as LocalTaskingService }
}

/** Runs one member turn per name, in order, in the foreground. */
function membersTool(app: NexgentApp, names: readonly string[], started: Agent[]): Tool {
  return {
    definition: { name: 'members', description: 'Run members.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
    handler: async (_input, context) => {
      for (const name of names) {
        const member = await app.agents.create({ child: { parentSessionId: context.sessionId, member: { name, executionForm: 'delegated' } } })
        started.push(member)
        await member.run(`work as ${name}`, { signal: context.signal })
        await member.close()
      }
      return { content: 'members done' }
    },
  }
}

/**
 * Whether a process whose command line contains `marker` is still running
 * after `ms`. Pids inside a command sandbox are namespaced, so the command
 * line is the stable handle; the sandbox's PID namespace ends its processes
 * a moment after the sandbox itself, hence the short wait.
 */
async function commandRunning(marker: string, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    const running = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).split('\n').some(line => line.includes(marker))
    if (!running || Date.now() > deadline) return running
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const present = (summary: string) => ({ toolCalls: [{ name: 'present', arguments: { paths: ['out/report.md'], summary } }] })

describe('members and present', () => {
  it('keeps one deliverable per session for a shared path and names the member on its versions', async () => {
    const root = await tempDir()
    await mkdir(nodePath.join(root, 'out'), { recursive: true })
    await writeFile(nodePath.join(root, 'out', 'report.md'), '# report\n')
    const { app, tasking } = await boot(root, [
      { toolCalls: [{ name: 'members' }] },
      present('alpha v1'), present('alpha v2'), { content: 'alpha done' },
      present('beta v1'), { content: 'beta done' },
      present('root v1'), { content: 'all done' },
    ])
    const started: Agent[] = []
    app.ctx.tools.register(membersTool(app, ['alpha', 'beta'], started))
    const lead = await app.agents.create()
    const result = await lead.run('write the report')
    expect(result.reason).toEqual({ kind: 'completed' })
    const [alpha, beta] = started

    const list = await tasking.deliverables.list()
    const bySession = list.map(deliverable => deliverable.versions.map(version => [version.sessionId, version.version, version.memberId, version.memberName]))
    expect(bySession).toHaveLength(3)
    expect(bySession).toEqual(expect.arrayContaining([
      [[alpha!.sessionId, 1, alpha!.sessionId, 'alpha'], [alpha!.sessionId, 2, alpha!.sessionId, 'alpha']],
      [[beta!.sessionId, 1, beta!.sessionId, 'beta']],
      [[lead.sessionId, 1, undefined, undefined]],
    ]))
    const { records } = await app.ctx.session.readAll(alpha!.sessionId)
    const presented = records.filter(record => record.type === 'deliverable.presented')
    expect(presented.map(record => record.type === 'deliverable.presented' && record.deliverable.memberName)).toEqual(['alpha', 'alpha'])
    await lead.close()
  })

  it.skipIf(process.platform === 'win32')('a parent cancel ends a member shell command with its process tree', async () => {
    const root = await tempDir()
    const { app } = await boot(root, [
      { toolCalls: [{ name: 'members' }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 30.417 & echo $! > sleeper.pid; wait' } }] },
    ])
    const started: Agent[] = []
    app.ctx.tools.register(membersTool(app, ['runner'], started))
    const lead = await app.agents.create()
    const controller = new AbortController()
    const running = lead.run('run it', { signal: controller.signal })
    const pidFile = nodePath.join(root, 'sleeper.pid')
    while (!existsSync(pidFile) || (await readFile(pidFile, 'utf8')).trim() === '') await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    const result = await running
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    const { records } = await app.ctx.session.readAll(started[0]!.sessionId)
    const end = records.find(record => record.type === 'turn.end')
    expect(end?.type === 'turn.end' && end.reason).toEqual({ kind: 'cancelled', cause: 'parent' })
    expect(await commandRunning('sleep 30.417')).toBe(false)
    await lead.close()
  })
})
