/**
 * The round-2 judges of accept-step4 against hand-made observations: one
 * set that satisfies every judge, then each condition broken on purpose.
 * The product parts these items need (W1, W2 part 2) have not landed, so a
 * live run reports them not-implemented; these tests pin what a pass means.
 */
import { DEFAULT_CAPABILITIES_CONFIG, functionToolName, MEMBER_DENIED_TOOLS } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { checkpoint4, EXTRAS, FUNCTION_TOOL, GATE as GATE_FACTS, judge, judgeCheckpoint, JUDGES, versionWritten } from '../../../scripts/accept-common/step4-judges.mjs'
import { BUDGET, GATE_PLUGIN } from '../../../scripts/accept-common/step4-gate.mjs'
import { PLUGIN, pluginFiles, POLICIES } from '../../../scripts/accept-common/step4-scenario.mjs'
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
    features: { capabilityTools: true, gate: false },
    phases: {
      baseline: { sessionId: 'S-base', reason: { kind: 'completed' } },
      taskA: { sessionId: 'S-A', reason: { kind: 'completed' } },
      peer: { sessionId: 'S-peer', reason: { kind: 'completed' } },
      adopt: { version: V, published: true },
      taskB: { sessionId: 'S-B', parentPid: 100, child: { pid: 200, exitCode: 0, done: { type: 'driver.done', reason: { kind: 'completed' } } } },
      tamper: { sessionId: 'S-T', reason: { kind: 'completed' } },
      extras: {
        sessionId: 'S-X',
        reason: { kind: 'completed' },
        approvals: [{ sessionId: 'S-X', request: { id: 'a1', risk: 'high', summary: 'Load plugin "probe-plugin" into Nexgent' }, answered: true }],
      },
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
      'S-X': [
        start('baseline'),
        result('draft-policy-short-summaries'), result('try-policy-short-summaries'),
        { type: 'capability.try', component: { kind: 'context-policy', name: 'short-summaries' }, revision: 1 },
        ...EXTRAS.badPolicies.flatMap(([name, field]) => [result(`draft-policy-${name}`, true, `policy.json: /${field} is not allowed`), result(`try-policy-${name}`, true, 'no draft')]),
        result('draft-plugin'), result('try-plugin', true, 'the user did not allow loading plugin probe-plugin'),
      ],
    },
    ledger: [
      { type: 'llm.request.start', sessionId: 'S-base', capabilityVersion: 'baseline' },
      { type: 'task.outcome', sessionId: 'S-base', memberId: 'main', capabilityVersion: 'baseline', taskId: 'T1', componentsUsed: [], checks: [{ name: 'file-exists', passed: true, target: 'c1' }, { name: 'test-command', passed: true, target: 'c2' }] },
      { type: 'task.outcome', sessionId: 'S-A', memberId: 'main', capabilityVersion: 'baseline', taskId: 'T3', componentsUsed: [{ ...fm, version: 'draft', calls: 1, errors: 0 }], checks: [] },
      { type: 'task.outcome', sessionId: 'S-help', memberId: 'S-help', capabilityVersion: 'baseline', taskId: 'T4', componentsUsed: [] },
      { type: 'task.outcome', sessionId: 'S-peer', memberId: 'main', capabilityVersion: 'baseline', taskId: 'T4', componentsUsed: [], checks: [], memberCosts: [{ memberId: 'S-help', name: 'helper' }] },
      { type: 'task.outcome', sessionId: 'S-X', memberId: 'main', capabilityVersion: 'baseline', taskId: 'T5', componentsUsed: [], checks: [] },
      { type: 'llm.request.start', sessionId: 'S-B', capabilityVersion: V },
      { type: 'tool.call', sessionId: 'S-B', capabilityVersion: V },
      { type: 'task.outcome', sessionId: 'S-B', memberId: 'main', capabilityVersion: V, taskId: 'T2', componentsUsed: [{ ...fm, version: V, calls: 1, errors: 0 }], checks: [] },
    ],
    requests: [
      ...Array.from({ length: 8 }, (_, i) => ({ route: 'taskA', tools: [...CAP, ...(i >= 2 ? [F] : [])], system: 'root' })),
      { route: 'peer', tools: [...CAP], system: 'root' },
      { route: 'peer', tools: [...CAP], system: 'root' },
      { route: 'helper', tools: ['read_file', 'write_file'], system: 'persona\nMember: helper (delegated)\n' },
      ...Array.from({ length: 4 }, () => ({ route: 'taskB', tools: [...CAP, F], system: 'root' })),
      ...Array.from({ length: 3 }, () => ({ route: 'extras', tools: [...CAP], system: 'root' })),
    ],
    pluginRan: false,
    schemaIssues: [],
    export: { code: 0, files: ['session.md'] },
    secretHits: [],
    exportSecretHits: [],
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
const lineOfB = (obs: Obs, type: string) => obs['ledger'].find((r: any) => r.sessionId === 'S-B' && r.type === type)
const ROUND2 = ['H01', 'H02', 'H03', 'H04', 'H05', 'H07', 'H10', 'H17']
/** Round 3: judged now. */
const ROUND3 = ['H13', 'H18']
/** Judged from the gate scenario (`obs.gate`, step4-gate.mjs); not-implemented while the gate is missing. */
const GATE = ['H06', 'H08', 'H09', 'H11', 'H12', 'H15', 'H16']

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
    expect(Object.keys(JUDGES).sort()).toEqual([...ROUND2, ...ROUND3, 'H14', ...GATE].sort())
  })

  it('pins the extras phase the judges read against the scenario', () => {
    expect(EXTRAS.goodPolicy).toBe(POLICIES.good.name)
    expect(EXTRAS.badPolicies).toEqual(POLICIES.bad.map(p => [p.name, p.field]))
    for (const p of POLICIES.bad) expect(p.files[0]!.content).toContain(`"${p.field}"`)
    expect([EXTRAS.plugin, EXTRAS.pluginTool]).toEqual([PLUGIN.name, PLUGIN.tool])
    expect(pluginFiles('/m').map(f => f.path)).toEqual(['plugin.json', 'index.mjs'])
  })

  it('every round-2 judge passes the good observations; the checkpoint passes too', () => {
    for (const id of [...ROUND2, ...ROUND3]) expect(judge(id, base()), id).toMatchObject({ status: 'passed' })
    // H14's try half passes; adoption approval needs the gate.
    expect(judge('H14', base())).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/gate \(W3\).*checked so far: trying the plugin asked once/) })
    for (const id of GATE) expect(judge(id, base()), id).toEqual({ status: 'not-implemented', evidence: expect.stringMatching(/the gate \(W3\) has not landed/) })
    // The gate is there but its scenario did not run: a failure, not a pass.
    const gate = base()
    gate['features'].gate = true
    for (const id of [...GATE, 'H14']) expect(judge(id, gate), id).toEqual({ status: 'failed', evidence: 'the gate is present, but the gate scenario did not run' })
    expect(judgeCheckpoint(base()).map(p => [p.id, p.status])).toEqual([['CP1', 'passed'], ['CP2', 'passed'], ['CP3', 'passed'], ['CP4', 'passed']])
  })
})

