/**
 * The round-2 judges of accept-step4 against hand-made observations: one
 * set that satisfies every judge, then each condition broken on purpose.
 * The product parts these items need (W1, W2 part 2) have not landed, so a
 * live run reports them not-implemented; these tests pin what a pass means.
 */
import { functionToolName, MEMBER_DENIED_TOOLS } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { checkpoint4, FUNCTION_TOOL, judge, judgeCheckpoint, JUDGES, versionWritten } from '../../../scripts/accept-common/step4-judges.mjs'
import { COMPONENTS, TASK_B } from '../../../scripts/accept-common/step4-fixtures.mjs'
import { expectedSummary, ordersCsv } from '../../../scripts/real-task/step4-orders.mjs'

const V = 'a'.repeat(64)
const CAP = ['capability_draft', 'capability_try', 'capability_propose']
const F = 'cap_order-summary_summarizeOrders'
const fm = { kind: 'function-module', name: 'order-summary' }
const skill = { kind: 'skill', name: 'monthly-order-summary' }

type Obs = Record<string, any>

const result = (toolCallId: string, isError = false, content = 'ok') => ({ type: 'tool.result', toolCallId, name: 'x', isError, content })
const start = (capabilityVersion?: string) => ({ type: 'session.start', ...(capabilityVersion === undefined ? {} : { capabilityVersion }) })

/** Observations that satisfy every round-2 judge. */
function good(): Obs {
  return {
    features: { capabilityTools: true },
    phases: {
      baseline: { sessionId: 'S-base', reason: { kind: 'completed' } },
      taskA: { sessionId: 'S-A', reason: { kind: 'completed' } },
      peer: { sessionId: 'S-peer', reason: { kind: 'completed' } },
      adopt: { version: V, published: true },
      taskB: { sessionId: 'S-B', parentPid: 100, child: { pid: 200, exitCode: 0, done: { type: 'driver.done', reason: { kind: 'completed' } } } },
      tamper: { sessionId: 'S-T', reason: { kind: 'completed' } },
    },
    sessions: {
      'S-base': [start('baseline')],
      'S-A': [
        start('baseline'),
        result('draft-fm'), result('draft-skill'), result('draft-unused'),
        { type: 'capability.draft', component: fm, files: [], revision: 1 },
        { type: 'capability.draft', component: skill, files: [], revision: 1 },
        result('try-fm'), result('try-skill'), result('try-unused'),
        { type: 'capability.try', component: fm, revision: 1, tools: [F] },
        { type: 'capability.try', component: skill, revision: 1 },
        result('probe-read', true, 'denied'), result('probe-write', true, 'denied'),
        result('use-fm'), result('write-a'), result('use-skill'),
        result('propose-unused', true, 'skill/unused-notes has no successful use after it was tried'),
        result('propose-good'),
        { type: 'capability.propose', toolCallId: 'propose-good', candidateId: 'C1', proofs: [{ ...fm, turn: 1, toolCallId: 'use-fm' }, { ...skill, turn: 1, toolCallId: 'use-skill' }] },
      ],
      'S-peer': [start('baseline'), result('peer-skill', true, 'unknown skill'), result('peer-helper')],
      'S-help': [start('baseline')],
      'S-B': [start(V), result('use-fm-b'), result('probe-bundle', true, 'denied')],
      'S-T': [start('baseline')],
    },
    ledger: [
      { type: 'llm.request.start', sessionId: 'S-base', capabilityVersion: 'baseline' },
      { type: 'task.outcome', sessionId: 'S-base', capabilityVersion: 'baseline', taskId: 'T1', checks: [{ name: 'file-exists', passed: true, target: 'c1' }, { name: 'test-command', passed: true, target: 'c2' }] },
      { type: 'llm.request.start', sessionId: 'S-B', capabilityVersion: V },
      { type: 'tool.call', sessionId: 'S-B', capabilityVersion: V },
      { type: 'task.outcome', sessionId: 'S-B', capabilityVersion: V, taskId: 'T2', componentsUsed: [{ ...fm, version: V, calls: 1, errors: 0 }] },
    ],
    requests: [
      ...Array.from({ length: 8 }, (_, i) => ({ route: 'taskA', tools: [...CAP, ...(i >= 2 ? [F] : [])], system: 'root' })),
      { route: 'peer', tools: [...CAP], system: 'root' },
      { route: 'peer', tools: [...CAP], system: 'root' },
      { route: 'helper', tools: ['read_file', 'write_file'], system: 'persona\nMember: helper (delegated)\n' },
      ...Array.from({ length: 4 }, () => ({ route: 'taskB', tools: [...CAP, F], system: 'root' })),
    ],
    bundle: {
      version: V,
      recomputedVersion: V,
      manifestText: '{"formatVersion":1}',
      files: [
        { ...fm, path: 'functions.json', listed: 'h1', actual: 'h1' },
        { ...fm, path: 'index.mjs', listed: 'h2', actual: 'h2' },
        { ...skill, path: 'SKILL.md', listed: 'h3', actual: 'h3' },
      ],
      unlisted: [],
    },
    activationBeforeTamper: [{ revision: 1, type: 'adopt', from: 'baseline', version: V }],
    activation: [
      { revision: 1, type: 'adopt', from: 'baseline', version: V },
      { revision: 2, type: 'rollback', trigger: 'load-failure', from: V, version: 'baseline', decisionId: 'D1' },
    ],
    tampered: { version: V, path: 'index.mjs' },
    candidates: [{ id: 'C1', record: { id: 'C1', components: [{ ...fm, files: [] }, { ...skill, files: [] }] }, files: [] }],
    drafts: ['S-A/functions/order-summary/functions.json', 'S-A/functions/order-summary/index.mjs', 'S-A/skills/monthly-order-summary/SKILL.md'],
    snapshots: ['checks/T1.json', 'tasks/T1.json', 'trees/x.json'],
    outputs: { [TASK_B.id]: `${JSON.stringify(expectedSummary(ordersCsv(TASK_B.month)))}\n` },
  }
}

