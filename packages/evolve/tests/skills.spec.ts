/**
 * ADR 0025 layer 2 in the background learner: the trigger (two similar
 * tasks with a high outcome from the user, the checks or the external
 * review), curation of induced candidates, and the scripted flow — two
 * successful similar tasks induce a trial skill with one `induce` request;
 * a third similar task spends nothing because the skill already covers it;
 * a dissimilar success induces nothing.
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillLibrary } from '@nexgent/capabilities'
import type { LearnedSkill, LedgerRecord, LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage, SessionRecord } from '@nexgent/kernel'
import {
  curateInduction,
  EMPTY_INDUCTION_STATE,
  inductionGroupFor,
  inductionStatePath,
  LearningHost,
  learningPaths,
  parseInduction,
  readInductionState,
  type LearnedTask,
  type ProposedSkill,
} from '../src/index.js'
import { home, project } from './helpers.js'

const USAGE: LLMUsage = { inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

function learned(input: Partial<LearnedTask> & Pick<LearnedTask, 'task'>): LearnedTask {
  return {
    taskId: randomUUID(), sessionId: randomUUID(), fromTurn: 1, throughTurn: 1, finishedAt: '2026-10-19T00:00:00.000Z', status: 'done', outcome: 'success',
    keywords: [], approach: '', ops: {}, rejected: {}, added: [], externalScore: 1, ...input,
  }
}

describe('induction trigger', () => {
  const merge1 = learned({ task: 'Merge the monthly spreadsheet exports into one sheet', finishedAt: '2026-10-19T01:00:00.000Z' })
  const merge2 = learned({ task: 'Merge the spreadsheet exports of both stores into one sheet', finishedAt: '2026-10-19T02:00:00.000Z' })
  const poem = learned({ task: 'Write a short poem about autumn leaves' })

  it('groups the task with similar successful ones, newest first', () => {
    expect(inductionGroupFor(merge2.taskId, [merge1, poem, merge2], EMPTY_INDUCTION_STATE)?.tasks.map(task => task.taskId)).toEqual([merge2.taskId, merge1.taskId])
  })

  it('needs two successes by outcome evidence, and an unused newest task', () => {
    const weak = { ...merge1, externalScore: 0.5 }
    expect(inductionGroupFor(merge2.taskId, [weak, merge2], EMPTY_INDUCTION_STATE)).toBeUndefined()
    const noEvidence: LearnedTask = { ...merge1 }
    delete (noEvidence as { externalScore?: number }).externalScore
    expect(inductionGroupFor(merge2.taskId, [noEvidence, merge2], EMPTY_INDUCTION_STATE)).toBeUndefined()
    expect(inductionGroupFor(merge2.taskId, [{ ...merge1, reverted: true }, merge2], EMPTY_INDUCTION_STATE)).toBeUndefined()
    expect(inductionGroupFor(poem.taskId, [merge1, merge2, poem], EMPTY_INDUCTION_STATE)).toBeUndefined()
    expect(inductionGroupFor(merge2.taskId, [merge1, merge2], { ...EMPTY_INDUCTION_STATE, used: { [merge2.taskId]: 'x' } })).toBeUndefined()
  })
})

describe('induction curation', () => {
  const good: ProposedSkill = {
    name: 'merge-spreadsheet-exports',
    description: 'Merge several spreadsheet exports into one table, aligning their columns.',
    whenToUse: 'Combining exports that share most columns.',
    body: '1. List the columns of every <input file>.\n2. Map renamed columns before merging.\n3. Check the row count of the result.',
  }
  const existing: LearnedSkill = {
    id: 'clean-csv-rows@v1', name: 'clean-csv-rows', version: 1, description: 'Clean the rows of a CSV file before analysis.', status: 'trial', sources: [], createdAt: 'x', updatedAt: 'x',
  }
  const ctx = {
    skills: [existing],
    reservedNames: ['spreadsheets'],
    sources: [{ kind: 'feedback' as const, ref: 'task', text: 'Merge sales_q3.xlsx and sales_q4.xlsx; the total should be 18342.50.' }],
    requests: ['Merge sales_q3.xlsx and sales_q4.xlsx; the total should be 18342.50.', 'Please keep the region column first in the merged table.'],
    taskTexts: ['Merge sales_q3.xlsx and sales_q4.xlsx; the total should be 18342.50.'],
  }

  it('keeps a general candidate and refuses what fails a rule', () => {
    const result = curateInduction([
      good,
      { ...good, name: 'spreadsheets' },
      { ...good, name: 'Bad Name' },
      { ...good, name: 'with-value', body: `${good.body}\n4. The total must be 18342.50.` },
      { ...good, name: 'with-file', body: `${good.body}\n4. Open sales_q3.xlsx first.` },
      { ...good, name: 'copied', body: `${good.body}\n4. Keep the region column first in the merged table.` },
      { ...good, name: 'clean-csv-rows', description: 'Something else entirely about formatting dates.' },
      { name: 'clean-csv-rows-two', description: existing.description, body: 'Drop empty rows.' },
    ], ctx)
    expect(result.accepted.map(skill => skill.name)).toEqual(['merge-spreadsheet-exports'])
    expect(result.rejected.map(entry => [entry.skill.name, entry.reason])).toEqual([
      ['spreadsheets', 'name-taken'],
      ['Bad Name', 'invalid-name'],
      ['with-value', 'instance-literal'],
      ['with-file', 'project-name'],
      ['copied', 'copied-request'],
      ['clean-csv-rows', 'name-taken'],
      ['clean-csv-rows-two', 'duplicate'],
    ])
    const replacing = curateInduction([{ ...good, name: 'clean-csv-rows', description: 'Clean the rows of a CSV file before any analysis.', replaces: existing.id }], ctx)
    expect(replacing.accepted).toHaveLength(1)
  })

  it('parses the reply', () => {
    expect(parseInduction(`ok\n${JSON.stringify({ skills: [{ ...good, when_to_use: good.whenToUse }, { name: 1 }] })}`)?.skills[0]).toMatchObject({ name: good.name, whenToUse: good.whenToUse })
    expect(parseInduction('none')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// the background learner
// ---------------------------------------------------------------------------

function sessionRecords(sessionId: string, text: string): SessionRecord[] {
  let seq = 0
  const ts = '2026-10-19T08:00:00.000Z'
  const base = () => ({ seq: (seq += 1), ts, sessionId })
  return [
    { ...base(), type: 'session.start', version: 1, projectRoot: '/p', model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' },
    { ...base(), type: 'turn.start', turn: 1 },
    { ...base(), type: 'user.message', turn: 1, content: text, source: 'user' },
    { ...base(), type: 'assistant.message', turn: 1, step: 1, requestId: randomUUID(), content: 'done', usage: USAGE, finishReason: 'stop' },
    { ...base(), type: 'turn.end', turn: 1, reason: { kind: 'completed' } },
    { ...base(), type: 'turn.start', turn: 2 },
    { ...base(), type: 'feedback', turn: 2, feedback: { id: randomUUID(), deliverableId: randomUUID(), version: 1, rating: 5, comment: 'good' } },
    { ...base(), type: 'user.message', turn: 2, content: 'good', source: 'feedback' },
    { ...base(), type: 'assistant.message', turn: 2, step: 1, requestId: randomUUID(), content: 'thanks', usage: USAGE, finishReason: 'stop' },
    { ...base(), type: 'turn.end', turn: 2, reason: { kind: 'completed' } },
  ] as SessionRecord[]
}

function scripted(replies: string[], ledger: LedgerRecord[]) {
  const requests: Array<{ request: LLMRequest; options: unknown }> = []
  const llm: LLMProvider = {
    info: { id: 'scripted', endpoint: 'http://scripted', defaultModel: 'claude-sonnet-5-5' },
    async *complete(request, options): AsyncIterable<LLMStreamEvent> {
      requests.push({ request, options })
      const text = replies.shift()
      if (text === undefined) throw new Error('no scripted reply left')
      ledger.push({ type: 'llm.request.end', ts: new Date().toISOString(), requestId: request.requestId, provider: 'scripted', endpoint: 'http://scripted', model: request.model, status: 'ok', usage: USAGE, latencyMs: 1, ...(options as object) } as LedgerRecord)
      yield { type: 'text.delta', text }
      yield { type: 'usage', usage: USAGE }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
  return { llm, requests }
}

describe('induction in the background learner', () => {
  it('induces a trial skill from two similar successful tasks, then spends nothing for a covered one', async () => {
    const layout = await project(undefined)
    await writeFile(layout.configFile, `${JSON.stringify({ version: 1, learning: {} })}\n`)
    await writeFile(join(home(), 'config.json'), `${JSON.stringify({ version: 1, learning: { noticeAcknowledgedAt: '2026-10-19T00:00:00.000Z' } })}\n`)
    const ledger: LedgerRecord[] = []
    const replies: string[] = []
    const { llm, requests } = scripted(replies, ledger)
    const sessions = new Map<string, SessionRecord[]>()
    const host = new LearningHost({
      layout,
      home: home(),
      llm: () => llm,
      ledger: () => ({ writeFailures: 0, async append(record: never) { ledger.push(record); return record }, async *read() { yield* ledger } }),
      sessions: () => ({ readAll: async (id: string) => ({ records: sessions.get(id) ?? [] }) }),
      skillNames: async () => ['spreadsheets'],
    })
    const run = async (text: string): Promise<void> => {
      const sessionId = randomUUID()
      sessions.set(sessionId, sessionRecords(sessionId, text))
      await host.stop()
      await host.noteTurnEnd({ taskId: randomUUID(), sessionId, turn: 2, reason: { kind: 'completed' } })
      await host.start()
      await host.idle()
    }
    const noOps = JSON.stringify({ ops: [] })
    const skill = {
      name: 'merge-spreadsheet-exports',
      description: 'Merge several spreadsheet exports into one table, aligning their columns.',
      when_to_use: 'The task combines spreadsheet exports that share most columns.',
      body: '1. List the columns of every <input file>.\n2. Map renamed columns before merging.\n3. Check the row count of the result.',
    }
    replies.push(noOps)
    await run('Merge the monthly spreadsheet exports into one sheet')
    expect(requests.map(r => (r.options as { learningPhase?: string }).learningPhase)).toEqual(['reflect'])
    replies.push(noOps, JSON.stringify({ skills: [skill] }))
    await run('Merge the spreadsheet exports of both stores into one sheet')
    expect(requests.map(r => (r.options as { learningPhase?: string }).learningPhase)).toEqual(['reflect', 'reflect', 'induce'])
    expect(requests[2]!.request.messages[1]!.content).toContain('spreadsheets')
    const library = SkillLibrary.of(home())
    expect((await library.skills()).map(s => [s.id, s.status, s.sources.length])).toEqual([['merge-spreadsheet-exports@v1', 'trial', 2]])
    const state = await readInductionState(inductionStatePath(learningPaths(layout.dataDir).directory))
    expect(state.runs.at(-1)).toMatchObject({ added: ['merge-spreadsheet-exports@v1'] })
    // A third similar success: the skill already covers it, so no induction request.
    replies.push(noOps)
    await run('Merge the spreadsheet exports from the three stores into one sheet')
    expect(requests).toHaveLength(4)
    expect((await readInductionState(inductionStatePath(learningPaths(layout.dataDir).directory))).runs.at(-1)?.detail).toMatch(/already matches/)
    // A dissimilar success induces nothing.
    replies.push(noOps)
    await run('Write a short poem about autumn leaves')
    expect(requests).toHaveLength(5)
  })
})
