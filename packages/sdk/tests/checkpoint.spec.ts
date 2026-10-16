/**
 * The step-2 mid-term checkpoint item 4 (`step-2-work-partition.md`
 * §中期检查点): without the CLI, only through the SDK, run
 * materials → execute → present → feedback → v2 → hard kill → recover →
 * continue, against the scripted Claude Messages API server (no real model).
 *
 * The first process is a child (`fixtures/chain-child.ts`) killed with
 * SIGKILL (TerminateProcess on Windows) while turn 3 streams; a fresh SDK in
 * this process then recovers the session and continues it.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLedgerRecords, readSessionRecords, scriptedModelServer, type MessagesRequestBody, type ScriptedModelServer } from '@nexgent/test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { createSdk, type SdkEvent } from '../src/index.js'
import { tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/chain-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const XLSX = fileURLToPath(new URL('../../skill/tests/fixtures/orders.xlsx', import.meta.url))
const KEY = 'sk-checkpoint-key-5d1e0f9a7c'
const usage = { inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

let server: ScriptedModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

const text = (body: MessagesRequestBody) => JSON.stringify(body)
const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

function workbookPath(body: MessagesRequestBody): string {
  const match = /[^"\\\s]+\/materials\/[0-9a-f-]{36}\/[^"\\\s]+\.xlsx/.exec(text(body))
  if (match === null) throw new Error('no workbook path in the request')
  return match[0]
}

function presentedId(body: MessagesRequestBody): string {
  const match = /Presented deliverable ([0-9a-f-]{36})/.exec(text(body))
  if (match === null) throw new Error('no present result in the request')
  return match[1]!
}

function runChild(args: string[], env: Record<string, string>): Promise<{ lines: Array<Record<string, unknown>>; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const lines: Array<Record<string, unknown>> = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        lines.push(parsed)
        if (parsed.step === 'streaming') child.kill('SIGKILL')
      }
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ lines, code, signal }))
  })
}

describe('mid-term checkpoint: the whole chain through the SDK only', () => {
  it('materials → present v1 → feedback → v2 → kill mid-stream → recover → continue', async () => {
    const base = await tempDir('nexgent-sdk-chain-')
    const root = nodePath.join(base, 'project')
    const home = nodePath.join(base, 'home')
    await mkdir(root)
    await mkdir(home)
    await writeFile(nodePath.join(root, 'AGENTS.md'), 'Always answer in a short paragraph.\n')
    const csv = nodePath.join(base, 'orders.csv')
    const xlsx = nodePath.join(base, 'regions.xlsx')
    await writeFile(csv, 'order,region,amount\n1,north,"1,200"\n2,south,80\n2,south,80\n')
    await copyFile(XLSX, xlsx)

    server = await scriptedModelServer({
      script: [
        // turn 1: read the workbook through the skill, write, present
        body => ({ toolCalls: [{ name: 'load_skill', arguments: { name: 'office-documents' } }, { name: 'read_document', arguments: { path: workbookPath(body), sheet: 'Summary' } }], usage }),
        { toolCalls: [{ name: 'write_file', arguments: { path: 'report/summary.csv', content: 'region,total\nnorth,1200\nsouth,80\n' } }], usage },
        { toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: 'Sales by region.' } }], usage },
        { content: 'Here is the summary.', usage },
        // turn 2 (feedback): edit in place, present v2
        { toolCalls: [{ name: 'str_replace', arguments: { path: 'report/summary.csv', old_str: 'north,1200', new_str: '华北,1200' } }], usage },
        body => ({ toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: 'Chinese region names.', deliverableId: presentedId(body) } }], usage }),
        { content: 'Updated.', usage },
        // turn 3: a few chunks, then the stream stalls; the process is killed here
        { content: ['Duplicates ', 'were ', 'dropped ', 'by order id'], fault: { kind: 'timeout', afterChunks: 4 } },
        // after recovery: the continued turn
        { content: 'Duplicate orders (same order id) were kept once.', usage },
      ],
    })
    const env = { NEXGENT_HOME: home, NEXGENT_API_KEY: KEY, NEXGENT_API_BASE_URL: server.baseUrl }

    const child = await runChild([root, csv, xlsx], env)
    const steps = child.lines.map(line => line.step)
    expect(steps).toEqual(['session', 'turn1', 'turn2', 'streaming'])
    expect(child.code === 0).toBe(false)
    expect((child.lines[1]!.end as SdkEvent)).toMatchObject({ type: 'turn.end', reason: { kind: 'completed' } })
    expect((child.lines[2]!.end as SdkEvent)).toMatchObject({ type: 'turn.end', reason: { kind: 'completed' } })
    const sessionId = child.lines[0]!.sessionId as string
    expect(server.requests).toHaveLength(8)

    // checkpoint item 2: the instructions file is in the system prompt; item 3: the workbook was read through the skill
    expect(JSON.stringify(server.requests[0]!.body!.system)).toContain('Always answer in a short paragraph.')

    // ---- a new process: recover through the SDK ----
    const sdk = createSdk({ appVersion: '0.0.0-test', env })
    const events: SdkEvent[] = []
    sdk.subscribe(event => events.push(event))
    try {
      const project = await sdk.call('projects.open', { root })
      expect((await sdk.call('projects.recent', {})).map(entry => entry.root)).toContain(project.root)
      const { projectId } = project
      const [listed] = await sdk.call('sessions.list', { projectId })
      expect(listed).toMatchObject({ sessionId, title: 'sales', lastTurn: 3, interrupted: true, running: false, goal: { text: 'Summarize the orders', status: 'active' } })

      const view = await sdk.call('sessions.open', { projectId, sessionId })
      expect(events.filter(event => event.type === 'turn.end')).toEqual([expect.objectContaining({ turn: 3, reason: { kind: 'interrupted' } })])
      expect(view.summary.interrupted).toBe(true)
      const kinds = view.items.map(item => item.kind)
      expect(kinds.filter(kind => kind === 'deliverable')).toHaveLength(2)
      expect(kinds.filter(kind => kind === 'feedback')).toHaveLength(1)
      expect(view.items.filter(item => item.kind === 'turn.end').map(item => item.kind === 'turn.end' && item.reason.kind)).toEqual(['completed', 'completed', 'interrupted'])
      const read = view.items.find(item => item.kind === 'tool' && item.call.name === 'read_document')
      expect(read).toMatchObject({ isError: false })
      expect(read !== undefined && read.kind === 'tool' && read.content).toContain('Total,139.75')
      expect(view.items.some(item => item.kind === 'tool' && item.call.name === 'load_skill' && !item.isError)).toBe(true)

      // materials, deliverables v1/v2, feedback and goal all survived
      const materials = await sdk.call('materials.list', { projectId })
      expect(materials.map(material => material.originalName)).toEqual(['orders.csv', 'regions.xlsx'])
      expect(materials.map(material => material.sha256)).toEqual([await sha256(csv), await sha256(xlsx)])
      const [deliverable, ...more] = await sdk.call('deliverables.list', { projectId })
      expect(more).toEqual([])
      expect(deliverable!.versions.map(version => version.version)).toEqual([1, 2])
      expect(await sdk.call('deliverables.readText', { projectId, deliverableId: deliverable!.deliverableId, version: 1, path: 'report/summary.csv' })).toBe('region,total\nnorth,1200\nsouth,80\n')
      expect(await sdk.call('deliverables.readText', { projectId, deliverableId: deliverable!.deliverableId, version: 2, path: 'report/summary.csv' })).toBe('region,total\n华北,1200\nsouth,80\n')
      const diff = await sdk.call('deliverables.diff', { projectId, deliverableId: deliverable!.deliverableId, from: 1, to: 2 })
      expect(diff.files.map(file => [file.path, file.change])).toEqual([['report/summary.csv', 'modified']])
      expect(await sdk.call('feedback.list', { projectId, sessionId })).toEqual([expect.objectContaining({ deliverableId: deliverable!.deliverableId, version: 1, rating: 3, turn: 2 })])
      expect(await sdk.call('goals.get', { projectId, sessionId })).toMatchObject({ status: 'active' })

      // continue the conversation
      const started = await sdk.startTurn({ projectId, sessionId, text: 'Please finish the explanation.' })
      expect(started.turn).toBe(4)
      expect((await started.done).reason).toEqual({ kind: 'completed' })
      const resumed = server.requests[8]!.body!
      const history = JSON.stringify(resumed.messages)
      for (const fragment of ['Summarize the orders by region', 'Feedback on deliverable', 'Also explain how duplicates were handled.', 'Please finish the explanation.', 'Total,139.75']) {
        expect(history).toContain(fragment)
      }
      await sdk.call('goals.update', { projectId, sessionId, status: 'completed' })
      expect(await sdk.call('goals.get', { projectId, sessionId })).toMatchObject({ status: 'completed' })
      server.assertConsumed()

      const turnEnds = events.filter(event => event.type === 'turn.end').map(event => event.type === 'turn.end' && [event.turn, event.reason.kind])
      expect(turnEnds).toEqual([[3, 'interrupted'], [4, 'completed']])

      // records: continuous seq; ledger: one task.outcome per finished turn, none for the killed one
      const { records } = await readSessionRecords(project.root, sessionId, { home })
      expect(records.map(record => record.seq)).toEqual(records.map((_, index) => index + 1))
      const outcomes = (await readLedgerRecords(project.root, { home })).records.filter(record => record.type === 'task.outcome')
      expect(outcomes.map(record => record.type === 'task.outcome' && record.status)).toEqual(['completed', 'completed', 'completed'])

      // export: the bundle carries the session, its ledger lines and metadata, never the key
      const out = nodePath.join(base, 'export')
      const bundle = await sdk.call('sessions.export', { projectId, sessionId, outDir: out })
      expect(bundle.files).toEqual(['session.jsonl', 'ledger.jsonl', 'materials.json', 'deliverables.json', 'manifest.json'])
      for (const file of bundle.files) expect(await readFile(nodePath.join(out, file), 'utf8')).not.toContain(KEY)
      expect(JSON.parse(await readFile(nodePath.join(out, 'deliverables.json'), 'utf8'))).toHaveLength(2)
      expect(JSON.parse(await readFile(nodePath.join(out, 'materials.json'), 'utf8'))).toHaveLength(2)
      const ledgerLines = (await readFile(nodePath.join(out, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string })
      expect(ledgerLines.filter(line => line.type === 'llm.request.start')).toHaveLength(9)
      expect(ledgerLines.filter(line => line.type === 'task.outcome')).toHaveLength(3)
    } finally {
      await sdk.dispose()
    }
  }, 120_000)
})