function withAfter(obs: Obs): Obs {
  obs['bundleAfterB'] = structuredClone(obs['bundle'])
  return obs
}
const base = () => withAfter(good())
const ROUND2 = ['H01', 'H02', 'H03', 'H04', 'H05', 'H07', 'H10', 'H17']

/** Expect `id` to fail on `obs`, with evidence matching `pattern`. */
function fails(id: string, obs: Obs, pattern: RegExp) {
  const r = judge(id, obs)
  expect(r.status, `${id}: ${r.evidence}`).toBe('failed')
  expect(r.evidence).toMatch(pattern)
}

describe('round-2 judges: the pass case', () => {
  it('pins the contract names the scenario uses', () => {
    expect(FUNCTION_TOOL).toBe(functionToolName(COMPONENTS.good.functionModule.name, COMPONENTS.good.functionModule.function))
    expect(FUNCTION_TOOL).toBe(F)
    for (const tool of CAP) expect(MEMBER_DENIED_TOOLS).toContain(tool)
    expect(Object.keys(JUDGES)).toEqual(ROUND2)
  })

  it('every round-2 judge passes the good observations; the checkpoint passes too', () => {
    for (const id of ROUND2) expect(judge(id, base()), id).toMatchObject({ status: 'passed' })
    expect(judgeCheckpoint(base()).map(p => [p.id, p.status])).toEqual([['CP1', 'passed'], ['CP2', 'passed'], ['CP3', 'passed'], ['CP4', 'passed']])
  })
})

describe('round-2 judges: not-implemented until the product part lands', () => {
  it('without the capability tools every tool-dependent item is not-implemented, never passed', () => {
    const obs = base()
    obs['features'].capabilityTools = false
    for (const id of ['H02', 'H03', 'H04', 'H05', 'H07', 'H10', 'H17']) expect(judge(id, obs), id).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/W2 part 2/) })
    expect(judge('H01', obs)).toMatchObject({ status: 'passed' })
  })

  it('without capabilityVersion anywhere, H01, H07 and checkpoint 4 are not-implemented; H10 checks the chain but cannot pass', () => {
    const obs = base()
    for (const records of Object.values<any[]>(obs['sessions'])) for (const r of records) delete r.capabilityVersion
    for (const r of obs['ledger']) delete r.capabilityVersion
    expect(versionWritten(obs)).toBe(false)
    for (const id of ['H01', 'H07']) expect(judge(id, obs), id).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/W1/) })
    expect(checkpoint4(obs)).toMatchObject({ status: 'not-implemented' })
    expect(judge('H10', obs)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/checked so far/) })
    obs['activation'].pop()
    expect(judge('H10', obs)).toMatchObject({ status: 'failed' })
  })

  it('a throwing judge fails, and nothing at all is never a pass', () => {
    expect(judge('H02', { features: { capabilityTools: true }, get phases(): never { throw new Error('boom') } })).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/boom/) })
    for (const id of ROUND2) expect(judge(id, {}).status, id).not.toBe('passed')
    expect(judge('H99', base())).toEqual({ status: 'not-implemented', evidence: 'no judge' })
  })
})

