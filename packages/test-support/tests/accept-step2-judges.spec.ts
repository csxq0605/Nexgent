/**
 * The accept-step2 H judges against one real headless run (scripted model,
 * in-process runtime, two kills in child processes) and, for every judge, a
 * copy of that run broken in the one way the judge exists to catch.
 *
 * Needs the packages built (`pnpm build`), like the acceptance script.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FILES, TASKS } from '../../../scripts/accept-common/scenario-step2.mjs'
import { runHeadlessScenario } from '../../../scripts/accept-common/step2-headless.mjs'
import { JUDGES, judge, type JudgeTools, type Observations } from '../../../scripts/accept-common/step2-judges.mjs'
import { isLoopbackUrl, loadStep2Packages } from '../../../scripts/accept-common/step2-runtime.mjs'
import * as h from '../src/index.js'

let tools: JudgeTools

let work: string
let good: Observations

beforeAll(async () => {
  const loaded = await loadStep2Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  tools = { ...loaded.pkgs.session, requestText: h.requestText, isAuxiliaryRequest: h.isAuxiliaryRequest }
  // Not under a `nexgent-` prefix: the sandbox currently admits writes into any
  // tmpdir/nexgent-* directory (reported to the workspace owner), which would make
  // the baseline's "outside the project" path writable. The acceptance script's
  // default work dir keeps that prefix and so still catches it.
  work = await mkdtemp(join(tmpdir(), 'nxjudges-'))
  good = await runHeadlessScenario(h, work)
}, 180_000)

afterAll(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

/** A deep copy of the good run with one defect. */
function broken(mutate: (obs: Observations) => void): Observations {
  const copy = structuredClone(good)
  mutate(copy)
  return copy
}

const recordsOfTurn = (obs: Observations, turn: number, type: string) => (obs.records as Array<Record<string, any>>).filter(r => r.turn === turn && r.type === type)
const turnOf = (obs: Observations, phase: string) => (obs.phases[phase].events as Array<Record<string, any>>).find(e => e.type === 'turn.start')!.turn as number
const toolResult = (obs: Observations, phase: string, name: string, match: (args: Record<string, any>) => boolean = () => true) => {
  const events = obs.phases[phase].events as Array<Record<string, any>>
  const start = events.find(e => e.type === 'tool.start' && e.name === name && match(JSON.parse(e.arguments)))!
  return events.find(e => e.type === 'tool.result' && e.callId === start.callId)!
}

