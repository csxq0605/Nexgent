import { createHash } from 'node:crypto'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertCapabilitiesConfig,
  assertCapabilityManifest,
  BASELINE_VERSION,
  CAPABILITY_COMPONENT_KINDS,
  CAPABILITY_DRAFT_TOOL,
  CAPABILITY_PROPOSE_TOOL,
  CAPABILITY_TRY_TOOL,
  CAPABILITY_VERSION_PATTERN,
  CANDIDATE_STATUSES,
  canonicalJson,
  canonicalManifestText,
  COMPONENT_DIRS,
  COMPONENT_ENTRY_FILES,
  COMPONENT_FILE_PATTERN,
  componentDir,
  decideTrial,
  decideUsageRollback,
  DEFAULT_CAPABILITIES_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  functionToolName,
  GUARDED_PROJECT_CONFIG_FIELDS,
  INITIAL_ACTIVATION,
  isNextRevision,
  LEDGER_RECORD_TYPES,
  MEMBER_DENIED_TOOLS,
  normalizeManifest,
  pluginApprovalInfo,
  resolveCapabilitiesConfig,
  STEP3_TOOLS,
  STEP4_TOOLS,
  validateJsonSchema,
  type ActivationRevision,
  type CapabilityComponentKind,
  type CapabilityDecisionRecord,
  type CapabilityManifest,
  type HostRecordType,
  type LedgerRecordType,
  type PluginApprovalInfo,
  type PluginSpec,
  type SessionRecordType,
  type ToolRecordType,
  type TrialTally,
} from '../../src/index.js'

const SHA = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const file = (path: string, bytes = 10) => ({ path, sha256: SHA, bytes })

const MANIFEST: CapabilityManifest = {
  formatVersion: 1,
  components: [
    { kind: 'skill', name: 'csv-summary', files: [file('notes.md'), file('SKILL.md')] },
    { kind: 'function-module', name: 'csv-tools', files: [file('index.mjs'), file('functions.json')] },
  ],
}

describe('step-4 contract vocabulary', () => {
  it('fixes the component kinds, their directories and entry files', () => {
    expect([...CAPABILITY_COMPONENT_KINDS]).toEqual(['function-module', 'plugin', 'skill', 'context-policy', 'preset', 'team-template', 'architecture'])
    for (const kind of CAPABILITY_COMPONENT_KINDS) {
      expect(COMPONENT_DIRS[kind], kind).toMatch(/^[a-z]+$/)
      expect(COMPONENT_ENTRY_FILES[kind], kind).toMatch(/\.(json|md)$/)
    }
    expect(componentDir('skill', 'csv-summary')).toBe('skills/csv-summary')
    expect([...CANDIDATE_STATUSES]).toEqual(['drafted', 'proposed', 'trialing', 'awaiting-approval', 'adopted', 'rejected', 'rolled-back'])
  })

  it('adds the step-4 session, host, tool and ledger record types', () => {
    expectTypeOf<'capability.version'>().toMatchTypeOf<HostRecordType>()
    expectTypeOf<'capability.draft' | 'capability.try' | 'capability.propose'>().toMatchTypeOf<ToolRecordType>()
    expectTypeOf<'capability.version' | 'capability.draft' | 'capability.try' | 'capability.propose'>().toMatchTypeOf<SessionRecordType>()
    expectTypeOf<'capability.decision'>().toMatchTypeOf<LedgerRecordType>()
    expectTypeOf<CapabilityDecisionRecord['outcome']>().toEqualTypeOf<'adopted' | 'rejected' | 'awaiting-approval' | 'rolled-back'>()
    expect(LEDGER_RECORD_TYPES).toContain('capability.decision')
  })

  it('accepts baseline or a lowercase SHA-256 as a version', () => {
    expect(CAPABILITY_VERSION_PATTERN.test(BASELINE_VERSION)).toBe(true)
    expect(CAPABILITY_VERSION_PATTERN.test(SHA)).toBe(true)
    expect(CAPABILITY_VERSION_PATTERN.test(SHA.toUpperCase())).toBe(false)
    expect(CAPABILITY_VERSION_PATTERN.test('draft')).toBe(false)
  })

  it('accepts only relative component paths', () => {
    for (const ok of ['SKILL.md', 'lib/util.mjs', 'a.b/c']) expect(COMPONENT_FILE_PATTERN.test(ok), ok).toBe(true)
    for (const bad of ['', '/abs', './x', '../x', 'a/../b', 'a//b', 'a\\b', 'C:x', 'dir/', '.hidden']) expect(COMPONENT_FILE_PATTERN.test(bad), bad).toBe(false)
  })
})

