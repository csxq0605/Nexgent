import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The host's own rule (not a dependency of this package: read from the built tasking package).
import { TEST_COMMAND_PATTERN } from '../../tasking/dist/task-records.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadStep3Packages } from '../../../scripts/accept-common/step3-runtime.mjs'
import {
  checkSource,
  COMPONENTS,
  outputFor,
  REPLAY_TASKS,
  runCheck,
  runReplayHistory,
  TASK_A,
  TASK_B,
  writeReplayProject,
  type FamilyTask,
} from '../../../scripts/accept-common/step4-fixtures.mjs'
import * as harness from '../src/index.js'
import { expectedRegionsCsv, expectedSummary, judgeSummary, MONTHS, ordersCsv, parseOrders } from '../../../scripts/real-task/step4-orders.mjs'

const ALL_TASKS: FamilyTask[] = [...REPLAY_TASKS, TASK_A, TASK_B]

describe('order family (scripts/real-task/step4-orders.mjs)', () => {
  it('generates the same CSV every time; months differ; every month has a discounted order', () => {
    for (const month of [...MONTHS.history, MONTHS.taskA, MONTHS.taskB]) {
      expect(ordersCsv(month)).toBe(ordersCsv(month))
      const rows = parseOrders(ordersCsv(month))
      expect(rows.length).toBeGreaterThanOrEqual(24)
      expect(rows.every(row => row.date.startsWith(month))).toBe(true)
      expect(rows.some(row => row.discount > 0)).toBe(true)
    }
    expect(ordersCsv('2026-06')).not.toBe(ordersCsv('2026-07'))
    expect(() => ordersCsv('June')).toThrow(/YYYY-MM/)
  })

  it('expected summary of a hand-made CSV', () => {
    const csv = 'order_id,date,region,product,quantity,unit_price,discount\n1,2026-01-03,North,Desk,2,100,0.1\n2,2026-01-04,South,Lamp,3,10,0\n3,2026-01-05,North,Lamp,1,10,0\n'
    expect(expectedSummary(csv)).toEqual({ month: '2026-01', orders: 3, units: 6, revenue: 220, byRegion: { North: 190, South: 30 }, topProduct: 'Lamp' })
    expect(expectedRegionsCsv(csv)).toBe('region,orders,revenue\nNorth,2,190.00\nSouth,1,30.00\n')
  })

  it('the hidden judge passes the right summary and names each wrong field', () => {
    const csv = ordersCsv('2026-09')
    const right = expectedSummary(csv)
    expect(judgeSummary(csv, JSON.stringify(right))).toEqual({ pass: true, problems: [] })
    expect(judgeSummary(csv, 'not json')).toMatchObject({ pass: false, problems: [expect.stringMatching(/not JSON/)] })
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['month', { month: '2026-08' }, /^month/],
      ['orders', { orders: right.orders + 1 }, /^orders/],
      ['units', { units: right.units - 1 }, /^units/],
      ['revenue', { revenue: right.revenue + 1 }, /^revenue/],
      ['a region', { byRegion: { ...right.byRegion, North: 0 } }, /^North revenue/],
      ['missing region', { byRegion: { North: right.byRegion['North'] } }, /^regions/],
      ['top product', { topProduct: 'Nothing' }, /^topProduct/],
    ]
    for (const [label, patch, problem] of cases) {
      const result = judgeSummary(csv, JSON.stringify({ ...right, ...patch }))
      expect(result.pass, label).toBe(false)
      expect(result.problems.some(text => problem.test(text)), `${label}: ${result.problems.join('; ')}`).toBe(true)
    }
  })
})

