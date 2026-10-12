import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_VERSION,
  pluginApprovalInfo,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  type CapabilityDecision,
  type CandidateRecord,
  type PluginSpec,
  type SessionRecordInput,
  type TaskChecksRecord,
  type TaskSnapshotRecord,
  type TrialReceipt,
} from '@nexgent/kernel'
import {
  capabilitiesSchema,
  CAPABILITY_FILE_DEFS,
  JsonlSessionStore,
  projectSession,
  validateCapabilityFile,
  validateLedgerRecord,
  validateSessionRecord,
  type CapabilityFileKind,
} from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

const SHA = 'd'.repeat(64)
const VERSION = 'e'.repeat(64)
const TS = '2026-10-12T00:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const file = (path: string) => ({ path, sha256: SHA, bytes: 12 })
const cost = { usage: KNOWN_USAGE, requestCount: 2, estimatedUsd: 0.01 }
const verdict = { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1.05, decidedByReview: false } as const

const candidate: CandidateRecord = {
  formatVersion: 1,
  id: UUID(1),
  proposedAt: TS,
  sessionId: SESSION_ID,
  taskId: 'task-1',
  turn: 2,
  base: BASELINE_VERSION,
  version: VERSION,
  components: [{ kind: 'function-module', name: 'csv-tools', files: [file('functions.json'), file('index.mjs')] }],
  proofs: [{ kind: 'function-module', name: 'csv-tools', turn: 2, toolCallId: 'c1' }],
  requiresApproval: false,
  summary: 'Sum CSV columns',
}

const plan = {
  selection: [
    { caseId: 'task-1', sessionId: SESSION_ID, tree: SHA, checks: [{ id: 'k1', name: 'file-exists', path: 'out/summary.csv' }] },
    { caseId: 'task-2', sessionId: SESSION_ID, tree: SHA, checks: [{ id: 'k2', name: 'parses', path: 'out/summary.csv', format: 'csv' }] },
  ],
  guard: [{ caseId: 'task-0', sessionId: SESSION_ID, tree: SHA, checks: [{ id: 'k3', name: 'test-command', command: 'npm test', shell: 'bash' }] }],
  repeats: 2,
  costRatioCap: 1.2,
  reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' },
  budget: { maxRequests: 400, maxTokens: 8_000_000 },
} as const

const receipts: TrialReceipt[] = [
  { type: 'trial.start', format: 1, trialId: UUID(2), ts: TS, candidateId: UUID(1), candidateVersion: VERSION, baselineVersion: BASELINE_VERSION, plan },
  { type: 'trial.run', format: 1, trialId: UUID(2), ts: TS, set: 'selection', caseId: 'task-1', arm: 'candidate', repeat: 1, status: 'pass', checks: [{ name: 'file-exists', passed: true, target: 'k1' }], cost, durationMs: 1200 },
  { type: 'trial.run', format: 1, trialId: UUID(2), ts: TS, set: 'guard', caseId: 'task-0', arm: 'baseline', repeat: 2, status: 'unknown', reason: 'timeout', checks: [], cost: { usage: UNKNOWN_USAGE, requestCount: 1, estimatedUsd: 'unknown' }, durationMs: 0 },
  { type: 'trial.review', format: 1, trialId: UUID(2), ts: TS, set: 'selection', caseId: 'task-1', repeat: 1, preference: 'tie', reason: 'Both outputs match.', model: 'claude-sonnet-5-5', cost },
  { type: 'trial.end', format: 1, trialId: UUID(2), ts: TS, status: 'pass', verdict, cost: { candidate: cost, baseline: cost, review: cost } },
]

const decision: CapabilityDecision = {
  formatVersion: 1,
  id: UUID(3),
  outcome: 'adopted',
  reason: 'quality-up',
  trigger: 'gate',
  decidedAt: TS,
  candidateId: UUID(1),
  trialId: UUID(2),
  fromVersion: BASELINE_VERSION,
  toVersion: VERSION,
  revision: 1,
  verdict,
  cost: { candidate: cost, baseline: cost, review: cost },
  detail: 'Selection pass rate 1.00 vs 0.50; cost ratio 1.05.',
}

