/**
 * New direction step 2 in the real loop (scripted model, real kernel members):
 * a small task is done alone; a larger one is organized into roles that run
 * in parallel where they can; an organization that makes no progress is
 * changed in the same task; the task's outcome records how it was organized.
 */
import { createApp, REORGANIZE_AFTER_CHECKS_NOTE, type Context, type LLMRequest, type NexgentApp, type OrganizationMemory, type OrganizationRun, type Plugin, type SessionRecord, type TaskOutcomeRecord } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { TaskingPlugin } from '@nexgent/tasking'
import { llmSessionText, routeByMember, scriptedProvider, type ScriptEntry, type ScriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultOrganizer, isSmallTask, SOLO_SECTION, TEAM_SECTION, THREAD_SIZE_RULE, THREAD_TEAM_SECTION, WorkflowPlugin } from '../src/index.js'
import { ofType, tempDir } from './helpers.js'

const apps: NexgentApp[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
})

async function boot(script: ScriptEntry<LLMRequest>[], routes: Record<string, ScriptEntry<LLMRequest>[]>, draw: number, memory?: OrganizationMemory): Promise<{ app: NexgentApp; llm: ScriptedProvider }> {
  const root = await tempDir()
  const llm = scriptedProvider(script, { routeKey: routeByMember(llmSessionText), routes, chunkDelayMs: 5 })
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
  await app.ctx.plugin(WorkflowPlugin, { organizer: { random: () => draw, ...(memory === undefined ? {} : { memory: () => memory }) } })
  return { app, llm }
}

const LARGE_TASK = 'Add a CSV export to the reports page.\nThe export needs a server endpoint, a download button in the page, and tests for both; keep the existing JSON export working.'

const report = (done: string, rest: { notDone?: string; checks?: string; blockers?: string } = {}) =>
  `${done}\nDone: ${done}\nNot done: ${rest.notDone ?? 'none'}\nChecks: ${rest.checks ?? 'none'}\nBlockers: ${rest.blockers ?? 'none'}`

/** The organization section of a request: a context note right before the user's message, never in the system prompt (which stays the same from turn to turn, and cached). */
const organizationOf = (request: LLMRequest): string => {
  expect(String(request.messages[0]!.content)).not.toContain('# How this task is organized')
  return String(request.messages.at(-2)!.content)
}

async function outcomes(app: NexgentApp): Promise<TaskOutcomeRecord[]> {
  const out: TaskOutcomeRecord[] = []
  for await (const record of app.ctx.ledger.read()) if (record.type === 'task.outcome' && record.memberId === 'main') out.push(record)
  return out
}

describe('deciding whether members help', () => {
  it('sizes tasks generically', () => {
    expect(isSmallTask('把 README 里的错别字改掉')).toBe(true)
    expect(isSmallTask('Fix the typo in the README title')).toBe(true)
    expect(isSmallTask(LARGE_TASK)).toBe(false)
    expect(isSmallTask('Fix the typo', ['material-1'])).toBe(false)
  })

  it('does a small task alone: the turn records it and organize is refused', async () => {
    const { app, llm } = await boot([
      { toolCalls: [{ name: 'organize', arguments: { organization: 'lead-checker', roles: [{ name: 'checker', kind: 'review', task: 'check' }] } }] },
      { content: 'Fixed it myself.' },
    ], {}, 0.99)
    const lead = await app.agents.create()
    expect((await lead.run('Fix the typo in the README title')).reason).toEqual({ kind: 'completed' })
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    expect(ofType(records, 'turn.start')[0]).toMatchObject({ organization: { decision: 'solo', chosenBy: 'size' } })
    expect(organizationOf(llm.requests[0]!)).toContain(SOLO_SECTION.body)
    const result = ofType(records, 'tool.result')[0]!
    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain('without members')
    expect(ofType(records, 'subagent.start')).toEqual([])
    await lead.close()
    expect((await outcomes(app)).at(-1)?.organization).toEqual({ decision: 'solo', chosenBy: 'size', reorganizations: 0, corrections: 0 })
  })

  it('does 1 in 5 of the larger tasks alone for comparison', async () => {
    const { app, llm } = await boot([{ content: 'Done alone.' }], {}, 0.1)
    const lead = await app.agents.create()
    await lead.run(LARGE_TASK)
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    expect(ofType(records, 'turn.start')[0]).toMatchObject({ organization: { decision: 'solo', chosenBy: 'control' } })
    expect(organizationOf(llm.requests[0]!)).toContain(SOLO_SECTION.body)
    await lead.close()
  })
})

