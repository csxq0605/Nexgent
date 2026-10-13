import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertPresetFile,
  BUILTIN_PRESET_NAMES,
  childSandboxMode,
  COLLABORATION_LIMITS,
  DELEGATE_TOOL,
  EXECUTION_FORMS,
  isSandboxWithin,
  IMPROVEMENT_DIAGNOSIS_TOOLS,
  MEMBER_DENIED_TOOLS,
  MEMBER_NAME_PATTERN,
  PRESET_FILE_SCHEMA,
  renderMemberPromptLine,
  RUN_CODE_TOOL,
  STEP3_MIGRATED_TOOLS,
  STEP3_TOOLS,
  STEP4_TOOLS,
  TEAMMATE_TOOLS,
  TURN_CANCEL_CAUSES,
  validateJsonSchema,
  WORKFLOW_TOOL,
  type ApprovalRequest,
  type ExecutionForm,
  type HostRecordInput,
  type LedgerAttribution,
  type MemberResultStatus,
  type SessionRecord,
  type SkillSource,
  type ToolContext,
  type ToolRecordInput,
  type TurnCancelCause,
} from '../../src/index.js'
import type { CreateAgentOptions, ResumeAgentOptions } from '../../src/agents.js'

describe('step-3 contracts: types', () => {
  it('fix the execution forms, the new cancel cause and the member result statuses', () => {
    expectTypeOf<ExecutionForm>().toEqualTypeOf<'direct' | 'delegated' | 'team' | 'workflow'>()
    expectTypeOf<LedgerAttribution['executionForm']>().toEqualTypeOf<ExecutionForm | undefined>()
    expectTypeOf<TurnCancelCause>().toEqualTypeOf<'user' | 'timeout' | 'shutdown' | 'cost-cap' | 'parent'>()
    expectTypeOf<MemberResultStatus>().toEqualTypeOf<'completed' | 'failed' | 'cancelled' | 'budget' | 'interrupted'>()
    expectTypeOf<SkillSource>().toEqualTypeOf<'builtin' | 'user' | 'project'>()
    expect(EXECUTION_FORMS).toEqual(['direct', 'delegated', 'team', 'workflow'])
    expect(TURN_CANCEL_CAUSES).toEqual(['user', 'timeout', 'shutdown', 'cost-cap', 'parent'])
  })

  it('limit which records hosts and tools may append (step-4 additions included)', () => {
    expectTypeOf<HostRecordInput['type']>().toEqualTypeOf<
      | 'material.added' | 'goal.set' | 'goal.update' | 'session.title'
      | 'subagent.end' | 'team.member' | 'team.task' | 'team.message' | 'workflow.phase' | 'workflow.end'
      | 'capability.version'
    >()
    expectTypeOf<ToolRecordInput['type']>().toEqualTypeOf<
      | 'deliverable.presented' | 'subagent.start' | 'subagent.end' | 'team.member' | 'team.task' | 'team.message'
      | 'workflow.start' | 'workflow.phase' | 'workflow.end'
      | 'capability.draft' | 'capability.try' | 'capability.propose'
    >()
  })

  it('carry the member on session.start, approvals and tool contexts', () => {
    expectTypeOf<Extract<SessionRecord, { type: 'session.start' }>['member']>().toEqualTypeOf<
      { readonly name: string; readonly executionForm: 'delegated' | 'team' | 'workflow'; readonly preset?: string } | undefined
    >()
    expectTypeOf<NonNullable<ApprovalRequest['member']>>().toHaveProperty('parentSessionId').toBeString()
    expectTypeOf<NonNullable<ToolContext['attribution']>['taskId']>().toBeString()
    expectTypeOf<NonNullable<CreateAgentOptions['child']>['parentSessionId']>().toBeString()
    expectTypeOf<NonNullable<ResumeAgentOptions['child']>['parentSessionId']>().toBeString()
  })
})

