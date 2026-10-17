import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHeadlessScenario } from '../../../scripts/accept-common/step3-headless.mjs'
import { COLLABORATION_TOOLS, forbiddenFor, judge, TEAMMATE_TOOLS, type DirectObservations, type Step3Observations } from '../../../scripts/accept-common/step3-judges.mjs'
import { MEMBER_DENIED_TOOLS, STEP3_TOOLS } from '@nexgent/kernel'
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

type Phase = Record<string, any>
/** A deep copy of every project's observations, changed by `edit` (keys: direct, delegation, readonly, tools, workflow). */
function brokenObs(edit: (o: Record<string, Phase>) => void): Step3Observations {
  const o = structuredClone(real) as unknown as Record<string, Phase>
  edit(o)
  return o as unknown as Step3Observations
}
const ledgerRecords = (project: Phase) => project['ledger'] as Record<string, any>[]
const childRecordsAll = (project: Phase) => Object.entries(project['sessions'] as Record<string, { records: Record<string, any>[] }>).filter(([id]) => id !== project['sessionId']).flatMap(([, s]) => s.records)
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
  it('passes on the real run: every form attributed across all projects, resumed members included', () => {
    const result = judge('H10', real, tools)
    expect(result.status, result.evidence).toBe('passed')
    expect(result.evidence).toMatch(/across 11 projects.*\(direct, delegated, team, workflow\)/)
    expect(judge('H10', unattributed(), tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/does not write taskId/) })
  })

  it('fails when a resumed team turn omits the team form (the defect fixed in #71)', () => {
    const result = judge('H10', brokenObs(o => {
      const k = o['teamKill']!
      for (const r of ledgerRecords(k)) if (r['type'] === 'task.outcome' && r['sessionId'] === k['sessionId']) r['formsUsed'] = ['direct']
    }), tools)
    expect(result.status).toBe('failed')
    expect(result.evidence).toMatch(/teamKill task\.outcome [0-9a-f]{8}: formsUsed \["direct"\], expected \["direct","team"\]/)
  })

  it.each<[string, (o: Record<string, Phase>) => void]>([
    ['a member record says main', o => { const r = ledgerRecords(o['delegation']!).find(x => x['executionForm'] === 'delegated')!; r['memberId'] = 'main' }],
    ['a workflow member record says delegated', o => { ledgerRecords(o['workflow']!).find(x => x['executionForm'] === 'workflow')!['executionForm'] = 'delegated' }],
    ['a teammate record says delegated', o => { ledgerRecords(o['team']!).find(x => x['executionForm'] === 'team')!['executionForm'] = 'delegated' }],
    ['a member record has another tree\'s taskId', o => { const member = ledgerRecords(o['delegation']!).find(x => x['executionForm'] === 'delegated')!; member['taskId'] = TASK_ID }],
    ['a root outcome omits a form it used', o => { const r = ledgerRecords(o['workflow']!).find(x => x['type'] === 'task.outcome' && JSON.stringify(x['formsUsed']) === '["direct","workflow"]')!; r['formsUsed'] = ['direct'] }],
    ['a record names a session with no file', o => { ledgerRecords(o['tools']!)[0]!['sessionId'] = 'no-such-session' }],
    ['no workflow member ran anywhere', o => { delete o['workflow']; delete o['cancel'] }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H10', brokenObs(edit), tools).status).toBe('failed')
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
  it('passes on the real run: all eleven projects, all nine step-3 record types', () => {
    const result = judge('H22', real, tools)
    expect(result.status, result.evidence).toBe('passed')
    expect(result.evidence).toMatch(/11 projects, .*seq continuous, schema ok.*types seen: fork\.seed, subagent\.start, subagent\.end, team\.member, team\.task, team\.message, workflow\.start, workflow\.phase, workflow\.end; all nine/)
  })

  it('is not-implemented when a step-3 record type never appears', () => {
    const result = judge('H22', brokenObs(o => { for (const key of ['team', 'teamKill', 'cancel']) for (const s of Object.values(o[key]!['sessions'] as Record<string, { records: Record<string, unknown>[] }>)) s.records = s.records.filter(r => r['type'] !== 'team.task').map((r, i) => ({ ...r, seq: i + 1 })) }), tools)
    expect(result).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/not exercised yet: team\.task;/) })
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

  it.each<[string, (o: Record<string, Phase>) => void]>([
    ['a member session with a seq gap', o => { o['workflow']!['sessions'][Object.keys(o['workflow']!['sessions']).find(id => id !== o['workflow']!['sessionId'])!].records.splice(1, 1) }],
    ['a fork.seed failing the schema', o => { childRecordsAll(o['delegation']!).find(r => r['type'] === 'fork.seed')!['messages'] = 'none' }],
    ['a workflow ledger line failing the schema', o => { ledgerRecords(o['workflow']!)[0]!['requestId'] = 7 }],
    ['the test key in the tools project', o => { o['tools']!['secretHits'] = ['.nexgent/ledgers/x.jsonl'] }],
  ])('fails on %s in another project', (_label, edit) => {
    expect(judge('H22', brokenObs(edit), tools).status).toBe('failed')
  })
})