describe('organizing members', () => {
  it('runs the roles of an organization, in parallel where they can, and reports their progress', async () => {
    const roles = [
      { name: 'planner', kind: 'plan', task: 'Split the export into parts with their files.' },
      { name: 'server', kind: 'implement', task: 'Add the endpoint in server/export.ts.', after: ['planner'] },
      { name: 'page', kind: 'implement', task: 'Add the button in web/reports.tsx.', after: ['planner'] },
      { name: 'reviewer', kind: 'review', task: 'Review both parts against the task.', after: ['server', 'page'] },
    ]
    const { app, llm } = await boot([
      { toolCalls: [{ name: 'organize', arguments: { organization: 'plan-build-review', roles } }] },
      { content: 'The export is in; the reviewer found nothing.' },
    ], {
      planner: [{ content: report('Two parts: server/export.ts and web/reports.tsx.') }],
      server: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'server/export.ts', content: 'export {}\n' } }] }, { content: report('Endpoint added.', { checks: 'type check passed' }) }],
      page: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'web/reports.tsx', content: 'export {}\n' } }] }, { content: report('Button added.') }],
      reviewer: [{ content: report('Both parts match the task.') }],
    }, 0.99)
    const lead = await app.agents.create()
    expect((await lead.run(LARGE_TASK)).reason).toEqual({ kind: 'completed' })
    expect(organizationOf(llm.requests[0]!)).toContain(TEAM_SECTION.body)
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    expect(ofType(records, 'turn.start')[0]).toMatchObject({ organization: { decision: 'team', chosenBy: 'default' } })
    const [organization] = ofType(records, 'organization')
    expect(organization).toMatchObject({
      name: 'plan-build-review',
      roles: [
        { name: 'planner', kind: 'plan', after: [] },
        { name: 'server', kind: 'implement', after: ['planner'] },
        { name: 'page', kind: 'implement', after: ['planner'] },
        { name: 'reviewer', kind: 'review', after: ['server', 'page'] },
      ],
    })
    expect(ofType(records, 'workflow.start')[0]).toMatchObject({ workflowId: organization!.workflowId, kind: 'graph' })
    // Each member ran with its role's preset; the two implementers ran at the same time.
    const starts = ofType(records, 'subagent.start')
    expect(starts.map(start => [start.name, start.preset, start.workflowId])).toEqual(expect.arrayContaining([
      ['planner', 'read-only-analyst', organization!.workflowId],
      ['server', 'general-executor', organization!.workflowId],
      ['page', 'general-executor', organization!.workflowId],
      ['reviewer', 'read-only-checker', organization!.workflowId],
    ]))
    const order = records.flatMap(record => (record.type === 'subagent.start' || record.type === 'subagent.end'
      ? [`${record.type === 'subagent.start' ? 'start' : 'end'}:${record.type === 'subagent.start' ? record.name : starts.find(s => s.childSessionId === record.childSessionId)!.name}`]
      : []))
    expect(order.indexOf('start:page')).toBeLessThan(order.indexOf('end:server'))
    expect(order.indexOf('start:server')).toBeLessThan(order.indexOf('end:page'))
    expect(order.indexOf('start:reviewer')).toBeGreaterThan(Math.max(order.indexOf('end:server'), order.indexOf('end:page')))
    // Members were told their role and asked for the report; the result shows the progress.
    const plannerPrompt = ofType(records, 'subagent.start').find(start => start.name === 'planner')!.task
    expect(plannerPrompt).toContain('You are the planner of a team.')
    const result = ofType(records, 'tool.result')[0]!
    expect(result.content).toContain('Organization plan-build-review: 4 of 4 roles done')
    expect(result.content).toContain('Every role reports done.')
    await lead.close()
    expect((await outcomes(app)).at(-1)?.organization).toEqual({ decision: 'team', chosenBy: 'default', name: 'plan-build-review', roles: 4, reorganizations: 0, corrections: 0 })
  })

  it('changes an organization that made no progress, and refuses to repeat it', async () => {
    const first = { organization: 'lead-checker', roles: [{ name: 'tester', kind: 'test', task: 'Run the export tests.' }] }
    const second = {
      organization: 'custom',
      reason: 'The tester had no test setup to run; someone has to add it first.',
      roles: [
        { name: 'setup', kind: 'implement', task: 'Add a test script for the export.' },
        { name: 'tester2', kind: 'test', task: 'Run the export tests.', after: ['setup'] },
      ],
    }
    const { app } = await boot([
      { toolCalls: [{ name: 'organize', arguments: first }] },
      // The same organization again, then a change without a reason: both refused.
      { toolCalls: [{ name: 'organize', arguments: { ...first, reason: 'try again' } }] },
      { toolCalls: [{ name: 'organize', arguments: { ...second, reason: undefined } }] },
      { toolCalls: [{ name: 'organize', arguments: second }] },
      { content: 'Tests added and passing.' },
    ], {
      tester: [{ content: report('Nothing.', { notDone: 'all tests', blockers: 'there is no test command in this project' }) }],
      setup: [{ content: report('Added npm test.') }],
      tester2: [{ content: report('Ran the tests.', { checks: '12 passed, 0 failed' }) }],
    }, 0.99)
    const lead = await app.agents.create()
    expect((await lead.run(LARGE_TASK)).reason).toEqual({ kind: 'completed' })
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    const results = ofType(records, 'tool.result')
    expect(results[0]!.content).toContain('0 of 1 roles done')
    expect(results[0]!.content).toContain('blockers: there is no test command in this project')
    expect(results[0]!.content).toContain('This organization made no progress.')
    expect(results[1]).toMatchObject({ isError: true })
    expect(results[1]!.content).toContain('the organization that just ran')
    expect(results[2]).toMatchObject({ isError: true })
    expect(results[2]!.content).toContain('give the reason')
    expect(results[3]!.content).toContain('2 of 2 roles done')
    const organizations = ofType(records, 'organization')
    expect(organizations).toHaveLength(2)
    expect(organizations[1]).toMatchObject({ name: 'custom', replaces: organizations[0]!.organizationId, reason: second.reason })
    await lead.close()
    expect((await outcomes(app)).at(-1)?.organization).toMatchObject({ name: 'custom', roles: 2, reorganizations: 1 })
  })

  it('starts from what worked on similar tasks and reports how the turn went (step 3)', async () => {
    const recorded: Omit<OrganizationRun, 'id' | 'at'>[] = []
    const reworked: string[] = []
    const roles = [{ name: 'builder', kind: 'implement' as const, after: [] }, { name: 'checker', kind: 'review' as const, after: ['builder'] }]
    const memory: OrganizationMemory = {
      suggest: async () => ({ classId: 'c1', key: ['export'], runs: 3, decision: 'team', control: false, organization: { name: 'lead-checker', roles } }),
      record: async run => void recorded.push(run),
      noteRework: async ({ sessionId }) => void reworked.push(sessionId),
      noteReverts: async () => undefined,
      summary: async () => [],
    }
    const { app, llm } = await boot([
      { toolCalls: [{ name: 'organize', arguments: { organization: 'lead-checker', roles: [{ name: 'builder', kind: 'implement', task: 'Build it.' }, { name: 'checker', kind: 'review', task: 'Check it.', after: ['builder'] }] } }] },
      { content: 'Built and checked.' },
      { content: 'Changed as asked.' },
    ], { builder: [{ content: report('Built.') }], checker: [{ content: report('Looks right.') }] }, 0.99, memory)
    const lead = await app.agents.create()
    await lead.run(LARGE_TASK)
    expect(organizationOf(llm.requests[0]!)).toContain('On similar tasks `lead-checker` with these roles: builder (implement); checker (review, after builder) went well.')
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    expect(ofType(records, 'turn.start')[0]).toMatchObject({ organization: { decision: 'team', chosenBy: 'memory', suggested: 'lead-checker' } })
    expect(recorded).toEqual([expect.objectContaining({ classId: 'c1', sessionId: lead.sessionId, turn: 1, decision: 'team', control: false, organization: { name: 'lead-checker', roles }, corrections: 0, completed: true })])
    expect(typeof recorded[0]!.usd).toBe('number')
    // A follow-up feedback turn on the result is rework of that turn.
    await lead.run({ source: 'feedback', feedback: { id: 'f1', deliverableId: 'd1', version: 1, rating: 2, comment: 'Use semicolons instead of commas in the file.' } })
    expect(reworked).toEqual([lead.sessionId])
    expect(recorded).toHaveLength(1)
    await lead.close()
  })

  it('coordinator: tries the change found on the last similar task and records the measured organization', async () => {
    const recorded: Omit<OrganizationRun, 'id' | 'at'>[] = []
    const target = { part: 'builder', kind: 'implement' as const, cause: 'cost' as const, value: 0.6 }
    const change = { id: 'ch-1', classId: 'c1', action: 'split' as const, target, baseline: 0.6, baselineUsd: 1, runId: 'r0', instruction: 'Split the builder role between two members.' }
    const memory: OrganizationMemory = {
      suggest: async () => ({ classId: 'c1', key: ['export'], runs: 3, decision: 'team', control: false, organization: { name: 'lead-checker' }, change, note: { status: 'trying', action: 'split', target } }),
      record: async run => void recorded.push(run),
      noteRework: async () => undefined,
      noteReverts: async () => undefined,
      summary: async () => [],
    }
    const { app, llm } = await boot([
      { toolCalls: [{ name: 'organize', arguments: { organization: 'custom', roles: [{ name: 'left', kind: 'implement', task: 'Build a.ts.' }, { name: 'right', kind: 'implement', task: 'Build b.ts.' }] } }] },
      { content: 'Built.' },
    ], {
      left: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'a.ts', content: 'export {}\n' } }], usage: { inputTokens: 3000, outputTokens: 200 } }, { content: report('a.ts built.'), usage: { inputTokens: 3000, outputTokens: 200 } }],
      right: [{ content: report('b.ts built.'), usage: { inputTokens: 1000, outputTokens: 100 } }],
    }, 0.99, memory)
    const lead = await app.agents.create()
    await lead.run(LARGE_TASK)
    expect(organizationOf(llm.requests[0]!)).toContain('one change to the organization for this task: Split the builder role between two members.')
    const { records } = await app.ctx.session.readAll(lead.sessionId)
    expect(ofType(records, 'turn.start')[0]).toMatchObject({ organization: { decision: 'team', change: { status: 'trying', action: 'split' } } })
    expect(ofType(records, 'organization')[0]).toMatchObject({ change: { status: 'trying', action: 'split', target } })
    expect(ofType(records, 'subagent.start').every(start => typeof start.queuedMs === 'number')).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.change).toBe('ch-1')
    const profile = recorded[0]!.profile!
    expect(profile.parts.map(part => [part.name, part.kind])).toEqual([['coordinator', 'coordinator'], expect.any(Array), expect.any(Array)])
    expect(profile.parts.slice(1).map(part => part.name).sort()).toEqual(['left', 'right'])
    expect(profile.parts.find(part => part.name === 'coordinator')!.idleMs).toBeGreaterThan(0)
    expect(profile.parts.reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(1, 2)
    await lead.close()
  })

  it('suggests changing the organization when checks fail after members worked', () => {
    expect(REORGANIZE_AFTER_CHECKS_NOTE).toContain('call `organize` again with a reason')
  })
})