describe('step-3 contracts: helpers', () => {
  it('narrow the sandbox and reject a wider request', () => {
    expect(isSandboxWithin('read-only', 'workspace-write')).toBe(true)
    expect(isSandboxWithin('full-access', 'workspace-write')).toBe(false)
    expect(childSandboxMode('workspace-write')).toBe('workspace-write')
    expect(childSandboxMode('workspace-write', 'read-only', undefined)).toBe('read-only')
    expect(childSandboxMode('full-access', 'workspace-write', 'read-only')).toBe('read-only')
    expect(() => childSandboxMode('read-only', 'workspace-write')).toThrow(expect.objectContaining({ code: 'sandbox/denied' }))
  })

  it('render the member identity line exactly', () => {
    expect(renderMemberPromptLine({ name: 'analyst', executionForm: 'delegated' })).toBe('Member: analyst (delegated)')
    expect(renderMemberPromptLine({ name: 'b', executionForm: 'workflow' })).toBe('Member: b (workflow)')
  })

  it('validate preset files', () => {
    const preset = { formatVersion: 1, name: 'read-only-analyst', description: 'Reads and reports.', sandboxMode: 'read-only', tools: { deny: ['bash'] } }
    expect(() => assertPresetFile(preset)).not.toThrow()
    expect(validateJsonSchema(preset, PRESET_FILE_SCHEMA)).toBeUndefined()
    for (const bad of [
      { ...preset, name: 'Analyst' },
      { ...preset, formatVersion: 2 },
      { ...preset, description: ' ' },
      { ...preset, tools: { only: ['x'] } },
      { ...preset, sandboxMode: 'root' },
      { ...preset, maxSteps: 0 },
      { ...preset, extra: true },
    ]) {
      expect(() => assertPresetFile(bad)).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    }
    expect(BUILTIN_PRESET_NAMES).toEqual(['read-only-analyst', 'read-only-checker', 'general-executor'])
  })

  it('freeze tool names, member limits and depth-1 denials', () => {
    expect(STEP3_TOOLS.map(tool => tool.name)).toEqual([
      'delegate', 'spawn_teammate', 'send_message', 'wait_teammates', 'team_task_create', 'team_task_list', 'team_task_update', 'workflow', 'run_code',
    ])
    expect(STEP3_MIGRATED_TOOLS.map(tool => tool.name)).toEqual(['web_fetch', 'read_spreadsheet', 'write_spreadsheet'])
    expect(MEMBER_DENIED_TOOLS).toEqual([
      'delegate', 'spawn_teammate', 'wait_teammates', 'workflow', 'send_message', 'team_task_create', 'team_task_list', 'team_task_update',
      'capability_draft', 'capability_try', 'capability_propose',
      'improve_read_session', 'improve_read_ledger', 'improve_list_feedback', 'improve_report_diagnosis',
    ])
    // every collaboration tool except run_code, every step-4 capability tool and every step-5 improvement tool is hidden from members
    expect([...STEP3_TOOLS, ...STEP4_TOOLS, ...IMPROVEMENT_DIAGNOSIS_TOOLS].map(tool => tool.name).filter(name => name !== 'run_code').sort()).toEqual([...MEMBER_DENIED_TOOLS].sort())
    expect(STEP3_TOOLS.filter(tool => tool.selfSandboxed === true).map(tool => tool.name)).toEqual(['run_code'])
    for (const name of TEAMMATE_TOOLS) expect(MEMBER_DENIED_TOOLS).toContain(name)
    expect(COLLABORATION_LIMITS).toMatchObject({ maxConcurrentMembers: 4, maxMembersPerTask: 16 })
    expect(MEMBER_NAME_PATTERN.test('analyst-2')).toBe(true)
    expect(MEMBER_NAME_PATTERN.test('2analyst')).toBe(false)
    expect(validateJsonSchema({ name: 'analyst', task: 'sum orders', mode: 'fork', materialIds: ['m1'] }, DELEGATE_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ name: 'analyst', task: 'x', mode: 'clone' }, DELEGATE_TOOL.inputSchema)).toBeDefined()
    expect(validateJsonSchema({ graph: { nodes: [{ id: 'a', prompt: 'p', dependencies: [] }] } }, WORKFLOW_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ code: 'return 1', timeoutMs: 10 }, RUN_CODE_TOOL.inputSchema)).toBeDefined()
  })
})
