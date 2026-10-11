/**
 * The workflow in the real loop: scripted model routed per member, real
 * kernel child sessions through `@nexgent/subagent`'s `runMember`, real
 * session store, workspace and tasking. Two parallel members and a summary
 * member that presents the final deliverable (H07); a hard kill mid-run and
 * recovery on reopen (H09).
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createApp, type Context, type LLMRequest, type NexgentApp, type Plugin, type SessionRecord } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { TaskingPlugin, type LocalTaskingService } from '@nexgent/tasking'
import { llmSessionText, routeByMember, scriptedProvider, type ScriptEntry, type ScriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverWorkflows, WorkflowPlugin } from '../src/index.js'
import { ofType, tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/workflow-crash-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const apps: NexgentApp[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
})

async function boot(root: string, script: ScriptEntry<LLMRequest>[], routes: Record<string, ScriptEntry<LLMRequest>[]> = {}): Promise<{ app: NexgentApp; llm: ScriptedProvider; tasking: LocalTaskingService }> {
  const llm = scriptedProvider(script, { routeKey: routeByMember(llmSessionText), routes, chunkDelayMs: 15 })
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
      '@nexgent/session': SessionPlugin as unknown as Plugin,
      '@nexgent/workspace': WorkspacePlugin as unknown as Plugin,
    },
  })
  apps.push(app)
  await app.ctx.plugin(TaskingPlugin)
  await app.ctx.plugin(WorkflowPlugin)
  return { app, llm, tasking: app.ctx.get('tasking') as LocalTaskingService }
}

const writeAndPresent = (path: string, text: string): ScriptEntry<LLMRequest>[] => [
  { toolCalls: [{ name: 'write_file', arguments: { path, content: text } }] },
  { toolCalls: [{ name: 'present', arguments: { paths: [path], summary: text } }] },
  { content: `${text}: wrote ${path}` },
]

function runChild(root: string): Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, root], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ stdout, code, signal }))
  })
}

describe('workflow with kernel members', () => {
  it('runs two members in parallel and a summary member that presents the final report', async () => {
    const root = await tempDir()
    await mkdir(`${root}/data`, { recursive: true })
    await writeFile(`${root}/data/orders.csv`, 'region,amount\nnorth,10\nsouth,20\n')
    const script = `
      phase('parts')
      const parts = await parallel(['north', 'south'].map(region => () => agent('Sum the ' + region + ' orders', { name: region, files: ['data/orders.csv'], preset: 'general-executor' })))
      phase('summary')
      const [summary] = await pipeline([parts], async results => agent('Combine: ' + results.map(r => r.text).join(' | '), { name: 'summary' }))
      return summary.deliverables.map(version => version.files.map(file => file.path))`
    const { app, llm, tasking } = await boot(root, [
      { toolCalls: [{ name: 'workflow', arguments: { title: 'regions', script } }] },
      { content: 'The summary member presented out/summary/report.md.' },
    ], {
      north: writeAndPresent('out/north/sum.md', 'north 10'),
      south: writeAndPresent('out/south/sum.md', 'south 20'),
      summary: writeAndPresent('out/summary/report.md', 'total 30'),
    })
    const lead = await app.agents.create()
    const result = await lead.run('Summarize orders by region with a workflow')
    expect(result.reason).toEqual({ kind: 'completed' })

    const { records } = await app.ctx.session.readAll(lead.sessionId)
    const toolResult = records.find(record => record.type === 'tool.result')
    expect(toolResult?.type === 'tool.result' && toolResult.isError).toBe(false)
    expect(toolResult?.type === 'tool.result' && toolResult.content).toContain('Workflow "regions" completed: 3 members (3 completed).')
    const starts = ofType(records, 'subagent.start')
    const workflowId = ofType(records, 'workflow.start')[0]!.workflowId
    expect(starts.map(record => [record.name, record.executionForm, record.workflowId, record.preset])).toEqual(expect.arrayContaining([
      ['north', 'workflow', workflowId, 'general-executor'],
      ['south', 'workflow', workflowId, 'general-executor'],
      ['summary', 'workflow', workflowId, 'general-executor'],
    ]))
    expect(ofType(records, 'workflow.phase').map(record => record.phase)).toEqual(['parts', 'summary'])
    expect(ofType(records, 'workflow.end')[0]).toMatchObject({ status: 'completed', members: 3 })

    // The two parts overlapped: south's first model request came before north's last one.
    const routes = llm.calls.map(call => call.route)
    expect(routes.indexOf('south')).toBeLessThan(routes.lastIndexOf('north'))
    expect(routes.lastIndexOf('summary')).toBe(routes.length - 2)

    // Each member is a child session of the lead; the summary's deliverable carries its name.
    for (const start of starts) {
      const child = await app.ctx.session.readAll(start.childSessionId)
      expect(child.records[0]).toMatchObject({ type: 'session.start', parentSessionId: lead.sessionId, member: { name: start.name, executionForm: 'workflow' } })
    }
    const summaryEnd = ofType(records, 'subagent.end').find(record => record.childSessionId === starts.find(start => start.name === 'summary')!.childSessionId)
    expect(summaryEnd?.result.deliverables[0]).toMatchObject({ memberName: 'summary', files: [{ path: 'out/summary/report.md' }] })
    const deliverables = await tasking.deliverables.list()
    expect(deliverables.map(deliverable => deliverable.versions[0]?.memberName).sort()).toEqual(['north', 'south', 'summary'])
    // The north member was told which file to read first.
    const northFirst = llm.calls.find(call => call.route === 'north')!
    expect(JSON.stringify(northFirst.request.messages)).toContain('Read these project files first:\\n- data/orders.csv')
    await lead.close()
  })

  it.skipIf(process.platform === 'win32')('after a hard kill, recovery closes the open member and workflow without re-running the completed member', async () => {
    const root = await tempDir()
    const child = await runChild(root)
    const match = /^ids (\S+)$/m.exec(child.stdout)
    expect(match, child.stdout).not.toBeNull()
    expect(child.signal).toBe('SIGKILL')
    const parentId = match![1]!

    const { app, llm } = await boot(root, [])
    const lead = await app.agents.resume(parentId)
    const written = await recoverWorkflows(lead, app.ctx.session)
    expect(written).toHaveLength(1)

    const { records } = await app.ctx.session.readAll(parentId)
    const starts = ofType(records, 'subagent.start')
    expect(starts.map(record => record.name)).toEqual(['first', 'second'])
    const ends = ofType(records, 'subagent.end')
    const byName = (name: string) => ends.filter(record => record.childSessionId === starts.find(start => start.name === name)!.childSessionId)
    expect(byName('first')).toHaveLength(1)
    expect(byName('first')[0]?.result).toMatchObject({ status: 'completed', text: 'first part done' })
    expect(byName('second')).toHaveLength(1)
    expect(byName('second')[0]?.result).toMatchObject({ status: 'interrupted' })
    const workflowStart = ofType(records, 'workflow.start')[0]!
    expect(ofType(records, 'workflow.end')).toEqual([expect.objectContaining({ turn: workflowStart.turn, workflowId: workflowStart.workflowId, status: 'interrupted', members: 2 })])
    // Nothing ran again: no model request in the recovering process, and the first member's session still has one turn.
    expect(llm.calls).toHaveLength(0)
    const first = await app.ctx.session.readAll(starts[0]!.childSessionId)
    expect(first.records.filter((record: SessionRecord) => record.type === 'turn.start')).toHaveLength(1)
    // Recovering again writes nothing.
    expect(await recoverWorkflows(lead, app.ctx.session)).toEqual([])
    await lead.close()
  })
})