const snapshot: TaskSnapshotRecord = { formatVersion: 1, taskId: 'task-1', sessionId: SESSION_ID, takenAt: TS, tree: SHA, capabilityVersion: BASELINE_VERSION }
const checks: TaskChecksRecord = {
  formatVersion: 1,
  taskId: 'task-1',
  sessionId: SESSION_ID,
  checkedAt: TS,
  specs: [{ id: 'k1', name: 'file-exists', path: 'out/summary.csv' }],
  results: [{ name: 'file-exists', passed: true, target: 'k1' }],
}

/** One valid sample per file kind. */
const VALID: Record<CapabilityFileKind, unknown[]> = {
  manifest: [{ formatVersion: 1, components: [] }, { formatVersion: 1, components: candidate.components }],
  functionModule: [{
    formatVersion: 1,
    name: 'csv-tools',
    description: 'CSV helpers',
    entry: 'index.mjs',
    functions: [{ name: 'sum_column', description: 'Sum one column.', inputSchema: { type: 'object' }, effects: ['read'] }],
  }],
  plugin: [{ formatVersion: 1, name: 'git-notes', description: 'Notes', permissions: 'Reads .git', tools: ['git_note'] }],
  contextPolicy: [{ formatVersion: 1, name: 'concise', description: 'Short answers', instructions: 'Answer briefly.', compaction: { thresholdTokens: 120_000, keepRecentTurns: 2 } }],
  teamTemplate: [{ formatVersion: 1, name: 'review-pair', description: 'Writer and checker', members: [{ name: 'writer', task: 'Write' }, { name: 'checker', task: 'Check', preset: 'read-only-checker' }] }],
  activationRevision: [
    { format: 1, revision: 1, previous: null, from: 'baseline', version: VERSION, type: 'adopt', trigger: 'gate', decisionId: UUID(3), committedAt: TS },
    { format: 1, revision: 2, previous: SHA, from: VERSION, version: 'baseline', type: 'rollback', trigger: 'usage-regression', decisionId: UUID(4), committedAt: TS },
  ],
  candidate: [candidate],
  trialReceipt: receipts,
  decision: [
    decision,
    {
      formatVersion: 1,
      id: UUID(4),
      outcome: 'rolled-back',
      reason: 'usage-regression',
      trigger: 'usage-regression',
      decidedAt: TS,
      fromVersion: VERSION,
      toVersion: BASELINE_VERSION,
      revision: 2,
      regression: { observations: [{ taskId: 't', checksPassed: 0, checksTotal: 2, componentErrors: [true] }], baselinePassRate: 0.5, passRate: 0, consecutiveErrors: 1 },
      detail: 'Pass rate 0.00 below 0.50 over 3 tasks.',
    },
  ],
  snapshotTree: [{ formatVersion: 1, files: [{ path: 'out/summary.csv', sha256: SHA, bytes: 3 }, { path: 'run.sh', sha256: SHA, bytes: 9, executable: true }] }],
  taskSnapshot: [snapshot, { ...snapshot, tree: null, omitted: { reason: 'too-large', bytes: 300_000_000 } }],
  taskChecks: [checks],
}

