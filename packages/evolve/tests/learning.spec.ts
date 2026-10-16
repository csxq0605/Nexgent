/**
 * Rework E1 (ADR 0018 layer 1): the handbook logs and retrieval, curation,
 * the dollar learning budget and the scripted full flow of the background
 * learner — task → evaluation → reflection → entry on trial → the next
 * similar task retrieves it → marked helpful → enabled; a misleading entry
 * retired; the loop stops with the app; nothing is spent without the notice
 * or with the budget exhausted; old job records stay readable and the
 * counting path no longer starts jobs.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  foldHandbook,
  type HandbookEntry,
  type LedgerRecord,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type LLMUsage,
  type SessionRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import {
  createJob,
  curateReflection,
  detectLanguage,
  HandbookLog,
  ImprovementHost,
  improvementsDir,
  LearningHost,
  learningBudgetStatus,
  longestSharedRun,
  parseReflection,
  readLearningQueue,
  retrieveEntries,
  statusOps,
  tokenize,
  visibleEntries,
  type CurationContext,
  type HandbookOpInput,
} from '../src/index.js'
import { feedback, home, project } from './helpers.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PROJECT = 'a'.repeat(64)
const USAGE: LLMUsage = { inputTokens: 5_000, outputTokens: 1_000, totalTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

function entry(input: Partial<HandbookEntry> & Pick<HandbookEntry, 'text'>): HandbookEntry {
  return {
    id: randomUUID(), keywords: [], scope: 'user', status: 'trial', helpful: 0, harmful: 0, sources: [], supersedes: [],
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', ...input,
  }
}

/** A root task session's records: one turn per message, optional tool calls, handbook ids and ratings. */
function sessionRecords(sessionId: string, turns: readonly { readonly text: string; readonly answer?: string; readonly handbook?: readonly string[]; readonly rating?: 1 | 2 | 3 | 4 | 5; readonly toolError?: string }[]): SessionRecord[] {
  let seq = 0
  const ts = '2026-10-16T08:00:00.000Z'
  const base = () => ({ seq: (seq += 1), ts, sessionId })
  const records: unknown[] = [{ ...base(), type: 'session.start', version: 1, projectRoot: '/p', model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' }]
  turns.forEach((turn, index) => {
    const n = index + 1
    records.push({ ...base(), type: 'turn.start', turn: n, ...(turn.handbook === undefined ? {} : { handbook: turn.handbook }) })
    if (turn.rating !== undefined) records.push({ ...base(), type: 'feedback', turn: n, feedback: { id: randomUUID(), deliverableId: randomUUID(), version: 1, rating: turn.rating, comment: turn.text } })
    records.push({ ...base(), type: 'user.message', turn: n, content: turn.text, source: turn.rating === undefined ? 'user' : 'feedback' })
    records.push({ ...base(), type: 'assistant.message', turn: n, step: 1, requestId: randomUUID(), content: '', toolCalls: [{ id: `c${n}`, name: 'run_command', arguments: '{"command":"npm test"}' }], usage: USAGE, finishReason: 'tool_use' })
    records.push({ ...base(), type: 'tool.result', turn: n, step: 1, toolCallId: `c${n}`, name: 'run_command', content: turn.toolError ?? 'ok', isError: turn.toolError !== undefined, durationMs: 5 })
    records.push({ ...base(), type: 'assistant.message', turn: n, step: 2, requestId: randomUUID(), content: turn.answer ?? 'done', usage: USAGE, finishReason: 'stop' })
    records.push({ ...base(), type: 'turn.end', turn: n, reason: { kind: 'completed' } })
  })
  return records as SessionRecord[]
}

/** A model that answers reflections from a script and books each request in the ledger as learning spend. */
function scriptedLearner(replies: Array<string | ((request: LLMRequest) => string) | 'hang'>, ledger: LedgerRecord[]) {
  const requests: Array<{ request: LLMRequest; options: unknown }> = []
  const llm: LLMProvider = {
    info: { id: 'scripted', endpoint: 'http://scripted', defaultModel: 'claude-sonnet-5-5' },
    async *complete(request, options): AsyncIterable<LLMStreamEvent> {
      requests.push({ request, options })
      const reply = replies.shift()
      if (reply === undefined) throw new Error('no scripted reply left')
      if (reply === 'hang') {
        await new Promise<void>(resolve => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
        yield { type: 'done', finishReason: 'aborted' }
        return
      }
      const text = typeof reply === 'function' ? reply(request) : reply
      ledger.push({ type: 'llm.request.end', ts: new Date().toISOString(), requestId: request.requestId, provider: 'scripted', endpoint: 'http://scripted', model: request.model, status: 'ok', usage: USAGE, latencyMs: 1, ...(options as object) } as LedgerRecord)
      yield { type: 'text.delta', text }
      yield { type: 'usage', usage: USAGE }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
  return { llm, requests }
}

function fakeLedger(records: LedgerRecord[]) {
  return {
    writeFailures: 0,
    async append(record: never) { records.push(record); return record },
    async *read() { yield* records },
  }
}

async function acknowledge(): Promise<void> {
  await writeFile(join(home(), 'config.json'), `${JSON.stringify({ version: 1, learning: { noticeAcknowledgedAt: '2026-10-16T00:00:00.000Z' } })}\n`)
}

async function learningProject(learning: Record<string, unknown> = {}): Promise<WorkspaceLayout> {
  const layout = await project(undefined)
  await writeFile(layout.configFile, `${JSON.stringify({ version: 1, learning })}\n`)
  return layout
}

interface Setup {
  readonly layout: WorkspaceLayout
  readonly host: LearningHost
  readonly ledger: LedgerRecord[]
  readonly sessions: Map<string, SessionRecord[]>
  readonly requests: Array<{ request: LLMRequest; options: unknown }>
  readonly replies: Array<string | ((request: LLMRequest) => string) | 'hang'>
}

async function setup(options: { readonly learning?: Record<string, unknown>; readonly acknowledged?: boolean; readonly ledger?: LedgerRecord[] } = {}): Promise<Setup> {
  const layout = await learningProject(options.learning)
  if (options.acknowledged !== false) await acknowledge()
  const ledger = options.ledger ?? []
  const replies: Setup['replies'] = []
  const { llm, requests } = scriptedLearner(replies, ledger)
  const sessions = new Map<string, SessionRecord[]>()
  const host = new LearningHost({
    layout,
    home: home(),
    llm: () => llm,
    ledger: () => fakeLedger(ledger),
    sessions: () => ({ readAll: async (id: string) => ({ records: sessions.get(id) ?? [] }) }),
  })
  return { layout, host, ledger, sessions, requests, replies }
}

const ops = (...list: unknown[]) => JSON.stringify({ ops: list })

async function runTask(s: Setup, turns: Parameters<typeof sessionRecords>[1], options: { readonly reply?: Setup['replies'][number]; readonly taskId?: string } = {}): Promise<{ taskId: string; sessionId: string }> {
  const sessionId = randomUUID()
  const taskId = options.taskId ?? randomUUID()
  s.sessions.set(sessionId, sessionRecords(sessionId, turns))
  if (options.reply !== undefined) s.replies.push(options.reply)
  // All turns land in the queue before the loop runs, so one reflection covers them.
  await s.host.stop()
  for (let turn = 1; turn <= turns.length; turn += 1) await s.host.noteTurnEnd({ taskId, sessionId, turn, reason: { kind: 'completed' }, checks: [{ name: 'file-exists', passed: true }] })
  await s.host.start()
  await s.host.idle()
  return { taskId, sessionId }
}

// ---------------------------------------------------------------------------
// pure parts
// ---------------------------------------------------------------------------

describe('lexical helpers', () => {
  it('tokenizes English words and Chinese bigrams, detects the language', () => {
    expect(tokenize('Merge the CSV files and dedupe rows')).toEqual(['merge', 'csv', 'files', 'dedupe', 'rows'])
    expect(tokenize('合并表格数据')).toEqual(['合并', '并表', '表格', '格数', '数据'])
    expect(detectLanguage('请把这些文件合并成一个表')).toBe('zh')
    expect(detectLanguage('Please merge these files')).toBe('en')
    expect(longestSharedRun('Always  run the tests first', 'please always run the TESTS first today')).toBe('always run the tests first'.length)
  })

  it('parses a reflection reply around prose and fences, counting malformed operations', () => {
    const parsed = parseReflection(`Here you go:\n\`\`\`json\n${ops({ op: 'add', text: 'x', keywords: ['a'] }, { op: 'upvote', entryId: 'e1' }, { op: 'nope' })}\n\`\`\``)
    expect(parsed).toEqual({ ops: [{ op: 'add', text: 'x', keywords: ['a'], scope: 'user', supersedes: [] }, { op: 'upvote', entryId: 'e1' }], malformed: 1 })
    expect(parseReflection('no json here')).toBeUndefined()
  })
})

describe('handbook log', () => {
  it('appends contiguous seq under the lock, folds, and cuts a torn tail', async () => {
    const dir = join((await project()).dataDir, 'handbook')
    const log = new HandbookLog(dir)
    const id = randomUUID()
    await log.append(() => [{ op: 'add', entryId: id, actor: 'reflection', text: 'Read the failing test output before editing code.', keywords: ['tests'], scope: 'user' }])
    await Promise.all([1, 2, 3].map(n => log.append(() => [{ op: 'upvote', entryId: id, actor: 'execution', source: { taskId: `t${n}` } }])))
    await appendFile(log.file, '{"formatVersion":1,"seq":5,"at":"2026-')
    const read = await log.read()
    expect(read.map(op => op.seq)).toEqual([1, 2, 3, 4])
    expect(read[0]!.op).toBe('add')
    await log.append(() => [{ op: 'status', entryId: id, actor: 'host', status: 'active' }])
    const text = await readFile(log.file, 'utf8')
    expect(text.trim().split('\n').map(line => JSON.parse(line).seq)).toEqual([1, 2, 3, 4, 5])
    expect(await log.entries()).toEqual([expect.objectContaining({ id, helpful: 3, status: 'active' })])
  })
})

describe('retrieval', () => {
  it('ranks relevant retrievable entries, at most five, and applies the project and sharing rules', () => {
    const tests = entry({ text: 'Run the project test suite after editing code and read failures before retrying.', keywords: ['tests', 'code'] })
    const csv = entry({ text: 'When merging CSV files, check that the header rows match before concatenating.', keywords: ['csv', 'merge'] })
    const retired = entry({ text: 'Merge CSV files by appending them blindly.', keywords: ['csv'], status: 'retired' })
    const mine = entry({ text: 'In this project spreadsheets live under data/.', keywords: ['csv', 'spreadsheet'], scope: 'project', projectId: PROJECT })
    const other = entry({ text: 'Another project keeps CSV files in raw/.', keywords: ['csv'], scope: 'project', projectId: 'b'.repeat(64) })
    const visible = visibleEntries([tests, csv, retired], [mine, other], { projectId: PROJECT, useShared: true })
    expect(visible.map(e => e.id).sort()).toEqual([tests.id, csv.id, mine.id].sort())
    expect(retrieveEntries('merge two csv exports into one table', visible).map(hit => hit.entry.id)).toEqual([csv.id, mine.id])
    expect(visibleEntries([tests, csv], [mine], { projectId: PROJECT, useShared: false }).map(e => e.id)).toEqual([mine.id])
    const many = Array.from({ length: 9 }, (_, i) => entry({ text: `csv practice number ${i}`, keywords: ['csv'] }))
    expect(retrieveEntries('csv', many)).toHaveLength(5)
  })
})

describe('curation', () => {
  const given = entry({ text: 'Check the header rows of every input file before merging tables.', keywords: ['merge'] })
  const base = (over: Partial<CurationContext> = {}): CurationContext => ({
    projectId: PROJECT,
    source: { projectId: PROJECT, taskId: 't1', sessionId: 's1' },
    outcome: 'success',
    contribute: true,
    votable: new Set([given.id]),
    user: [given],
    project: [],
    sources: [{ kind: 'feedback', ref: 'message:task', text: 'Merge sales_q3.csv and sales_q4.csv; the total should be 18342.50 for 2026-09.', projectId: PROJECT }],
    projectMessages: [],
    requests: ['Merge sales_q3.csv and sales_q4.csv; the total should be 18342.50 for 2026-09.'],
    votedFromTask: new Set(),
    ...over,
  })

  it('writes general entries and rejects task values, copied requests, duplicates and bad votes', () => {
    const result = curateReflection([
      { op: 'add', text: 'After merging tables, recompute the grand total from the inputs and compare it with the merged result.', keywords: ['Merge', 'Totals', 'merge'], scope: 'user', supersedes: [] },
      { op: 'add', text: 'The merged total must be 18342.50.', keywords: [], scope: 'user', supersedes: [] },
      { op: 'add', text: 'Note: merge sales_q3.csv and sales_q4.csv; the total should be checked.', keywords: [], scope: 'user', supersedes: [] },
      { op: 'add', text: 'Check the header rows of every input file before merging the tables.', keywords: [], scope: 'user', supersedes: [] },
      { op: 'upvote', entryId: given.id, reason: 'x'.repeat(300) },
      { op: 'upvote', entryId: given.id },
      { op: 'downvote', entryId: randomUUID() },
    ], base())
    expect(result.user.map(op => op.op)).toEqual(['add', 'upvote'])
    expect(result.user[0]).toMatchObject({ actor: 'reflection', scope: 'user', keywords: ['merge', 'totals'], source: { taskId: 't1' } })
    expect((result.user[1] as { reason: string }).reason).toHaveLength(200)
    expect(result.rejected.map(r => r.reason)).toEqual(['instance-literal', 'copies-request', 'duplicate', 'already-voted', 'unknown-entry'])
  })

  it('keeps entries in the project when it does not contribute, and votes need a known outcome and a given entry', () => {
    const elsewhere = entry({ text: 'Unrelated practice about writing reports.', keywords: ['report'] })
    const result = curateReflection([
      { op: 'add', text: 'Keep a short log of the commands that changed files.', keywords: ['commands'], scope: 'user', supersedes: [given.id] },
      { op: 'upvote', entryId: given.id },
      { op: 'upvote', entryId: elsewhere.id },
    ], base({ contribute: false, outcome: 'unknown', user: [given, elsewhere] }))
    expect(result.user).toEqual([])
    expect(result.project).toEqual([expect.objectContaining({ op: 'add', scope: 'project', projectId: PROJECT })])
    // A project entry cannot retire a user entry.
    expect(result.project[0]).not.toHaveProperty('supersedes')
    expect(result.rejected.map(r => r.reason)).toEqual(['outcome-unknown', 'not-given'])
  })

  it('never lets a task vote for an entry learned from itself', () => {
    const own = entry({ text: 'Compare row counts before and after a merge.', keywords: ['merge'], sources: [{ taskId: 't1' }] })
    const result = curateReflection([{ op: 'upvote', entryId: own.id }], base({ votable: new Set([own.id]), user: [own] }))
    expect(result.user).toEqual([])
    expect(result.rejected.map(r => r.reason)).toEqual(['own-entry'])
  })

  it('derives status changes from the counts', () => {
    const id = randomUUID()
    const add: HandbookOpInput = { op: 'add', entryId: id, actor: 'reflection', text: 'x', keywords: [], scope: 'user' }
    const current = [{ ...add, formatVersion: 1, seq: 1, at: 'x' }, { op: 'upvote', entryId: id, actor: 'execution', formatVersion: 1, seq: 2, at: 'x' }] as never
    expect(statusOps(current, [{ op: 'upvote', entryId: id, actor: 'reflection' }], 'zh')).toEqual([{ op: 'status', entryId: id, actor: 'host', status: 'active', reason: '有用 2 票、有害 0 票，转为启用' }])
    expect(statusOps(current, [{ op: 'downvote', entryId: id, actor: 'reflection' }], 'en')).toEqual([])
  })
})

describe('learning budget', () => {
  it('sums the learning records of the window in dollars; unknown prices count at the highest price', async () => {
    const now = new Date('2026-10-16T12:00:00.000Z')
    const records = [
      { type: 'llm.request.end', ts: '2026-10-16T10:00:00.000Z', model: 'claude-sonnet-5-5', usage: USAGE, learningPhase: 'reflect' },
      { type: 'llm.request.end', ts: '2026-10-16T10:00:00.000Z', model: 'mystery', usage: USAGE, learningPhase: 'self-eval' },
      { type: 'llm.request.end', ts: '2026-10-16T10:00:00.000Z', model: 'claude-sonnet-5-5', usage: USAGE },
      { type: 'llm.request.end', ts: '2026-08-01T10:00:00.000Z', model: 'claude-sonnet-5-5', usage: USAGE, learningPhase: 'reflect' },
    ] as LedgerRecord[]
    const status = await learningBudgetStatus(fakeLedger(records), { maxUsd: 1, windowDays: 30 }, now)
    // sonnet: 5000×2 + 1000×10 = 0.02 USD; fallback (opus prices): 5000×4 + 1000×20 = 0.04 USD.
    expect(status.usedUsd).toBeCloseTo(0.06, 10)
    expect(status).toMatchObject({ requests: 2, estimated: 1, maxUsd: 1 })
    expect(status.remainingUsd).toBeCloseTo(0.94, 10)
  })
})

// ---------------------------------------------------------------------------
// the background learner
// ---------------------------------------------------------------------------

describe('layer-1 learning, scripted end to end', () => {
  it('task → evaluation → reflection → trial entry → retrieved by the next similar task → marked helpful → enabled', async () => {
    const s = await setup()
    const text = 'Before merging spreadsheet exports, compare their header rows and stop if the columns differ.'
    const first = await runTask(s, [{ text: 'Merge the two monthly spreadsheet exports into one sheet' }, { text: 'good', rating: 5 }], { reply: ops({ op: 'add', text, keywords: ['spreadsheet', 'merge', 'exports'], scope: 'user', reason: 'Mismatched headers were the risk.' }) })
    expect(s.requests).toHaveLength(1)
    expect(s.requests[0]!.options).toMatchObject({ purpose: 'auxiliary', taskId: first.taskId, learningPhase: 'reflect' })
    expect(s.requests[0]!.options).not.toHaveProperty('sessionId')
    const user = s.requests[0]!.request.messages[1]!.content as string
    expect(user).toContain('Outcome: success')
    expect(user).toContain('user rating 5/5')
    expect(s.requests[0]!.request.messages[0]!.content).toContain('English')
    let entries = await s.host.logs.user.entries()
    expect(entries).toEqual([expect.objectContaining({ text, status: 'trial', scope: 'user', sources: [{ projectId: expect.any(String), taskId: first.taskId, sessionId: first.sessionId }] })])
    const id = entries[0]!.id
    expect((await readLearningQueue(s.layout.dataDir)).history).toEqual([expect.objectContaining({ taskId: first.taskId, status: 'done', outcome: 'success', throughTurn: 2, added: [id] })])

    // The next similar task retrieves it, was given it, and the executing model marks it helpful.
    const next = 'Merge last quarter spreadsheet exports'
    expect((await s.host.retrieve(next)).map(hit => hit.entry.id)).toEqual([id])
    const second = { taskId: randomUUID(), sessionId: randomUUID() }
    expect(await s.host.mark({ ...second, entryId: id, verdict: 'helpful' })).toMatchObject({ recorded: true, entry: { helpful: 1, status: 'trial' } })
    expect(await s.host.mark({ ...second, entryId: id, verdict: 'helpful' })).toEqual({ recorded: false, reason: 'already-voted' })
    expect(await s.host.mark({ ...first, entryId: id, verdict: 'helpful' })).toEqual({ recorded: false, reason: 'own-entry' })
    // Its reflection votes too: the same task cannot vote twice.
    await runTask(s, [{ text: next, handbook: [id] }, { text: 'thanks', rating: 4 }], { taskId: second.taskId, reply: ops({ op: 'upvote', entryId: id }) })
    expect((await readLearningQueue(s.layout.dataDir)).history.at(-1)).toMatchObject({ rejected: { 'already-voted': 1 } })
    // A third similar task: the reflection's helpful vote enables it.
    await runTask(s, [{ text: 'Merge the spreadsheet exports from both stores', handbook: [id] }, { text: 'great', rating: 5 }], { reply: ops({ op: 'upvote', entryId: id, reason: 'Comparing headers caught a renamed column.' }) })
    entries = await s.host.logs.user.entries()
    expect(entries).toEqual([expect.objectContaining({ id, helpful: 2, harmful: 0, status: 'active' })])
    const log = await s.host.logs.user.read()
    expect(log.at(-1)).toMatchObject({ op: 'status', status: 'active', actor: 'host' })
    expect(log.map(op => op.seq)).toEqual(log.map((_, i) => i + 1))
    // The contrast and the evaluation reach the prompt; the entries given are listed as votable.
    expect(s.requests.at(-1)!.request.messages[1]!.content).toContain(`id ${id}`)
    expect((await s.host.status())).toMatchObject({ mayLearn: true, pending: 0, entries: { active: 1, trial: 0 } })
  })

  it('retires a misleading entry after harmful votes, and it is no longer retrieved', async () => {
    const s = await setup()
    const id = randomUUID()
    await s.host.logs.user.append(() => [{ op: 'add', entryId: id, actor: 'reflection', text: 'For report tasks, skip reading the source files and write from the title alone.', keywords: ['report'], scope: 'user' }])
    for (const answer of ['first report', 'second report']) {
      await runTask(s, [{ text: 'Write a report from the meeting notes', handbook: [id], answer }, { text: 'this is wrong', rating: 1 }], { reply: ops({ op: 'downvote', entryId: id, reason: 'Skipping the sources produced wrong content.' }) })
    }
    expect(await s.host.logs.user.entries()).toEqual([expect.objectContaining({ id, harmful: 2, status: 'retired' })])
    expect(await s.host.retrieve('write a report from notes')).toEqual([])
  })

  it('writes in the task language and keeps a project-only convention in the project log', async () => {
    const s = await setup({ learning: { contribute: false } })
    await runTask(s, [{ text: '把这几个月的销售明细合并成一张汇总表' }, { text: '很好', rating: 5 }], {
      reply: request => {
        expect(request.messages[0]!.content).toContain('简体中文')
        return ops({ op: 'add', text: '合并多份明细前先核对各文件的列名是否一致，不一致时先统一再合并。', keywords: ['合并', '明细'], scope: 'user' })
      },
    })
    expect(await s.host.logs.user.entries()).toEqual([])
    expect(await s.host.logs.project.entries()).toEqual([expect.objectContaining({ scope: 'project', projectId: expect.any(String), status: 'trial' })])
  })

  it('spends nothing before the notice is acknowledged, or once the budget is exhausted', async () => {
    const quiet = await setup({ acknowledged: false })
    await runTask(quiet, [{ text: 'Tidy the README' }])
    expect(quiet.requests).toEqual([])
    expect((await readLearningQueue(quiet.layout.dataDir)).items).toEqual([expect.objectContaining({ status: 'pending' })])

    const spent = await setup({ learning: { budget: { maxUsd: 0.05 } } })
    spent.ledger.push({ type: 'llm.request.end', ts: new Date().toISOString(), model: 'claude-sonnet-5-5', usage: USAGE, learningPhase: 'self-eval' } as LedgerRecord)
    await runTask(spent, [{ text: 'Tidy the README' }], { reply: ops() })
    expect(spent.requests).toEqual([])
    expect((await readLearningQueue(spent.layout.dataDir)).items).toEqual([expect.objectContaining({ status: 'waiting-budget', detail: expect.stringContaining('budget') })])
  })

  it('does not learn when learning is off, or from turns the user cancelled', async () => {
    const off = await setup({ learning: { enabled: false } })
    await runTask(off, [{ text: 'Tidy the README' }])
    expect(await readLearningQueue(off.layout.dataDir)).toEqual({ formatVersion: 1, items: [], history: [] })
    const on = await setup()
    await on.host.noteTurnEnd({ taskId: randomUUID(), sessionId: randomUUID(), turn: 1, reason: { kind: 'cancelled', cause: 'user' } })
    expect((await readLearningQueue(on.layout.dataDir)).items).toEqual([])
  })

  it('stops with the app: the running request is aborted, the item stays queued and runs on the next start', async () => {
    const s = await setup()
    const sessionId = randomUUID()
    const taskId = randomUUID()
    s.sessions.set(sessionId, sessionRecords(sessionId, [{ text: 'Rename the helper module' }]))
    s.replies.push('hang')
    await s.host.noteTurnEnd({ taskId, sessionId, turn: 1, reason: { kind: 'completed' } })
    while (s.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    await s.host.stop()
    expect(s.host.busy).toBe(false)
    expect((await readLearningQueue(s.layout.dataDir)).items).toEqual([expect.objectContaining({ taskId, status: 'pending', attempts: 0 })])
    // Turns while stopped only queue.
    await s.host.noteTurnEnd({ taskId: randomUUID(), sessionId, turn: 1, reason: { kind: 'completed' } })
    expect(s.requests).toHaveLength(1)
    s.replies.push(ops(), ops())
    await s.host.start()
    await s.host.idle()
    expect((await readLearningQueue(s.layout.dataDir))).toMatchObject({ items: [], history: [expect.objectContaining({ taskId, status: 'done' }), expect.objectContaining({ status: 'done' })] })
  })

  it('a later turn of a queued task replaces its item, and the reflection covers every new turn', async () => {
    const s = await setup()
    const sessionId = randomUUID()
    const taskId = randomUUID()
    s.sessions.set(sessionId, sessionRecords(sessionId, [{ text: 'Draft the release notes' }, { text: 'Add the upgrade steps' }, { text: 'Shorten it' }]))
    await s.host.stop()
    for (const turn of [1, 2]) await s.host.noteTurnEnd({ taskId, sessionId, turn, reason: { kind: 'completed' } })
    expect((await readLearningQueue(s.layout.dataDir)).items).toEqual([expect.objectContaining({ fromTurn: 1, turn: 2 })])
    s.replies.push(ops(), ops())
    await s.host.start()
    await s.host.idle()
    await s.host.noteTurnEnd({ taskId, sessionId, turn: 3, reason: { kind: 'completed' } })
    await s.host.idle()
    const history = (await readLearningQueue(s.layout.dataDir)).history
    expect(history.map(task => [task.fromTurn, task.throughTurn])).toEqual([[1, 2], [3, 3]])
    expect(s.requests[1]!.request.messages[1]!.content).toContain('Shorten it')
    // The later reflection still sees the earlier turns, marked as context.
    expect(s.requests[1]!.request.messages[1]!.content).toContain('Turns 3–3 are new since the last reflection')
    expect(s.requests[1]!.request.messages[1]!.content).toContain('Add the upgrade steps')
  })
})

describe('the retired counting path', () => {
  it('counted feedback and failed checks no longer start jobs; old job records stay readable', async () => {
    const layout = await project(true)
    const launched: string[] = []
    const host = new ImprovementHost(layout, { launch: (_layout, jobId) => { launched.push(jobId); return { jobId, pid: undefined, exited: Promise.resolve(0) } } })
    await host.start()
    const old = await createJob(improvementsDir(layout), { id: randomUUID(), trigger: 'feedback-count', items: [], now: new Date('2026-10-13T09:00:00.000Z') })
    for (let i = 0; i < 3; i += 1) await host.noteFeedback([feedback({ rating: 1 })])
    await host.noteCheckFailure({ taskId: randomUUID(), sessionId: randomUUID(), turn: 1, checks: [{ name: 'file-exists', passed: false }] })
    expect(launched).toEqual([])
    expect((await host.queue())?.pending).toEqual([])
    expect((await host.list()).map(job => job.id)).toEqual([old.id])
    expect(await host.show(old.id)).toMatchObject({ id: old.id, trigger: 'feedback-count' })
    // The legacy flag keeps the old behaviour for its own tests.
    const legacy = new ImprovementHost(await project(true), { legacyCounting: true, launch: (_layout, jobId) => { launched.push(jobId); return { jobId, pid: undefined, exited: Promise.resolve(0) } } })
    await legacy.start()
    for (let i = 0; i < 3; i += 1) await legacy.noteFeedback([feedback({ rating: 1 })])
    expect(launched).toHaveLength(1)
  })

  it('forwards the kernel turn-end signal to the learner', async () => {
    const s = await setup()
    const host = new ImprovementHost(s.layout, {})
    host.learning = s.host
    const sessionId = randomUUID()
    s.sessions.set(sessionId, sessionRecords(sessionId, [{ text: 'Summarize the changelog' }]))
    s.replies.push(ops())
    await host.noteTurnEnd({ taskId: randomUUID(), sessionId, turn: 1, reason: { kind: 'completed' } })
    await s.host.idle()
    expect(s.requests).toHaveLength(1)
    expect(foldHandbook([])).toEqual([])
  })
})