describe('missing phase', () => {
  it('H01, H10 and H22 fail when the direct phase did not run', () => {
    for (const id of ['H01', 'H10', 'H22']) expect(judge(id, { repo: real.repo! }, tools).status, id).toBe('failed')
  })
})

// ---- delegation (H02–H04, H12, H15, H16) --------------------------------------------------------

/** A deep copy of the real observations with the delegation and read-only phases changed by `edit`. */
function brokenPhases(edit: (delegation: Phase, readonly: Phase) => void): Step3Observations {
  return brokenObs(o => edit(o['delegation']!, o['readonly']!))
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

  it('the judges copy the kernel collaboration tools; a teammate keeps only its four team tools', () => {
    expect([...COLLABORATION_TOOLS]).toEqual(STEP3_TOOLS.map(t => t.name).filter(name => name !== 'run_code'))
    // The step-3 judges know only step-3 tools; step-4 names are judged by accept-step4.
    expect([...forbiddenFor('delegated')].sort()).toEqual(MEMBER_DENIED_TOOLS.filter(t => STEP3_TOOLS.some(s => s.name === t)).sort())
    expect(forbiddenFor('workflow')).toEqual([...COLLABORATION_TOOLS])
    expect(forbiddenFor('team')).toEqual(COLLABORATION_TOOLS.filter(t => !TEAMMATE_TOOLS.includes(t)))
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
    ['the first request lacks the material reference', d => { const r = firstRequest(d, 'analyst'); r['text'] = r['text'].replaceAll('materials/', 'files/') }],
    ['the first request leaks parent history', d => { firstRequest(d, 'analyst')['text'] += ' PARENT-HISTORY-MARKER' }],
    ['the fresh child got a fork.seed', d => { childRecords(d, 'analyst').splice(1, 0, { type: 'fork.seed' }) }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H02', brokenPhases(edit), tools).status).toBe('failed')
  })
})

