/**
 * The step-5 task family and fixtures (scripts/real-task/step5-orders.mjs,
 * scripts/accept-common/step5-fixtures.mjs): the hidden judge, the counting
 * oracle, the project's checker (both arms pass, wrong tables fail), and the
 * three playbooks' shapes. No model is called.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The host's own rules (not dependencies of this package: read from the built packages).
import * as evolve from '../../evolve/dist/index.js'
import { FAILURE_CATEGORIES, functionToolName, IMPROVE_REPORT_DIAGNOSIS_TOOL } from '../../kernel/dist/index.js'
import { validateImprovementFile } from '../../session/dist/index.js'
import { TEST_COMMAND_PATTERN } from '../../tasking/dist/task-records.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BROKEN_MODULE,
  CONVENTION_SKILL,
  DIAGNOSIS_TOOL,
  FEEDBACK_TASK,
  HISTORY_TASKS,
  isDiagnosisRequest,
  isProposalRequest,
  JOB_STATES,
  MAST,
  NEXT_TASK,
  outputFor,
  PARKED_STATES,
  playbook,
  playbookScript,
  PLAYBOOKS,
  EXTRA_PLAYBOOKS,
  PROPOSAL_MARKER,
  SECOND_SKILL,
  MISSING_SESSION,
  runCheck,
  TERMINAL_STATES,
  writeFeedbackProject,
  type FamilyTask,
} from '../../../scripts/accept-common/step5-fixtures.mjs'
import {
  CONVENTION_COLUMN,
  countsTowardImprovement,
  FEEDBACK,
  judgeRegionTable,
  MONTHS,
  ordersCsv,
  regionTable,
  SECOND_FEEDBACK,
  THRESHOLD,
} from '../../../scripts/real-task/step5-orders.mjs'
import * as harness from '../src/index.js'

const ALL_TASKS: FamilyTask[] = [...HISTORY_TASKS, FEEDBACK_TASK, NEXT_TASK]
const ctx = { sessionId: 's-feedback', turn: 2, seq: 7 }

describe('region-table family (scripts/real-task/step5-orders.mjs)', () => {
  const csv = 'order_id,date,region,product,quantity,unit_price,discount\n1,2026-01-03,North,Desk,2,100,0.1\n2,2026-01-04,South,Lamp,3,10,0\n3,2026-01-05,North,Lamp,1,10,0\n'

  it('region table of a hand-made CSV, with and without the convention column', () => {
    expect(regionTable(csv, { withAverage: false })).toBe('region,orders,revenue\nNorth,2,190.00\nSouth,1,30.00\n')
    expect(regionTable(csv, { withAverage: true })).toBe(`region,orders,revenue,${CONVENTION_COLUMN}\nNorth,2,190.00,95.00\nSouth,1,30.00,30.00\n`)
  })

  it('the hidden judge passes the wanted table and names the missing column as the only problem of the asked one', () => {
    expect(judgeRegionTable(csv, regionTable(csv, { withAverage: true }))).toEqual({ pass: true, problems: [], missingConvention: false })
    expect(judgeRegionTable(csv, regionTable(csv, { withAverage: false }))).toEqual({ pass: false, problems: [`column ${CONVENTION_COLUMN} is missing`], missingConvention: true })
  })

  it('the hidden judge fails wrong tables, and a wrong table without the column is not "only the column"', () => {
    const wrongAvg = regionTable(csv, { withAverage: true }).replace('95.00', '90.00')
    expect(judgeRegionTable(csv, wrongAvg)).toMatchObject({ pass: false, missingConvention: false, problems: [expect.stringContaining('North avg_order_value 90.00')] })
    const wrongRevenue = regionTable(csv, { withAverage: false }).replace('190.00', '200.00')
    expect(judgeRegionTable(csv, wrongRevenue)).toMatchObject({ pass: false, missingConvention: false })
    const unsorted = 'region,orders,revenue,avg_order_value\nSouth,1,30.00,30.00\nNorth,2,190.00,95.00\n'
    expect(judgeRegionTable(csv, unsorted).pass).toBe(false)
    expect(judgeRegionTable(csv, null)).toMatchObject({ pass: false, missingConvention: false })
    expect(judgeRegionTable(csv, 'region,revenue\nNorth,190\n')).toMatchObject({ pass: false, problems: ['column orders is missing'] })
  })

  it('counts feedback by user decision 2: rating ≤ 3, or a comment without a rating', () => {
    expect(countsTowardImprovement({ rating: 3, comment: 'x' })).toBe(true)
    expect(countsTowardImprovement({ rating: 1, comment: '' })).toBe(true)
    expect(countsTowardImprovement({ rating: 4, comment: 'missing a column' })).toBe(false)
    expect(countsTowardImprovement({ rating: 5, comment: '' })).toBe(false)
    expect(countsTowardImprovement({ comment: 'missing a column' })).toBe(true)
    expect(countsTowardImprovement({ comment: '  ' })).toBe(false)
    expect(countsTowardImprovement(undefined)).toBe(false)
  })

  it('the feedback fixture: exactly N counted, worded differently, naming the column; none mentions a capability tool', () => {
    const counted = FEEDBACK.filter(countsTowardImprovement)
    expect(THRESHOLD).toBe(3)
    expect(counted).toHaveLength(THRESHOLD)
    expect(FEEDBACK.length).toBeGreaterThan(counted.length)
    expect(new Set(counted.map(f => f.comment)).size).toBe(THRESHOLD)
    for (const f of counted) expect(f.comment).toMatch(/平均客单价|avg_order_value/)
    expect(SECOND_FEEDBACK.filter(countsTowardImprovement)).toHaveLength(THRESHOLD)
    for (const f of [...FEEDBACK, ...SECOND_FEEDBACK]) expect(f.comment).not.toMatch(/capability|能力|技能|skill|函数/i)
  })
})

describe('feedback project (scripts/accept-common/step5-fixtures.mjs)', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexgent-step5-fixture-'))
    await writeFeedbackProject(root)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('asks never name the convention column or a capability tool; every check command is one the host re-runs', () => {
    for (const task of ALL_TASKS) {
      expect(task.ask).not.toMatch(/avg|average|平均|capability|skill|function/i)
      expect(TEST_COMMAND_PATTERN.test(task.checkCommand), task.checkCommand).toBe(true)
    }
    expect(HISTORY_TASKS.map(t => t.set)).toEqual(['guard', 'guard', 'selection'])
    expect(FEEDBACK_TASK).toMatchObject({ kind: 'regions', month: MONTHS.feedback, set: 'selection' })
    expect(NEXT_TASK).toMatchObject({ kind: 'regions', month: MONTHS.next })
  })

  it('the project check passes both arms (with and without the column) and fails a wrong table', async () => {
    for (const task of ALL_TASKS) {
      await mkdir(join(root, 'out'), { recursive: true })
      for (const withAverage of [false, true]) {
        await writeFile(join(root, task.output), outputFor(task, { withAverage }))
        expect(runCheck(root, task), `${task.id} withAverage=${withAverage}`).toMatchObject({ passed: true })
      }
    }
    const wrong = outputFor(FEEDBACK_TASK, { withAverage: true }).split('\n').map((line, i) => (i === 1 ? line.replace(/,([\d.]+)$/, ',0.01') : line)).join('\n')
    await writeFile(join(root, FEEDBACK_TASK.output), wrong)
    expect(runCheck(root, FEEDBACK_TASK)).toMatchObject({ passed: false, exitCode: 1, stdout: expect.stringContaining(`${CONVENTION_COLUMN}`) })
    await writeFile(join(root, FEEDBACK_TASK.output), 'region,orders\n')
    expect(runCheck(root, FEEDBACK_TASK)).toMatchObject({ passed: false, stdout: expect.stringContaining('column revenue is missing') })
  })

  it('the tables the user tasks write lack only the convention column; the hidden judge passes the wanted ones', () => {
    for (const task of [FEEDBACK_TASK, NEXT_TASK]) {
      const csv = ordersCsv(task.month)
      expect(judgeRegionTable(csv, outputFor(task)).missingConvention).toBe(true)
      expect(judgeRegionTable(csv, outputFor(task, { withAverage: true })).pass).toBe(true)
    }
  })
})

describe('playbooks', () => {
  const callsOf = (name: (typeof PLAYBOOKS)[number]) => playbook(name, ctx).steps.flatMap(step => step.toolCalls ?? [])

  it('the diagnosis tool and categories are the contract\'s', () => {
    expect(DIAGNOSIS_TOOL).toBe(IMPROVE_REPORT_DIAGNOSIS_TOOL.name)
    expect([...MAST]).toEqual([...FAILURE_CATEGORIES])
  })

  it('three playbooks in plan order; each reports one diagnosis with MAST labels citing the feedback record', () => {
    expect(PLAYBOOKS).toEqual(['improve', 'not-capability', 'broken'])
    expect(PLAYBOOKS.map(name => playbook(name, ctx).title)).toEqual(['该改进', '不是能力问题', '提案跑不起来'])
    for (const name of PLAYBOOKS) {
      const diagnoses = callsOf(name).filter(call => call.name === DIAGNOSIS_TOOL)
      expect(diagnoses, name).toHaveLength(1)
      const args = diagnoses[0]!.arguments as { failureTypes: { category: string; evidence: unknown[] }[]; proposalKind: string; hypothesis: string }
      expect(args.failureTypes.length).toBeGreaterThan(0)
      for (const f of args.failureTypes) {
        expect(MAST).toContain(f.category)
        expect(f.evidence).toEqual([ctx])
      }
      // The report is what the contract's diagnosis file holds, minus the host's fields.
      const full = { formatVersion: 1, jobId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', createdAt: '2026-10-13T00:00:00.000Z', sessionId: '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c', attempts: 1, memberCosts: [], ...args }
      expect(validateImprovementFile('diagnosis', full), name).toEqual([])
      expect(args.hypothesis.length).toBeGreaterThan(0)
      // Diagnosis comes first; nothing is drafted before it.
      expect(playbook(name, ctx).steps[0]!.phase).toBe('diagnose')
    }
  })

  it('该改进: one skill drafted, tried, used, then proposed alone; the redo writes the wanted table', () => {
    const book = playbook('improve', ctx)
    const names = callsOf('improve').map(call => call.name)
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    expect(names).toEqual([DIAGNOSIS_TOOL, 'capability_draft', 'capability_try', 'load_skill', 'write_file', shell, 'present', 'capability_propose'])
    const propose = callsOf('improve').find(call => call.name === 'capability_propose')!
    expect(propose.arguments.components).toEqual([{ kind: 'skill', name: CONVENTION_SKILL.name }])
    expect(book.expect).toMatchObject({ candidate: true, component: { kind: 'skill', name: CONVENTION_SKILL.name } })
    expect(judgeRegionTable(ordersCsv(FEEDBACK_TASK.month), book.expect.output!).pass).toBe(true)
    expect(CONVENTION_SKILL.files[0]!.content).toContain(CONVENTION_COLUMN)
    expect((callsOf('improve')[0]!.arguments as { proposalKind: string }).proposalKind).toBe('skill')
  })

  it('不是能力问题: proposalKind none and nothing else; ends no-proposal', () => {
    expect(callsOf('not-capability').map(call => call.name)).toEqual([DIAGNOSIS_TOOL])
    expect((callsOf('not-capability')[0]!.arguments as { proposalKind: string }).proposalKind).toBe('none')
    expect(playbook('not-capability', ctx).expect).toEqual({ candidate: false, outcome: 'no-proposal' })
  })

  it('提案跑不起来: the function module throws, its call is the only use, and the job ends without a candidate', async () => {
    expect(BROKEN_MODULE.tool).toBe(functionToolName(BROKEN_MODULE.name, BROKEN_MODULE.function))
    expect(callsOf('broken').map(call => call.name)).toEqual([DIAGNOSIS_TOOL, 'capability_draft', 'capability_try', BROKEN_MODULE.tool, 'capability_propose'])
    const source = BROKEN_MODULE.files.find(f => f.path === 'index.mjs')!.content
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as { regionTable: () => unknown }
    expect(() => module.regionTable()).toThrow(/not finished/)
    const spec = JSON.parse(BROKEN_MODULE.files.find(f => f.path === 'functions.json')!.content) as { name: string; functions: { name: string }[] }
    expect(spec).toMatchObject({ name: BROKEN_MODULE.name, functions: [{ name: BROKEN_MODULE.function }] })
    const outcome = playbook('broken', ctx).expect.outcome
    expect(outcome).toEqual(['no-proposal', 'failed'])
    for (const state of outcome) expect(TERMINAL_STATES).toContain(state)
  })

  it('job states match @nexgent/evolve: the plan\'s twelve plus the contract\'s cancelled; terminal and parked sets; the counting rule agrees', () => {
    expect(JOB_STATES).toHaveLength(13)
    expect(Object.keys(evolve.JOB_TRANSITIONS).sort()).toEqual([...JOB_STATES].sort())
    expect([...evolve.TERMINAL_STATUSES].sort()).toEqual([...TERMINAL_STATES].sort())
    expect([...evolve.PARKED_STATUSES].sort()).toEqual([...PARKED_STATES].sort())
    expect(evolve.DEFAULT_THRESHOLD).toBe(THRESHOLD)
    for (const entry of [...FEEDBACK, ...SECOND_FEEDBACK, { rating: 4 as const, comment: '' }, { comment: ' ' }]) {
      expect(evolve.countsTowardImprovement(entry), JSON.stringify(entry)).toBe(countsTowardImprovement(entry))
    }
  })

  it('scripts route diagnosis steps to requests offering the diagnosis tool and proposal steps to the snapshot redo', () => {
    const diagnose = { tools: [{ name: DIAGNOSIS_TOOL }], messages: [{ role: 'user', content: 'diagnose' }] }
    const propose = { tools: [{ name: 'capability_draft' }], messages: [{ role: 'user', content: `${PROPOSAL_MARKER}\n…\n# The task\n${FEEDBACK_TASK.ask}` }] }
    const userTask = { tools: [{ name: 'write_file' }], messages: [{ role: 'user', content: FEEDBACK_TASK.ask }] }
    expect(isDiagnosisRequest(diagnose)).toBe(true)
    expect(isDiagnosisRequest(propose)).toBe(false)
    expect(isProposalRequest(harness)(propose)).toBe(true)
    expect(isProposalRequest(harness)(userTask)).toBe(false)
    for (const name of [...PLAYBOOKS, ...EXTRA_PLAYBOOKS]) expect(playbookScript(harness, name, ctx)).toHaveLength(playbook(name, ctx).steps.length)
  })

  it('诊断不合 schema: a category outside MAST, then evidence the project does not have, then the session gives up', () => {
    const reports = callsOf('invalid').filter(call => call.name === DIAGNOSIS_TOOL)
    expect(reports).toHaveLength(3)
    const full = (args: unknown) => ({ formatVersion: 1, jobId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', createdAt: '2026-10-13T00:00:00.000Z', sessionId: '1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c', attempts: 1, memberCosts: [], ...(args as object) })
    const evidence = (call: { arguments: unknown }) => (call.arguments as { failureTypes: { evidence: { sessionId: string; seq: number }[] }[] }).failureTypes[0]!.evidence[0]!
    expect(validateImprovementFile('diagnosis', full(reports[0]!.arguments)).length).toBeGreaterThan(0)
    // The other two pass the schema; the host refuses them because the cited records do not exist.
    expect(validateImprovementFile('diagnosis', full(reports[1]!.arguments))).toEqual([])
    expect(evidence(reports[1]!)).toEqual({ sessionId: ctx.sessionId, seq: 99_999 })
    expect(validateImprovementFile('diagnosis', full(reports[2]!.arguments))).toEqual([])
    expect(evidence(reports[2]!)).toEqual({ sessionId: MISSING_SESSION, seq: 1 })
    expect(playbook('invalid', ctx).steps.at(-1)).toMatchObject({ phase: 'diagnose', content: expect.any(String) })
    expect(playbook('invalid', ctx).expect).toEqual({ candidate: false, outcome: 'failed' })
  })

  it('多于一个组件: two skills drafted, tried and loaded, proposed together', () => {
    const names = callsOf('two').map(call => call.name)
    expect(names.filter(name => name === 'capability_try')).toHaveLength(2)
    expect(names.filter(name => name === 'load_skill')).toHaveLength(2)
    const propose = callsOf('two').find(call => call.name === 'capability_propose')!
    expect(propose.arguments.components).toEqual([{ kind: 'skill', name: CONVENTION_SKILL.name }, { kind: 'skill', name: SECOND_SKILL.name }])
    expect(playbook('two', ctx).expect).toEqual({ candidate: false, outcome: 'failed' })
  })
})