/** Invalid samples per file kind. */
const INVALID: Record<CapabilityFileKind, unknown[]> = {
  manifest: [{ formatVersion: 1, components: [{ kind: 'skill', name: 'x', files: [file('../SKILL.md')] }] }, { formatVersion: 1, components: [], origin: 'gate' }],
  functionModule: [{ formatVersion: 1, name: 'csv-tools', description: 'x', functions: [{ name: 'sum', description: 'x', inputSchema: { type: 'object' }, effects: ['execute'] }] }],
  plugin: [{ formatVersion: 1, name: 'git-notes', description: 'Notes' }],
  // H13: a context policy cannot carry permission or gate settings.
  contextPolicy: [
    { formatVersion: 1, name: 'loose', description: 'x', approvals: { mode: 'never' } },
    { formatVersion: 1, name: 'loose', description: 'x', costCaps: { perTask: { maxTokens: 1 } } },
    { formatVersion: 1, name: 'loose', description: 'x', sandboxMode: 'full-access' },
    { formatVersion: 1, name: 'loose', description: 'x', capabilities: { selectionCases: 1 } },
    { formatVersion: 1, name: 'long', description: 'x', personaSuffix: 'x'.repeat(4097) },
  ],
  teamTemplate: [{ formatVersion: 1, name: 'pair', description: 'x', members: [{ name: 'lead', task: 'Lead' }] }],
  activationRevision: [{ format: 1, revision: 0, previous: null, from: 'baseline', version: VERSION, type: 'adopt', trigger: 'gate', decisionId: UUID(3), committedAt: TS }],
  candidate: [{ ...candidate, proofs: [] }, { ...candidate, version: 'draft' }],
  trialReceipt: [{ ...receipts[1], arm: 'both' }, { ...receipts[0], plan: { ...plan, selection: plan.selection.slice(0, 1) } }],
  decision: [{ ...decision, detail: 'x'.repeat(2001) }, { ...decision, outcome: 'adopt' }],
  snapshotTree: [{ formatVersion: 1, files: [{ path: 'a\\b', sha256: SHA, bytes: 1 }] }],
  taskSnapshot: [{ ...snapshot, capabilityVersion: undefined }],
  taskChecks: [{ ...checks, specs: [{ id: 'k1', name: 'lint', path: 'x' }] }],
}

describe('capability file schema', () => {
  it('covers every file kind with a $defs entry', () => {
    const defs = capabilitiesSchema.$defs as Record<string, unknown>
    for (const def of Object.values(CAPABILITY_FILE_DEFS)) expect(defs[def], def).toBeDefined()
    expect(Object.keys(VALID).sort()).toEqual(Object.keys(CAPABILITY_FILE_DEFS).sort())
  })

  it.each(Object.keys(CAPABILITY_FILE_DEFS) as CapabilityFileKind[])('accepts valid and rejects invalid %s files', (kind) => {
    for (const value of VALID[kind]) expect(validateCapabilityFile(kind, JSON.parse(JSON.stringify(value)) as unknown)).toEqual([])
    for (const value of INVALID[kind]) expect(validateCapabilityFile(kind, JSON.parse(JSON.stringify(value)) as unknown), JSON.stringify(value).slice(0, 80)).not.toEqual([])
  })

  it('a validated plugin.json round-trips into the approval dialog info', () => {
    const text = JSON.stringify(VALID.plugin[0])
    const spec = JSON.parse(text) as unknown
    expect(validateCapabilityFile('plugin', spec)).toEqual([])
    const info = pluginApprovalInfo(spec as PluginSpec)
    expect(JSON.parse(JSON.stringify(info))).toEqual({ name: 'git-notes', description: 'Notes', permissions: 'Reads .git', tools: ['git_note'] })
  })

  it('is published verbatim as schema/capabilities.v1.schema.json', async () => {
    const text = await readFile(new URL('../schema/capabilities.v1.schema.json', import.meta.url), 'utf8')
    expect(JSON.parse(text)).toEqual(capabilitiesSchema)
  })
})

describe('step-4 ledger fields', () => {
  it('accept the capability version, trial attribution, components used and member costs', () => {
    const outcome = {
      type: 'task.outcome',
      ts: TS,
      sessionId: SESSION_ID,
      capabilityVersion: VERSION,
      taskId: 'task-1',
      memberId: 'main',
      executionForm: 'direct',
      trialId: UUID(2),
      arm: 'candidate',
      status: 'completed',
      totalUsage: KNOWN_USAGE,
      requestCount: 3,
      toolCallCount: 2,
      turns: 1,
      checks: [{ name: 'parses', passed: true, target: 'k2' }],
      toolsUsed: ['cap_csv-tools_sum_column'],
      componentsUsed: [{ kind: 'function-module', name: 'csv-tools', version: 'draft', calls: 2, errors: 0 }],
      memberCosts: [{ memberId: 'child-1', name: 'checker', executionForm: 'delegated', usage: KNOWN_USAGE, requestCount: 1, toolCallCount: 0 }],
    }
    expect(validateLedgerRecord(outcome, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...outcome, capabilityVersion: 'v2' })).not.toEqual([])
    expect(validateLedgerRecord({ ...outcome, arm: 'both' })).not.toEqual([])
    const record = { type: 'capability.decision', ts: TS, decisionId: UUID(4), outcome: 'rolled-back', reason: 'load-failure', trigger: 'load-failure', fromVersion: VERSION, toVersion: 'baseline', revision: 2 }
    expect(validateLedgerRecord(record, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...record, outcome: 'rollback' })).not.toEqual([])
  })
})

