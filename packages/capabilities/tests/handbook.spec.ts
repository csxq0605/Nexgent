import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HANDBOOK_ACTIVATE_HELPFUL, resolveProjectDataLayout, resolveUserDataLayout, type HandbookEntry } from '@nexgent/kernel'
import {
  deriveKeywords,
  Handbook,
  HandbookIndex,
  HandbookLog,
  migrateContextPolicies,
  policyPractices,
  terms,
} from '../src/index.js'
import { tempDir } from './helpers.js'

const ON = { useShared: true, contribute: true }

async function project(home: string, learning = ON): Promise<Handbook> {
  return Handbook.open({ projectRoot: await tempDir(), home, learning })
}

async function add(handbook: Handbook, text: string, keywords: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const [result] = await handbook.apply([{ op: 'add', text, keywords, ...extra }], { actor: 'reflection', source: { taskId: 'task-1' } })
  expect(result).toMatchObject({ outcome: 'applied' })
  return result!.entryId!
}

describe('terms', () => {
  it('splits English words and snake_case names, and Chinese into character pairs', () => {
    expect(terms('Check the avg_order_value per Region')).toEqual(expect.arrayContaining(['check', 'avg', 'order', 'value', 'region', 'avg_order_value']))
    expect(terms('Check the region')).not.toContain('the')
    expect(terms('核对汇总')).toEqual(['核对', '对汇', '汇总'])
    expect(terms('项目的文件')).toEqual(['项目', '文件'])
    expect(deriveKeywords('Run the tests before reporting; tests must pass.')).toContain('test')
  })
})

