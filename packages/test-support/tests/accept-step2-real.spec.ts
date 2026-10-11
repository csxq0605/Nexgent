/**
 * The accept-step2 R judges and the real task's hidden check, against one run
 * of the real-layer runner with a scripted stand-in for the model (loopback,
 * fake key — no real model), plus a copy of that run broken in the one way
 * each judge exists to catch.
 *
 * Needs the packages built (`pnpm build`), like the acceptance script.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { judgeReal, REAL_JUDGES } from '../../../scripts/accept-common/step2-real-judges.mjs'
import { realLikeScript } from '../../../scripts/accept-common/step2-real-scripted.mjs'
import { ledgerUsage, MATERIALS_DIR, runRealScenario } from '../../../scripts/accept-common/step2-real.mjs'
import type { Observations } from '../../../scripts/accept-common/step2-judges.mjs'
import { checkReadme, checkSummary, expectedSummary } from '../../../scripts/real-task/step2-sales-hidden.mjs'
import { ordersCsv, regionsXlsx } from '../../../scripts/real-task/step2-sales/generate.mjs'
import * as h from '../src/index.js'

let work: string
let good: Observations

beforeAll(async () => {
  const server = await h.scriptedModelServer({ script: realLikeScript() as never })
  try {
    work = await mkdtemp(join(tmpdir(), 'nxreal-'))
    good = await runRealScenario(h, work, { env: { NEXGENT_API_KEY: 'sk-scripted-real-layer-0000', NEXGENT_API_BASE_URL: server.baseUrl }, runCapUsd: 5, turnTimeoutMs: 60_000 })
    server.assertConsumed()
  } finally {
    await server.close()
  }
}, 180_000)

afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

function broken(mutate: (obs: Observations) => void): Observations {
  const copy = structuredClone(good)
  mutate(copy)
  return copy
}
const asReal = (obs: Observations): Observations => ({ ...obs, realModel: true })
const toolEvent = (obs: Observations, phase: string, name: string) => {
  const events = obs.phases[phase].events as Array<Record<string, any>>
  const start = events.find(e => e.type === 'tool.start' && e.name === name)!
  return events.find(e => e.type === 'tool.result' && e.callId === start.callId)!
}

describe('step-2 real task materials and hidden check', () => {
  it('the committed materials are what the generator writes', async () => {
    expect(await readFile(join(MATERIALS_DIR, 'orders.csv'), 'utf8')).toBe(ordersCsv())
    expect(new Uint8Array(await readFile(join(MATERIALS_DIR, 'regions.xlsx')))).toEqual(new Uint8Array(regionsXlsx()))
  })

  it('the expected summary drops repeated ids and empty regions and parses separators', () => {
    const rows = expectedSummary('order_id,order_date,region,amount\nA,2026-01-02,north,"1,000.50"\nA,2026-01-02,north,"1,000.50"\nB,2026-01-03, NORTH,99.50\nC,2026-01-04,,7\n'
      + 'D,2026-02-01,north,550\n')
    const north = rows.filter(r => r.region === '华北')
    expect(north[0]).toEqual({ region: '华北', month: '2026-01', sales: 1100, growth: null })
    expect(north[1]).toMatchObject({ month: '2026-02', sales: 550, growth: -0.5 })
  })

  it('checkSummary and checkReadme fail on wrong output', async () => {
    const expected = expectedSummary(ordersCsv())
    const good = ['region,month,sales,mom_growth', ...expected.map(e => [e.region, e.month, e.sales.toFixed(2), e.growth === null ? '' : e.growth.toFixed(4)].join(','))].join('\n')
    expect(checkSummary(good, expected).every(([ok]) => ok)).toBe(true)
    const percent = ['region,month,sales,mom_growth', ...expected.map(e => [e.region, e.month, e.sales.toFixed(2), e.growth === null ? '' : `${(e.growth * 100).toFixed(2)}%`].join(','))].join('\n')
    expect(checkSummary(percent, expected).every(([ok]) => ok)).toBe(true)
    const failing = (text: string) => checkSummary(text, expected).filter(([ok]) => !ok).length
    expect(failing(good.replace('华北', 'north'))).toBeGreaterThan(0)
    expect(failing(good.replace(/,mom_growth/, ''))).toBeGreaterThan(0)
    expect(failing(good.split('\n').slice(0, -1).join('\n'))).toBeGreaterThan(0)
    const lines = good.split('\n')
    lines[3] = lines[3]!.replace(/,([0-9.]+),/, (_, n: string) => `,${(Number(n) + 1).toFixed(2)},`)
    expect(failing(lines.join('\n'))).toBeGreaterThan(0)
    expect(checkReadme('# 汇总\n').filter(([ok]) => !ok).length).toBe(3)
    expect(checkReadme('订单号重复只保留第一条；地区为空剔除；金额去掉千分位').every(([ok]) => ok)).toBe(true)
  })
})

describe('accept-step2 R judges', () => {
  it('R02 accepts an absolute path inside the project for the feedback-round str_replace', () => {
    const obs = broken((o) => {
      for (const e of o.phases.feedback.events) {
        if (e.type === 'tool.start' && e.name === 'str_replace') e.arguments = JSON.stringify({ ...JSON.parse(e.arguments), path: `/somewhere/project/${JSON.parse(e.arguments).path}` })
      }
    })
    expect(judgeReal('R02', obs).status).toBe('passed')
  })

  it('R01–R05 pass on the scripted run; R07 says it is not a real run; R06 only on Windows', () => {
    expect(good.error, String(good.error)).toBeUndefined()
    for (const id of ['R01', 'R02', 'R03', 'R04', 'R05']) {
      const result = judgeReal(id, good)
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
    expect(judgeReal('R07', good)).toMatchObject({ status: 'not-implemented' })
    expect(judgeReal('R07', asReal(good)).status).toBe('passed')
    expect(judgeReal('R06', good).status).toBe(process.platform === 'win32' ? 'failed' : 'not-implemented')
  })

  const cases: Array<[string, string, (obs: Observations) => void]> = [
    ['R01', 'a hidden check fails', obs => { obs.hidden[0].ok = false }],
    ['R01', 'there is no v3', obs => { obs.deliverable.versions = [1, 2] }],
    ['R01', 'the v1 snapshot changed', obs => { obs.v1AtEnd[0].actual = '0'.repeat(64) }],
    ['R02', 'str_replace never succeeded', obs => {
      for (const phase of ['first', 'feedback', 'resume']) {
        for (const e of obs.phases[phase].events) if (e.type === 'tool.start' && e.name === 'str_replace') e.name = 'bash'
      }
    }],
    ['R02', 'the feedback round rewrote files with write_file', obs => {
      for (const e of obs.phases.feedback.events) if (e.type === 'tool.start' && e.name === 'str_replace') e.name = 'write_file'
    }],
    ['R02', 'the feedback round only str_replaced a file that did not exist before', obs => {
      for (const e of obs.phases.feedback.events) if (e.type === 'tool.start' && e.name === 'str_replace') e.arguments = JSON.stringify({ ...JSON.parse(e.arguments), path: 'report/new-file.md' })
    }],
    ['R02', 'write_file failed', obs => { toolEvent(obs, 'first', 'write_file').isError = true; for (const e of obs.phases.first.events) if (e.type === 'tool.start' && e.name === 'write_file') e.name = 'write_file_x' }],
    ['R03', 'no thinking blocks in the session', obs => { for (const r of obs.records) delete r.providerContent }],
    ['R03', 'a request was rejected with 400', obs => { obs.ledger.find((r: Record<string, any>) => r.type === 'llm.request.end').httpStatus = 400 }],
    ['R03', 'thinking was off', obs => { obs.config.thinking = 'off' }],
    ['R04', 'the turn finished before the kill', obs => { obs.phases.kill.finishedBeforeKill = true }],
    ['R04', 'the killed request got a normal end', obs => {
      const id = obs.phases.kill.requestIds.at(-1)
      obs.ledger.push({ type: 'llm.request.end', requestId: id, status: 'ok', usage: {} })
      obs.usage.unknownRequestIds = []
    }],
    ['R04', 'the resumed turn failed', obs => { obs.phases.resume.reason = { kind: 'error' } }],
    ['R05', 'no feedback record', obs => { obs.records = obs.records.filter((r: Record<string, any>) => r.type !== 'feedback') }],
    ['R05', 'only one material', obs => { obs.materials = obs.materials.slice(0, 1) }],
    ['R06', 'a Windows run used bash', obs => { obs.platform = 'win32' }],
    ['R07', 'another request has unknown usage', obs => { Object.assign(obs, asReal(obs)); obs.usage.unknownRequestIds = [...obs.usage.unknownRequestIds, 'extra'] }],
    ['R07', 'the estimate passed the run cap', obs => { Object.assign(obs, asReal(obs)); obs.usage.costUsd = 9 }],
    ['R07', 'the run stopped for cost', obs => { Object.assign(obs, asReal(obs)); obs.stoppedForCost = { after: 'first', costUsd: 6 } }],
  ]

  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judgeReal(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(REAL_JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('no observations at all is never a pass', () => {
    for (const id of Object.keys(REAL_JUDGES)) expect(judgeReal(id, {}).status, id).not.toBe('passed')
  })

  it('ledger usage: open starts and unknown usage count as unknown; cost from known usage', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const result = ledgerUsage([
      { type: 'llm.request.start', requestId: 'a', sessionId: 's' },
      { type: 'llm.request.end', requestId: 'a', sessionId: 's', usage },
      { type: 'llm.request.start', requestId: 'b', sessionId: 's' },
      { type: 'llm.request.start', requestId: 'c', sessionId: 's' },
      { type: 'llm.request.end', requestId: 'c', sessionId: 's', usage: { ...usage, inputTokens: 'unknown' } },
      { type: 'llm.request.start', requestId: 'x', sessionId: 'other' },
    ], 's')
    expect(result).toMatchObject({ callCount: 3, unknownCount: 2, unknownRequestIds: ['b', 'c'] })
    expect(result.costUsd).toBeCloseTo(2 + 1 + 1, 4)
  })
})
