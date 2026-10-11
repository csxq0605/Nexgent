import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHeadlessScenario } from '../../../scripts/accept-common/step3-headless.mjs'
import { judge, MEMBER_DENIED_TOOLS, type DirectObservations, type Step3Observations } from '../../../scripts/accept-common/step3-judges.mjs'
import { MEMBER_DENIED_TOOLS as KERNEL_MEMBER_DENIED_TOOLS } from '@nexgent/kernel'
import { loadStep2Packages } from '../../../scripts/accept-common/step2-runtime.mjs'
import * as harness from '../src/index.js'

// One real run of the headless scenario (scripted model, through the built SDK with the subagent
// plugin, and the CLI); every test below judges it or a deliberately broken copy of it. Requires `pnpm build`.
let tools: unknown
let work: string
let real: Step3Observations

beforeAll(async () => {
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  tools = loaded.pkgs.session
  work = await mkdtemp(join(tmpdir(), 'nexgent-step3-judges-'))
  real = await runHeadlessScenario(harness, work)
}, 180_000)
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
    const partlyAttributed = unattributed()
    ;(partlyAttributed.direct!.ledger as Record<string, unknown>[])[0]!['taskId'] = TASK_ID
    expect(judge('H10', partlyAttributed, tools).status).toBe('failed')
    expect(judge('H01', partlyAttributed, tools).status).toBe('failed')
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

// ---- delegation (H02–H04, H12, H15, H16) --------------------------------------------------------

type Phase = Record<string, any>
/** A deep copy of the real observations with the delegation and read-only phases changed by `edit`. */
function brokenPhases(edit: (delegation: Phase, readonly: Phase) => void): Step3Observations {
  const delegation = structuredClone(real.delegation) as Phase
  const readonly = structuredClone(real.readonly) as Phase
  edit(delegation, readonly)
  return { ...real, delegation, readonly } as Step3Observations
}
const childId = (phase: Phase, name: string) => Object.keys(phase['sessions']).find(id => phase['sessions'][id].records[0]?.member?.name === name)!
const childRecords = (phase: Phase, name: string) => phase['sessions'][childId(phase, name)].records as Record<string, any>[]
const rootRecords = (phase: Phase) => phase['sessions'][phase['sessionId']].records as Record<string, any>[]
const firstRequest = (phase: Phase, route: string) => (phase['requests'] as Record<string, any>[]).find(r => r['route'] === route)!
const subStart = (phase: Phase, name: string) => rootRecords(phase).find(r => r['type'] === 'subagent.start' && r['name'] === name)!
const subEnd = (phase: Phase, name: string) => rootRecords(phase).find(r => r['type'] === 'subagent.end' && r['childSessionId'] === subStart(phase, name)['childSessionId'])!

describe('the real delegation run', () => {
  it('runs every phase through the subagent plugin and consumes every route', () => {
    const d = real.delegation as Phase
    for (const phase of ['setup', 'fresh', 'fork', 'sameName', 'resume']) expect(d['phases'][phase].reason, phase).toEqual({ kind: 'completed' })
    for (const phase of ['delegation', 'forkKill', 'resume']) expect(Object.values(d['phases'][phase].unconsumed).every(n => n === 0), phase).toBe(true)
    expect(new Set((d['requests'] as { route: string | null }[]).map(r => r.route))).toEqual(new Set([null, 'analyst', 'forker', 'writer-a', 'writer-b', 'forker-two']))
    expect(real.readonly?.reason).toEqual({ kind: 'completed' })
  })

  it('the judges copy the kernel member deny list', () => {
    expect([...MEMBER_DENIED_TOOLS]).toEqual([...KERNEL_MEMBER_DENIED_TOOLS])
  })
})

describe.each(['H02', 'H03', 'H04', 'H12', 'H16'])('%s on the real run', (id) => {
  it('passes', () => {
    const result = judge(id, real, tools)
    expect(result.status, result.evidence).toBe('passed')
  })
  it('fails when its phase did not run', () => {
    expect(judge(id, { repo: real.repo! }, tools).status).toBe('failed')
  })
})