describe('manifest canonical form and version hash', () => {
  it('canonical JSON sorts keys, drops undefined and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }], e: undefined } as never)).toBe('{"a":[2,{"c":"x","d":null}],"b":1}')
  })

  it('normalizes component and file order, so equal content has one version', () => {
    const normal = normalizeManifest(MANIFEST)
    expect(normal.components.map(c => `${c.kind}/${c.name}`)).toEqual(['function-module/csv-tools', 'skill/csv-summary'])
    expect(normal.components[1]!.files.map(f => f.path)).toEqual(['SKILL.md', 'notes.md'])
    const reordered: CapabilityManifest = { formatVersion: 1, components: [...MANIFEST.components].reverse() }
    expect(canonicalManifestText(reordered)).toBe(canonicalManifestText(MANIFEST))
    const version = createHash('sha256').update(canonicalManifestText(MANIFEST), 'utf8').digest('hex')
    expect(CAPABILITY_VERSION_PATTERN.test(version)).toBe(true)
    const changed = { ...MANIFEST, components: [{ ...MANIFEST.components[0]!, files: [file('SKILL.md', 11), file('notes.md')] }, MANIFEST.components[1]!] }
    expect(createHash('sha256').update(canonicalManifestText(changed), 'utf8').digest('hex')).not.toBe(version)
  })

  it('checks manifest structure', () => {
    expect(() => assertCapabilityManifest(MANIFEST)).not.toThrow()
    expect(() => assertCapabilityManifest({ formatVersion: 1, components: [] })).not.toThrow()
    const bad = (value: unknown, message: RegExp) => expect(() => assertCapabilityManifest(value)).toThrow(message)
    bad({ formatVersion: 2, components: [] }, /formatVersion/)
    bad({ formatVersion: 1, components: [], origin: 'x' }, /unknown field origin/)
    bad({ formatVersion: 1, components: [MANIFEST.components[0], MANIFEST.components[0]] }, /duplicate component skill\/csv-summary/)
    bad({ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [file('notes.md')] }] }, /lacks its entry file SKILL.md/)
    bad({ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [file('SKILL.md'), file('../escape')] }] }, /relative component path/)
    bad({ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [file('SKILL.md'), file('SKILL.md')] }] }, /duplicated/)
    bad({ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', sha256: 'ABC', bytes: 1 }] }] }, /sha256/)
    bad({ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [file('SKILL.md', 2 ** 21)] }] }, /bytes/)
    bad({ formatVersion: 1, components: [{ kind: 'macro', name: 'x', files: [file('SKILL.md')] }] }, /component kind/)
    bad(
      {
        formatVersion: 1,
        components: [
          { kind: 'context-policy', name: 'a', files: [file('policy.json')] },
          { kind: 'context-policy', name: 'b', files: [file('policy.json')] },
        ],
      },
      /at most one context-policy/,
    )
  })

  it('names function tools cap_<module>_<function>', () => {
    expect(functionToolName('csv-tools', 'sum_column')).toBe('cap_csv-tools_sum_column')
    expect(() => functionToolName('csv_tools', 'sum')).toThrow(/module name/)
    expect(() => functionToolName('csv-tools', '1sum')).toThrow(/function name/)
    expect(() => functionToolName('a'.repeat(40), 'b'.repeat(30))).toThrow(/longer than 64/)
  })
})

