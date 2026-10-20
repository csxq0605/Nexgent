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
import { scriptedProvider } from '@nexgent/test-support'
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
  wentWell,
  chooseAction,
  findHotspot,
  judgeChange,
  followedChange,
  layoutInstruction,
  newChange,
  reflectedRun,
  reflectOnRun,
  sinceStart,
  type ReflectedRun,
  modelReflector,
  parseChoice,
  partExcerpt,
  type ReflectionRequest,
} from '../src/index.js'
import type { OrganizationChange, OrganizationProfile, SessionRecord } from '@nexgent/kernel'

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

  it('takes an external review of a run with no other signal: a low score means it did not go well', async () => {
    const runs = foldOrganizationLog([
      { type: 'run', ...run({ sessionId: 'a', turn: 1 }) },
      { type: 'run', ...run({ sessionId: 'b', turn: 1 }) },
      { type: 'review', sessionId: 'a', turn: 1, score: 0.4, at: '2026-10-19T00:00:01.000Z' },
      { type: 'review', sessionId: 'b', turn: 1, score: 0.9, at: '2026-10-19T00:00:01.000Z' },
    ])
    expect(runs.map(r => [r.review, wentWell(r)])).toEqual([[0.4, false], [0.9, true]])
    const dir = await mkdtemp(join(tmpdir(), 'org-review-'))
    try {
      const library = new OrganizationLibrary(dir)
      const { id: _id, at: _at, reworked: _reworked, ...recorded } = run({ sessionId: 's-review', turn: 2 })
      await library.record(recorded)
      await library.noteReview({ sessionId: 's-review', turn: 1, score: 0.1 })
      await library.noteReview({ sessionId: 's-review', turn: 2, score: 0.2 })
      expect((await library.lines()).filter(line => line.type === 'review')).toHaveLength(1)
      expect((await library.runs())[0]).toMatchObject({ review: 0.2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

function profile(builderShare: number, over: { failures?: number; usd?: number; ms?: number } = {}): OrganizationProfile {
  const usd = over.usd ?? 1
  const ms = over.ms ?? 10_000
  const part = (name: string, kind: 'coordinator' | 'implement', share: number, failures = 0) => ({ name, kind, tokens: Math.round(share * 1000), share, usd: share * usd, ms: share * ms, failures, retries: 0, idleMs: 0, wasted: false })
  return { usd, ms, tokens: 1000, parts: [part('coordinator', 'coordinator', 1 - builderShare), part('builder', 'implement', builderShare, over.failures)] }
}
/** A profile whose builder part was split between two implement members (a followed `split`). */
function halves(builderShare: number): OrganizationProfile {
  const base = profile(builderShare)
  const builder = base.parts[1]!
  const half = { ...builder, share: builderShare / 2, usd: builder.usd / 2, tokens: builder.tokens / 2 }
  return { ...base, parts: [base.parts[0]!, { ...half, name: 'builder-1' }, { ...half, name: 'builder-2' }] }
}
const team = { name: 'lead-checker' as const, roles: [{ name: 'builder', kind: 'implement' as const, after: [] }] }

describe('coordinator reflection', () => {
  it('finds the hottest part from the run alone and picks one change, skipping one that already failed', () => {
    const hot = findHotspot(profile(0.6), [])
    expect(hot).toMatchObject({ part: 'builder', kind: 'implement', cause: 'cost' })
    expect(chooseAction(hot!, team, new Set())).toBe('split')
    expect(chooseAction(hot!, team, new Set(['implement:cost:split']))).toBe('narrow-reading')
    // Failures beat a large share.
    expect(findHotspot(profile(0.5, { failures: 3 }), [])).toMatchObject({ cause: 'failures', value: 3 })
    // Below every threshold: nothing to change.
    expect(findHotspot(profile(0.3, { ms: 10_000 }), [profile(0.3)])?.part).not.toBe('builder')
  })

  it('keeps a change after two better runs and reverts one at once when the task went worse', () => {
    const change: OrganizationChange = { id: 'x', classId: 'c', action: 'split', target: { part: 'builder', kind: 'implement', cause: 'cost', value: 0.6 }, baseline: 0.6, baselineUsd: 1, runId: 'r0', instruction: '' }
    const tried = (share: number, good = true, usd = 1): ReflectedRun => ({ id: `t${share}`, seq: 1, decision: 'team', usd, profile: profile(share, { usd }), change: 'x', good })
    expect(judgeChange(change, [tried(0.4)])).toBeUndefined()
    expect(judgeChange(change, [tried(0.4), tried(0.3)])).toBe('kept')
    expect(judgeChange(change, [tried(0.4), tried(0.55)])).toBe('reverted')
    expect(judgeChange(change, [tried(0.3, false)])).toBe('reverted')
    expect(judgeChange(change, [tried(0.3, true, 1.5)])).toBe('reverted')
  })

  it('does not count a run that did not follow the change, nor revert one only for a mid-task correction', () => {
    const solo = (usd = 1): OrganizationProfile => ({ usd, ms: 10_000, tokens: 1000, parts: [{ name: 'coordinator', kind: 'coordinator', tokens: 1000, share: 1, usd, ms: 10_000, failures: 0, retries: 0, idleMs: 0, wasted: false }] })
    const change: OrganizationChange = { id: 'y', classId: 'c', action: 'split', target: { part: 'coordinator', kind: 'coordinator', cause: 'cost', value: 0.8 }, baseline: 0.8, baselineUsd: 1, runId: 'r0', instruction: '' }
    const source: ReflectedRun = { id: 'r0', seq: 0, decision: 'team', usd: 1, profile: solo(), good: true }
    // The coordinator kept all the work: no trial, dropped as unfollowed (not "tried, did not work").
    expect(judgeChange(change, [source, { id: 'r1', seq: 1, decision: 'team', usd: 1, profile: solo(), change: 'y', good: false }])).toBe('unfollowed')
    // Followed, with a correction: the correction alone does not revert it; the measured values decide.
    const corrected: ReflectedRun = { id: 'r2', seq: 2, decision: 'team', usd: 1, profile: profile(0.7), change: 'y', good: false, sound: true }
    expect(judgeChange(change, [source, corrected])).toBeUndefined()
    expect(judgeChange(change, [source, corrected, { ...corrected, id: 'r3', seq: 3 }])).toBe('kept')
    expect(reflectedRun(run({ corrections: 2 }))).toMatchObject({ good: false, sound: true })
  })

  it('judges the coordinator\'s split by how many parts it made, and words its change as the split', () => {
    const part = (name: string, kind: 'thread' | 'member' | 'coordinator', share: number) => ({ name, kind, tokens: 100, share, usd: share, ms: 1000, failures: 0, retries: 0, idleMs: 0, wasted: false })
    const split = (...parts: ReturnType<typeof part>[]): OrganizationProfile => ({ usd: 1, ms: 1000, tokens: 300, parts: [part('coordinator', 'coordinator', 0.1), ...parts] })
    const source: ReflectedRun = { id: 'r0', seq: 0, decision: 'team', usd: 1, level: 'coordinator', profile: split(part('docs', 'thread', 0.7), part('check', 'thread', 0.2)), good: true }
    const hotspot = { part: 'docs', kind: 'thread' as const, cause: 'cost' as const, value: 0.7 }
    const change = newChange({ classId: 'c', run: source, hotspot, action: 'split', history: [source] })
    expect(change.instruction).toContain('Split this task into 3 threads: divide the part of "docs" between two threads')
    expect(layoutInstruction('merge', hotspot, source.profile, 'check')).toContain('Split this task into 1 thread: the part of "docs" goes to the thread "check"')
    // Three parts, whatever their form, follow a split of two; the same two do not.
    expect(followedChange(change, { ...source, id: 'r1', profile: split(part('a', 'thread', 0.4), part('b', 'thread', 0.3), part('check', 'member', 0.2)) }, source)).toBe(true)
    expect(followedChange(change, { ...source, id: 'r1' }, source)).toBe(false)
  })

  it('proposes no change for a run whose work was not divided, but still judges a change it did not follow', () => {
    const alone: OrganizationProfile = { usd: 1, ms: 1000, tokens: 100, parts: [{ name: 'coordinator', kind: 'coordinator', tokens: 100, share: 1, usd: 1, ms: 1000, failures: 0, retries: 0, idleMs: 0, wasted: false }] }
    const solo = (id: string, change?: string): ReflectedRun => ({ id, seq: 0, decision: 'team', usd: 1, profile: alone, good: true, ...(change === undefined ? {} : { change }) })
    expect(reflectOnRun('c', [solo('r1')], [])).toEqual({})
    const change: OrganizationChange = { id: 'x', classId: 'c', action: 'split', target: { part: 'coordinator', kind: 'coordinator', cause: 'cost', value: 1 }, baseline: 1, baselineUsd: 1, runId: 'r1', instruction: '' }
    expect(reflectOnRun('c', [solo('r1'), solo('r2', 'x')], [{ change, seq: 1 }])).toEqual({ verdict: { changeId: 'x', verdict: 'unfollowed' } })
  })

  it('keeps the coordinator\'s splits and the members\' divisions of work in separate classes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'org-level-'))
    try {
      const library = new OrganizationLibrary(dir)
      const text = 'export csv report endpoint'
      const first = await library.suggest({ text, random: () => 0.9, level: 'coordinator' })
      await library.record({ classId: first.classId, key: first.key, sessionId: 'c', turn: 1, level: 'coordinator', decision: 'team', control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1 })
      expect((await library.suggest({ text, random: () => 0.9, level: 'coordinator' })).classId).toBe(first.classId)
      expect((await library.suggest({ text, random: () => 0.9 })).classId).not.toBe(first.classId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('records a change after a team task, gives it to the next similar one, and keeps it once it helped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'org-reflect-'))
    try {
      const library = new OrganizationLibrary(dir)
      const base = { classId: 'c-reflect', key: KEY, turn: 1, decision: 'team' as const, control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1, organization: team }
      await library.record({ ...base, sessionId: 'a', profile: profile(0.6) })
      const first = await library.suggest({ text: KEY.join(' '), random: () => 0.9 })
      expect(first.change).toMatchObject({ action: 'split', target: { part: 'builder', cause: 'cost' }, baseline: 0.6 })
      expect(first.change!.instruction).toContain('split')
      expect(first.note).toMatchObject({ status: 'trying', action: 'split' })
      const id = first.change!.id
      await library.record({ ...base, sessionId: 'b', profile: halves(0.4), change: id })
      await library.record({ ...base, sessionId: 'c', profile: halves(0.3), change: id })
      const after = await library.suggest({ text: KEY.join(' '), random: () => 0.9 })
      expect(after.kept?.map(item => item.id)).toEqual([id])
      expect(after.note).toMatchObject({ status: 'kept', action: 'split' })
      expect((await library.summary())[0]).toMatchObject({ classId: 'c-reflect', changesKept: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gives a differently worded task in the same project the change of the class it will be recorded in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'org-project-'))
    try {
      const library = new OrganizationLibrary(dir)
      const traits = ['ext:js', 'ext:md', 'tool:bash']
      const base = { key: KEY, turn: 1, decision: 'team' as const, control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1, organization: team, projectRoot: '/p', traits }
      await library.record({ ...base, classId: 'c-project', sessionId: 'a', profile: profile(0.6) })
      const text = '给命令行工具加撤销和导入两个命令，再加一个统计页'
      // Another project, or no project: the words alone decide (a new class, no change).
      expect((await library.suggest({ text, random: () => 0.9, projectRoot: '/q' })).change).toBeUndefined()
      const same = await library.suggest({ text, random: () => 0.9, projectRoot: '/p' })
      expect(same).toMatchObject({ classId: 'c-project', change: { action: 'split' } })
      // Recorded with the change it tried, the run is judged (one better run: still trying, no second change).
      await library.record({ ...base, key: same.key, classId: same.classId, sessionId: 'b', profile: halves(0.4), change: same.change!.id })
      const lines = await library.lines()
      expect(lines.filter(line => line.type === 'change')).toHaveLength(1)
      expect((await library.suggest({ text: KEY.join(' '), random: () => 0.9 })).change?.id).toBe(same.change!.id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lets a model pick the change from the run records, and falls back to the rule when it cannot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'org-model-'))
    try {
      const base = { classId: 'c-model', key: KEY, turn: 1, decision: 'team' as const, control: false, reorganizations: 0, corrections: 0, completed: true, usd: 1, organization: team }
      const asked: ReflectionRequest[] = []
      // The model's answer, as text, for each call in turn.
      const answers = [
        '{"cause":"The builder read the whole tree before each edit.","action":"narrow-reading","reason":"Its cost was reading, not the size of its part, so splitting would only double the reading."}',
        '{"cause":"x","action":"parallelize","reason":"not one of the listed changes"}',
      ]
      const reflector = async (request: ReflectionRequest) => {
        asked.push(request)
        return parseChoice(answers.shift() ?? 'not json')
      }
      const library = new OrganizationLibrary(dir, { reflector })
      await library.record({ ...base, sessionId: 'a', profile: profile(0.6) })
      const first = await library.suggest({ text: KEY.join(' '), random: () => 0.9 })
      // Data found the hotspot; the model chose among the changes that fit it.
      expect(asked[0]).toMatchObject({ sessionId: 'a', turn: 1, hotspot: { part: 'builder', cause: 'cost' }, allowed: ['split', 'narrow-reading'] })
      expect(first.change).toMatchObject({ action: 'narrow-reading', chosenBy: 'model', cause: 'The builder read the whole tree before each edit.', baseline: 0.6 })
      expect(first.change!.instruction).toContain('read only those')
      expect(first.change!.instruction).toContain('Found cause: The builder read')

      // A worse run reverts it on the same data; with one fitting change left there is nothing to ask.
      await library.record({ ...base, sessionId: 'b', profile: profile(0.6, { usd: 2 }), usd: 2, change: first.change!.id })
      const second = await library.suggest({ text: KEY.join(' '), random: () => 0.9 })
      expect(second.note).toMatchObject({ status: 'reverted', action: 'narrow-reading' })
      expect(asked).toHaveLength(1)
      expect(second.change).toMatchObject({ action: 'split', chosenBy: 'rule' })
      expect(second.change!.reason).toBeUndefined()

      // An answer outside the list leaves the rule's pick.
      const invalid = new OrganizationLibrary(join(dir, 'invalid'), { reflector })
      await invalid.record({ ...base, sessionId: 'd', profile: profile(0.6) })
      expect(asked).toHaveLength(2)
      expect((await invalid.suggest({ text: KEY.join(' '), random: () => 0.9 })).change).toMatchObject({ action: 'split', chosenBy: 'rule' })

      // A failing reflector leaves the rule's pick too.
      const failing = new OrganizationLibrary(join(dir, 'other'), { reflector: async () => { throw new Error('offline') } })
      await failing.record({ ...base, sessionId: 'c', profile: profile(0.6) })
      expect((await failing.suggest({ text: KEY.join(' '), random: () => 0.9 })).change).toMatchObject({ action: 'split', chosenBy: 'rule' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('shows the model the hot part\'s own records', async () => {
    const at = '2026-10-20T00:00:00.000Z'
    const coordinator = [
      { type: 'session.start', ts: at, seq: 1, model: 'm' },
      { type: 'user.message', ts: at, seq: 2, turn: 1, source: 'user', content: 'do it' },
      { type: 'subagent.start', ts: at, seq: 3, turn: 1, childSessionId: 'k', childTurn: 1, name: 'builder', executionForm: 'workflow', task: 'build the thing' },
    ] as unknown as SessionRecord[]
    const child = [
      { type: 'assistant.message', ts: at, seq: 1, turn: 1, step: 1, content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], usage: {} },
      { type: 'tool.result', ts: at, seq: 2, turn: 1, step: 1, toolCallId: 'c1', name: 'read_file', content: '', isError: true, error: { code: 'tool/failed', message: 'no such file a' }, durationMs: 1 },
    ] as unknown as SessionRecord[]
    const excerpt = await partExcerpt({ sessionId: 's', turn: 1, hotspot: { part: 'builder', kind: 'implement', cause: 'failures', value: 2 } }, async id => (id === 's' ? coordinator : child))
    expect(excerpt).toContain('--- builder, run 1 ---')
    expect(excerpt).toContain('[call] read_file {"path":"a"}')
    expect(excerpt).toContain('[failed] read_file: no such file a')
    expect(excerpt).not.toContain('do it')
    // Over the project's model: one auxiliary request on the run's model; a failed request leaves it to the rule.
    const request: ReflectionRequest = { sessionId: 's', turn: 1, hotspot: { part: 'builder', kind: 'implement', cause: 'failures', value: 2 }, profile: profile(0.6), allowed: ['sequence', 'split'] }
    const llm = scriptedProvider([], { reflectionReply: '{"cause":"It read a file that did not exist yet.","action":"sequence","reason":"The file came from a part that ran at the same time."}' })
    const reflect = modelReflector({ llm: () => llm, readRecords: async id => (id === 's' ? coordinator : child) })
    expect(await reflect(request)).toMatchObject({ action: 'sequence' })
    expect(llm.reflectionCalls[0]!.request).toMatchObject({ model: 'm' })
    expect(llm.reflectionCalls[0]!.options).toMatchObject({ purpose: 'auxiliary' })
    expect(llm.calls).toHaveLength(0)
    // Through the script instead (empty: the request fails).
    const failing = scriptedProvider([], { reflectionReply: false })
    expect(await modelReflector({ llm: () => failing, readRecords: async id => (id === 's' ? coordinator : child) })(request)).toBeUndefined()
    expect(failing.calls).toHaveLength(1)
    expect(await modelReflector({ llm: () => undefined, readRecords: async () => coordinator })(request)).toBeUndefined()
    expect(parseChoice('```json\n{"cause":"c","action":"merge","reason":"r"}\n```')).toEqual({ action: 'merge', cause: 'c', reason: 'r' })
    expect(parseChoice('{"cause":"c","action":"rewrite-everything","reason":"r"}')).toBeUndefined()
  })

  it('compares the latest similar team tasks with the first ones', () => {
    const r = (usd: number, ms: number, good = true): ReflectedRun => ({ id: `s${usd}`, seq: 0, decision: 'team', usd, profile: profile(0.5, { usd, ms }), good })
    expect(sinceStart([r(1, 10), r(1, 10), r(1, 10)])).toBeUndefined()
    expect(sinceStart([r(1, 10_000), r(1, 10_000), r(0.7, 8_000), r(0.7, 8_000)])).toEqual({ costChange: -0.3, timeChange: -0.2, qualityHeld: true })
  })
})

export type { OrganizationRun }