describe('H02 fresh delegation', () => {
  it.each<[string, (d: Phase) => void]>([
    ['the child names another parent', d => { childRecords(d, 'analyst')[0]!['parentSessionId'] = 'someone-else' }],
    ['the child is not marked delegated', d => { childRecords(d, 'analyst')[0]!['member'].executionForm = 'team' }],
    ['subagent.start says fork', d => { subStart(d, 'analyst')['mode'] = 'fork' }],
    ['the material id was not passed', d => { subStart(d, 'analyst')['materialIds'] = [] }],
    ['the first request lacks the material reference', d => { const r = firstRequest(d, 'analyst'); r['text'] = r['text'].replaceAll('.nexgent/materials/', 'materials/') }],
    ['the first request leaks parent history', d => { firstRequest(d, 'analyst')['text'] += ' PARENT-HISTORY-MARKER' }],
    ['the fresh child got a fork.seed', d => { childRecords(d, 'analyst').splice(1, 0, { type: 'fork.seed' }) }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H02', brokenPhases(edit), tools).status).toBe('failed')
  })
})

describe('H03 fork delegation', () => {
  it('passes without a subagent.end for the killed member (closeInterruptedRuns is the host\'s, W6) and says so', () => {
    expect(judge('H03', real, tools).evidence).toMatch(/closeInterruptedRuns/)
  })
  it.each<[string, (d: Phase) => void]>([
    ['the forker has no fork.seed', d => { childRecords(d, 'forker').splice(1, 1) }],
    ['the seed lacks the earlier history', d => { const seed = childRecords(d, 'forker')[1]!; seed['messages'] = seed['messages'].slice(2) }],
    ['the seed includes the current turn', d => { childRecords(d, 'forker')[1]!['messages'].push({ role: 'user', content: 'Ask a forked helper which supplier I prefer.' }) }],
    ['the forker request lacks the history', d => { const r = firstRequest(d, 'forker'); r['text'] = r['text'].replaceAll('PARENT-HISTORY-MARKER', '') }],
    ['the driver was not killed mid-stream', d => { d['phases'].forkKill.streaming = false }],
    ['the killed member lost its seed after resume', d => { childRecords(d, 'forker-two').splice(1, 1) }],
    ['the seed changed between the kill and the resume', d => { childRecords(d, 'forker-two')[1]!['throughSeq'] = 1 }],
    ['the root did not close the killed turn as interrupted', d => { const t = rootRecords(d).find(r => r['type'] === 'turn.end' && r['turn'] === subStart(d, 'forker-two')['turn'])!; t['reason'] = { kind: 'completed' } }],
    ['a subagent.end for the killed member says completed', d => { rootRecords(d).push({ type: 'subagent.end', childSessionId: subStart(d, 'forker-two')['childSessionId'], result: { status: 'completed' } }) }],
    ['the resume turn failed', d => { d['phases'].resume.reason = { kind: 'failed' } }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H03', brokenPhases(edit), tools).status).toBe('failed')
  })
})

describe('H04 delegation result', () => {
  it.each<[string, (d: Phase) => void]>([
    ['subagent.end is not completed', d => { subEnd(d, 'analyst')['result'].status = 'failed' }],
    ['subagent.end lists no deliverable', d => { subEnd(d, 'analyst')['result'].deliverables = [] }],
    ['the tool result does not name the deliverable', d => { const r = rootRecords(d).find(x => x['type'] === 'tool.result' && x['toolCallId'] === 'call-analyst')!; r['content'] = 'done' }],
    ['the tool result is an error', d => { rootRecords(d).find(x => x['type'] === 'tool.result' && x['toolCallId'] === 'call-analyst')!['isError'] = true }],
    ['the final deliverable omits the member file', d => { for (const r of rootRecords(d)) if (r['type'] === 'deliverable.presented') r['deliverable'].files = r['deliverable'].files.filter((f: { path: string }) => f.path !== 'analysis/summary.md') }],
    ['the final deliverable has a different copy of the file', d => { for (const r of rootRecords(d)) if (r['type'] === 'deliverable.presented') for (const f of r['deliverable'].files) f.sha256 = '0'.repeat(64) }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H04', brokenPhases(edit), tools).status).toBe('failed')
  })
})

describe('H12 sandbox inheritance', () => {
  it.each<[string, (r: Phase) => void]>([
    ['the wider member was not refused', r => { const t = rootRecords(r).find(x => x['toolCallId'] === 'call-wide')!; t['isError'] = false; delete t['error'] }],
    ['the refusal has another code', r => { rootRecords(r).find(x => x['toolCallId'] === 'call-wide')!['error'].code = 'tool/denied' }],
    ['the refused member got a session', r => { r['sessions']['ghost'] = { records: [{ type: 'session.start', member: { name: 'wide-one' } }], truncated: null } }],
    ['the member runs workspace-write', r => { childRecords(r, 'quiet')[0]!['sandboxMode'] = 'workspace-write' }],
    ['the member sees the denied shell', r => { firstRequest(r, 'quiet')['tools'].push(r['shell']) }],
    ['the root never offered the shell (nothing to deny)', r => { for (const q of r['requests']) q['tools'] = q['tools'].filter((t: string) => t !== r['shell']) }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H12', brokenPhases((_d, r) => edit(r)), tools).status).toBe('failed')
  })
})

describe('H15 members cannot delegate', () => {
  it('is not-implemented while the root offers no team or workflow tools; the rest is checked', () => {
    const result = judge('H15', real, tools)
    expect(result.status, result.evidence).toBe('not-implemented')
    expect(result.evidence).toMatch(/does not offer spawn_teammate, wait_teammates, workflow/)
  })
  it('passes once the root offers them and members still do not', () => {
    const obs = brokenPhases((d, r) => { for (const q of [...d['requests'], ...r['requests']]) if (q['route'] === null) q['tools'].push('spawn_teammate', 'wait_teammates', 'workflow') })
    expect(judge('H15', obs, tools)).toMatchObject({ status: 'passed' })
  })
  it.each(MEMBER_DENIED_TOOLS.map(t => [t]))('fails when a member is offered %s', (tool) => {
    expect(judge('H15', brokenPhases(d => { firstRequest(d, 'writer-b')['tools'].push(tool) }), tools).status).toBe('failed')
  })
  it('fails when the root does not offer delegate, or a phase is missing', () => {
    expect(judge('H15', brokenPhases(d => { for (const q of d['requests']) if (q['route'] === null) q['tools'] = q['tools'].filter((t: string) => t !== 'delegate') }), tools).status).toBe('failed')
    const { readonly: _dropped, ...withoutReadonly } = real
    expect(judge('H15', withoutReadonly, tools).status).toBe('failed')
  })
})

describe('H16 same-path deliverables', () => {
  it.each<[string, (d: Phase) => void]>([
    ['writer-b appended a version to writer-a\'s deliverable', d => {
      const list = d['deliverables'] as { deliverableId: string; versions: Record<string, unknown>[] }[]
      const [a, b] = list.filter(x => x.versions.some(v => (v['files'] as string[]).includes('shared/notes.md')))
      a!.versions.push({ ...b!.versions[0], version: 2 })
      list.splice(list.indexOf(b!), 1)
    }],
    ['only one deliverable has the path', d => { d['deliverables'] = (d['deliverables'] as { versions: { files: string[] }[] }[]).filter(x => !x.versions.some(v => v.files.includes('shared/notes.md') && v.files.length === 1)).concat([(d['deliverables'] as never[]).find((x: { versions: { files: string[] }[] }) => x.versions.some(v => v.files.includes('shared/notes.md')))!]) }],
    ['both results name the same deliverable', d => { subEnd(d, 'writer-b')['result'].deliverables[0].deliverableId = subEnd(d, 'writer-a')['result'].deliverables[0].deliverableId }],
    ['a member failed', d => { subEnd(d, 'writer-a')['result'].status = 'failed' }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H16', brokenPhases(edit), tools).status).toBe('failed')
  })
})