describe('round-2 judges: counter-examples', () => {
  it('H01 fails on a non-baseline version or an unfinished task', () => {
    let obs = base(); obs['sessions']['S-base'][0].capabilityVersion = V
    fails('H01', obs, /session\.start/)
    obs = base(); obs['ledger'][0].capabilityVersion = V
    fails('H01', obs, /1 do not/)
    obs = base(); obs['phases'].baseline.reason = { kind: 'cancelled' }
    fails('H01', obs, /completed/)
    obs = base(); obs['ledger'] = obs['ledger'].filter((r: any) => r.sessionId !== 'S-base')
    fails('H01', obs, /has ledger records/)
  })

  it('H02 fails when a draft or try failed, the tool was missing, or a file tool reached the draft area', () => {
    const cases: [string, (o: Obs) => void, RegExp][] = [
      ['draft failed', o => { o['sessions']['S-A'][1].isError = true }, /capability_draft/],
      ['no draft record', o => { o['sessions']['S-A'] = o['sessions']['S-A'].filter((r: any) => r.type !== 'capability.draft') }, /capability\.draft records/],
      ['try lists no tool', o => { o['sessions']['S-A'].find((r: any) => r.type === 'capability.try').tools = [] }, /lists cap_/],
      ['tool missing later', o => { o['requests'][5].tools = CAP }, /every later request/],
      ['function call failed', o => { o['sessions']['S-A'].find((r: any) => r.toolCallId === 'use-fm').isError = true }, /call succeeded/],
      ['skill not loaded', o => { o['sessions']['S-A'].find((r: any) => r.toolCallId === 'use-skill').isError = true }, /load_skill/],
      ['read reached the drafts', o => { o['sessions']['S-A'].find((r: any) => r.toolCallId === 'probe-read').isError = false }, /read_file into the draft area/],
      ['write reached the drafts', o => { o['sessions']['S-A'].find((r: any) => r.toolCallId === 'probe-write').isError = false }, /write_file into the draft area/],
      ['model file in drafts', o => { o['drafts'].push('S-A/functions/order-summary/extra.mjs') }, /host-written module/],
    ]
    for (const [label, mutate, pattern] of cases) {
      const obs = base(); mutate(obs)
      expect(judge('H02', obs).status, label).toBe('failed')
      fails('H02', obs, pattern)
    }
  })

  it('H03 fails when the peer saw the tool or the skill, or when task A never had the tool', () => {
    let obs = base(); obs['requests'].find((r: any) => r.route === 'peer').tools.push(F)
    fails('H03', obs, /no request of the peer/)
    obs = base(); obs['requests'].find((r: any) => r.route === 'peer').system = 'skills: monthly-order-summary'
    fails('H03', obs, /system prompt/)
    obs = base(); obs['sessions']['S-peer'][1].isError = false
    fails('H03', obs, /load_skill/)
    obs = base(); for (const r of obs['requests']) if (r.route === 'taskA') r.tools = CAP
    fails('H03', obs, /proves nothing/)
  })

  it('H04 fails when the unused component was accepted or the candidate is wrong', () => {
    let obs = base(); obs['sessions']['S-A'].find((r: any) => r.toolCallId === 'propose-unused').isError = false
    fails('H04', obs, /never-used/)
    obs = base(); obs['sessions']['S-A'].push({ type: 'capability.propose', toolCallId: 'propose-unused', candidateId: 'C0', proofs: [] })
    fails('H04', obs, /wrote no capability\.propose/)
    obs = base(); obs['sessions']['S-A'].find((r: any) => r.type === 'capability.propose').proofs.pop()
    fails('H04', obs, /a proof for each/)
    obs = base(); obs['candidates'] = []
    fails('H04', obs, /candidate\.json exists/)
    obs = base(); obs['candidates'].push({ id: 'C2', record: { id: 'C2', components: [{ kind: 'skill', name: 'unused-notes', files: [] }] } })
    fails('H04', obs, /no candidate holds the unused/)
  })

  it('H05 fails on a hash mismatch, a stray file, a writable bundle or a changed bundle', () => {
    let obs = base(); obs['bundle'].recomputedVersion = 'b'.repeat(64)
    fails('H05', obs, /canonical manifest/)
    obs = base(); obs['bundle'].files[1].actual = 'zz'; obs['bundleAfterB'] = structuredClone(obs['bundle'])
    fails('H05', obs, /1 differ/)
    obs = base(); obs['bundle'].unlisted = ['functions/order-summary/evil.mjs']; obs['bundleAfterB'] = structuredClone(obs['bundle'])
    fails('H05', obs, /outside the manifest/)
    obs = base(); obs['sessions']['S-B'][2].isError = false
    fails('H05', obs, /adopted bundle was refused/)
    obs = base(); obs['bundleAfterB'].manifestText = 'changed'
    fails('H05', obs, /byte-identical/)
    obs = base(); obs['phases'].adopt = { error: 'store refused' }; delete obs['bundle']
    fails('H05', obs, /store refused/)
  })

  it('H07 fails unless a separate process loaded the version, called the tool and recorded it', () => {
    const cases: [string, (o: Obs) => void, RegExp][] = [
      ['same process', o => { o['phases'].taskB.child.pid = 100 }, /own OS process/],
      ['not completed', o => { o['phases'].taskB.child.done.reason = { kind: 'error' } }, /task B completed/],
      ['old version in start', o => { o['sessions']['S-B'][0].capabilityVersion = 'baseline' }, /session\.start of B/],
      ['tool not offered', o => { o['requests'].find((r: any) => r.route === 'taskB').tools = CAP }, /without a try/],
      ['call failed', o => { o['sessions']['S-B'][1].isError = true }, /call succeeded/],
      ['ledger line without version', o => { o['ledger'][3].capabilityVersion = 'baseline' }, /1 of 3 do not/],
      ['componentsUsed missing', o => { delete o['ledger'][4].componentsUsed }, /componentsUsed/],
      ['componentsUsed from a draft', o => { o['ledger'][4].componentsUsed[0].version = 'draft' }, /componentsUsed/],
      ['wrong summary', o => { o['outputs'][TASK_B.id] = '{"month":"2026-10"}' }, /hidden check/],
    ]
    for (const [label, mutate, pattern] of cases) {
      const obs = base(); mutate(obs)
      expect(judge('H07', obs).status, label).toBe('failed')
      fails('H07', obs, pattern)
    }
  })

  it('H10 fails without a load-failure rollback to the previous version', () => {
    let obs = base(); obs['activation'][1].trigger = 'manual'
    fails('H10', obs, /load-failure/)
    obs = base(); obs['activation'][1].version = V
    fails('H10', obs, /leaves/)
    obs = base(); delete obs['activation'][1].decisionId
    fails('H10', obs, /decision record/)
    obs = base(); obs['sessions']['S-T'][0].capabilityVersion = V
    fails('H10', obs, /previous version/)
    obs = base(); obs['phases'].tamper.reason = { kind: 'error' }
    fails('H10', obs, /still worked/)
  })

  it('H17 fails when a member sees a capability tool, or nothing proves the root had them', () => {
    let obs = base(); obs['requests'].find((r: any) => r.route === 'helper').tools.push('capability_propose')
    fails('H17', obs, /sees none/)
    obs = base(); obs['requests'].find((r: any) => r.route === 'helper').tools.push(F)
    fails('H17', obs, /sees none/)
    obs = base(); obs['requests'] = obs['requests'].filter((r: any) => r.route !== 'helper')
    fails('H17', obs, /sent requests/)
    obs = base(); for (const r of obs['requests']) if (r.route === 'peer') r.tools = ['read_file']
    fails('H17', obs, /root session offers/)
  })

  it('checkpoint 4 fails without a snapshot, a checks record or a passing test command', () => {
    let obs = base(); obs['snapshots'] = ['checks/T1.json']
    expect(checkpoint4(obs)).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/tasks\/T1\.json/) })
    obs = base(); obs['snapshots'] = ['tasks/T1.json']
    expect(checkpoint4(obs)).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/checks\/T1\.json/) })
    obs = base(); obs['ledger'][1].checks = [{ name: 'test-command', passed: false, target: 'c2' }]
    expect(checkpoint4(obs)).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/test command/) })
    obs = base(); obs['ledger'][1].checks = [{ name: 'test-command', passed: true }]
    expect(checkpoint4(obs)).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/targets/) })
  })

  it('checkpoints 1–3 follow their items: a failed item fails the point', () => {
    const obs = base(); obs['sessions']['S-A'].find((r: any) => r.toolCallId === 'probe-read').isError = false
    expect(judgeCheckpoint(obs).find(p => p.id === 'CP1')).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/^H02/) })
  })
})