describe('round-2 judges: not-implemented until the product part lands', () => {
  it('without the capability tools every tool-dependent item is not-implemented, never passed', () => {
    const obs = base()
    obs['features'].capabilityTools = false
    for (const id of ['H02', 'H03', 'H04', 'H05', 'H07', 'H10', 'H13', 'H14', 'H17']) expect(judge(id, obs), id).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/W2 part 2/) })
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
      ['ledger line without version', o => { lineOfB(o, 'tool.call').capabilityVersion = 'baseline' }, /1 of 3 do not/],
      ['componentsUsed missing', o => { delete lineOfB(o, 'task.outcome').componentsUsed }, /componentsUsed/],
      ['componentsUsed from a draft', o => { lineOfB(o, 'task.outcome').componentsUsed[0].version = 'draft' }, /componentsUsed/],
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

describe('round-3 judges: counter-examples', () => {
  const xRecords = (obs: Obs) => obs['sessions']['S-X'] as Record<string, any>[]
  const xResult = (obs: Obs, id: string) => xRecords(obs).find(r => r.toolCallId === id)!

  it('H13 fails when a policy reaching a gate field loads, is refused for another reason, or the control fails', () => {
    let obs = base()
    xResult(obs, 'draft-policy-open-sandbox').isError = false
    xResult(obs, 'try-policy-open-sandbox').isError = false
    fails('H13', obs, /open-sandbox \(with sandbox\) was refused/)
    obs = base()
    xRecords(obs).push({ type: 'capability.try', component: { kind: 'context-policy', name: 'skip-gate' }, revision: 1 })
    fails('H13', obs, /skip-gate was never loaded/)
    obs = base()
    xResult(obs, 'draft-policy-more-budget').content = 'invalid JSON'
    fails('H13', obs, /names costCapUsd/)
    obs = base()
    xResult(obs, 'try-policy-short-summaries').isError = true
    fails('H13', obs, /the control/)
  })

  it('H14 fails when the plugin loaded, ran, asked twice or was not asked as high risk', () => {
    let obs = base()
    obs['pluginRan'] = true
    fails('H14', obs, /never ran/)
    obs = base()
    xResult(obs, 'try-plugin').isError = false
    fails('H14', obs, /failed after the denial/)
    obs = base()
    obs['phases'].extras.approvals.push(structuredClone(obs['phases'].extras.approvals[0]))
    fails('H14', obs, /exactly once/)
    obs = base()
    obs['phases'].extras.approvals[0].request.risk = 'medium'
    fails('H14', obs, /high risk/)
    obs = base()
    obs['requests'].find((r: any) => r.route === 'extras').tools.push('probe_plugin_ping')
    fails('H14', obs, /no request offers/)
  })

  it('H18 fails on a missing outcome field, member cost, schema issue, failed export or leaked key', () => {
    const cases: [(o: Obs) => void, RegExp][] = [
      [o => { delete o['ledger'].find((r: any) => r.sessionId === 'S-X').checks }, /lack them/],
      [o => { o['ledger'].find((r: any) => r.sessionId === 'S-peer').memberCosts = [] }, /missing in S-peer/],
      [o => { lineOfB(o, 'task.outcome').componentsUsed = [] }, /adopted module/],
      [o => { o['schemaIssues'] = ['ledger#3 tool.call: /x bad'] }, /passes the schema \(ledger#3/],
      [o => { o['export'] = { code: 1, files: [] } }, /export of task B/],
      [o => { o['secretHits'] = ['.nexgent/config.json'] }, /config\.json/],
      [o => { o['exportSecretHits'] = undefined }, /not scanned/],
    ]
    for (const [mutate, pattern] of cases) {
      const obs = base()
      mutate(obs)
      fails('H18', obs, pattern)
    }
    const old = base()
    for (const r of old['ledger']) delete r.capabilityVersion
    for (const records of Object.values(old['sessions']) as any[]) for (const r of records) delete r.capabilityVersion
    expect(judge('H18', old)).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/W1/) })
  })
})

