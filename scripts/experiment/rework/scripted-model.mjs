// @ts-check
/**
 * The scripted model of the rework rehearsal: answers every request the orchestration's
 * product processes send to the local scripted server — task turns, feedback turns, the
 * "please present" follow-up, and the external reviewer. Never calls a real model; it
 * exists so orchestration, records and report can be rehearsed end to end.
 *
 *   task       a case's message opens the session: write an end state with one shell call
 *              (`../step6/pilot/scripted-model.mjs` `applyCall`), present the written
 *              files, answer. Which end state depends on what the first user turn carries
 *              before the case's message:
 *                nothing, or the format frame      the known bad end state of the first
 *                                                  input-problem point
 *                the notes text                    the bad end state of the convention
 *                                                  point when the case has one, else good
 *                handbook entries (L1)             good on even case numbers, else as base
 *                stand-in "L1+L2" / "L1+L2+L3"     good
 *   feedback   a short acknowledgement
 *   learner    the product's background requests: a rubric of two items, full marks, and
 *              one reflection that adds a fixed, general entry (so the L1 arm has
 *              something to retrieve)
 *   reviewer   "是" for every point asked
 *
 * So the arms come out in a fixed order. That is a scripted outcome chosen to exercise the
 * report; it says nothing about a real model.
 *
 * Linux, macOS and Windows; no dependencies beyond the test-support harness passed in.
 */
import { PRESENT_REQUEST } from '../step6/cases.mjs'
import { applyCall, USAGE } from '../step6/pilot/scripted-model.mjs'
import { HANDBOOK_HEADER, NOTES_HEADER, STAND_IN_TITLE } from './arms.mjs'
import { badOf, goodOf } from './cases.mjs'

/**
 * @typedef {import('./common.mjs').ReworkCase} ReworkCase
 * @typedef {import('./common.mjs').Answer} Answer
 */

const REVIEWER_MARKER = '你是一名独立评审'
/** System-prompt words of the product's background requests (G1 self-evaluation, E1 reflection). */
const RUBRIC_MARKER = 'grading rubric'
const SCORE_MARKER = 'fixed rubric'
const REFLECTION_MARKER = 'You maintain the handbook'
/** The one entry the scripted learner adds (general; shares words with every case's closing line). */
export const SCRIPTED_ENTRY = '交付前逐项核对输入资料，遇到重复、缺失或对不上的数据时，在说明里写明发现的问题和处理办法。'

