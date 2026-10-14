// @ts-check
/**
 * The scripted model of the step-6 experiment rehearsal (W6 part 2): one object answers
 * every request the experiment's processes send to the local scripted server — user
 * tasks and feedback turns, improvement jobs (diagnose, propose), the gate's replays,
 * feedback check and review, meta jobs (meta diagnose, meta propose) and the comparison
 * arms' jobs. Never calls a real model.
 *
 * What it does, so the rehearsal exercises every branch of the report:
 *
 *   task        a planned case's message opens the session: do the task right; follow the
 *               user's convention only when a skill that covers this case is offered
 *               (tables: the avg_order_value column; code: the matching test file per
 *               changed module); later turns (feedback) get "Noted."
 *   diagnose    report a missing skill. The hypothesis says the skill's scope: narrow (only
 *               the kind of task the feedback was about) with the default improver, general
 *               (every task of the family) when the improver carries {@link CHILD_PARAGRAPH}
 *   propose     draft that skill, try it, redo the task with it, propose it
 *   feedback    "solved" when the attempt shows the convention
 *   review      always a tie
 *   meta        list the jobs, report one finding about narrow skills, then propose appending
 *               {@link CHILD_PARAGRAPH} to the diagnosis policy
 *
 * So base (no skill) misses the convention everywhere, parent (narrow skills) only where the
 * dev tasks' variants come back, child (general skill) everywhere. That is a scripted
 * outcome, chosen to show the report end to end; it says nothing about a real model.
 */
import { CONVENTION_COLUMN } from './tables.mjs'
import { codeParams, referenceSolution, renderProject } from './code.mjs'
import { PRESENT_REQUEST } from './cases.mjs'
import { referenceTable, expectedSummary } from './tables.mjs'

/** The paragraph the scripted meta proposal appends to the diagnosis policy. */
export const CHILD_PARAGRAPH = 'When the user states a convention in feedback, record it so that it covers every similar task of the project, not only the kind of task the feedback was about.'

/** Usage of every scripted answer: all four billed fields known (the gate refuses unknown costs). */
export const USAGE = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }

const DIAGNOSIS_TOOL = 'improve_report_diagnosis'
const PROPOSAL_MARKER = '# Improvement job'
const GENERAL = '[scope: every task of this kind of work]'
const NARROW = '[scope: the kind of task the feedback was about]'
const TEST_MARKER = 'exports what the task asked for'

/**
 * @typedef {import('./cases.mjs').TaskCase} TaskCase
 * @typedef {{ name: string, family: string, scope: string[] }} SkillScope
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

/** Every text of a request (system, messages, tool results), for marker searches. @param {any} body */
function allText(body) {
  return JSON.stringify(body ?? {})
}

/** The shell call that runs a command (bash, or pwsh on Windows). @param {string} command */
function shell(command) {
  return process.platform === 'win32' ? { name: 'pwsh', arguments: { command } } : { name: 'bash', arguments: { command } }
}

/** SKILL.md of a convention skill. @param {SkillScope} skill */
function skillFile(skill) {
  const what = skill.family === 'tables'
    ? `Every grouped table (one row per region or product) also carries ${CONVENTION_COLUMN} = revenue / orders, rounded to cents, as its last column.`
    : 'Every module changed or added under src/ (index.js aside) gets a new or changed test/<module>.test.js that imports it; amounts stay integer cents.'
  const scope = skill.scope.join(', ')
  return `---\nname: ${skill.name}\ndescription: The user's convention for ${skill.family === 'tables' ? 'tables' : 'code changes'} (${scope}).\n---\n\n${what}\n\nApplies to: ${scope}.\n`
}

/**
 * Code files the reference solution changes (with the tests when `withTests`).
 * @param {TaskCase} task
 * @param {boolean} withTests
 */
function changedFiles(task, withTests) {
  const hidden = /** @type {any} */ (task.hidden)
  const p = codeParams(hidden.seed)
  const original = renderProject(p, { bug: hidden.variant === 'bugfix' ? p.bug : null })
  const solved = referenceSolution(task, { withTests })
  return Object.keys(solved).filter(path => solved[path] !== original[path]).sort()
}

/**
 * The `present` call for a case: the table, or the code files the reference solution changes.
 * @param {TaskCase} task
 * @param {string[]} [changed]
 */
