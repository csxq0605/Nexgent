/**
 * The scripted model of the step-5 headless scenario: one object answers every
 * request of one project's scripted server, whichever process sends it — the
 * SDK's user tasks and feedback turns, the improvement job's diagnose and
 * propose sessions (the SDK's improve entry, a detached process), the gate's
 * replays (one process each) and its reviewer. Requests are told apart the way
 * the product makes them differ:
 *
 *   feedback check   system prompt "You check one attempt" (gate, step 5): solved when the
 *                    attempt's table has the convention column (`feedbackAnswer: 'null'`
 *                    answers null, an unknown check)
 *   review           system prompt "quality gate": always a tie
 *   diagnose         the diagnosis tool is offered: the next playbook of `playbooks` (one per
 *                    diagnose session; `stall` hangs the request so the job stays diagnosing)
 *   propose          evolve's brief opens the first user message: that playbook's propose steps
 *   task             a family task's ask opens the first user message: write → test command →
 *                    present → answer; a region table where the convention skill is offered
 *                    loads it and writes the column. A user task, a replay of either arm and the
 *                    next task after adoption all follow this rule; later turns (feedback) get
 *                    "Noted."
 *
 * Evidence a diagnosis cites is looked up when the request arrives: the record of the
 * feedback (or failed check) the prompt names, read from the project's session file.
 * Never calls a real model.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONVENTION_COLUMN, FEEDBACK, SECOND_FEEDBACK } from '../real-task/step5-orders.mjs'
import { dataDirSync } from './data-dir.mjs'
import { shellCall } from './scenario-step2.mjs'
import { CONVENTION_SKILL, DIAGNOSIS_TOOL, FEEDBACK_TASK, HISTORY_TASKS, NEXT_TASK, outputFor, playbook, PROPOSAL_MARKER } from './step5-fixtures.mjs'

/** Usage of every scripted answer, all four billed fields known (the gate rejects unknown costs). */
export const USAGE = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** Every family task of the feedback project. */
export const TASKS = [...HISTORY_TASKS, FEEDBACK_TASK, NEXT_TASK]

const blocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const toolNames = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)
const steps = body => (body?.messages ?? []).filter(message => message.role === 'assistant').length
const toolUses = body => (body?.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => blocks(message.content)).filter(block => block.type === 'tool_use').map(block => block.name)

/** Text of the first user message (the session's opening ask). */
export function firstUserText(body) {
  for (const message of body?.messages ?? []) {
    if (message.role !== 'user') continue
    const text = blocks(message.content).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text !== '') return text
  }
  return ''
}

const turn = (toolCalls) => ({ toolCalls, usage: USAGE })
const answer = content => ({ content, usage: USAGE })
const step = entry => (entry.toolCalls === undefined ? answer(entry.content) : turn(entry.toolCalls))

/** The feedback comments a replay must never see. */
const COMMENTS = [...FEEDBACK, ...SECOND_FEEDBACK].map(entry => entry.comment).filter(text => typeof text === 'string' && text.length > 8)