describe('activation chain', () => {
  const first: ActivationRevision = {
    format: 1,
    revision: 1,
    previous: null,
    from: 'baseline',
    version: SHA,
    type: 'adopt',
    trigger: 'gate',
    decisionId: '00000000-0000-4000-8000-000000000001',
    committedAt: '2026-10-12T00:00:00.000Z',
  }

  it('accepts only the next revision from the current tail', () => {
    expect(isNextRevision(INITIAL_ACTIVATION, first)).toBe(true)
    expect(isNextRevision(INITIAL_ACTIVATION, { ...first, revision: 2 })).toBe(false)
    expect(isNextRevision(INITIAL_ACTIVATION, { ...first, previous: SHA })).toBe(false)
    expect(isNextRevision(INITIAL_ACTIVATION, { ...first, from: SHA_B })).toBe(false)
    expect(isNextRevision(INITIAL_ACTIVATION, { ...first, version: 'baseline' })).toBe(false)
    const tail = { revision: 1, digest: SHA_B, version: SHA }
    const rollback: ActivationRevision = { ...first, revision: 2, previous: SHA_B, from: SHA, version: 'baseline', type: 'rollback', trigger: 'usage-regression' }
    expect(isNextRevision(tail, rollback)).toBe(true)
    expect(isNextRevision(tail, { ...rollback, previous: null })).toBe(false)
  })
})