function presentCall(task, changed) {
  const hidden = /** @type {any} */ (task.hidden)
  if (task.family === 'tables') return { name: 'present', arguments: { paths: [hidden.output], summary: `${hidden.variant} ${hidden.month}` } }
  const files = changed ?? changedFiles(task, false)
  return { name: 'present', arguments: { paths: files.map(path => `${hidden.dir}/${path}`), summary: `${hidden.variant} in ${hidden.dir}` } }
}

export class ExperimentModel {
  /**
   * @param {any} h the loaded test-support harness (`requestText`)
   * @param {{ cases: TaskCase[], evidence: (text: string) => { sessionId: string, seq: number, turn?: number } }} options
   *   `evidence` finds the record a diagnosis cites from the diagnose prompt
   */
  constructor(h, { cases, evidence }) {
    this.h = h
    this.cases = [...cases].sort((a, b) => b.message.length - a.message.length)
    this.evidence = evidence
    /** @type {Map<string, SkillScope>} */
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
    if (system.includes('You check one attempt')) return this.feedbackCheck(body)
    if (system.includes('quality gate')) {
      this.requests.push({ kind: 'review', step: at })
      return answer(JSON.stringify({ better: 'tie', reason: 'Both attempts are the same.' }))
    }
    if (tools.includes('improve_report_meta_diagnosis')) return this.metaDiagnose(body, at)
    if (tools.includes('improve_propose_change')) return this.metaPropose(body, at)
    if (tools.includes(DIAGNOSIS_TOOL)) return this.diagnose(body, first, at)
    const task = this.caseIn(first)
    if (first.includes(PROPOSAL_MARKER) && task !== undefined) return this.propose(body, first, task, at)
    if (task === undefined) {
      this.requests.push({ kind: 'other', step: at })
      return answer('Done.')
    }
    return this.task(body, system, tools, task, at)
  }

  /** @param {any} body */
  feedbackCheck(body) {
    const text = this.h.requestText(body)
    const solved = new RegExp(`(revenue|return_rate),${CONVENTION_COLUMN}`).test(text) || text.includes(TEST_MARKER)
    this.requests.push({ kind: 'feedback-check', step: 0, detail: String(solved) })
    return answer(JSON.stringify({ solved, reason: solved ? 'The attempt follows the convention the user asked for.' : 'The convention the user asked for is still missing.' }))
  }

  /** @param {any} body @param {string} first @param {number} at */
  diagnose(body, first, at) {
    const general = allText(body).includes(CHILD_PARAGRAPH)
    this.requests.push({ kind: 'diagnose', step: at, detail: general ? 'general' : 'narrow' })
    if (at > 0) return answer('Diagnosis reported.')
    const evidence = this.evidence(first)
    return calls([{
      name: DIAGNOSIS_TOOL,
      arguments: {
        failureTypes: [{ category: 'task-verification', label: 'the output does not follow the convention the user stated in feedback', evidence: [evidence] }],
        involved: { members: ['root'], tools: ['write_file', 'present'], skills: [], components: [] },
        hypothesis: `Nothing in the project records the user's convention; a skill would carry it. ${general ? GENERAL : NARROW}`,
        proposalKind: 'skill',
      },
    }])
  }

  /** The skill a propose session drafts for a case. @param {TaskCase} task @param {boolean} general */
  skillFor(task, general) {
    const family = task.family
    const all = family === 'tables' ? ['region', 'category', 'returns'] : ['bugfix', 'feature', 'refactor']
    /** @type {SkillScope} */
    const skill = general
      ? { name: `${family}-convention-all`, family, scope: all }
      : { name: `${family}-convention-${task.variant}-${String(task.seed).replace(/[^0-9a-z]/gi, '')}`, family, scope: [task.variant] }
    return skill
  }

  /** @param {any} body @param {string} first @param {TaskCase} task @param {number} at */
  propose(body, first, task, at) {
    const general = first.includes(GENERAL) || allText(body).includes(GENERAL)
    const skill = this.skillFor(task, general)
    this.skills.set(skill.name, skill)
    this.requests.push({ kind: 'propose', caseId: task.id, step: at, detail: skill.name })
    const ref = { kind: 'skill', name: skill.name }
    const work = this.taskSteps(task, skill.name)
    const script = [
      calls([{ name: 'capability_draft', arguments: { kind: 'skill', name: skill.name, files: [{ path: 'SKILL.md', content: skillFile(skill) }] } }]),
      calls([{ name: 'capability_try', arguments: ref }]),
      ...work.slice(0, -1),
      calls([{ name: 'capability_propose', arguments: { components: [ref], summary: `Record the user's convention (${skill.scope.join(', ')}).` } }]),
      answer(`Proposed ${skill.name}.`),
    ]
    return script[Math.min(at, script.length - 1)]
  }

