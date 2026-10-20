import { createHash } from 'node:crypto'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertCapabilityManifest,
  BASELINE_VERSION,
  CAPABILITY_COMPONENT_KINDS,
  CAPABILITY_DRAFT_TOOL,
  CAPABILITY_TRY_TOOL,
  CAPABILITY_VERSION_PATTERN,
  canonicalJson,
  canonicalManifestText,
  COMPONENT_DIRS,
  COMPONENT_ENTRY_FILES,
  COMPONENT_FILE_PATTERN,
  componentDir,
  functionToolName,
  INITIAL_ACTIVATION,
  isNextRevision,
  LEDGER_RECORD_TYPES,
  MEMBER_DENIED_TOOLS,
  normalizeManifest,
  pluginApprovalInfo,
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
  })

  it('adds the step-4 session, host, tool and ledger record types', () => {
    expectTypeOf<'capability.version'>().toMatchTypeOf<HostRecordType>()
    expectTypeOf<'capability.draft' | 'capability.try'>().toMatchTypeOf<ToolRecordType>()
    expectTypeOf<'capability.version' | 'capability.draft' | 'capability.try'>().toMatchTypeOf<SessionRecordType>()
    expectTypeOf<'capability.decision'>().toMatchTypeOf<LedgerRecordType>()
    expectTypeOf<CapabilityDecisionRecord['outcome']>().toEqualTypeOf<'rolled-back'>()
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
    expect(STEP4_TOOLS.map(t => t.name)).toEqual(['capability_draft', 'capability_try'])
    expect(STEP4_TOOLS.map(t => [t.effects, t.approval])).toEqual([[['write'], 'never'], [['read'], 'never']])
    for (const tool of STEP4_TOOLS) expect(MEMBER_DENIED_TOOLS).toContain(tool.name)
    expect(STEP3_TOOLS.some(t => STEP4_TOOLS.some(s => s.name === t.name))).toBe(false)
  })

  it('validate their inputs', () => {
    const kinds: CapabilityComponentKind[] = [...CAPABILITY_COMPONENT_KINDS]
    for (const kind of kinds) expect(validateJsonSchema({ kind, name: 'x' }, CAPABILITY_TRY_TOOL.inputSchema), kind).toBeUndefined()
    expect(validateJsonSchema({ kind: 'macro', name: 'x' }, CAPABILITY_TRY_TOOL.inputSchema)).toBeTypeOf('string')
    expect(validateJsonSchema({ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md', content: '# x' }], remove: ['old.md'] }, CAPABILITY_DRAFT_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ kind: 'skill', name: 'x', files: [{ path: 'SKILL.md' }] }, CAPABILITY_DRAFT_TOOL.inputSchema)).toBeTypeOf('string')
  })
})