describe('candidates and the replay project (scripts/accept-common/step4-fixtures.mjs)', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexgent-step4-fixture-'))
    await writeReplayProject(root)
    await mkdir(join(root, 'out'), { recursive: true })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('selection and guard tasks never overlap; selection is the candidate\'s kind; A and B are new months', () => {
    const selection = REPLAY_TASKS.filter(t => t.set === 'selection')
    const guard = REPLAY_TASKS.filter(t => t.set === 'guard')
    expect(selection.length).toBeGreaterThanOrEqual(2)
    expect(guard.length).toBeGreaterThanOrEqual(1)
    expect(selection.every(t => t.kind === 'summary')).toBe(true)
    expect(guard.every(t => t.kind !== 'summary')).toBe(true)
    expect(new Set(ALL_TASKS.map(t => t.month)).size).toBe(ALL_TASKS.length)
    expect(TASK_A.ask).toMatch(/reusable function or skill/)
    expect(TASK_B.ask).not.toMatch(/reusable|function|skill/)
  })

  it('the good and bad candidates are the same components, differing only in the discount', () => {
    expect(COMPONENTS.good.functionModule.name).toBe(COMPONENTS.bad.functionModule.name)
    expect(COMPONENTS.good.skill.name).toBe(COMPONENTS.bad.skill.name)
    expect(COMPONENTS.good.functionModule.source).toContain('cells[6]')
    expect(COMPONENTS.bad.functionModule.source).not.toContain('cells[6]')
    expect(COMPONENTS.good.skill.source).toMatch(/1 − discount/)
    expect(COMPONENTS.bad.skill.source).not.toMatch(/1 − discount/)
  })

  it.each(ALL_TASKS.map(t => [t.id, t] as const))('%s: the good output passes the hidden judge and the test command; the bad one fails both on summaries', async (_id, entry) => {
    const csv = ordersCsv(entry.month)
    for (const quality of ['good', 'bad'] as const) {
      const output = await outputFor(entry, quality)
      await writeFile(join(root, entry.output), output)
      const check = runCheck(root, entry)
      const hidden = entry.kind === 'summary' ? judgeSummary(csv, output).pass : output === expectedRegionsCsv(csv)
      const expected = quality === 'good' || entry.kind !== 'summary'
      expect(hidden, `${quality} hidden`).toBe(expected)
      expect(check.passed, `${quality} check: ${check.stdout}`).toBe(expected)
      expect(check.exitCode).toBe(expected ? 0 : 1)
    }
  })

  it('the test command fails on a missing output and exits 2 on bad usage', async () => {
    const missing = { ...TASK_B, id: 'missing', output: 'out/nothing.json', checkCommand: 'node --test checks/missing.test.mjs' }
    await writeFile(join(root, 'checks/missing.test.mjs'), checkSource(missing))
    expect(runCheck(root, missing)).toMatchObject({ exitCode: 1, stdout: expect.stringMatching(/does not exist/) })
    expect(runCheck(root, { ...TASK_B, checkCommand: 'node checks/verify.mjs' }).exitCode).toBe(2)
  })

  it('every test command is one the host re-runs as the task\'s test-command check', () => {
    for (const entry of ALL_TASKS) expect(TEST_COMMAND_PATTERN.test(entry.checkCommand), entry.checkCommand).toBe(true)
  })
})

describe('replay history through @nexgent/sdk (requires `pnpm build`)', () => {
  let work: string
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'nexgent-step4-replay-'))
  })
  afterAll(async () => {
    await rm(work, { recursive: true, force: true })
  })

  it('every history task completes; the test command passes under good and fails on summaries under bad', async () => {
    const pkgs = await loadStep3Packages()
    if (!pkgs.ok) throw new Error(pkgs.reason)
    for (const quality of ['good', 'bad'] as const) {
      const obs = await runReplayHistory(harness, pkgs.pkgs, work, { quality })
      expect(obs.tasks.map(t => t.id)).toEqual(REPLAY_TASKS.map(t => t.id))
      for (const task of obs.tasks) {
        expect(task.reason, `${quality} ${task.id}`).toEqual({ kind: 'completed' })
        expect(task.output).not.toBeNull()
        expect(task.check.passed, `${quality} ${task.id}: ${task.check.stdout}`).toBe(quality === 'good' || task.set === 'guard')
      }
    }
  }, 120_000)
})