  /** @param {any} body @param {string} system @param {string[]} tools @param {TaskCase} task @param {number} at */
  task(body, system, tools, task, at) {
    const offered = tools.includes('load_skill')
      ? [...this.skills.values()].find(skill => skill.family === task.family && skill.scope.includes(task.variant) && system.includes(skill.name))
      : undefined
    this.requests.push({ kind: 'task', caseId: task.id, step: at, detail: offered?.name })
    if (lastUserText(body).includes(PRESENT_REQUEST)) return calls([presentCall(task)])
    const script = this.taskSteps(task, offered?.name)
    return at < script.length ? script[at] : answer('Noted.')
  }

  /**
   * The model side of doing a case: write (with the convention when `skill` is given, after
   * loading it), check (code: the visible tests), present, answer.
   * @param {TaskCase} task
   * @param {string | undefined} skill
   */
  taskSteps(task, skill) {
    const load = skill === undefined ? [] : [{ name: 'load_skill', arguments: { name: skill } }]
    const hidden = /** @type {any} */ (task.hidden)
    if (task.family === 'tables') {
      const content = hidden.variant === 'summary'
        ? `${JSON.stringify(expectedSummary(hidden.month), null, 2)}\n`
        : referenceTable(hidden.variant, hidden.month, { withConvention: skill !== undefined, hard: hidden.hard === true })
      return [
        calls([...load, { name: 'write_file', arguments: { path: hidden.output, content } }]),
        calls([presentCall(task)]),
        answer(`${hidden.output} presented.`),
      ]
    }
    const p = codeParams(hidden.seed)
    const original = renderProject(p, { bug: hidden.variant === 'bugfix' ? p.bug : null })
    const solved = referenceSolution(task, { withTests: skill !== undefined })
    const changed = Object.keys(solved).filter(path => solved[path] !== original[path]).sort()
    const edits = changed.map(path => (original[path] === undefined
      ? { name: 'write_file', arguments: { path: `${hidden.dir}/${path}`, content: solved[path] } }
      : { name: 'str_replace', arguments: { path: `${hidden.dir}/${path}`, old_str: original[path], new_str: solved[path] } }))
    // Like the real model: code edits in place are presented only when a skill says so or the user asks.
    return [
      calls([...load, ...edits]),
      calls([shell(`node --test '${hidden.dir}/test/*.test.js'`)]),
      ...(skill === undefined ? [] : [calls([presentCall(task, changed)])]),
      answer(`Changed ${changed.length} files in ${hidden.dir}.`),
    ]
  }

  /** @param {any} body @param {number} at */
  metaDiagnose(body, at) {
    this.requests.push({ kind: 'meta-diagnose', step: at })
    if (at === 0) return calls([{ name: 'improve_list_jobs', arguments: {} }])
    if (at === 1) {
      // Job ids are the `id` fields of the listed jobs (the list also carries other ids).
      const listed = this.h.requestText(body).matchAll(/\\?"id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/g)
      const ids = [...new Set([...listed].map(m => m[1]))]
      return calls([{
        name: 'improve_report_meta_diagnosis',
        arguments: {
          findings: [{ stage: 'diagnose', label: 'each job records the convention only for the kind of task its feedback was about', jobIds: ids.slice(0, 2) }],
          hypothesis: 'A diagnosis policy that asks for conventions covering every similar task would need fewer jobs.',
          proposal: 'change',
        },
      }])
    }
    return answer('Meta diagnosis reported.')
  }

  /** @param {any} body @param {number} at */
  metaPropose(body, at) {
    this.requests.push({ kind: 'meta-propose', step: at })
    if (at === 0) return calls([{ name: 'improve_read_improver', arguments: {} }])
    if (at === 1) {
      const index = Number(/append with index = (\d+)/.exec(this.h.requestText(body))?.[1] ?? 0)
      return calls([{ name: 'improve_propose_change', arguments: { change: { op: 'set-diagnosis-paragraph', index, text: CHILD_PARAGRAPH }, rationale: 'Conventions should cover every similar task.' } }])
    }
    return answer('Change proposed.')
  }
}