const blocks = (/** @type {any} */ content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const assistantSteps = (/** @type {any} */ body) => (body?.messages ?? []).filter((/** @type {any} */ m) => m.role === 'assistant').length
const answer = (/** @type {string} */ content) => ({ content, usage: USAGE })
const calls = (/** @type {any[]} */ toolCalls) => ({ toolCalls, usage: USAGE })

/** Text of the last message when it is the user's (not a tool result). @param {any} body */
function lastUserText(body) {
  const last = (body?.messages ?? []).at(-1)
  if (last?.role !== 'user') return ''
  return blocks(last.content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
}

/** Text of the first user message. @param {any} body */
function firstUserText(body) {
  for (const message of body?.messages ?? []) {
    if (message.role !== 'user') continue
    const text = blocks(message.content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
    if (text !== '') return text
  }
  return ''
}

/**
 * Which behaviour the first user turn asks for (what stands before the case's message).
 * @param {string} first
 * @returns {'base' | 'notes' | 'L1' | 'L1+L2' | 'L1+L2+L3'}
 */
export function behaviourOf(first) {
  for (const arm of /** @type {const} */ (['L1+L2+L3', 'L1+L2', 'L1'])) if (first.includes(`${STAND_IN_TITLE}：${arm}`)) return arm
  if (first.includes(NOTES_HEADER)) return 'notes'
  // The handbook with at least one entry (the format frame has none).
  if (first.includes(HANDBOOK_HEADER) && /\n- \[[^\]]+\] /.test(first)) return 'L1'
  return 'base'
}

/**
 * The end state a case's run writes under a behaviour.
 * @param {ReworkCase} task
 * @param {ReturnType<typeof behaviourOf>} behaviour
 * @returns {Answer}
 */
export function endState(task, behaviour) {
  const bad = badOf(task)
  const firstProblem = task.rubric.find(p => p.type === 'unverified')
  const asBase = () => bad.find(b => b.point === firstProblem?.id)?.answer ?? goodOf(task)
  if (behaviour === 'base') return asBase()
  if (behaviour === 'notes') {
    const convention = task.rubric.find(p => p.type === 'convention')
    return convention === undefined ? goodOf(task) : (bad.find(b => b.point === convention.id)?.answer ?? goodOf(task))
  }
  if (behaviour === 'L1') return task.index % 2 === 0 ? goodOf(task) : asBase()
  return goodOf(task)
}

export class ReworkModel {
  /**
   * @param {any} h the loaded test-support harness (`requestText`)
   * @param {{ cases: ReworkCase[] }} options
   */
  constructor(h, { cases }) {
    this.h = h
    this.cases = [...cases].sort((a, b) => b.message.length - a.message.length)
    /** @type {Array<{ kind: string, caseId?: string, step: number, detail?: string }>} */
    this.requests = []
  }

  /** A script entry for `h.scriptedModelServer`. */
  get entry() {
    return (/** @type {any} */ body) => this.respond(body)
  }

  /** @param {any} body */
  respond(body) {
    const system = JSON.stringify(body?.system ?? '')
    const at = assistantSteps(body)
    if (system.includes(REVIEWER_MARKER)) return this.reviewer(body)
    if (system.includes(RUBRIC_MARKER)) return this.learner('rubric', JSON.stringify({ items: [{ text: '成果文件齐全并回答了任务里的每个问题。', weight: 3 }, { text: '说明里写明了资料中的问题及处理办法。', weight: 2 }] }))
    if (system.includes(SCORE_MARKER)) return this.learner('score', JSON.stringify({ scores: [{ id: 'r1', score: 1, note: '脚本化。' }, { id: 'r2', score: 1, note: '脚本化。' }] }))
    if (system.includes(REFLECTION_MARKER)) return this.learner('reflect', JSON.stringify({ ops: [{ op: 'add', text: SCRIPTED_ENTRY, keywords: ['资料', '核对', '说明', '问题'], scope: 'user', reason: '脚本化。' }] }))
    const first = firstUserText(body)
    const task = this.cases.find(c => first.includes(c.message))
    if (task === undefined) {
      this.requests.push({ kind: 'other', step: at })
      return answer('好的。')
    }
    const behaviour = behaviourOf(first)
    const end = endState(task, behaviour)
    const present = { name: 'present', arguments: { paths: Object.keys(end.write), summary: '成果' } }
    const last = lastUserText(body)
    if (last.includes(PRESENT_REQUEST)) {
      this.requests.push({ kind: 'present', caseId: task.id, step: at })
      return calls([present])
    }
    // The host's own reminders (`[Nexgent] …`) are not the user's feedback.
    if (last !== '' && last !== first && !last.startsWith('[Nexgent]')) {
      // A feedback turn on a finished task.
      this.requests.push({ kind: 'feedback', caseId: task.id, step: at })
      return answer('收到，我记下了。')
    }
    this.requests.push({ kind: 'task', caseId: task.id, step: at, detail: behaviour })
    const script = [calls([applyCall(end)]), calls([present]), answer('做好了，成果已提交。')]
    return at < script.length ? script[at] : answer('好的。')
  }

  /** A background request of the product. @param {string} kind @param {string} text */
  learner(kind, text) {
    this.requests.push({ kind, step: 0 })
    return answer(text)
  }

  /** The external reviewer: "是" for every asked point. @param {any} body */
  reviewer(body) {
    const user = this.h.requestText(body)
    const section = user.split('# 评分要点\n')[1] ?? ''
    const ids = [...section.matchAll(/^- ([^：\n]+)：/gm)].map(m => m[1])
    this.requests.push({ kind: 'review', step: 0, detail: ids.join(',') })
    return answer(JSON.stringify({ points: ids.map(id => ({ id, verdict: '是', reason: '脚本化评审。' })) }))
  }
}

