import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_SUMMARY_SCHEMA,
  acceptanceSummary,
  validateAcceptanceSummary,
} from '../src/index.js'

function builder() {
  return acceptanceSummary({
    step: 1,
    name: '本地执行内核',
    exitCriteria: ['accept-step1 passes on Linux and Windows'],
    script: 'scripts/accept-step1.mjs',
    simulated: 'run → write file → kill → resume',
  })
}

describe('acceptanceSummary', () => {
  it('builds a valid passing summary with environment, checks, faults and ledger', async () => {
    const b = builder()
      .check('run completes', true)
      .fault('kill')
      .fault('truncate')
      .fault('kill')
      .ledger([], 0)
      .proves('scripted run/resume works on this platform')
      .doesNotProve('real model behaviour')
      .untested('Windows ACL')
    expect(await b.run('resume continues', async () => 42)).toBe(42)
    const summary = b.build()
    expect(summary.result).toBe('pass')
    expect(summary.kind).toBe('nexgent.acceptance-summary')
    expect(summary.environment.platform).toBe(process.platform)
    expect(summary.environment.node).toBe(process.version)
    expect(summary.scripted).toMatchObject({ result: 'pass', command: 'node scripts/accept-step1.mjs', faultsInjected: ['kill', 'truncate'] })
    expect(summary.checks).toHaveLength(2)
    expect(summary.checks[1]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(summary.ledger).toMatchObject({ requestCount: 0, writeFailures: 0 })
    expect(summary.conclusion).toMatchObject({ meetsExitCriteria: true, proves: ['scripted run/resume works on this platform'] })
    expect(summary.failures.untested).toEqual(['Windows ACL'])
    expect(summary.source.commit.length).toBeGreaterThan(0)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
  })

  it('records a thrown check as failed, rethrows, and fails the summary', async () => {
    const b = builder()
    await expect(b.run('kill and resume', () => { throw new Error('no session') })).rejects.toThrow('no session')
    const summary = b.build()
    expect(summary.result).toBe('fail')
    expect(summary.failures.failedCases).toEqual(['kill and resume: no session'])
    expect(summary.conclusion.meetsExitCriteria).toBe(false)
    expect(validateAcceptanceSummary(summary).valid).toBe(true)
  })

  it('an empty summary fails (no checks)', () => {
    expect(builder().build().result).toBe('fail')
  })

  it('supports real-model sections via set()', () => {
    const summary = acceptanceSummary({ step: 1, name: 'x', provider: 'real' })
      .check('real write task', true)
      .set({
        realModel: {
          model: 'mimo-v2.6-pro', thinking: 'off', task: 'write README', callCount: 3,
          knownTokens: { input: 900, output: 'unknown' }, unknownCount: 1, cost: 'unknown', result: 'pass',
          summaryFile: null, runNote: 'manual run', unknownSources: ['usage missing on one response'],
        },
      })
      .build()
    expect(summary.scripted).toBeNull()
    expect(validateAcceptanceSummary(summary).errors).toEqual([])
  })

  it('write() validates and writes pretty JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-ts-'))
    try {
      const path = join(dir, 'nested', 'summary.json')
      await builder().check('ok', true).write(path)
      const text = await readFile(path, 'utf8')
      expect(text.endsWith('}\n')).toBe(true)
      expect(validateAcceptanceSummary(JSON.parse(text)).valid).toBe(true)
      await expect(builder().check('ok', true).set({ raw: { location: null, sha256: 'xyz', summaryDir: null, manifest: [] } }).write(path))
        .rejects.toThrow(/\/raw\/sha256/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('validateAcceptanceSummary', () => {
  const valid = builder().check('ok', true).build()

  it('rejects non-objects, missing fields, extra fields and wrong types', () => {
    expect(validateAcceptanceSummary(null).valid).toBe(false)
    const { step: _step, ...missing } = valid
    expect(validateAcceptanceSummary(missing).errors).toContain('/step: is required')
    expect(validateAcceptanceSummary({ ...valid, extra: 1 }).errors).toContain('/extra: is not allowed')
    expect(validateAcceptanceSummary({ ...valid, checks: [{ name: 'x', passed: 'yes' }] }).errors)
      .toContain('/checks/0/passed: must be boolean, got string')
    expect(validateAcceptanceSummary({ ...valid, date: { ...valid.date, acceptedAt: 'yesterday' } }).valid).toBe(false)
  })

  it('accepts unknown counts but not negative or made-up strings', () => {
    const ledger = { requestCount: 0, statusCounts: { ok: 0, error: 0, aborted: 0, unknown: 0 }, unknownUsageCount: 0,
      knownInputTokens: 0, knownOutputTokens: 0, toolCallCount: 0, taskOutcomes: 0 }
    expect(validateAcceptanceSummary({ ...valid, ledger: { ...ledger, writeFailures: 'unknown' } }).valid).toBe(true)
    expect(validateAcceptanceSummary({ ...valid, ledger: { ...ledger, writeFailures: -1 } }).valid).toBe(false)
    expect(validateAcceptanceSummary({ ...valid, ledger: { ...ledger, writeFailures: 'n/a' } }).valid).toBe(false)
  })

  it('enforces result consistency with checks', () => {
    expect(validateAcceptanceSummary({ ...valid, result: 'fail' }).errors).toEqual(['/result: must be "pass" given checks'])
  })

  it('exposes a JSON Schema document', () => {
    expect(ACCEPTANCE_SUMMARY_SCHEMA['$schema']).toMatch(/2020-12/)
    expect(ACCEPTANCE_SUMMARY_SCHEMA['required']).toContain('environment')
  })
})
