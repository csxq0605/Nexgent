import { describe, expect, it } from 'vitest'
import { findInstanceLiterals, literalTokens, type InstanceLiteralSource, type ProjectTaskMessage } from '@nexgent/kernel'

/**
 * The instance-literal check the handbook applies to learned entries: values
 * of one task (its feedback and results) must not be written into a reusable
 * practice. Every rule here is about values, counts and projects, never
 * about a kind of task.
 */
const SHA = (c: string) => c.repeat(64)

describe('literal tokens', () => {
  it('reads decimals, integers of 3+ digits, dates and year-months', () => {
    expect(literalTokens('East=4/2384.13 and North=5, 2026-10 report, due 2026-10-05, 120 rows, 42 cols')).toEqual([
      { value: '2384.13', kind: 'decimal' },
      { value: '2026-10', kind: 'date' },
      { value: '2026-10-05', kind: 'date' },
      { value: '120', kind: 'integer' },
    ])
    expect(literalTokens('total 2,384.13 USD; 1,000,000 units').map(t => t.value)).toEqual(['2384.13', '1000000'])
    expect(literalTokens('2384.13USD and 2026-10-05T08:00').map(t => t.value)).toEqual(['2384.13', '2026-10-05'])
    expect(literalTokens('again 2384.13, 2384.13.').map(t => t.value)).toEqual(['2384.13'])
  })

  it('ignores identifiers, versions and short integers', () => {
    expect(literalTokens('sha256 v1.2.3 x86_64 utf-8 h264 col_100 q3 id42 1.2.3 10 99')).toEqual([])
    expect(literalTokens('build.2024 file2024.csv 2024_report')).toEqual([])
  })
})

describe('findInstanceLiterals (ADR 0013 decision 2)', () => {
  const feedback: InstanceLiteralSource = { kind: 'feedback', ref: 'feedback:f1', text: 'East should be 4 with total 2384.13 for 2026-10; threshold 500 as always.' }
  const deliverable: InstanceLiteralSource = { kind: 'deliverable', ref: 'deliverable:d1/v2/report.md', text: '| region | orders | total |\n| East | 4 | 2384.13 |\n| North | 5 | 1999.50 |\nPeriod 2026-10' }
  const history: ProjectTaskMessage[] = [
    { taskId: 't1', text: 'Make the monthly report; flag orders above 500.' },
    { taskId: 't2', text: 'Same report for the next month, still flag above 500.' },
    { taskId: 't3', text: 'Report for 2026-10 please.' },
  ]

  it('counts the task values: 2384.13 and 2026-10', () => {
    const hits = findInstanceLiterals([{ path: 'context-policy.md', text: 'Before finishing, self-check East=4/2384.13 and North=5 for 2026-10.' }], [feedback, deliverable], history)
    expect(hits).toEqual([
      { value: '2384.13', kind: 'decimal', path: 'context-policy.md', source: 'feedback:f1' },
      { value: '2026-10', kind: 'date', path: 'context-policy.md', source: 'feedback:f1' },
    ])
  })

  it('a deliverable value counts too, reported with its first source', () => {
    expect(findInstanceLiterals([{ path: 'SKILL.md', text: 'North total must read 1999.50.' }], [feedback, deliverable], history)).toEqual([
      { value: '1999.50', kind: 'decimal', path: 'SKILL.md', source: 'deliverable:d1/v2/report.md' },
    ])
  })

  it('a project constant in the user messages of 2 tasks does not count; in 1 task it does', () => {
    const component = [{ path: 'SKILL.md', text: 'Flag every order above 500.' }]
    expect(findInstanceLiterals(component, [feedback], history)).toEqual([])
    expect(findInstanceLiterals(component, [feedback], history.slice(0, 1))).toEqual([{ value: '500', kind: 'integer', path: 'SKILL.md', source: 'feedback:f1' }])
    // Two messages of the same task are one task.
    expect(findInstanceLiterals(component, [feedback], [history[0]!, { ...history[1]!, taskId: 't1' }])).toHaveLength(1)
  })

  it('column names, conventions and values not in any source do not count', () => {
    const texts = [
      { path: 'SKILL.md', text: 'Keep the columns region, orders, total; name the file report-<yyyy-mm>.md; round to 2 decimals.' },
      { path: 'tools/check.js', text: 'const MAX_ROWS = 10000; const ratio = 0.95' },
    ]
    expect(findInstanceLiterals(texts, [feedback, deliverable], history)).toEqual([])
  })

  it('values are compared as written, one hit per value and path', () => {
    expect(findInstanceLiterals([{ path: 'a', text: '2384.1 and 2384.130' }], [feedback], [])).toEqual([])
    const hits = findInstanceLiterals([{ path: 'a', text: '2384.13 then 2384.13' }, { path: 'b', text: '2,384.13' }], [feedback], [])
    expect(hits.map(hit => `${hit.path}:${hit.value}`)).toEqual(['a:2384.13', 'b:2384.13'])
  })

  it('with projectId, a constant counts only within its own project', () => {
    const p1 = SHA('1')
    const p2 = SHA('2')
    const component = [{ path: 'diagnosis.paragraphs[2]', text: 'Check the threshold 500.' }]
    const messages: ProjectTaskMessage[] = [
      { taskId: 't1', text: 'flag above 500', projectId: p2 },
      { taskId: 't2', text: 'flag above 500', projectId: p2 },
    ]
    expect(findInstanceLiterals(component, [{ ...feedback, projectId: p2 }], messages)).toEqual([])
    expect(findInstanceLiterals(component, [{ ...feedback, projectId: p1 }], messages)).toEqual([{ value: '500', kind: 'integer', path: 'diagnosis.paragraphs[2]', source: 'feedback:f1' }])
  })
})