// ---------------------------------------------------------------------------
// The gate items (H06, H08, H09, H11, H12, H14's adoption half, H15, H16) over
// hand-made gate-scenario observations shaped like step4-gate.mjs's.
// ---------------------------------------------------------------------------

const VA = 'a1'.repeat(32)
const VC = 'c1'.repeat(32)
const VD = 'd1'.repeat(32)
const VE = 'e1'.repeat(32)
const VF = 'f1'.repeat(32)
const PLUGIN_TOOL = 'greet_user'
const cost = (requestCount: number) => ({ usage: { inputTokens: 40 * requestCount, outputTokens: 12 * requestCount }, requestCount, estimatedUsd: 'unknown' })
const named = (name: string, isError = false) => ({ type: 'tool.result', toolCallId: `c-${name}`, name, isError, content: isError ? 'Failed' : 'ok' })
const passedChecks = [{ name: 'test-command', passed: true, target: 'test-1' }]

/** A full trial: selection [origin, similar] and guard [far], `repeats` runs per arm; `status(arm, set)` per run. */
function trialReceipts(trialId: string, candidateId: string, cases: { selection: string[]; guard: string[] }, status: (arm: string, set: string) => string, extra: Obs = {}) {
  const runs: Obs[] = []
  for (const [set, list] of [['selection', cases.selection], ['guard', cases.guard]] as const) {
    for (const caseId of list) {
      for (const repeat of [1, 2]) {
        for (const arm of ['candidate', 'baseline']) {
          const s = status(arm, set)
          runs.push({ type: 'trial.run', trialId, set, caseId, arm, repeat, status: s, checks: [{ name: 'test-command', passed: s === 'pass', target: 'test-1' }], cost: cost(3) })
        }
      }
    }
  }
  const plan = { selection: cases.selection.map(caseId => ({ caseId })), guard: cases.guard.map(caseId => ({ caseId })), repeats: 2, budget: { maxRequests: 400, maxTokens: 8_000_000 }, ...extra['plan'] }
  return [{ type: 'trial.start', trialId, candidateId, plan }, ...runs, ...(extra['reviews'] ?? []), ...(extra['end'] === null ? [] : [extra['end']])]
}

