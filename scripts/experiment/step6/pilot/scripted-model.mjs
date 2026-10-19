// @ts-check
/**
 * The scripted model of the pilot rehearsal (ADR 0011; partition R6 part 2): one object
 * answers every request the pilot's processes send to the local scripted server — user
 * tasks and feedback turns, improvement jobs (diagnose, propose), the gate's replays,
 * feedback check and review, and the external and in-loop reviewers. Never calls a real
 * model; it exists so the orchestration, the records and the report can be rehearsed end
 * to end.
 *
 *   task        a pilot case's message opens the session: write the case's known end state
 *               (pilot/cases.mjs) with one shell call, present the written files, answer. The
 *               project convention is followed only when the system prompt carries it: a
 *               skill of the family offered (`load_skill` first), or the `memory` arm's
 *               policy title. Otherwise the end state is the known bad one for the
 *               convention point (`c`), so the convention is the only point missed.
 *   diagnose    report a missing skill for the feedback
 *   propose     draft a skill that states the convention in general words, try it, redo the
 *               task with it, propose it
 *   feedback    "solved" when the attempt follows the convention
 *   gate review always a tie
 *   reviewer    point review: "是" for every point; pairs: prefers the document that equals
 *               a known good document (tie when both or neither do)
 *
 * So base misses the convention everywhere, memory and parent follow it everywhere. That
 * is a scripted outcome, chosen to exercise the report; it says nothing about a real model.
 *
 * Linux, macOS and Windows; no dependencies beyond the test-support harness passed in.
 */
import { PRESENT_REQUEST } from '../cases.mjs'
import { badOf, goodOf, pilotReferencePairs } from './cases.mjs'
import { MEMORY_POLICY } from './memory.mjs'

/** The injected skills-list messages of a request as one string (the list is no longer part of the system prompt). */
const skillsListText = body => JSON.stringify((body?.messages ?? []).filter(message => message?.role === 'user').flatMap(message => (typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block?.type === 'text').map(block => block.text))).filter(text => typeof text === 'string' && text.startsWith('# Skills')))

/** Usage of every scripted answer: all four billed fields known (the gate refuses unknown costs). */
export const USAGE = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** The convention, in general words, per family (what a scripted skill says). */
export const SKILL_TEXT = {
  docs: '写报告、纪要、备忘之类的文档时，在文档末尾列出这次用到的资料文件名。',
  files: '生成或改名的文件和目录，名字里不要有空格，用连字符代替。',
}

const DIAGNOSIS_TOOL = 'improve_report_diagnosis'
const PROPOSAL_MARKER = '# Improvement job'
const REVIEWER_MARKER = '你是一名独立评审'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').Answer} Answer
 */