describe('step-4 session records', () => {
  const records = (): SessionRecordInput[] => [
    { type: 'turn.start', turn: 2 },
    { type: 'user.message', turn: 2, content: 'Make it reusable', source: 'user' },
    { type: 'capability.draft', turn: 2, step: 1, toolCallId: 'c1', component: { kind: 'function-module', name: 'csv-tools' }, files: [file('functions.json'), file('index.mjs')], revision: 1 },
    { type: 'capability.try', turn: 2, step: 2, toolCallId: 'c2', component: { kind: 'function-module', name: 'csv-tools' }, revision: 1, tools: ['cap_csv-tools_sum_column'] },
    { type: 'capability.propose', turn: 2, step: 4, toolCallId: 'c4', candidateId: UUID(1), proofs: candidate.proofs },
    { type: 'turn.end', turn: 2, reason: { kind: 'completed' } },
  ]

  it('round-trip, record the starting version and project version switches', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await store.create(sessionInit(root, { capabilityVersion: VERSION }))
    for (const record of [...turnRecords(1), ...records()]) await store.append(SESSION_ID, record)
    await store.append(SESSION_ID, { type: 'capability.version', version: BASELINE_VERSION, previous: VERSION, reason: 'unavailable', detail: 'bundle missing' })
    await store.release(lock)

    const { records: read, truncation } = await store.readAll(SESSION_ID)
    expect(truncation).toBeUndefined()
    expect(read[0]).toMatchObject({ type: 'session.start', capabilityVersion: VERSION })
    for (const record of read) expect(validateSessionRecord(record), record.type).toEqual([])
    expect(projectSession(read.slice(0, 1)).metadata.capabilityVersion).toBe(VERSION)
    const state = await store.resume(SESSION_ID)
    expect(state).toEqual(projectSession(read))
    expect(state.metadata.capabilityVersion).toBe(BASELINE_VERSION)
    // The tool records leave the conversation alone.
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'Make it reusable' })
  })

  it('a step-3 session (no capability version) still reads', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await store.release(lock)
    const { records: read } = await store.readAll(SESSION_ID)
    expect(read[0]).not.toHaveProperty('capabilityVersion')
    const state = await store.resume(SESSION_ID)
    expect(state.metadata.capabilityVersion).toBeUndefined()
  })

  it('reject malformed records', () => {
    const base = { seq: 9, ts: TS, sessionId: SESSION_ID }
    const draft = { ...base, type: 'capability.draft', turn: 1, step: 1, toolCallId: 'c', component: { kind: 'skill', name: 'x' }, files: [file('SKILL.md')], revision: 1 }
    expect(validateSessionRecord(draft)).toEqual([])
    expect(validateSessionRecord({ ...draft, component: { kind: 'skill', name: 'X' } })).not.toEqual([])
    expect(validateSessionRecord({ ...draft, files: [file('/etc/passwd')] })).not.toEqual([])
    expect(validateSessionRecord({ ...draft, revision: 0 })).not.toEqual([])
    const version = { ...base, type: 'capability.version', version: 'baseline', previous: VERSION, reason: 'unavailable' }
    expect(validateSessionRecord(version)).toEqual([])
    expect(validateSessionRecord({ ...version, reason: 'gate' })).not.toEqual([])
    expect(validateSessionRecord({ ...base, type: 'capability.propose', turn: 1, step: 1, toolCallId: 'c', candidateId: 'x', proofs: [] })).not.toEqual([])
  })
})