/** Ledger request lines of a trial: three per run, with the run's arm. */
function trialRequests(trialId: string, receipts: Obs[]) {
  return receipts.filter(r => r.type === 'trial.run').flatMap(r => Array.from({ length: r.cost.requestCount }, () => ({ type: 'llm.request.end', trialId, arm: r.arm, sessionId: `trial-${r.arm}-${r.caseId}-${r.repeat}` })))
}

/** Gate observations that satisfy every gate judge. */
function goodGate(): Obs {
  const cases = { selection: ['T-A0', 'T-H1'], guard: ['T-H3'] }
  const tA = trialReceipts('tA', 'cA', cases, arm => (arm === 'candidate' ? 'pass' : 'fail'), { end: { type: 'trial.end', status: 'pass', verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0 }, costRatio: 1, decidedByReview: false } } })
  const tC = trialReceipts('tC', 'cC', { selection: ['T-C', 'T-H1'], guard: ['T-H3'] }, (arm, set) => (set === 'guard' || arm === 'baseline' ? 'pass' : 'fail'), { end: { type: 'trial.end', status: 'fail', verdict: { outcome: 'reject', reason: 'quality-down', passRate: { candidate: 0, baseline: 1 }, costRatio: 1, decidedByReview: false } } })
  const reviews = [1, 2].flatMap(repeat => ['T-E', 'T-H1'].map(caseId => ({ type: 'trial.review', trialId: 'tE', set: 'selection', caseId, repeat, preference: 'candidate', reason: 'It also greets.', model: 'claude-sonnet-5-5', cost: cost(2) })))
  const tE = trialReceipts('tE', 'cE', { selection: ['T-E', 'T-H1'], guard: ['T-H3'] }, (_arm, set) => (set === 'guard' ? 'pass' : 'fail'), { reviews, end: { type: 'trial.end', status: 'pass', verdict: { outcome: 'await-approval', reason: 'review-preferred', passRate: { candidate: 0, baseline: 0 }, costRatio: 1, decidedByReview: true } } })
  const tD = [
    { type: 'trial.start', trialId: 'tD', candidateId: 'cD', plan: { selection: [{ caseId: 'T-D' }, { caseId: 'T-H1' }], guard: [{ caseId: 'T-H3' }], repeats: 2, budget: { maxRequests: 3, maxTokens: 8_000_000 } } },
    { type: 'trial.run', trialId: 'tD', set: 'selection', caseId: 'T-D', arm: 'candidate', repeat: 1, status: 'fail', checks: [{ name: 'test-command', passed: false, target: 'test-1' }], cost: cost(3) },
    { type: 'trial.run', trialId: 'tD', set: 'selection', caseId: 'T-D', arm: 'baseline', repeat: 1, status: 'unknown', reason: 'budget', checks: [], cost: cost(0) },
    { type: 'trial.end', status: 'unknown', verdict: { outcome: 'reject', reason: 'budget-exhausted', passRate: { candidate: 0, baseline: 0 }, costRatio: 'unknown', decidedByReview: false } },
  ]
  const tF = [{ type: 'trial.start', trialId: 'tF', candidateId: 'cF', plan: { selection: [], guard: [], repeats: 2 } }]
  const gateCost = (c: number, b: number, r: number) => ({ candidate: cost(c), baseline: cost(b), review: cost(r) })
  const decisions = [
    { id: 'dA', outcome: 'adopted', reason: 'quality-up', trigger: 'gate', candidateId: 'cA', trialId: 'tA', fromVersion: 'baseline', toVersion: VA, revision: 1, verdict: tA.at(-1)!['verdict'], cost: gateCost(18, 18, 0), detail: 'adopt (quality-up). No reviewer opinion was needed.' },
    { id: 'dC', outcome: 'rejected', reason: 'quality-down', trigger: 'gate', candidateId: 'cC', trialId: 'tC', fromVersion: VA, toVersion: VA, verdict: tC.at(-1)!['verdict'], cost: gateCost(18, 18, 0), detail: 'reject (quality-down).' },
    { id: 'dR', outcome: 'rolled-back', reason: 'component-errors', trigger: 'usage-regression', candidateId: 'cA', fromVersion: VA, toVersion: 'baseline', revision: 2, regression: { consecutiveErrors: 3, observations: [{ taskId: 'T-C' }, { taskId: 'T-B2' }, { taskId: 'T-R' }] }, detail: 'rolled back' },
    { id: 'dD', outcome: 'rejected', reason: 'budget-exhausted', trigger: 'gate', candidateId: 'cD', trialId: 'tD', fromVersion: 'baseline', toVersion: 'baseline', detail: 'reject (budget-exhausted).' },
    { id: 'dE1', outcome: 'rejected', reason: 'review-preferred', trigger: 'gate', candidateId: 'cE', trialId: 'tE', fromVersion: 'baseline', toVersion: 'baseline', verdict: tE.at(-1)!['verdict'], cost: gateCost(18, 18, 8), detail: "await-approval (review-preferred). Candidates that need the user's approval are no longer adopted." },
    { id: 'dF', outcome: 'rejected', reason: 'interrupted', trigger: 'gate', candidateId: 'cF', trialId: 'tF', fromVersion: 'baseline', toVersion: 'baseline', detail: 'interrupted' },
  ]
  const tasks: Obs = {}
  const sessions: Obs = {}
  const versions: Obs = { A0: 'baseline', H1: 'baseline', H2: 'baseline', H3: 'baseline', C: VA, B2: VA, R: VA, D: 'baseline', E: 'baseline', F: 'baseline', G: 'baseline' }
  for (const [key, version] of Object.entries(versions)) {
    tasks[key] = { sessionId: `G-${key}`, reason: { kind: 'completed' }, taskId: `T-${key}` }
    sessions[`G-${key}`] = [{ type: 'session.start', capabilityVersion: version }]
  }
  sessions['G-B2'].push(named(F))
  sessions['G-R'].push(named(F, true), named(F, true), named(F, true))
  sessions['G-E'].push(named(PLUGIN_TOOL))
  return {
    tasks,
    sessions,
    candidates: { A0: { id: 'cA', version: VA }, C: { id: 'cC', version: VC }, D: { id: 'cD', version: VD }, E: { id: 'cE', version: VE }, F: { id: 'cF', version: VF } },
    candidateDirs: ['cA', 'cC', 'cD', 'cE', 'cF'],
    retry: { sameApp: { status: 'trialing' } },
    waiting: { line: { status: 'waiting', detail: 'the project has 1' }, trial: { code: 'tool/invalid-input', error: 'the gate cannot run yet: the project has 1' }, status: 'proposed', trials: 0, decisions: 0, files: { 'cA.log': { size: 120 } } },
    isolation: { before: { files: { 'data/orders.csv': 'h1', 'out/summary.json': 'h2' }, sessions: { 'G-A0/session.jsonl': 'h3' } }, after: { files: { 'data/orders.csv': 'h1', 'out/summary.json': 'h2' }, sessions: { 'G-A0/session.jsonl': 'h3' } } },
    plugin: { status: 'rejected', versionAfter: 'baseline' },
    approvals: [{ sessionId: 'G-E', summary: 'Load plugin "greeter" into Nexgent (runs in the host process, not sandboxed)', risk: 'high', decision: 'allow' }],
    requests: [{ kind: 'main', task: 'F', tools: [] }, { kind: 'main', task: 'F', tools: [] }],
    kill: { trialId: 'tF', pid: 4242, aliveBefore: true, receiptsBefore: ['trial.start'], deadAfter: true, versionBefore: 'baseline' },
    recovered: { decision: decisions.at(-1), status: 'rejected', trial: { code: 'tool/invalid-input', error: 'candidate cF is rejected' }, trialsOfF: 1 },
    trials: { tA, tC, tD, tE, tF },
    trialFiles: Object.fromEntries(['cA', 'cC', 'cD', 'cE', 'cF'].flatMap(id => [[`${id}.attempt`, { size: 0, text: '' }], [`${id}.log`, { size: 200 }]])),
    logs: { A0: [{ status: 'waiting' }, { status: 'decided', trialId: 'tA' }], C: [{ status: 'decided', trialId: 'tC' }], D: [{ status: 'decided', trialId: 'tD' }], E: [{ status: 'decided', trialId: 'tE' }], F: [] },
    decisions,
    activation: [
      { revision: 1, type: 'adopt', trigger: 'gate', from: 'baseline', version: VA, decisionId: 'dA' },
      { revision: 2, type: 'rollback', trigger: 'usage-regression', from: VA, version: 'baseline', decisionId: 'dR' },
    ],
    ledger: [
      ...trialRequests('tA', tA),
      ...trialRequests('tE', tE),
      // ADR 0016: each opinion is two requests, one per order.
      ...Array.from({ length: 8 }, () => ({ type: 'llm.request.end', trialId: 'tE', sessionId: 'review' })),
      ...trialRequests('tD', tD),
      { type: 'task.outcome', sessionId: 'G-B2', memberId: 'main', taskId: 'T-B2', componentsUsed: [{ kind: 'function-module', name: 'order-summary', version: VA, calls: 1, errors: 0 }], checks: passedChecks },
      { type: 'task.outcome', sessionId: 'G-G', memberId: 'main', taskId: 'T-G', componentsUsed: [], checks: passedChecks },
    ],
  }
}