describe('accept-step2 H judges', () => {
  it('all pass on a real run', () => {
    for (const id of Object.keys(JUDGES)) {
      const result = judge(id, good, tools)
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
  })

  const cases: Array<[string, string, (obs: Observations) => void]> = [
    ['H01', 'config.json missing', obs => { obs.init.configExists = false }],
    ['H01', 'the project is not in the recent list', obs => { obs.init.recent = [] }],
    ['H02', 'the original file changed', obs => { obs.materials[1].sourceShaAfter = '0'.repeat(64) }],
    ['H02', 'metadata fails the schema', obs => { delete obs.materials[0].meta.sha256 }],
    ['H03', 'the first request lacks the material references', obs => { obs.phases.first.requests[0].messages = [{ role: 'user', content: TASKS.first }] }],
    ['H03', 'the write into materials/ succeeded', obs => { toolResult(obs, 'first', 'write_file', a => String(a.path).includes('.nexgent/materials/')).isError = false }],
    ['H04', 'read_document failed', obs => { toolResult(obs, 'first', 'read_document').isError = true }],
    ['H05', 'AGENTS.md missing from the system prompt', obs => { obs.phases.first.requests[0].system = 'You are Nexgent.' }],
    ['H06', 'the first turn ended in an error', obs => { obs.phases.first.reason = { kind: 'error' } }],
    ['H06', 'no successful str_replace', obs => { toolResult(obs, 'first', 'str_replace').isError = true }],
    ['H07', 'a v1 snapshot does not hash to its record', obs => { obs.v1Files[0].afterV1 = '0'.repeat(64) }],
    ['H08', 'turn.files misses the shell-written file', obs => {
      const record = recordsOfTurn(obs, turnOf(obs, 'first'), 'turn.files')[0]!
      record.changes = record.changes.filter((c: { path: string }) => c.path !== FILES.shellNote.path)
    }],
    ['H08', 'turn.files lists a file that did not change', obs => {
      recordsOfTurn(obs, turnOf(obs, 'first'), 'turn.files')[0]!.changes.push({ path: 'report/ghost.txt', change: 'added' })
    }],
    ['H09', 'the feedback is linked to the wrong version', obs => { recordsOfTurn(obs, turnOf(obs, 'feedback'), 'feedback')[0]!.feedback.version = 2 }],
    ['H09', 'no source: feedback user message', obs => {
      for (const r of recordsOfTurn(obs, turnOf(obs, 'feedback'), 'user.message')) r.source = 'user'
    }],
    ['H10', 'v1 snapshot changed after v2', obs => { obs.v1Files[0].atEnd = '0'.repeat(64) }],
    ['H10', 'the diff touches an unexpected file', obs => { obs.diff.files.push({ path: 'report/README.md', change: 'modified' }) }],
    ['H10', 'no v2', obs => { obs.deliverableAfterFeedback.versions = obs.deliverableAfterFeedback.versions.slice(0, 1) }],
    ['H11', 'the goal was never completed', obs => { obs.records = obs.records.filter((r: { type: string }) => r.type !== 'goal.update'); obs.goalAtEnd.status = 'active' }],
    ['H11', 'the goal is not in the system prompt', obs => { obs.phases.goal.requests[0].system = 'You are Nexgent.' }],
    ['H12', 'a descendant survived the cancel', obs => { obs.phases.cancelTool.survivors = [424242] }],
    ['H12', 'the streamed text was dropped', obs => {
      obs.records = obs.records.filter((r: { type: string; turn?: number }) => !(r.type === 'assistant.message' && r.turn === turnOf(obs, 'cancelStream')))
    }],
    ['H13', 'the outside write went through', obs => { obs.approvals.outsideExists = true }],
    ['H13', 'the outside write asked for approval instead of being refused', obs => { obs.approvals.log.unshift({ tool: 'write_file', summary: 'write ../outside-the-project.txt', decision: 'deny', scope: 'once' }) }],
    ['H13', 'the outside write was not refused by the sandbox', obs => { toolResult(obs, 'approvals', 'write_file', a => a.path === FILES.outside.path).content = 'Created ../outside-the-project.txt' }],
    ['H23', 'once was not spent (no second approval)', obs => { obs.approvals.log = obs.approvals.log.slice(0, 1) }],
    ['H23', 'the denied write landed', obs => { obs.approvals.envContent = FILES.env.denied }],
    ['H23', 'the first approval was not once', obs => { obs.approvals.log[0].scope = 'session' }],
    ['H14', 'no compaction record', obs => { obs.records = obs.records.filter((r: { type: string }) => r.type !== 'compaction') }],
    ['H14', 'the request after compaction still carries the early turns', obs => {
      obs.phases.compact.requests[2].messages.unshift({ role: 'user', content: TASKS.first })
    }],
    ['H14', 'the summary request carried tools', obs => { obs.phases.compact.requests[1].tools = [{ name: 'bash' }] }],
    ['H14', 'a failed compaction dropped the history', obs => { obs.phases.compactFail.requests[2].messages = [{ role: 'user', content: TASKS.compactFail }] }],
    ['H15', 'part of the tree survived', obs => { obs.phases.streamKill.survivors = [424242] }],
    ['H15', 'the kill came before any streaming', obs => { obs.phases.streamKill.sawText = false }],
    ['H16', 'no tool was running', obs => { obs.phases.toolKill.crash.tool = undefined }],
    ['H16', 'an orphan on Windows', obs => { obs.platform = 'win32'; obs.phases.toolKill.crash.survivors = [424242] }],
    ['H17', 'the killed turn was not closed as interrupted', obs => {
      const turn = obs.phases.resumeAfterStream.openTurnBefore
      obs.records = obs.records.filter((r: { type: string; turn?: number }) => !(r.type === 'turn.end' && r.turn === turn))
    }],
    ['H17', 'thinking blocks were not replayed', obs => {
      for (const message of obs.phases.resumeAfterTool.requests[0].messages) {
        if (Array.isArray(message.content)) message.content = message.content.filter((b: { type: string }) => b.type !== 'thinking')
      }
    }],
    ['H19', 'a seq gap', obs => { obs.records.splice(5, 1) }],
    ['H19', 'a record fails the schema', obs => { delete obs.records[0].sessionId }],
    ['H19', 'a request start without an end (not the killed one)', obs => {
      const killed = new Set(obs.phases.streamKill.requestIds)
      const index = obs.ledger.findIndex((r: { type: string; requestId?: string }) => r.type === 'llm.request.end' && !killed.has(r.requestId))
      obs.ledger.splice(index, 1)
    }],
    ['H18', 'a material vanished after the kills', obs => { obs.viewAfterKills.materials.pop() }],
    ['H18', 'the history before the kills was rewritten', obs => { obs.viewAfterKills.items[0].text = 'something else' }],
    ['H18', 'the goal changed after the kills', obs => { obs.viewAfterKills.goal.status = 'active' }],
    ['H19', 'a task.outcome missing', obs => {
      const index = obs.ledger.findIndex((r: { type: string }) => r.type === 'task.outcome')
      obs.ledger.splice(index, 1)
    }],
    ['H20', 'the test key was written to disk', obs => { obs.secretHits = ['.nexgent/sessions/x/session.jsonl'] }],
    ['H20', 'the test key is in the export', obs => { obs.exportSecretHits = ['export/session.jsonl'] }],
    ['H22', 'the export failed', obs => { obs.export.code = 1 }],
    ['H22', 'the export misses ledger lines', obs => { obs.export.files['ledger.jsonl'] = obs.export.files['ledger.jsonl'].split('\n').slice(1).join('\n') }],
    ['H22', 'the export lacks the deliverables', obs => { delete obs.export.files['deliverables.json'] }],
    ['H21', 'a request went out after the cap', obs => { obs.budget.requests.push({}) }],
    ['H21', 'the second session was not stopped', obs => { obs.budget.turns[1].reason = { kind: 'completed' } }],
  ]

  it.each(cases)('%s fails when %s', (id, _defect, mutate) => {
    const result = judge(id, broken(mutate), tools)
    expect(result.status, result.evidence).toBe('failed')
    expect(result.evidence).not.toMatch(/^judge threw/)
  })

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('the runtime refuses any API base URL but the loopback scripted server', () => {
    expect(isLoopbackUrl('http://127.0.0.1:4321')).toBe(true)
    expect(isLoopbackUrl('http://localhost:1')).toBe(true)
    expect(isLoopbackUrl('https://api.anthropic.com')).toBe(false)
    expect(isLoopbackUrl(undefined)).toBe(false)
  })

  it('a judge that throws is a failure', () => {
    expect(judge('H02', { materials: [{ meta: null }] }, tools).status).toBe('failed')
    expect(judge('H99', good, tools).status).toBe('not-implemented')
  })
})
