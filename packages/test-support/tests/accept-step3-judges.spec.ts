import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHeadlessScenario } from '../../../scripts/accept-common/step3-headless.mjs'
import { judge, type DirectObservations, type Step3Observations } from '../../../scripts/accept-common/step3-judges.mjs'
import { loadStep2Packages } from '../../../scripts/accept-common/step2-runtime.mjs'
import * as harness from '../src/index.js'

// One real run of the direct phase (scripted model, through the built SDK and CLI); every
// test below judges it or a deliberately broken copy of it. Requires `pnpm build`.
let tools: unknown
let work: string
let real: Step3Observations

beforeAll(async () => {
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  tools = loaded.pkgs.session
  work = await mkdtemp(join(tmpdir(), 'nexgent-step3-judges-'))
  real = await runHeadlessScenario(harness, work)
}, 120_000)
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

type Mutable = { -readonly [K in keyof DirectObservations]: DirectObservations[K] } & Record<string, unknown>
/** A deep copy of the real direct observations, changed by `edit`. */
function broken(edit: (direct: Mutable) => void): Step3Observations {
  const direct = structuredClone(real.direct) as Mutable
  edit(direct)
  return { ...real, direct }
}
const rootOf = (direct: Mutable) => (direct.sessions as Record<string, { records: Record<string, unknown>[]; truncated: unknown }>)[direct.sessionId as string]!
const ledgerOf = (direct: Mutable) => direct.ledger as Record<string, unknown>[]
const ATTRIBUTED = ['llm.request.start', 'llm.request.end', 'tool.call', 'task.outcome']
const TASK_ID = '0b9a6c1e-5d4f-4a3b-8c2d-1e0f9a8b7c6d'
/** What the kernel will write once W1 lands: attribution on every attributed ledger record. */
function attribute(direct: Mutable): void {
  for (const record of ledgerOf(direct)) {
    if (!ATTRIBUTED.includes(String(record['type']))) continue
    Object.assign(record, { taskId: TASK_ID, memberId: 'main', executionForm: 'direct' })
    if (record['type'] === 'task.outcome') record['formsUsed'] = ['direct']
  }
}

/** The real run with every attribution field removed (a kernel before W1). */
function unattributed(): Step3Observations {
  return broken(d => {
    for (const record of ledgerOf(d)) for (const key of ['taskId', 'memberId', 'executionForm', 'formsUsed']) delete record[key]
  })
}

describe('the real direct run', () => {
  it('runs one root session to completion through the SDK (routing: every request on the default script)', () => {
    expect(real.direct?.reason).toEqual({ kind: 'completed' })
    expect(real.direct?.requests?.every(r => r.route === null && r.outcome === 'completed')).toBe(true)
    expect(real.direct?.unconsumed).toEqual({ '': 0 })
  })
})

describe('H01 direct execution', () => {
  it('passes on the real run: the kernel attributes the ledger (step 3 W1)', () => {
    const result = judge('H01', real, tools)
    expect(result.status, result.evidence).toBe('passed')
  })

  it('is not-implemented when the ledger carries no attribution', () => {
    const result = judge('H01', unattributed(), tools)
    expect(result.status, result.evidence).toBe('not-implemented')
    expect(result.evidence).toMatch(/does not write executionForm/)
  })

  it('passes once the kernel attributes the ledger', () => {
    expect(judge('H01', broken(attribute), tools)).toMatchObject({ status: 'passed' })
  })

  it.each<[string, (d: Mutable) => void]>([
    ['the turn did not complete', d => { d.reason = { kind: 'failed' } }],
    ['present failed', d => { d.toolCalls = [{ name: 'write_file', isError: false }, { name: 'present', isError: true }] }],
    ['no deliverable', d => { d.deliverables = [] }],
    ['a second session file (a child)', d => { d.sessionFiles = [...(d.sessionFiles ?? []), 'child'] }],
    ['the session.start has a parent', d => { rootOf(d).records[0]!['parentSessionId'] = 'x' }],
    ['a subagent record', d => { rootOf(d).records.push({ type: 'subagent.start', seq: 99 }) }],
    ['a request routed to a member', d => { d.requests = [{ route: 'alpha', outcome: 'completed' }] }],
    ['sessions.list shows children', d => { d.listed = [{ sessionId: String(d.sessionId), childCount: 1 }] }],
  ])('fails when %s (even before attribution exists)', (_label, edit) => {
    expect(judge('H01', broken(edit), tools).status).toBe('failed')
  })

  it.each<[string, (d: Mutable) => void]>([
    ['one record says delegated', d => { attribute(d); ledgerOf(d)[0]!['executionForm'] = 'delegated' }],
    ['a record lacks memberId', d => { attribute(d); delete ledgerOf(d)[1]!['memberId'] }],
    ['two task ids', d => { attribute(d); ledgerOf(d)[0]!['taskId'] = 'd4c3b2a1-0f9e-4d8c-9b7a-6f5e4d3c2b1a' }],
    ['formsUsed missing on the root outcome', d => { attribute(d); delete ledgerOf(d).find(r => r['type'] === 'task.outcome')!['formsUsed'] }],
  ])('fails once attributed when %s', (_label, edit) => {
    expect(judge('H01', broken(edit), tools).status).toBe('failed')
  })
})

describe('H10 attribution', () => {
  it('is not-implemented while only the direct form is exercised (the real run is attributed)', () => {
    expect(judge('H10', real, tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/only the direct form/) })
    expect(judge('H10', unattributed(), tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/does not write taskId/) })
    expect(judge('H10', broken(attribute), tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/only the direct form/) })
  })

  it('fails on a wrong attribution as soon as any record carries one', () => {
    expect(judge('H10', broken(d => { attribute(d); ledgerOf(d)[2]!['memberId'] = 'someone' }), tools).status).toBe('failed')
    // A partially written attribution (one record only) is a defect, not "not built yet".
    expect(judge('H10', broken(d => { ledgerOf(d)[0]!['taskId'] = TASK_ID }), tools).status).toBe('failed')
  })
})

describe('H22 records, schema, secrets', () => {
  it('is not-implemented today only because no step-3 record type is exercised; the rest is checked', () => {
    const result = judge('H22', real, tools)
    expect(result.status, result.evidence).toBe('not-implemented')
    expect(result.evidence).toMatch(/not exercised yet: fork\.seed/)
    expect(result.evidence).toMatch(/seq continuous, schema ok/)
  })

  it.each<[string, (d: Mutable) => void]>([
    ['a seq gap', d => { rootOf(d).records.splice(2, 1) }],
    ['a torn tail', d => { rootOf(d).truncated = { bytes: 12 } }],
    ['a record failing the schema', d => { rootOf(d).records[1]!['turn'] = 'one' }],
    ['a ledger line failing the schema', d => { ledgerOf(d)[0]!['requestId'] = 42 }],
    ['the test key under .nexgent/', d => { d.secretHits = ['.nexgent/config.json'] }],
    ['the test key in the export', d => { d.exportSecretHits = ['direct-export/session.jsonl'] }],
    ['a failed export', d => { d.export = { code: 1, stderr: 'boom', files: {} } }],
  ])('fails on %s', (_label, edit) => {
    expect(judge('H22', broken(edit), tools).status).toBe('failed')
  })
})

describe('missing phase', () => {
  it('H01, H10 and H22 fail when the direct phase did not run', () => {
    for (const id of ['H01', 'H10', 'H22']) expect(judge(id, { repo: real.repo! }, tools).status, id).toBe('failed')
  })
})
