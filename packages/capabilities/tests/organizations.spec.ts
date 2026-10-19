/**
 * New direction step 3: the organization library classes similar tasks,
 * compares teams with working alone by deterministic signals only, keeps
 * 1 in 5 (then 1 in 10) turns for comparison, and suggests the organization
 * that went well with its roles.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrganizationRun, TurnOrganizationEnd } from '@nexgent/kernel'
import { asksRedo, defaultOrganizer } from '@nexgent/workflow'
import { describe, expect, it } from 'vitest'
import {
  classVerdict,
  foldOrganizationLog,
  OrganizationLibrary,
  ORGANIZATION_CONCLUDED_CONTROL_RATE,
  ORGANIZATION_CONTROL_RATE,
  pickOrganization,
  suggestOrganization,
  summarizeOrganizations,
  type FoldedRun,
} from '../src/index.js'

const KEY = ['export', 'csv', 'report', 'endpoint']
let n = 0
function run(over: Partial<FoldedRun> = {}): FoldedRun {
  n += 1
  return {
    id: `r${n}`, at: '2026-10-19T00:00:00.000Z', classId: 'c1', key: KEY, sessionId: `s${n}`, turn: 1, decision: 'team', control: false,
    reorganizations: 0, corrections: 0, completed: true, usd: 1, reworked: false, ...over,
  }
}
const planBuild = { name: 'plan-build-review' as const, roles: [{ name: 'planner', kind: 'plan' as const, after: [] }, { name: 'builder', kind: 'implement' as const, after: ['planner'] }] }
const sequence = (...values: number[]) => () => values.shift() ?? 0.5

describe('organization library', () => {
  it('puts similar tasks in one class and marks a session reworked by later feedback', () => {
    const runs = foldOrganizationLog([
      { type: 'run', ...run({ sessionId: 'a' }) },
      { type: 'run', ...run({ sessionId: 'b' }) },
      { type: 'rework', sessionId: 'a', at: '2026-10-19T00:00:01.000Z' },
    ])
    expect(runs.map(r => r.reworked)).toEqual([true, false])
    expect(suggestOrganization(['export', 'csv', 'report', 'button'], runs, () => 0.9).classId).toBe('c1')
    expect(suggestOrganization(['typo', 'readme', 'title'], runs, () => 0.9).classId).not.toBe('c1')
  })

  it('compares teams with working alone and lowers the comparison share once there is a verdict', () => {
    const comparing = [run({ decision: 'solo' }), run()]
    expect(classVerdict(comparing)).toBe('comparing')
    // Just under the comparison share: this turn is done alone.
    expect(suggestOrganization(KEY, comparing, sequence(ORGANIZATION_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'solo', control: true, runs: 2 })
    const decided = [
      ...Array.from({ length: 5 }, (_, i) => run({ decision: 'solo', corrections: i === 0 ? 0 : 1 })),
      ...Array.from({ length: 5 }, () => run({ organization: planBuild })),
    ]
    expect(classVerdict(decided)).toBe('team-better')
    expect(suggestOrganization(KEY, decided, sequence(ORGANIZATION_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'team', control: false })
    expect(suggestOrganization(KEY, decided, sequence(ORGANIZATION_CONCLUDED_CONTROL_RATE - 0.01))).toMatchObject({ decision: 'solo', control: true })
    const reversed = decided.map(r => ({ ...r, decision: r.decision === 'solo' ? 'team' as const : 'solo' as const }))
    expect(classVerdict(reversed)).toBe('solo-better')
    expect(suggestOrganization(KEY, reversed, sequence(0.5))).toMatchObject({ decision: 'solo', control: false })
    expect(summarizeOrganizations(decided)[0]).toMatchObject({ verdict: 'team-better', soloRuns: 5, teamRuns: 5, organization: 'plan-build-review', soloGood: 0.2, teamGood: 1, costChange: 0 })
  })

  it('suggests the organization that went well with its roles, and weighs cost', () => {
    const failedCustom = run({ organization: { name: 'custom', roles: [{ name: 'x', kind: 'implement', after: [] }] }, checks: { passed: 0, total: 1 } })
    const good = run({ organization: planBuild })
    // Same sampled rates (a constant draw): the cheaper organization wins; a custom one never went well, so it is not a candidate.
    const cheap = pickOrganization([failedCustom, good, run({ organization: { name: 'lead-checker', roles: [] }, usd: 5 })], () => 0.5)
    expect(cheap).toEqual({ name: 'plan-build-review', roles: planBuild.roles })
    const changed = run({ organization: { name: 'custom', roles: [{ name: 'setup', kind: 'implement', after: [] }, { name: 'tester', kind: 'test', after: ['setup'] }] }, reorganizations: 1 })
    expect(pickOrganization([changed], sequence(0.1, 0.1, 0.1, 0.9, 0.9))).toEqual({ name: 'custom', roles: changed.organization!.roles })
  })

  it('learns from the turns the organizer decided, end to end', async () => {
    const library = new OrganizationLibrary(join(await mkdtemp(join(tmpdir(), 'nexgent-orgs-')), 'organizations'))
    const organizer = defaultOrganizer({ memory: () => library, random: () => 0.99 })
    const text = 'Add a CSV export to the reports page.\nIt needs a server endpoint, a download button and tests for both.'
    const decide = (sessionId: string, source: 'user' | 'feedback' = 'user', rating?: number) =>
      organizer.decide({ sessionId, turn: 1, text, source, materialIds: [], ...(rating === undefined ? {} : { rating }) })
    const end = (sessionId: string, over: Partial<TurnOrganizationEnd> = {}) => organizer.noteTurnEnd!({
      sessionId, turn: 1, reason: { kind: 'completed' }, use: { decision: 'team', chosenBy: 'default', name: 'plan-build-review', roles: 2, reorganizations: 0, corrections: 0 },
      organization: planBuild, checks: [{ name: 'test-command', passed: true }], usd: 0.4, projectRoot: '/nowhere', tools: [], changes: [], presented: [], ...over,
    })
    expect((await decide('s1'))!.decision).toEqual({ decision: 'team', chosenBy: 'default', suggested: expect.any(String) })
    await end('s1')
    const second = await decide('s2')
    expect(second!.decision.chosenBy).toBe('memory')
    await end('s2', { use: { decision: 'team', chosenBy: 'memory', reorganizations: 0, corrections: 1 } })
    // Feedback asking for changes reworks the session's turn; a feedback turn is not recorded itself.
    await decide('s1', 'feedback', 2)
    await decide('s2', 'feedback', 5)
    const runs = await library.runs()
    expect(runs.map(r => [r.sessionId, r.reworked, r.corrections, r.checks, r.usd])).toEqual([['s1', true, 0, { passed: 1, total: 1 }, 0.4], ['s2', false, 1, { passed: 1, total: 1 }, 0.4]])
    expect(new Set(runs.map(r => r.classId)).size).toBe(1)
    expect(await library.summary()).toMatchObject([{ verdict: 'comparing', teamRuns: 2, soloRuns: 0, teamGood: 0 }])
  })

  it('classes tasks worded differently by what they did, and counts redo messages and deleted results as rework', async () => {
    const base = await mkdtemp(join(tmpdir(), 'nexgent-orgs-'))
    const project = join(base, 'project')
    await mkdir(project)
    await writeFile(join(project, 'report.csv'), 'a,b\n')
    const library = new OrganizationLibrary(join(base, 'organizations'))
    const organizer = defaultOrganizer({ memory: () => library, random: () => 0.99 })
    const did = {
      projectRoot: project,
      tools: ['organize', 'read_file', 'run_command', 'write_file'],
      changes: [{ path: 'src/export.ts', change: 'added' as const }, { path: 'tests/export.test.ts', change: 'modified' as const }],
      checks: [{ name: 'test-command', passed: true }],
    }
    const turn = async (sessionId: string, turnNo: number, text: string, over: Partial<TurnOrganizationEnd> = {}) => {
      await organizer.decide({ sessionId, turn: turnNo, text, source: 'user', materialIds: [] })
      await organizer.noteTurnEnd!({
        sessionId, turn: turnNo, reason: { kind: 'completed' }, use: { decision: 'team', chosenBy: 'default', reorganizations: 0, corrections: 0 }, usd: 0.3, presented: [], ...did, ...over,
      })
    }
    await turn('s1', 1, 'Add a CSV export to the reports page.\nIt needs a server endpoint and tests.', { presented: ['report.csv'] })
    await turn('s2', 1, '订单列表要能下载成表格文件。\n后端加接口，前端加按钮，并补上测试。')
    let runs = await library.runs()
    expect(runs.map(r => r.traits)).toEqual([['check:test-command', 'ext:ts', 'tool:read_file', 'tool:run_command', 'tool:write_file'], expect.any(Array)])
    expect(runs[1]!.classId).toBe(runs[0]!.classId)
    expect(runs[0]!.outputs).toEqual(['report.csv'])
    // A later task worded like the second one now finds the shared class by its words.
    expect((await library.suggest({ text: '客户列表要能下载成表格文件。\n后端加接口，前端加按钮。', random: () => 0.99 })).classId).toBe(runs[0]!.classId)
    // A follow-up saying the result is wrong reworks that session's turn; a new task mentioning such a word later does not.
    await organizer.decide({ sessionId: 's2', turn: 2, text: '不对，改回去，按钮放在表格上面。', source: 'user', materialIds: [] })
    await organizer.decide({ sessionId: 's1', turn: 2, text: 'Add paging to the list.\nUndo is not needed.', source: 'user', materialIds: [] })
    // The user deleted the first task's result outside Nexgent: rework too, noticed at the next recorded turn.
    await rm(join(project, 'report.csv'))
    await turn('s3', 1, 'Add a PDF export to the invoices page.\nIt needs an endpoint and tests.')
    runs = await library.runs()
    expect(runs.map(r => [r.sessionId, r.reworked])).toEqual([['s1', true], ['s2', true], ['s3', false]])
  })

  it('recognizes a redo message only in its opening sentence', () => {
    expect(asksRedo('不对，改回去')).toBe(true)
    expect(asksRedo('This is wrong. Use semicolons.')).toBe(true)
    expect(asksRedo('Please redo the chart with weekly totals')).toBe(true)
    expect(asksRedo('Add an undo button to the editor')).toBe(false)
    expect(asksRedo('给编辑器加一个按钮。不对的输入要提示。')).toBe(false)
    expect(asksRedo('加一个撤销按钮')).toBe(false)
    expect(asksRedo('嗯，撤销刚才的改动')).toBe(true)
    expect(asksRedo('导出的文件不是我要的格式')).toBe(true)
  })
})

export type { OrganizationRun }