const gateBase = () => {
  const obs = base()
  obs['features'].gate = true
  obs['gate'] = goodGate()
  return obs
}
const gateOf = (obs: Obs) => obs['gate'] as Obs
const decisionOf = (obs: Obs, id: string) => gateOf(obs)['decisions'].find((d: any) => d.id === id)

/** Each case breaks one thing; the item must fail naming it. */
function gateFails(id: string, cases: [string, (g: Obs) => void, RegExp][]) {
  for (const [what, mutate, pattern] of cases) {
    const obs = gateBase()
    mutate(gateOf(obs))
    const r = judge(id, obs)
    expect(r.status, `${id} / ${what}: ${r.evidence}`).toBe('failed')
    expect(r.evidence, `${id} / ${what}`).toMatch(pattern)
  }
}

describe('gate judges', () => {
  it('pins the scenario facts the judges read: the budget, the plugin and the product defaults', () => {
    expect(GATE_FACTS.budgetMaxRequests).toBe(BUDGET.maxRequests)
    expect([GATE_FACTS.plugin, GATE_FACTS.pluginTool]).toEqual([GATE_PLUGIN.name, GATE_PLUGIN.tool])
    expect([GATE_FACTS.selectionCases, GATE_FACTS.guardCases]).toEqual([DEFAULT_CAPABILITIES_CONFIG.selectionCases, DEFAULT_CAPABILITIES_CONFIG.guardCases])
    expect([GATE_FACTS.windowTasks, GATE_FACTS.consecutiveErrors]).toEqual([DEFAULT_CAPABILITIES_CONFIG.rollback.windowTasks, DEFAULT_CAPABILITIES_CONFIG.rollback.consecutiveErrors])
    expect(PLUGIN_TOOL).toBe(GATE_PLUGIN.tool)
  })

  it('every gate item passes the good observations, H14 with both halves', () => {
    for (const id of [...GATE, 'H14']) expect(judge(id, gateBase()), id).toMatchObject({ status: 'passed' })
  })

  it('a scenario that stopped half way fails its items and says where', () => {
    const obs = gateBase()
    delete gateOf(obs)['recovered']
    gateOf(obs)['error'] = { step: 'restart after the kill', message: 'timed out' }
    expect(judge('H16', obs)).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/stopped at restart after the kill: timed out/) })
    expect(judge('H06', obs)).toMatchObject({ status: 'passed' })
  })

  it('H06 fails on a missing run, the wrong order, no adoption revision, a missing cost or an unmarked reviewer', () => {
    gateFails('H06', [
      ['a run is missing', g => { g['trials'].tA.splice(3, 1) }, /missing guard|missing selection|runs; missing/],
      ['baseline before candidate', g => { const runs = g['trials'].tA; [runs[1], runs[2]] = [runs[2], runs[1]] }, /candidate arm ran before/],
      ['one repeat only', g => { g['trials'].tA[0].plan.repeats = 1 }, /r = 1/],
      ['no adoption revision', g => { g['activation'].shift() }, /adopt revision with trigger gate/],
      ['the review cost is missing', g => { delete g['decisions'][0].cost.review }, /cost of each arm and of the reviewer/],
      ['the reviewer was asked although the checks decided', g => { g['trials'].tA.push({ type: 'trial.review', preference: 'candidate', reason: 'x', model: 'm' }) }, /reviewer was not asked/],
      ['the tie is not marked decided by review', g => { g['decisions'][4].verdict = { ...g['decisions'][4].verdict, decidedByReview: false } }, /decided by review/],
      ['a review line without a reason', g => { g['trials'].tE.find((r: any) => r.type === 'trial.review').reason = '' }, /preference, reason and model/],
      ['reviewer requests carry an arm', g => { g['ledger'].find((r: any) => r.sessionId === 'review').arm = 'candidate' }, /trial id and no arm/],
    ])
  })

  it('H08 fails when the bad candidate is adopted, deleted, loses its receipts, or the next task leaves the adopted version', () => {
    gateFails('H08', [
      ['adopted', g => { g['trials'].tC.at(-1).verdict = { outcome: 'adopt', reason: 'quality-up' } }, /verdict is reject/],
      ['candidate deleted', g => { g['candidateDirs'] = ['cA'] }, /stays on disk/],
      ['receipts lost', g => { g['trials'].tC = [] }, /receipts stay|verdict is reject/],
      ['a revision for it', g => { g['activation'].push({ revision: 9, type: 'adopt', version: VC, decisionId: 'dC' }) }, /no revision/],
      ['next task on another version', g => { g['sessions']['G-B2'][0].capabilityVersion = 'baseline' }, /next task runs on the adopted version/],
      ['the module failed in the next task', g => { g['sessions']['G-B2'][1].isError = true }, /call worked/],
      ['its checks failed', g => { g['ledger'].find((r: any) => r.sessionId === 'G-B2').checks = [{ name: 'test-command', passed: false }] }, /checks passed/],
    ])
  })

  it('H09 fails without the rollback, outside the window, on the wrong trigger, or when the next task keeps the bad version', () => {
    gateFails('H09', [
      ['no rollback', g => { g['decisions'] = g['decisions'].filter((d: any) => d.id !== 'dR'); g['activation'].splice(1, 1) }, /usage-regression decision/],
      ['too few errors', g => { g['sessions']['G-R'].pop() }, /failed 2 calls/],
      ['outside the window', g => { decisionOf({ gate: g }, 'dR').regression.observations.push({ taskId: 'T-X' }) }, /within K = 3 tasks/],
      ['rollback by hand', g => { g['activation'][1].trigger = 'manual' }, /rollback revision from/],
      ['next task still on it', g => { g['sessions']['G-D'][0].capabilityVersion = VA }, /next task runs on the previous version/],
    ])
  })

  it('H11 fails when the trial touched the project or a request lacks its arm', () => {
    gateFails('H11', [
      ['an output changed', g => { g['isolation'].after.files['out/summary.json'] = 'h9' }, /changed: out\/summary\.json/],
      ['a session added', g => { g['isolation'].after.sessions['G-new/session.jsonl'] = 'h' }, /changed: G-new/],
      ['a request without its arm', g => { delete g['ledger'].find((r: any) => r.trialId === 'tA').arm }, /carries trialId and an arm/],
      ['receipts and ledger disagree', g => { g['ledger'] = g['ledger'].filter((r: any, i: number) => !(r.trialId === 'tA' && i === 0)) }, /match the receipts/],
      ['a trial record in a real session', g => { g['ledger'].find((r: any) => r.trialId === 'tA').sessionId = 'G-A0' }, /belongs to a session of the project/],
    ])
  })

  it('H12 fails when the trial ignored the budget, finished, or something was adopted', () => {
    gateFails('H12', [
      ['budget not frozen', g => { g['trials'].tD[0].plan.budget = { maxRequests: 400 } }, /froze the configured budget/],
      ['no budget stop', g => { g['trials'].tD[2].reason = 'error' }, /stopped on the budget/],
      ['too many requests', g => { g['ledger'].push(...Array.from({ length: 2 }, () => ({ type: 'llm.request.end', trialId: 'tD', arm: 'baseline' }))) }, /at most the budget's requests \(got 5\)/],
      ['concluded pass', g => { g['trials'].tD.at(-1).status = 'pass' }, /unknown \/ budget-exhausted/],
      ['adopted', g => { g['activation'].push({ revision: 9, type: 'adopt', version: VD, decisionId: 'dD' }) }, /nothing was adopted|no revision names/],
    ])
  })

  it('H14 fails when the plugin waited for approval, was adopted, or asks again', () => {
    gateFails('H14', [
      ['adopted by the gate', g => { decisionOf({ gate: g }, 'dE1').outcome = 'adopted' }, /is rejected, not waiting for approval/],
      ['waits for approval again', g => { g['plugin'].status = 'awaiting-approval' }, /is rejected, not waiting for approval/],
      ['the reason is not given', g => { decisionOf({ gate: g }, 'dE1').detail = 'await-approval (review-preferred).' }, /no longer adopted/],
      ['version moved', g => { g['plugin'].versionAfter = VE }, /adopted version is unchanged/],
      ['an approval decision exists', g => { (g['decisions'] as unknown[]).push({ id: 'dX', outcome: 'adopted', reason: 'approved', trigger: 'approval', candidateId: 'cE', fromVersion: 'baseline', toVersion: VE }) }, /no approval decision/],
      ['the try was not asked', g => { g['approvals'] = [] }, /asked once and was allowed/],
      ['asks again in the next session', g => { g['approvals'].push({ sessionId: 'G-F', summary: 'Load plugin "greeter"', decision: 'allow' }) }, /without asking again/],
      ['tool offered in the next session', g => { g['requests'][0].tools = [PLUGIN_TOOL] }, /not offered greet_user/],
    ])
  })

  it('H15 fails when the gate started without history or the sets overlap', () => {
    gateFails('H15', [
      ['started anyway', g => { g['waiting'].line = { status: 'decided' } }, /gate process waited/],
      ['an attempt marker while waiting', g => { g['waiting'].files['cA.attempt'] = { size: 0 } }, /no receipt, attempt marker/],
      ['manual start accepted', g => { g['waiting'].trial = { status: 'trialing' } }, /refused to start/],
      ['no start in the same app once there is history', g => { g['retry'].sameApp = { status: 'proposed' } }, /started the gate in the same app/],
      ['overlap', g => { g['trials'].tA[0].plan.guard = [{ caseId: 'T-H1' }] }, /do not overlap/],
      ['origin not first', g => { g['trials'].tA[0].plan.selection.reverse() }, /starts with the task that proposed/],
      ['guard not the least similar', g => { g['trials'].tA[0].plan.guard = [{ caseId: 'T-H2' }] }, /least similar/],
    ])
  })

  it('H16 fails when the killed trial is rerun, left open, moves the version, or side files are wrong', () => {
    gateFails('H16', [
      ['not recorded', g => { g['recovered'].decision = undefined }, /recorded as interrupted/],
      ['rerun', g => { g['recovered'].trialsOfF = 2 }, /not tried again/],
      ['version moved', g => { g['recovered'].decision = { ...g['recovered'].decision, toVersion: VA } }, /adopted version stays/],
      ['lock left behind', g => { g['trialFiles']['tF.lock'] = { size: 5, text: '4242\n' } }, /lock file is gone/],
      ['attempt marker missing', g => { delete g['trialFiles']['cF.attempt'] }, /attempt marker stays/],
      ['next task broken', g => { g['tasks'].G.reason = { kind: 'error' } }, /next task ran on/],
      ['a log without its result', g => { g['logs'].C = [] }, /last line of trials/],
      ['the trial had ended', g => { g['trials'].tF.push({ type: 'trial.end' }) }, /killed before its trial ended/],
    ])
  })
})