describe('H03 fork delegation', () => {
  it('the host marks the killed member interrupted on resume (SDK closeInterruptedRuns, W6)', () => {
    expect(judge('H03', real, tools).evidence).toMatch(/subagent\.end interrupted written/)
  })
  it('still passes when no subagent.end was written for the killed member (not part of H03)', () => {
    const obs = brokenPhases(d => { const id = subStart(d, 'forker-two')['childSessionId']; d['sessions'][d['sessionId']].records = rootRecords(d).filter(r => !(r['type'] === 'subagent.end' && r['childSessionId'] === id)) })
    expect(judge('H03', obs, tools)).toMatchObject({ status: 'passed', evidence: expect.stringMatching(/closeInterruptedRuns/) })
  })
  it.each<[string, (d: Phase) => void]>([
    ['the forker has no fork.seed', d => { childRecords(d, 'forker').splice(1, 1) }],
    ['the seed lacks the earlier history', d => { const seed = childRecords(d, 'forker')[1]!; seed['messages'] = seed['messages'].slice(2) }],
    // Rework K4 (audit D5): the seed now holds the current turn so far.
    ['the seed lacks the current turn', d => { const seed = childRecords(d, 'forker')[1]!; seed['messages'] = seed['messages'].filter((m: { content?: unknown }) => !JSON.stringify(m.content ?? '').includes('Ask a forked helper which supplier I prefer.')) }],
    ['the forker request lacks the history', d => { const r = firstRequest(d, 'forker'); r['text'] = r['text'].replaceAll('PARENT-HISTORY-MARKER', '') }],
    ['the driver was not killed mid-stream', d => { d['phases'].forkKill.streaming = false }],
    ['the killed member lost its seed after resume', d => { childRecords(d, 'forker-two').splice(1, 1) }],
    ['the seed changed between the kill and the resume', d => { childRecords(d, 'forker-two')[1]!['throughSeq'] = 1 }],
    ['the root did not close the killed turn as interrupted', d => { const t = rootRecords(d).find(r => r['type'] === 'turn.end' && r['turn'] === subStart(d, 'forker-two')['turn'])!; t['reason'] = { kind: 'completed' } }],
    ['the subagent.end for the killed member says completed', d => { subEnd(d, 'forker-two')['result'].status = 'completed' }],
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
  const MEMBER_KEYS = ['delegation', 'readonly', 'workflow', 'team', 'teamKill', 'cancel']
  const formOfRequest = (q: Phase) => /^Member: [a-z][a-z0-9-]* \((delegated|team|workflow)\)$/m.exec(q['sessionText'])?.[1]
  /** Remove every forbidden tool from member requests (what the fixed contract will give). */
  const fixMembers = (o: Record<string, Phase>) => {
    for (const key of MEMBER_KEYS) for (const q of o[key]!['requests']) if (q['route'] !== null) q['tools'] = q['tools'].filter((t: string) => !forbiddenFor(formOfRequest(q)).includes(t))
  }
  const teammateRequest = (o: Record<string, Phase>) => (o['team']!['requests'] as Phase[]).find(q => q['route'] === 'bob')!

  it('passes on the real run: delegated members, workflow members and teammates (contract erratum #69)', () => {
    const result = judge('H15', real, tools)
    expect(result.status, result.evidence).toBe('passed')
    expect(result.evidence).toMatch(/requests from members \((?=[^)]*delegated)(?=[^)]*workflow)(?=[^)]*team)[^)]*\); none sees a forbidden collaboration tool/)
    // Teammates keep their own four team tools.
    expect(TEAMMATE_TOOLS.every(t => teammateRequest(structuredClone(real) as unknown as Record<string, Phase>)['tools'].includes(t))).toBe(true)
  })
  it('fails when delegated members see the team tools (as before the contract erratum)', () => {
    const result = judge('H15', brokenObs(o => { for (const q of o['delegation']!['requests']) if (q['route'] === 'analyst') q['tools'].push('send_message', 'team_task_create') }), tools)
    expect(result.status).toBe('failed')
    expect(result.evidence).toMatch(/delegated analyst: send_message\/team_task_create/)
  })
  it.each(COLLABORATION_TOOLS.map(t => [t]))('fails when a delegated member is offered %s', (tool) => {
    expect(judge('H15', brokenObs(o => { fixMembers(o); firstRequest(o['delegation']!, 'writer-b')['tools'].push(tool) }), tools).status).toBe('failed')
  })
  it.each(COLLABORATION_TOOLS.filter(t => !TEAMMATE_TOOLS.includes(t)).map(t => [t]))('fails when a teammate is offered %s', (tool) => {
    expect(judge('H15', brokenObs(o => { fixMembers(o); teammateRequest(o)['tools'].push(tool) }), tools).status).toBe('failed')
  })
  it('is not-implemented without any teammate request', () => {
    expect(judge('H15', brokenObs(o => { fixMembers(o); for (const key of MEMBER_KEYS) o[key]!['requests'] = o[key]!['requests'].filter((q: Phase) => formOfRequest(q) !== 'team') }), tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/no teammate request/) })
  })
  it('fails when the root lacks a collaboration tool, or a project is missing', () => {
    expect(judge('H15', brokenObs(o => { fixMembers(o); for (const q of o['workflow']!['requests']) if (q['route'] === null) q['tools'] = q['tools'].filter((t: string) => t !== 'wait_teammates') }), tools).status).toBe('failed')
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

// ---- tools (H17–H19) and workflow (H07–H09) -------------------------------------------------------

const rootResult = (project: Phase, callId: string) => rootRecords(project).find(r => r['type'] === 'tool.result' && r['toolCallId'] === callId)!

describe.each(['H07', 'H08', 'H17', 'H18', 'H19'])('%s on the real run', (id) => {
  it('passes', () => {
    const result = judge(id, real, tools)
    expect(result.status, result.evidence).toBe('passed')
  })
  it('fails when its project did not run', () => {
    expect(judge(id, { repo: real.repo! }, tools).status).toBe('failed')
  })
})

describe('H17 run_code', () => {
  it.each<[string, (t: Phase) => void]>([
    ['the program saw environment variables', t => { const r = rootResult(t, 'call-ptc-files'); r['content'] = r['content'].replace('"envKeys": []', '"envKeys": ["HOME"]') }],
    ['the output file is wrong', t => { t['files']['data/output.txt'] = Buffer.from('restock').toString('base64') }],
    ['the outside read succeeded', t => { const r = rootResult(t, 'call-ptc-outside'); r['isError'] = false; r['content'] = 'OUTSIDE-SECRET' }],
    ['the timeout did not stop it', t => { rootResult(t, 'call-ptc-timeout')['isError'] = false }],
    ['the timed-out process survived', t => { t['phases'].ptc.timeoutPidAlive = true }],
    ['no pid was seen', t => { t['phases'].ptc.timeoutPid = null }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H17', brokenObs(o => edit(o['tools']!)), tools).status).toBe('failed')
  })
})

describe('H18 spreadsheets', () => {
  it.each<[string, (t: Phase) => void]>([
    ['the file is missing', t => { t['files']['sheets/plan.xlsx'] = null }],
    ['the file is not a workbook', t => { t['files']['sheets/plan.xlsx'] = Buffer.from('nope').toString('base64') }],
    ['an external reference was accepted', t => { const r = rootResult(t, 'call-sheet-external'); r['isError'] = false; delete r['error'] }],
    ['a refusal still wrote a file', t => { t['files']['sheets/divzero.xlsx'] = 'AAAA' }],
    ['the limit refusal has another code', t => { rootResult(t, 'call-sheet-limit')['error'].code = 'tool/failed' }],
    ['the unknown function failed for another reason', t => { rootResult(t, 'call-sheet-unknown')['error'].details.reason = 'exists' }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H18', brokenObs(o => edit(o['tools']!)), tools).status).toBe('failed')
  })
})

describe('H19 web_fetch', () => {
  it.each<[string, (o: Record<string, Phase>) => void]>([
    ['the page lost its table', o => { const r = rootResult(o['tools']!, 'call-web-page'); r['content'] = r['content'].replace(/\|[^\n]*\n?/g, '') }],
    ['hidden text leaked', o => { rootResult(o['tools']!, 'call-web-page')['content'] += '\nHIDDEN-MARKER' }],
    ['loopback was fetched', o => { const r = rootResult(o['tools']!, 'call-web-loopback'); r['isError'] = false; delete r['error'] }],
    ['the redirect refusal has another reason', o => { rootResult(o['tools']!, 'call-web-redirect')['error'].details.reason = 'network' }],
    ['the shipped plugin fetched the loopback page', o => { const r = rootResult(o['readonly']!, 'call-web-shipped'); r['isError'] = false; delete r['error'] }],
    ['the page server saw an extra request', o => { o['tools']!['webHits']['/stock.html'] = 2 }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H19', brokenObs(edit), tools).status).toBe('failed')
  })
})

const wfStarts = (w: Phase) => rootRecords(w).filter(r => r['type'] === 'subagent.start' && r['executionForm'] === 'workflow')

describe('H07 workflow script', () => {
  it.each<[string, (w: Phase) => void]>([
    ['five members ran at once (over the cap)', w => {
      const root = rootRecords(w)
      const fifth = root.find(r => r['type'] === 'subagent.start' && r['name'] === 'part-5')!
      const firstEnd = root.find(r => r['type'] === 'subagent.end')!
      ;[fifth['seq'], firstEnd['seq']] = [firstEnd['seq'], fifth['seq']]
    }],
    ['the members ran one at a time', w => {
      const root = rootRecords(w)
      for (const name of ['part-1', 'part-2', 'part-3', 'part-4', 'part-5']) {
        const start = root.find(r => r['type'] === 'subagent.start' && r['name'] === name)!
        const end = root.find(r => r['type'] === 'subagent.end' && r['childSessionId'] === start['childSessionId'])!
        end['seq'] = start['seq'] + 0.5
      }
    }],
    ['the summariser started before the parts ended', w => { wfStarts(w).find(r => r['name'] === 'summariser')!['seq'] = 1 }],
    ['the summariser presented nothing', w => { const s = wfStarts(w).find(r => r['name'] === 'summariser')!; rootRecords(w).find(r => r['type'] === 'subagent.end' && r['childSessionId'] === s['childSessionId'])!['result'].deliverables = [] }],
    ['the workflow failed', w => { rootRecords(w).find(r => r['type'] === 'workflow.end')!['status'] = 'failed' }],
    ['a member is marked delegated', w => { wfStarts(w)[0]!['executionForm'] = 'delegated' }],
    ['no phases were recorded', w => { w['sessions'][w['sessionId']].records = rootRecords(w).filter(r => r['type'] !== 'workflow.phase') }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H07', brokenObs(o => edit(o['workflow']!)), tools).status).toBe('failed')
  })
})

describe('H08 workflow graph', () => {
  it.each<[string, (w: Phase) => void]>([
    ['report started before check ended', w => { wfStarts(w).find(r => r['name'] === 'report')!['seq'] = wfStarts(w).find(r => r['name'] === 'check')!['seq'] + 0.1 }],
    ['the graph was not saved', w => { w['architectures'] = [] }],
    ['the cycle was accepted', w => { const r = rootResult(w, 'call-wf-cycle'); r['isError'] = false; delete r['error'] }],
    ['the cycle error is not readable', w => { rootResult(w, 'call-wf-cycle')['content'] = 'Error: invalid input' }],
    ['the cycle started a member', w => { w['sessions']['ghost'] = { records: [{ type: 'session.start', member: { name: 'loop-a' } }], truncated: null } }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H08', brokenObs(o => edit(o['workflow']!)), tools).status).toBe('failed')
  })
})

describe('H09 workflow recovery', () => {
  const killWf = (w: Phase) => rootRecords(w).find(r => r['type'] === 'workflow.start' && r['toolCallId'] === 'call-wf-kill')!
  const lateStart = (w: Phase) => wfStarts(w).find(r => r['name'] === 'late')!
  /** What recoverWorkflows will write once the host calls it (W6). */
  const recover = (w: Phase, status = 'interrupted') => {
    rootRecords(w).push(
      { type: 'subagent.end', seq: 1000, childSessionId: lateStart(w)['childSessionId'], result: { status } },
      { type: 'workflow.end', seq: 1001, workflowId: killWf(w)['workflowId'], status },
    )
  }

  /** The real run without the records recoverWorkflows wrote (a host that does not call it). */
  const unrecovered = (w: Phase) => {
    const id = killWf(w)['workflowId']
    w['sessions'][w['sessionId']].records = rootRecords(w).filter(r => !(r['type'] === 'workflow.end' && r['workflowId'] === id) && !(r['type'] === 'subagent.end' && r['childSessionId'] === lateStart(w)['childSessionId']))
  }
  it('passes on the real run: the SDK marks late and the workflow interrupted on resume (W6)', () => {
    expect(judge('H09', real, tools)).toMatchObject({ status: 'passed', evidence: expect.stringMatching(/late and the workflow marked interrupted/) })
  })
  it('is not-implemented for a host that does not call recoverWorkflows', () => {
    expect(judge('H09', brokenObs(o => unrecovered(o['workflow']!)), tools)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/recoverWorkflows/) })
    expect(judge('H09', brokenObs(o => { unrecovered(o['workflow']!); recover(o['workflow']!) }), tools)).toMatchObject({ status: 'passed' })
  })
  it.each<[string, (w: Phase) => void]>([
    ['the recovery says completed', w => { unrecovered(w); recover(w, 'completed') }],
    ['early ran again after resume', w => { w['requests'].push({ phase: 'wfResume', route: 'early', tools: [] }) }],
    ['a process survived the kill', w => { w['phases'].wfKill.survivors = [4242] }],
    ['the kill came before late streamed', w => { w['phases'].wfKill.streaming = false }],
    ['early had not completed', w => { const e = wfStarts(w).find(r => r['name'] === 'early')!; rootRecords(w).find(r => r['type'] === 'subagent.end' && r['childSessionId'] === e['childSessionId'])!['result'].status = 'failed' }],
    ['the killed turn is not closed as interrupted', w => { rootRecords(w).find(r => r['type'] === 'turn.end' && r['turn'] === killWf(w)['turn'])!['reason'] = { kind: 'completed' } }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H09', brokenObs(o => edit(o['workflow']!)), tools).status).toBe('failed')
  })
})

// ---- team (H05, H06) and cancel (H13) -------------------------------------------------------------

describe.each(['H05', 'H06', 'H13'])('%s on the real run', (id) => {
  it('passes', () => {
    const result = judge(id, real, tools)
    expect(result.status, result.evidence).toBe('passed')
  })
  it('fails when its project did not run', () => {
    expect(judge(id, { repo: real.repo! }, tools).status).toBe('failed')
  })
})

const messagesOf = (p: Phase) => rootRecords(p).filter(r => r['type'] === 'team.message')

describe('H05 team', () => {
  it.each<[string, (t: Phase) => void]>([
    ['a message was delivered twice', t => { const d = messagesOf(t).find(r => r['message'].state === 'delivered')!; rootRecords(t).push({ ...d, seq: 999 }) }],
    ['a message was never delivered', t => { t['sessions'][t['sessionId']].records = rootRecords(t).filter(r => !(r['type'] === 'team.message' && r['message'].to === 'bob' && r['message'].state === 'delivered')) }],
    ['bob got his mail twice', t => { const bob = childRecords(t, 'bob'); bob.push({ ...bob.find(r => r['type'] === 'user.message' && r['source'] === 'inject' && !String(r['content']).startsWith('# Skills'))!, seq: 999 }) }],
    ['the lead got its mail twice', t => { const r = rootResult(t, 'w1'); r['content'] += r['content'] }],
    ['bob started t3 early', t => { const r = childRecords(t, 'bob').find(x => x['toolCallId'] === 'b0')!; r['isError'] = false }],
    ['the teammates ran one after the other', t => { t['requests'] = [...t['requests'].filter((q: Phase) => q['route'] !== 'bob'), ...t['requests'].filter((q: Phase) => q['route'] === 'bob')] }],
    ['bob presented nothing', t => { t['deliverables'] = t['deliverables'].filter((d: Phase) => !d['versions'].some((v: Phase) => v['files'].includes('bob/b.md'))) }],
    ['a teammate is marked delegated', t => { childRecords(t, 'alice')[0]!['member'].executionForm = 'delegated' }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H05', brokenObs(o => edit(o['team']!)), tools).status).toBe('failed')
  })
})

describe('H06 team recovery', () => {
  it.each<[string, (t: Phase) => void]>([
    ['a message was already delivered at the kill', t => { t['atKill'].messages[0].state = 'delivered' }],
    ['a message is delivered twice after resume', t => { const d = messagesOf(t).find(r => r['message'].state === 'delivered')!; rootRecords(t).push({ ...d, seq: 999 }) }],
    ['the lead\'s mail is handed over again by wait_teammates', t => { const lead = t['atKill'].messages.find((m: Phase) => m['to'] === 'lead'); rootResult(t, 'r2')['content'] += `id="${lead['id']}"` }],
    ['bob got his mail twice', t => { const bob = childRecords(t, 'bob'); bob.push({ ...bob.find(r => r['type'] === 'user.message' && r['source'] === 'inject' && !String(r['content']).startsWith('# Skills'))!, seq: 999 }) }],
    ['the board changed', t => { rootResult(t, 'r1')['meta'].tasks[0].status = 'completed' }],
    ['alice did not continue', t => { for (const r of rootRecords(t)) if (r['type'] === 'subagent.start' && r['name'] === 'alice' && r['task'] === t['prompts'].continue) r['task'] = 'start over' }],
    ['a process survived', t => { t['phases'].teamKill.settled = false }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H06', brokenObs(o => edit(o['teamKill']!)), tools).status).toBe('failed')
  })
})

describe('H13 cancel propagation', () => {
  const endOf = (c: Phase, name: string) => rootRecords(c).find(r => r['type'] === 'subagent.end' && r['childSessionId'] === subStart(c, name)['childSessionId'])!
  it.each<[string, (c: Phase) => void]>([
    ['a delegated member ended with cause user', c => { endOf(c, 'sleeper')['result'].error.details.cause = 'user' }],
    ['a teammate completed', c => { endOf(c, 'mate-b')['result'].status = 'completed' }],
    ['a workflow member\'s own turn says completed', c => { const r = childRecords(c, 'flow-a').filter(x => x['type'] === 'turn.end').at(-1)!; r['reason'] = { kind: 'completed' } }],
    ['a slow command survived', c => { c['phases'].cancelTeam.survivors = [4242] }],
    ['the members were not running yet', c => { c['phases'].cancelWorkflow.running = false }],
    ['the workflow ended failed', c => { rootRecords(c).find(r => r['type'] === 'workflow.end')!['status'] = 'failed' }],
    ['a cancelled teammate was stopped', c => { rootRecords(c).push({ type: 'team.member', seq: 999, member: { name: 'mate-a', status: 'stopped' } }) }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H13', brokenObs(o => edit(o['cancel']!)), tools).status).toBe('failed')
  })
})

describe.each(['H11', 'H14', 'H20', 'H21'])('%s on the real run', (id) => {
  it('passes', () => {
    const result = judge(id, real, tools)
    expect(result.status, result.evidence).toBe('passed')
  })
  it('fails when its project did not run', () => {
    expect(judge(id, brokenObs(o => { for (const key of ['budget', 'memberApproval', 'skills', 'queries']) delete o[key] }), tools).status).toBe('failed')
  })
})

describe('H11 cost tree', () => {
  const errorOf = (b: Phase) => rootRecords(b).find(r => r['type'] === 'error')!
  it.each<[string, (b: Phase) => void]>([
    ['the root was not blocked (it sent a second request)', b => { b['requests'].push({ ...b['requests'].find((r: Phase) => r['route'] === null), phase: 'budget' }) }],
    ['the member was blocked instead', b => { const r = childRecordsAll(b).find(x => x['type'] === 'turn.end')!; r['reason'] = { kind: 'cancelled', cause: 'cost-cap' } }],
    ['the error is not budget/exhausted', b => { errorOf(b)['error'].code = 'internal' }],
    ['the cap counted only the root (used 1)', b => { errorOf(b)['error'].details.used = 1 }],
    ['the error came before the member ended', b => { errorOf(b)['seq'] = 1 }],
    ['the turn ended for another reason', b => { b['phases'].budget.reason = { kind: 'completed' } }],
    ['the root outcome does not record the cap', b => { delete ledgerRecords(b).find(r => r['type'] === 'task.outcome' && r['sessionId'] === b['sessionId'])!['error'] }],
    ['the member is in another task tree', b => { ledgerRecords(b).find(r => r['type'] === 'task.outcome' && r['sessionId'] !== b['sessionId'])!['taskId'] = TASK_ID }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H11', brokenObs(o => edit(o['budget']!)), tools).status).toBe('failed')
  })
})

describe('H14 member approval', () => {
  it.each<[string, (m: Phase) => void]>([
    ['no approval was asked', m => { m['approvals'] = [] }],
    ['the request does not name the member', m => { delete m['approvals'][0].request.member }],
    ['the request carries the root session id', m => { m['approvals'][0].request.sessionId = m['sessionId'] }],
    ['the answer by member session id was refused', m => { m['approvals'][0].answered = false }],
    ['the deny was not recorded in the child session', m => { const r = childRecordsAll(m).find(x => x['type'] === 'approval.decision')!; r['decision'].decision = 'allow' }],
    ['.env changed', m => { m['envContent'] = 'TOKEN=member-wrote\n' }],
    ['the edit did not fail', m => { m['phases'].memberApproval.toolResults.find((r: Phase) => r['callId'] === 'call-keeper-env').isError = false }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H14', brokenObs(o => edit(o['memberApproval']!)), tools).status).toBe('failed')
  })
})

describe('H20 skills', () => {
  const resultOf = (k: Phase, id: string) => k['phases'].skills.toolResults.find((r: Phase) => r['callId'] === id)
  it.each<[string, (k: Phase) => void]>([
    ['the user skill is not listed', k => { k['requests'][0].sessionText = k['requests'][0].sessionText.replace('- restock-user:', '- other:') }],
    ['the user copy of the clashing name is listed', k => { k['requests'][0].sessionText = k['requests'][0].sessionText.replace('Project copy', 'User copy') }],
    ['the user skill does not load', k => { Object.assign(resultOf(k, 'call-skill-user'), { isError: true, content: 'unknown skill' }) }],
    ['the user body wins the clash', k => { resultOf(k, 'call-skill-shared').content = '# Skill: stock-format\nUSER-SHARED-SKILL-BODY' }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H20', brokenObs(o => edit(o['skills']!)), tools).status).toBe('failed')
  })
})

describe('H21 queries after resume', () => {
  it.each<[string, (q: Phase) => void]>([
    ['a query called the model', q => { q['requests'] = 1 }],
    ['sessions.list shows a child at the top level', q => { q['delegation'].list.push({ sessionId: q['delegation'].children[0].sessionId, parentSessionId: q['delegation'].sessionId }) }],
    ['childCount is wrong', q => { q['workflow'].list[0].childCount = 1 }],
    ['sessions.children misses a child', q => { q['teamKill'].children.pop() }],
    ['a child view does not open', q => { const views = q['delegation'].views; delete views[Object.keys(views)[0]!] }],
    ["a member's deliverable is missing from its view", q => { const run = q['delegation'].collaboration.runs.find((r: Phase) => r['name'] === 'analyst'); q['delegation'].views[run.childSessionId].deliverables = [] }],
    ['the killed fork member reads completed', q => { q['delegation'].collaboration.runs.find((r: Phase) => r['name'] === 'forker-two').status = 'completed' }],
    ['the killed workflow reads running', q => { q['workflow'].collaboration.workflows[2].status = 'running' }],
    ['the team state is missing', q => { delete q['teamKill'].collaboration.team }],
    ['a team message is still queued', q => { q['teamKill'].collaboration.team.messages[0].state = 'queued' }],
  ])('fails when %s', (_label, edit) => {
    expect(judge('H21', brokenObs(o => edit(o['queries']!)), tools).status).toBe('failed')
  })
})