describe('the adoption rule', () => {
  const arm = (passed: number, failed: number, unknown = 0) => ({ passed, failed, unknown })
  const tally = (overrides: Partial<TrialTally> = {}): TrialTally => ({
    selection: { candidate: arm(4, 0), baseline: arm(2, 2) },
    guard: { candidate: arm(2, 0), baseline: arm(2, 0) },
    review: { candidate: 0, baseline: 0, tie: 0 },
    tokens: { candidate: 1000, baseline: 1000 },
    budgetExhausted: false,
    requiresApproval: false,
    ...overrides,
  })
  const tie = { selection: { candidate: arm(2, 2), baseline: arm(2, 2) } }

  it('adopts higher quality whatever it costs up to the approval ratio, then waits for the user (ADR 0007)', () => {
    expect(decideTrial(tally(), 1.2)).toEqual({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1, costBasis: 'tokens', decidedByReview: false })
    expect(decideTrial(tally({ tokens: { candidate: 1500, baseline: 1000 } }), 1.2)).toMatchObject({ outcome: 'adopt', reason: 'quality-up', costRatio: 1.5 })
    expect(decideTrial(tally({ tokens: { candidate: 2000, baseline: 1000 } }), 1.2)).toMatchObject({ outcome: 'adopt', reason: 'quality-up', costRatio: 2 })
    expect(decideTrial(tally({ tokens: { candidate: 2100, baseline: 1000 } }), 1.2)).toMatchObject({ outcome: 'await-approval', reason: 'quality-up' })
    expect(decideTrial(tally({ tokens: { candidate: 1300, baseline: 1000 } }), 1.2, 1.25)).toMatchObject({ outcome: 'await-approval', reason: 'quality-up' })
  })

  it('compares estimated dollars (cache included) when both arms have them, tokens otherwise', () => {
    // The step-5 real run: tokens 1.555×, dollars 1.16×.
    const run = tally({ tokens: { candidate: 8334, baseline: 5359 }, usd: { candidate: 0.47, baseline: 0.41 } })
    expect(decideTrial(run, 1.2)).toMatchObject({ outcome: 'adopt', reason: 'quality-up', costBasis: 'usd' })
    expect(decideTrial(run, 1.2).costRatio).toBeCloseTo(0.47 / 0.41)
    expect(decideTrial(tally({ tokens: { candidate: 1000, baseline: 1000 }, usd: { candidate: 2.5, baseline: 1 } }), 1.2)).toMatchObject({ outcome: 'await-approval', costBasis: 'usd', costRatio: 2.5 })
    expect(decideTrial(tally({ tokens: { candidate: 1500, baseline: 1000 }, usd: { candidate: 'unknown', baseline: 1 } }), 1.2)).toMatchObject({ costBasis: 'tokens', costRatio: 1.5 })
    expect(decideTrial(tally({ tokens: { candidate: 1500, baseline: 1000 }, usd: { candidate: 0, baseline: 0 } }), 1.2)).toMatchObject({ costBasis: 'tokens', costRatio: 1.5 })
    expect(decideTrial(tally({ ...tie, tokens: { candidate: 900, baseline: 1000 }, usd: { candidate: 1.1, baseline: 1 } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'no-improvement', costBasis: 'usd' })
  })

  it('rejects unknown runs, an exhausted budget, guard regressions and lower quality', () => {
    expect(decideTrial(tally({ budgetExhausted: true }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'budget-exhausted' })
    expect(decideTrial(tally({ guard: { candidate: arm(2, 0, 1), baseline: arm(2, 0) } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'unknown-runs' })
    expect(decideTrial(tally({ tokens: { candidate: 'unknown', baseline: 1000 } }), 1.2)).toMatchObject({ reason: 'unknown-runs', costRatio: 'unknown' })
    expect(decideTrial(tally({ tokens: { candidate: 10, baseline: 0 } }), 1.2)).toMatchObject({ reason: 'unknown-runs' })
    expect(decideTrial(tally({ guard: { candidate: arm(1, 1), baseline: arm(2, 0) } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'guard-regressed' })
    expect(decideTrial(tally({ selection: { candidate: arm(1, 3), baseline: arm(2, 2) } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'quality-down' })
  })

  it('on a tie, adopts lower cost, else lets the reviewer decide within the cap', () => {
    expect(decideTrial(tally({ ...tie, tokens: { candidate: 900, baseline: 1000 } }), 1.2)).toMatchObject({ outcome: 'adopt', reason: 'cost-down', decidedByReview: false })
    expect(decideTrial(tally({ ...tie, review: { candidate: 3, baseline: 1, tie: 0 } }), 1.2)).toMatchObject({ outcome: 'adopt', reason: 'review-preferred', decidedByReview: true })
    expect(decideTrial(tally({ ...tie, review: { candidate: 3, baseline: 1, tie: 0 }, tokens: { candidate: 1300, baseline: 1000 } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(decideTrial(tally({ ...tie, review: { candidate: 1, baseline: 1, tie: 2 } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })

  it('turns an adopting verdict into await-approval for a plugin candidate', () => {
    expect(decideTrial(tally({ requiresApproval: true }), 1.2)).toMatchObject({ outcome: 'await-approval', reason: 'quality-up' })
    expect(decideTrial(tally({ requiresApproval: true, budgetExhausted: true }), 1.2)).toMatchObject({ outcome: 'reject' })
  })
})

describe('the usage-regression rule', () => {
  const rule = { windowTasks: 3, consecutiveErrors: 3 }
  const obs = (passed: number, total: number, errors: boolean[] = []) => ({ taskId: `t${passed}${total}${errors.length}`, checksPassed: passed, checksTotal: total, componentErrors: errors })

  it('rolls back on consecutive component errors across tasks', () => {
    const result = decideUsageRollback([obs(1, 1, [false, true]), obs(1, 1, [true, true])], 0.5, rule)
    expect(result).toMatchObject({ reason: 'component-errors', evidence: { consecutiveErrors: 3 } })
    expect(decideUsageRollback([obs(1, 1, [true, true, false, true])], 0.5, rule)).toBeUndefined()
  })

  it('rolls back when the first window falls below the baseline pass rate, and waits until it is full', () => {
    expect(decideUsageRollback([obs(0, 2), obs(0, 2)], 0.5, rule)).toBeUndefined()
    const result = decideUsageRollback([obs(0, 2), obs(1, 2), obs(1, 2)], 0.5, rule)
    expect(result?.reason).toBe('usage-regression')
    expect(result?.evidence.passRate).toBeCloseTo(1 / 3)
    expect(decideUsageRollback([obs(1, 2), obs(1, 2), obs(1, 2)], 0.5, rule)).toBeUndefined()
    // Tasks after the window are not watched.
    expect(decideUsageRollback([obs(2, 2), obs(2, 2), obs(2, 2), obs(0, 9)], 0.5, rule)).toBeUndefined()
    // No checks at all is not a regression.
    expect(decideUsageRollback([obs(0, 0), obs(0, 0), obs(0, 0)], 0.5, rule)).toBeUndefined()
  })
})

describe('the capabilities config section', () => {
  it('defaults to the confirmed decisions and is guarded', () => {
    expect(DEFAULT_PROJECT_CONFIG.capabilities).toEqual(DEFAULT_CAPABILITIES_CONFIG)
    expect(DEFAULT_CAPABILITIES_CONFIG).toMatchObject({
      autoTrial: false,
      selectionCases: 2,
      guardCases: 1,
      repeats: 2,
      costRatioCap: 1.2,
      reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' },
      rollback: { windowTasks: 3, consecutiveErrors: 3 },
    })
    expect(GUARDED_PROJECT_CONFIG_FIELDS).toContain('capabilities')
    expect(resolveCapabilitiesConfig({ selectionCases: 4, reviewer: { model: 'claude-opus-5-5' } })).toMatchObject({
      selectionCases: 4,
      guardCases: 1,
      reviewer: { model: 'claude-opus-5-5', thinking: 'on' },
    })
  })

  it('accepts more replay cases, never fewer', () => {
    expect(() => assertCapabilitiesConfig({ selectionCases: 5, guardCases: 2, repeats: 1, costRatioCap: 1, rollback: { windowTasks: 5 } })).not.toThrow()
    const bad = (value: unknown, field: string) => expect(() => assertCapabilitiesConfig(value)).toThrow(expect.objectContaining({ code: 'config/invalid', details: { field } }))
    bad({ selectionCases: 1 }, 'capabilities.selectionCases')
    bad({ guardCases: 0 }, 'capabilities.guardCases')
    bad({ repeats: 6 }, 'capabilities.repeats')
    bad({ costRatioCap: 0.9 }, 'capabilities.costRatioCap')
    bad({ reviewer: { thinking: 'maybe' } }, 'capabilities.reviewer.thinking')
    bad({ rollback: { consecutiveErrors: 0 } }, 'capabilities.rollback.consecutiveErrors')
    bad({ trialBudget: { maxUsd: 3 } }, 'capabilities.trialBudget.maxUsd')
    bad({ sandboxMode: 'full-access' }, 'capabilities.sandboxMode')
    expect(() => assertCapabilitiesConfig([])).toThrow(/capabilities must be an object/)
  })
})

describe('plugin approval info', () => {
  it('carries the plugin.json description, permissions and tools verbatim', () => {
    const spec: PluginSpec = { formatVersion: 1, name: 'git-notes', description: 'Adds git notes', entry: 'main.mjs', permissions: 'Reads .git; runs git notes', tools: ['git_note'] }
    expect(pluginApprovalInfo(spec)).toEqual({ name: 'git-notes', description: 'Adds git notes', permissions: 'Reads .git; runs git notes', tools: ['git_note'] })
    expect(pluginApprovalInfo({ formatVersion: 1, name: 'x', description: 'd', permissions: 'p' }).tools).toEqual([])
    expectTypeOf(pluginApprovalInfo).returns.toEqualTypeOf<PluginApprovalInfo>()
  })
})

describe('step-4 tools', () => {
  it('fix names, effects and approval, and members cannot see them', () => {
    expect(STEP4_TOOLS.map(t => t.name)).toEqual(['capability_draft', 'capability_try', 'capability_propose'])
    expect(STEP4_TOOLS.map(t => [t.effects, t.approval])).toEqual([[['write'], 'never'], [['read'], 'never'], [['read'], 'never']])
    for (const tool of STEP4_TOOLS) expect(MEMBER_DENIED_TOOLS).toContain(tool.name)
    expect(STEP3_TOOLS.some(t => STEP4_TOOLS.some(s => s.name === t.name))).toBe(false)
  })

  it('validate their inputs', () => {
    const kinds: CapabilityComponentKind[] = [...CAPABILITY_COMPONENT_KINDS]
    for (const kind of kinds) expect(validateJsonSchema({ kind, name: 'x' }, CAPABILITY_TRY_TOOL.inputSchema), kind).toBeUndefined()
    expect(validateJsonSchema({ kind: 'macro', name: 'x' }, CAPABILITY_TRY_TOOL.inputSchema)).toBeTypeOf('string')
    expect(validateJsonSchema({ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '# x' }], remove: ['old.md'] }, CAPABILITY_DRAFT_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md' }] }, CAPABILITY_DRAFT_TOOL.inputSchema)).toBeTypeOf('string')
    expect(validateJsonSchema({ components: [{ kind: 'skill', name: 'x' }], summary: 'Sums CSV columns' }, CAPABILITY_PROPOSE_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ components: [{ kind: 'skill' }] }, CAPABILITY_PROPOSE_TOOL.inputSchema)).toBeTypeOf('string')
    // The kernel's tool-input validator has no minItems; the implementation also refuses an empty list.
    expect((CAPABILITY_PROPOSE_TOOL.inputSchema.properties as Record<string, { minItems?: number }>)['components']?.minItems).toBe(1)
  })
})