const blocks = (/** @type {any} */ content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const toolNames = (/** @type {any} */ body) => (body?.tools ?? []).map((/** @type {any} */ tool) => tool?.name).filter(Boolean)
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
 * One shell call that puts an end state into the project (removes, then writes; contents
 * as base64 so binary files and any text pass the shell unchanged). The program has no
 * `$`, backquote, backslash or double quote, so the same double-quoted command runs in
 * bash and pwsh.
 * @param {Answer} end
 */
export function applyCall(end) {
  const payload = Buffer.from(JSON.stringify({
    remove: end.remove,
    write: Object.entries(end.write).map(([path, content]) => [path, Buffer.from(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString('base64')]),
  }), 'utf8').toString('base64')
  const program = "const a=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));const fs=require('fs');const p=require('path');for(const r of a.remove)fs.rmSync(r,{force:true});for(const [f,b] of a.write){fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(b,'base64'))}"
  const command = `node -e "${program}" ${payload}`
  return process.platform === 'win32' ? { name: 'pwsh', arguments: { command } } : { name: 'bash', arguments: { command } }
}

/** The end state a case's run writes. @param {PilotCase} task @param {boolean} convention */
export function endState(task, convention) {
  if (convention) return goodOf(task)
  return badOf(task).find(bad => bad.point === 'c')?.answer ?? goodOf(task)
}

export class PilotModel {
  /**
   * @param {any} h the loaded test-support harness (`requestText`)
   * @param {{ cases: PilotCase[], evidence: (text: string) => { sessionId: string, seq: number, turn?: number } }} options
   */
  constructor(h, { cases, evidence }) {
    this.h = h
    this.cases = [...cases].sort((a, b) => b.message.length - a.message.length)
    this.evidence = evidence
    /** Known good documents (docs cases and reference pairs), for the scripted pair reviewer. */
    this.goodDocs = new Set([
      ...cases.filter(task => task.family === 'docs').map(task => String(Object.values(goodOf(task).write)[0])),
      ...pilotReferencePairs().map(pair => pair.good),
    ].map(text => text.trim()))
    /** Skills drafted so far: name → family. */
    /** @type {Map<string, string>} */
    this.skills = new Map()
    /** @type {Array<{ kind: string, caseId?: string, step: number, detail?: string }>} */
    this.requests = []
  }

  /** A script entry for `h.scriptedModelServer`. */
  get entry() {
    return (/** @type {any} */ body) => this.respond(body)
  }

  /** @param {string} text */
  caseIn(text) {
    return this.cases.find(task => text.includes(task.message))
  }

  /** @param {any} body */
  respond(body) {
    const system = JSON.stringify(body?.system ?? '')
    const tools = toolNames(body)
    const at = assistantSteps(body)
    const first = firstUserText(body)
    if (system.includes(REVIEWER_MARKER)) return this.reviewer(body, system)
    if (system.includes('You check one attempt')) return this.feedbackCheck(body)
    if (system.includes('quality gate')) {
      this.requests.push({ kind: 'review', step: at })
      return answer(JSON.stringify({ better: 'tie', reason: 'Both attempts are the same.' }))
    }
    if (tools.includes(DIAGNOSIS_TOOL)) return this.diagnose(first, at)
    const task = this.caseIn(first)
    if (first.includes(PROPOSAL_MARKER) && task !== undefined) return this.propose(task, at)
    if (task === undefined) {
      this.requests.push({ kind: 'other', step: at })
      return answer('Done.')
    }
    return this.task(body, system + skillsListText(body), tools, task, at)
  }

  /** The external or in-loop reviewer. @param {any} body @param {string} system */
  reviewer(body, system) {
    const user = this.h.requestText(body)
    if (system.includes('preference')) {
      const a = /# 成果 A\n([\s\S]*?)\n\n# 成果 B\n/.exec(user)?.[1] ?? ''
      const b = /\n\n# 成果 B\n([\s\S]*)$/.exec(user)?.[1] ?? ''
      const score = (/** @type {string} */ text) => (this.goodDocs.has(text.trim()) ? 1 : 0)
      const preference = score(a) > score(b) ? 'A' : score(b) > score(a) ? 'B' : 'tie'
      this.requests.push({ kind: 'pair-review', step: 0, detail: preference })
      return answer(JSON.stringify({ differences: preference === 'tie' ? [] : ['脚本化评审：只有一份是已知的好答案。'], preference, reason: '脚本化评审。' }))
    }
    const section = user.split('# 评分要点\n')[1] ?? ''
    const ids = [...section.matchAll(/^- ([^：\n]+)：/gm)].map(m => m[1])
    this.requests.push({ kind: 'point-review', step: 0, detail: ids.join(',') })
    return answer(JSON.stringify({ points: ids.map(id => ({ id, verdict: '是', reason: '脚本化评审。' })) }))
  }

  /** The gate's feedback check: solved when the attempt follows the convention. @param {any} body */
  feedbackCheck(body) {
    const text = this.h.requestText(body)
    const task = this.caseIn(text)
    let solved = false
    if (task?.family === 'docs') {
      const tail = String(Object.values(goodOf(task).write)[0]).trim().split('\n').at(-1) ?? ''
      solved = tail !== '' && text.includes(tail)
    } else if (task !== undefined) {
      const paths = [...text.matchAll(/^### (.+)$/gm)].map(m => m[1])
      solved = paths.length > 0 && paths.every(path => !path.includes(' '))
    }
    this.requests.push({ kind: 'feedback-check', step: 0, detail: String(solved) })
    return answer(JSON.stringify({ solved, reason: solved ? 'The attempt follows the convention the user asked for.' : 'The convention the user asked for is still missing.' }))
  }

  /** @param {string} first @param {number} at */
  diagnose(first, at) {
    this.requests.push({ kind: 'diagnose', step: at })
    if (at > 0) return answer('Diagnosis reported.')
    return calls([{
      name: DIAGNOSIS_TOOL,
      arguments: {
        failureTypes: [{ category: 'task-verification', label: 'the output does not follow the convention the user stated in feedback', evidence: [this.evidence(first)] }],
        involved: { members: ['root'], tools: ['bash', 'present'], skills: [], components: [] },
        hypothesis: "Nothing in the project records the user's convention; a skill would carry it to every similar task.",
        proposalKind: 'skill',
      },
    }])
  }

  /** @param {PilotCase} task @param {number} at */
  propose(task, at) {
    const name = `${task.family}-house-rule-${[...this.skills.values()].filter(f => f === task.family).length + (at === 0 ? 1 : 0)}`
    if (at === 0) this.skills.set(name, task.family)
    const skill = [...this.skills.entries()].filter(([, family]) => family === task.family).at(-1)?.[0] ?? name
    this.requests.push({ kind: 'propose', caseId: task.id, step: at, detail: skill })
    const ref = { kind: 'skill', name: skill }
    const body = `---\nname: ${skill}\ndescription: 用户对本项目成果的一条习惯要求。\n---\n\n${/** @type {Record<string, string>} */ (SKILL_TEXT)[task.family]}\n`
    const work = this.taskSteps(task, skill)
    const script = [
      calls([{ name: 'capability_draft', arguments: { kind: 'skill', name: skill, files: [{ path: 'SKILL.md', content: body }] } }]),
      calls([{ name: 'capability_try', arguments: ref }]),
      ...work.slice(0, -1),
      calls([{ name: 'capability_propose', arguments: { components: [ref], summary: '记下用户的习惯要求。' } }]),
      answer(`Proposed ${skill}.`),
    ]
    return script[Math.min(at, script.length - 1)]
  }

  /** @param {any} body @param {string} system @param {string[]} tools @param {PilotCase} task @param {number} at */
  task(body, system, tools, task, at) {
    const skill = tools.includes('load_skill')
      ? [...this.skills.entries()].filter(([name, family]) => family === task.family && system.includes(name)).map(([name]) => name).sort().at(-1)
      : undefined
    const memory = system.includes(MEMORY_POLICY.title)
    this.requests.push({ kind: 'task', caseId: task.id, step: at, detail: skill ?? (memory ? 'memory' : undefined) })
    if (lastUserText(body).includes(PRESENT_REQUEST)) return calls([this.presentCall(task, skill !== undefined || memory)])
    const script = this.taskSteps(task, skill, memory)
    return at < script.length ? script[at] : answer('好的。')
  }

  /** @param {PilotCase} task @param {boolean} convention */
  presentCall(task, convention) {
    return { name: 'present', arguments: { paths: Object.keys(endState(task, convention).write), summary: task.id } }
  }

  /**
   * The model side of a case: (load the skill,) write the end state, present it, answer.
   * @param {PilotCase} task
   * @param {string | undefined} skill
   * @param {boolean} [memory]
   */
  taskSteps(task, skill, memory = false) {
    const convention = skill !== undefined || memory
    const load = skill === undefined ? [] : [{ name: 'load_skill', arguments: { name: skill } }]
    return [
      calls([...load, applyCall(endState(task, convention))]),
      calls([this.presentCall(task, convention)]),
      answer('做好了，成果已提交。'),
    ]
  }
}
