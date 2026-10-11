import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  billedInputTokens,
  PRESENT_TOOL,
  READ_DOCUMENT_TOOL,
  renderCompactionSummary,
  renderFeedbackPrompt,
  SKILL_NAME_PATTERN,
  STEP2_TOOLS,
  toPortablePath,
  UNKNOWN_USAGE,
  validateJsonSchema,
  type HostRecordInput,
  type SessionRecordType,
  type ToolRecordInput,
} from '../../src/index.js'

describe('step-2 contracts', () => {
  it('render the compaction summary and the feedback prompt deterministically', () => {
    expect(renderCompactionSummary('S')).toBe(
      '<conversation-summary>\nThe earlier part of this conversation was compacted. Summary:\n\nS\n</conversation-summary>',
    )
    expect(renderFeedbackPrompt({ id: 'f', deliverableId: 'd1', version: 1, rating: 3, comment: '用中文名' }))
      .toBe('Feedback on deliverable d1 version 1. Rating: 3/5.\n\n用中文名')
    expect(renderFeedbackPrompt({ id: 'f', deliverableId: 'd1', version: 2, comment: 'ok' }))
      .toBe('Feedback on deliverable d1 version 2.\n\nok')
  })

  it('count billed input only when every part is known', () => {
    expect(billedInputTokens({ ...UNKNOWN_USAGE, inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 5 })).toBe(115)
    expect(billedInputTokens({ ...UNKNOWN_USAGE, inputTokens: 10, cacheReadTokens: 100 })).toBeUndefined()
  })

  it('normalize paths to forward slashes', () => {
    expect(toPortablePath('report\\summary.csv')).toBe('report/summary.csv')
    expect(toPortablePath('a/b')).toBe('a/b')
  })

  it('freeze the step-2 tool names and accept valid inputs', () => {
    expect(STEP2_TOOLS.map(tool => tool.name)).toEqual(['present', 'load_skill', 'read_document'])
    expect(validateJsonSchema({ paths: ['report/summary.csv'], summary: 'done' }, PRESENT_TOOL.inputSchema)).toBeUndefined()
    expect(validateJsonSchema({ paths: ['a'] }, PRESENT_TOOL.inputSchema)).toBeDefined()
    expect(validateJsonSchema({ path: 'regions.xlsx', sheet: 'Sheet1', maxRows: 10 }, READ_DOCUMENT_TOOL.inputSchema)).toBeUndefined()
    for (const tool of STEP2_TOOLS) expect(tool.effects).toEqual(['read'])
    expect(SKILL_NAME_PATTERN.test('office-read')).toBe(true)
    expect(SKILL_NAME_PATTERN.test('Office')).toBe(false)
  })

  it('limit which records hosts and tools may append', () => {
    expectTypeOf<HostRecordInput['type']>().toEqualTypeOf<'material.added' | 'goal.set' | 'goal.update' | 'session.title'>()
    expectTypeOf<ToolRecordInput['type']>().toEqualTypeOf<'deliverable.presented'>()
    expectTypeOf<'compaction'>().toExtend<SessionRecordType>()
  })
})