function readRecords(root, sessionId) {
  try {
    return readFileSync(join(dataDirSync(root), 'sessions', sessionId, 'session.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * The record a diagnosis cites: the turn the prompt names (a feedback's or a failed check's)
 * in that session, else the first record with a turn in the first session it names.
 */
export function evidenceFor(root, text) {
  const named = /in session ([0-9a-f-]{36}) turn (\d+)/.exec(text) ?? /\(session ([0-9a-f-]{36}), turn (\d+)\)/.exec(text)
  const sessionId = named?.[1] ?? /session ([0-9a-f-]{36})/.exec(text)?.[1]
  if (sessionId === undefined) return { sessionId: '00000000-0000-4000-8000-000000000000', seq: 1 }
  const wanted = named === null ? undefined : Number(named[2])
  const records = readRecords(root, sessionId)
  const record = records.find(r => typeof r.turn === 'number' && (wanted === undefined || r.turn === wanted))
  return record === undefined ? { sessionId, seq: 1 } : { sessionId, seq: record.seq, turn: record.turn }
}

export class Step5Model {
  /**
   * @param h - the loaded test-support harness.
   * @param options - `root` (the project), `playbooks` (diagnose sessions in order; default
   *   `not-capability` once they run out), `feedbackAnswer` (`'by-output'` or `'null'`).
   */
  constructor(h, { root, playbooks = [], feedbackAnswer = 'by-output' }) {
    this.h = h
    this.root = root
    this.playbooks = [...playbooks]
    this.feedbackAnswer = feedbackAnswer
    /** `main` while the scenario drives user tasks, `job` while a job (and its gate) runs. */
    this.phase = 'main'
    this.current = undefined
    this.requests = []
    this.diagnoseSessions = []
    this.feedbackChecks = []
    this.reviews = 0
  }

  /** A script entry for `h.scriptedModelServer`: `Array.from({ length }, () => model.entry)`. */
  get entry() {
    return body => this.respond(body)
  }

  respond(body) {
    const system = JSON.stringify(body?.system ?? '')
    const tools = toolNames(body)
    const at = steps(body)
    const first = firstUserText(body)
    if (system.includes('You check one attempt')) return this.#feedbackCheck(body)
    if (system.includes('quality gate')) {
      this.reviews += 1
      this.requests.push({ phase: this.phase, kind: 'review' })
      return answer(JSON.stringify({ better: 'tie', reason: 'Both attempts are the same.' }))
    }
    if (tools.includes(DIAGNOSIS_TOOL)) return this.#diagnose(first, tools, at)
    if (first.includes(PROPOSAL_MARKER)) return this.#propose(first, tools, at)
    const task = TASKS.filter(entry => first.includes(entry.ask)).sort((a, b) => b.ask.length - a.ask.length)[0]
    if (task === undefined) {
      this.requests.push({ phase: this.phase, kind: 'other', step: at })
      return answer('Done.')
    }
    return this.#task(task, body, tools, at)
  }

  #feedbackCheck(body) {
    const text = this.h.requestText(body)
    const solved = this.feedbackAnswer === 'null' ? null : text.includes(`revenue,${CONVENTION_COLUMN}`)
    this.feedbackChecks.push({ phase: this.phase, solved, quotesFeedback: COMMENTS.some(comment => text.includes(comment)) })
    this.requests.push({ phase: this.phase, kind: 'feedback-check' })
    return answer(JSON.stringify({ solved, reason: solved === null ? 'Cannot tell from the output.' : solved ? 'The table has the column the user asked for.' : 'The column the user asked for is still missing.' }))
  }

  #diagnose(first, tools, at) {
    if (at === 0) {
      this.current = this.playbooks.shift() ?? 'not-capability'
      this.diagnoseSessions.push({ playbook: this.current, tools })
    }
    this.requests.push({ phase: this.phase, kind: 'diagnose', playbook: this.current, step: at })
    if (this.current === 'stall') return { fault: { kind: 'timeout' } }
    const book = playbook(this.current, evidenceFor(this.root, first)).steps.filter(entry => entry.phase === 'diagnose')
    return step(book[Math.min(at, book.length - 1)])
  }

  #propose(first, tools, at) {
    this.requests.push({ phase: this.phase, kind: 'propose', playbook: this.current, step: at, tools })
    const book = playbook(this.current ?? 'improve', { sessionId: '00000000-0000-4000-8000-000000000000', seq: 1 }).steps.filter(entry => entry.phase === 'propose')
    if (book.length === 0) return answer('Nothing to propose.')
    return step(book[Math.min(at, book.length - 1)])
  }

  #task(task, body, tools, at) {
    // The convention skill is offered, i.e. listed in the injected skills message (adopted, or the candidate arm of a replay): load it and write the column.
    const offered = task.kind === 'regions' && tools.includes('load_skill') && JSON.stringify((body?.messages ?? []).filter(message => message?.role === 'user').flatMap(message => (typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text))).filter(text => typeof text === 'string' && text.startsWith('# Skills'))).includes(CONVENTION_SKILL.name)
    const withSkill = at === 0 ? offered : toolUses(body).includes('load_skill')
    const text = this.h.requestText(body)
    this.requests.push({ phase: this.phase, kind: 'task', task: task.id, step: at, withSkill, quotesFeedback: COMMENTS.some(comment => text.includes(comment)) })
    const write = { name: 'write_file', arguments: { path: task.output, content: outputFor(task, { withAverage: withSkill }) } }
    const script = [
      turn(withSkill ? [{ name: 'load_skill', arguments: { name: CONVENTION_SKILL.name } }, write] : [write]),
      turn([shellCall({ bash: task.checkCommand, pwsh: task.checkCommand })]),
      turn([{ name: 'present', arguments: { paths: [task.output], summary: `${task.kind} for ${task.month}` } }]),
      answer(`${task.output} presented.`),
    ]
    return at < script.length ? script[at] : answer('Noted.')
  }
}