describe('two layers: the coordinator splits into threads, a thread organizes members', () => {
  const text = 'Write the module documentation under docs/:\n1. one page per module in src/ and lib/ with its exports, parameters, return values and an example;\n2. an index in docs/README.md linking every page;\n3. check every example in the pages runs as written.'
  it('lets a thread judge from its part whether members are worth it', async () => {
    // Without a library, and with one: the thread's section opens with the size rule, never with "use members".
    const alone = await defaultOrganizer({ random: () => 0.9 }).decide({ sessionId: 't', turn: 1, text, source: 'user', materialIds: [], thread: true })
    expect(alone?.section).toEqual(THREAD_TEAM_SECTION)
    const { memory } = fakeMemory()
    const remembered = await defaultOrganizer({ memory: () => memory, random: () => 0.9 }).decide({ sessionId: 't', turn: 1, text, source: 'user', materialIds: [], thread: true })
    for (const section of [alone!.section, remembered!.section]) {
      expect(section.body.startsWith(THREAD_SIZE_RULE)).toBe(true)
      expect(section.body).not.toContain('do not answer before members have worked on it')
      expect(section.body).not.toContain('do not swap it for a smaller one')
    }
    expect(remembered!.section.body).toContain('When this part is large enough for members, start from `lead-checker`')
    // A conversation that is no thread keeps the team section.
    expect((await defaultOrganizer({ random: () => 0.9 }).decide({ sessionId: 'u', turn: 1, text, source: 'user', materialIds: [] }))?.section).toEqual(TEAM_SECTION)
  })

  const fakeMemory = () => {
    const suggested: unknown[] = []
    const recorded: unknown[] = []
    const memory = {
      async suggest(input: unknown) {
        suggested.push(input)
        return { classId: 'c', key: [], runs: 2, decision: 'team', control: false, organization: { name: 'lead-checker', roles: [{ name: 'checker', kind: 'test', after: ['coordinator'] }] }, change: { id: 'x', instruction: 'Split this task into 3 threads.' } }
      },
      async record(run: unknown) { recorded.push(run) },
      async noteRework() {},
      async noteReverts() {},
    } as unknown as OrganizationMemory
    return { memory, suggested, recorded }
  }
  const end = (sessionId: string) => ({ sessionId, turn: 1, use: { decision: 'team', chosenBy: 'memory', reorganizations: 0, corrections: 0 }, reason: { kind: 'completed' }, usd: 0, projectRoot: '/p', tools: [], changes: [], presented: [] }) as unknown as Parameters<NonNullable<ReturnType<typeof defaultOrganizer>['noteTurnEnd']>>[0]

  it('the coordinator\'s turn is a coordinator-level run: its section names threads and the split change, not members\' roles', async () => {
    const { memory, suggested, recorded } = fakeMemory()
    const organizer = defaultOrganizer({ memory: () => memory, random: () => 0.99 })
    const decided = await organizer.decide({ sessionId: 'c', turn: 1, text, source: 'user', materialIds: [], coordinator: true })
    expect(suggested[0]).toMatchObject({ level: 'coordinator' })
    expect(decided!.section.body).toContain('start_thread')
    expect(decided!.section.body).toContain('Split this task into 3 threads.')
    expect(decided!.section.body).not.toContain('lead-checker')
    await organizer.noteTurnEnd!(end('c'))
    expect(recorded[0]).toMatchObject({ level: 'coordinator', classId: 'c' })
  })

  it('a thread\'s turn is a run of its own at the members\' level', async () => {
    const { memory, suggested, recorded } = fakeMemory()
    const organizer = defaultOrganizer({ memory: () => memory, random: () => 0.99 })
    const decided = await organizer.decide({ sessionId: 't', turn: 1, text, source: 'user', materialIds: [] })
    expect((suggested[0] as { level?: string }).level).toBeUndefined()
    expect(decided!.section.body).toContain('lead-checker')
    await organizer.noteTurnEnd!(end('t'))
    expect((recorded[0] as { level?: string }).level).toBeUndefined()
  })
})

export type { SessionRecord }