describe('HandbookLog', () => {
  it('stamps seq without gaps under concurrent appends and skips a torn line', async () => {
    const dir = await tempDir()
    const a = new HandbookLog(dir)
    const b = new HandbookLog(dir)
    const id = () => crypto.randomUUID()
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).append(() => [{ op: 'add', entryId: id(), actor: 'user', text: `Practice ${i}.`, keywords: [], scope: 'user' }])))
    expect((await a.read()).map(op => op.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await appendFile(a.file, '{"formatVersion":1,"seq":11,"op":"ad')
    expect(await a.read()).toHaveLength(10)
    await a.append(() => [{ op: 'add', entryId: id(), actor: 'user', text: 'After the torn line.', keywords: [], scope: 'user' }])
    expect((await new HandbookLog(dir).read()).map(op => op.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('refuses operations outside the limits', async () => {
    const log = new HandbookLog(await tempDir())
    await expect(log.append(() => [{ op: 'add', entryId: crypto.randomUUID(), actor: 'user', text: 'x'.repeat(601), keywords: [], scope: 'user' }])).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(log.append(() => [{ op: 'add', entryId: crypto.randomUUID(), actor: 'user', text: 'ok', keywords: ['Upper'], scope: 'user' }])).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(await log.read()).toEqual([])
  })
})

describe('Handbook', () => {
  it('two projects share user entries; a project that turns sharing off no longer retrieves them', async () => {
    const home = await tempDir()
    const one = await project(home)
    const shared = await add(one, 'Before reporting totals, recompute them from the input file and compare.', ['totals', 'report'])
    const local = await add(one, 'Name output files after the input file.', ['naming'], { scope: 'project' })
    const two = await project(home)
    expect((await two.retrieve('report the totals of the sales file')).map(found => found.entry.id)).toEqual([shared])
    expect((await two.entries()).map(entry => entry.id)).toEqual([shared])
    expect((await one.entries()).map(entry => entry.id).sort()).toEqual([shared, local].sort())

    const off = await Handbook.open({ projectRoot: await tempDir(), home, learning: { useShared: false, contribute: true } })
    expect(await off.retrieve('report the totals of the sales file')).toEqual([])
    expect(await off.entries()).toEqual([])
    expect(await readFile(join(resolveUserDataLayout(home).handbook, 'ops.jsonl'), 'utf8')).toContain(shared)
  })

  it('a project that does not contribute keeps its new entries to itself', async () => {
    const home = await tempDir()
    const quiet = await Handbook.open({ projectRoot: await tempDir(), home, learning: { useShared: true, contribute: false } })
    const [result] = await quiet.apply([{ op: 'add', text: 'Keep a changelog entry for each fix.', keywords: ['changelog'] }], { actor: 'reflection' })
    expect(result).toMatchObject({ outcome: 'applied', scope: 'project' })
    expect(await (await project(home)).retrieve('write the changelog')).toEqual([])
    expect(await quiet.retrieve('write the changelog')).toHaveLength(1)
    expect(await readFile(join(resolveProjectDataLayout(home, quiet.projectId).handbook, 'ops.jsonl'), 'utf8')).toContain('"scope":"project"')
  })

  it('retrieves Chinese entries for a Chinese task and ranks by relevance', async () => {
    const handbook = await project(await tempDir())
    const sums = await add(handbook, '汇总多份资料里的数字时，先逐份核对再相加。', ['汇总', '核对'])
    await add(handbook, '改代码前先跑一遍测试，记下失败的用例。', ['测试', '代码'])
    expect((await handbook.retrieve('把三份报表的数字汇总一下')).map(found => found.entry.id)[0]).toBe(sums)
  })

  it('gives nothing when the task only shares common words with the entries', async () => {
    const handbook = await project(await tempDir())
    await add(handbook, '写报告时每个事实都注明来源资料的文件名，资料有冲突时写明采用了哪一份。', ['报告', '来源标注'])
    const shared = '这次用到的文件都在项目的 job-1/ 目录下。如果资料有问题，请写明发现了什么。'
    expect(await handbook.retrieve(`${shared}请把 inbox/ 下的 CSV 转成 JSON，存到 converted/。`)).toEqual([])
    expect(await handbook.retrieve(`${shared}请阅读 materials/ 下的资料，写成一份报告。`)).toHaveLength(1)
  })

  it('retrieves from 1000 entries in under 50 ms', async () => {
    const home = await tempDir()
    const handbook = await project(home)
    const topics = ['spreadsheet', 'tests', 'report', 'citation', 'csv', 'chart', 'invoice', 'refactor', 'migration', 'summary']
    const words = ['check', 'compare', 'verify', 'rename', 'archive', 'format', 'sort', 'group', 'filter', 'merge', 'split', 'export']
    const lines: string[] = []
    for (let i = 0; i < 1000; i += 1) {
      const topic = topics[i % topics.length]!
      const text = `When working on ${topic} task ${i.toString(36)}, ${words[i % words.length]} the ${words[(i * 7) % words.length]} step, then ${words[(i * 3) % words.length]} the output; 处理${topic}时先核对第${i}步。`
      lines.push(JSON.stringify({ formatVersion: 1, seq: i + 1, at: '2026-10-16T00:00:00.000Z', op: 'add', entryId: crypto.randomUUID(), actor: 'reflection', text, keywords: [topic], scope: 'user' }))
    }
    await mkdir(resolveUserDataLayout(home).handbook, { recursive: true })
    await writeFile(join(resolveUserDataLayout(home).handbook, 'ops.jsonl'), `${lines.join('\n')}\n`)
    const cold = performance.now()
    const first = await handbook.retrieve('verify the spreadsheet totals and export a csv')
    const coldMs = performance.now() - cold
    const warm = performance.now()
    await handbook.retrieve('merge the report sections and check citations')
    const warmMs = performance.now() - warm
    expect(first).toHaveLength(5)
    expect(warmMs).toBeLessThan(50)
    // The first call also reads and folds the log and builds the index.
    expect(coldMs).toBeLessThan(500)
  })

  it('a new entry that replaces a conflicting one retires it; a project entry cannot replace a shared one', async () => {
    const handbook = await project(await tempDir())
    const old = await add(handbook, 'Write reports as Word documents.', ['report', 'format'])
    const replacement = await add(handbook, 'Write reports as Markdown with a table of contents.', ['report', 'format'], { supersedes: [old] })
    const entries = await handbook.entries({ includeRetired: true })
    expect(entries.find(entry => entry.id === old)).toMatchObject({ status: 'retired', supersededBy: replacement })
    expect((await handbook.retrieve('write the report')).map(found => found.entry.id)).toEqual([replacement])
    const [refused] = await handbook.apply([{ op: 'add', text: 'Reports go to the docs folder.', keywords: ['report'], scope: 'project', supersedes: [replacement] }], { actor: 'reflection' })
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'superseded-shared' })
  })

  it('a near-identical entry is a duplicate and writes nothing', async () => {
    const handbook = await project(await tempDir())
    const first = await add(handbook, 'Run the test suite before saying the change works.', ['tests'])
    const [again] = await handbook.apply([{ op: 'add', text: 'Run the test suite before saying the change works!', keywords: ['tests'] }], { actor: 'reflection' })
    expect(again).toMatchObject({ outcome: 'duplicate', duplicateOf: first })
    expect(await handbook.user.read()).toHaveLength(1)
  })

  it('refuses an entry carrying a concrete value of the task (ADR 0013 decision 2)', async () => {
    const handbook = await project(await tempDir())
    const literals = { sources: [{ kind: 'deliverable' as const, ref: 'deliverable:d/v1/summary.md', text: 'Total: 2,384.13 USD over 41 orders.' }], projectMessages: [] }
    const [refused] = await handbook.apply([{ op: 'add', text: 'The total should be 2384.13; check it against the orders.', keywords: ['total'] }], { actor: 'reflection', literals })
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'instance-literal', hits: [expect.objectContaining({ value: '2384.13' })] })
    const [accepted] = await handbook.apply([{ op: 'add', text: 'Recompute the total from the order lines and compare it with the reported one.', keywords: ['total'] }], { actor: 'reflection', literals })
    expect(accepted).toMatchObject({ outcome: 'applied' })
    const [edit] = await handbook.apply([{ op: 'edit', entryId: accepted!.entryId!, text: 'Totals are 2384.13.' }], { actor: 'reflection', literals })
    expect(edit).toMatchObject({ outcome: 'rejected', reason: 'instance-literal' })
  })

  it('votes move an entry from trial to active, and harmful votes retire it, each status change logged', async () => {
    const handbook = await project(await tempDir())
    const id = await add(handbook, 'Quote the input file names in the summary.', ['summary'])
    for (let i = 0; i < HANDBOOK_ACTIVATE_HELPFUL; i += 1) await handbook.apply([{ op: 'upvote', entryId: id }], { actor: 'execution', source: { taskId: `t${i}` } })
    expect((await handbook.find(id))?.entry).toMatchObject({ status: 'active', helpful: 2 })
    for (let i = 0; i < 4; i += 1) await handbook.apply([{ op: 'downvote', entryId: id }], { actor: 'execution', source: { taskId: `d${i}` } })
    expect((await handbook.find(id))?.entry).toMatchObject({ status: 'retired', helpful: 2, harmful: 4 })
    expect((await handbook.ops(id)).ops.filter(op => op.op === 'status').map(op => op.op === 'status' && [op.status, op.actor])).toEqual([['active', 'host'], ['retired', 'host']])
    expect(await handbook.retrieve('write the summary')).toEqual([])
    await expect(handbook.ops('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'handbook/not-found' })
  })

  it('a task votes on an entry once and never on an entry it taught; the status reason can be the caller\'s', async () => {
    const handbook = await project(await tempDir())
    const id = await add(handbook, 'List the files you changed at the end.', ['changes'])
    const votes = await handbook.apply([
      { op: 'upvote', entryId: id, source: { taskId: 'task-1' } },
      { op: 'upvote', entryId: id, source: { taskId: 'task-2' } },
      { op: 'downvote', entryId: id, source: { taskId: 'task-2' } },
    ], { actor: 'execution' })
    expect(votes.map(vote => vote.outcome === 'rejected' ? vote.reason : vote.outcome)).toEqual(['own-source', 'applied', 'already-voted'])
    await handbook.apply([{ op: 'upvote', entryId: id }], { actor: 'reflection', source: { taskId: 'task-3' }, statusReason: status => `已${status === 'active' ? '启用' : '下线'}` })
    expect((await handbook.ops(id)).ops.at(-1)).toMatchObject({ op: 'status', status: 'active', actor: 'host', reason: '已启用' })
  })

  it('a project constant may stay in a project entry but not in a shared one', async () => {
    const handbook = await project(await tempDir())
    const literals = {
      sources: [{ kind: 'feedback' as const, ref: 'feedback:f', text: 'Orders above 500 count as large.' }],
      projectMessages: [{ taskId: 'a', text: 'List orders above 500.' }, { taskId: 'b', text: 'Count orders above 500.' }],
    }
    const [shared] = await handbook.apply([{ op: 'add', text: 'Orders above 500 are large.', keywords: ['orders'] }], { actor: 'reflection', literals })
    expect(shared).toMatchObject({ outcome: 'rejected', reason: 'instance-literal' })
    const [local] = await handbook.apply([{ op: 'add', text: 'Orders above 500 are large.', keywords: ['orders'], scope: 'project' }], { actor: 'reflection', literals })
    expect(local).toMatchObject({ outcome: 'applied', scope: 'project' })
  })

  it('rolls a log back to an earlier moment', async () => {
    const handbook = await project(await tempDir())
    const kept = await add(handbook, 'Keep units in column headers.', ['units'])
    const mark = (await handbook.user.read()).at(-1)!.seq
    await handbook.apply([{ op: 'edit', entryId: kept, text: 'Put units in a separate row.' }], { actor: 'reflection' })
    const later = await add(handbook, 'Freeze the header row.', ['header'])
    await handbook.rollback('user', mark)
    const entries = await handbook.entries({ includeRetired: true })
    expect(entries.find(entry => entry.id === kept)).toMatchObject({ text: 'Keep units in column headers.', status: 'trial' })
    expect(entries.find(entry => entry.id === later)).toMatchObject({ status: 'retired' })
  })
})

describe('context policy migration', () => {
  it('turns each paragraph or list item into a project-level active entry, once', async () => {
    const policy = '# House rules\n\n- Cite the source file of every number.\n- Keep summaries under one page.\n\nWhen a test fails, show its output before changing code.'
    expect(policyPractices(policy)).toEqual(['Cite the source file of every number.', 'Keep summaries under one page.', 'When a test fails, show its output before changing code.'])
    const handbook = await project(await tempDir())
    const results = await migrateContextPolicies(handbook, [policy])
    expect(results.map(result => result.outcome)).toEqual(['applied', 'applied', 'applied'])
    expect(await migrateContextPolicies(handbook, [policy])).toEqual([])
    const entries: HandbookEntry[] = await handbook.entries()
    expect(entries.map(entry => [entry.scope, entry.status, entry.projectId])).toEqual(Array(3).fill(['project', 'active', handbook.projectId]))
    expect(await handbook.user.read()).toEqual([])
    expect((await handbook.retrieve('summarise the test failures')).length).toBeGreaterThan(0)
  })

  it('keeps an index search pure', () => {
    expect(new HandbookIndex([]).search('anything', 5)).toEqual([])
  })
})
