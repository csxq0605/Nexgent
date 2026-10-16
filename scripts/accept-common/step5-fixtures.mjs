/**
 * Fixtures of accept-step5 (docs/plan/step-5-work-partition.md §W5, round 1):
 * the feedback project and the three scripted playbooks of the improvement job.
 *
 *   project     one shop project (step5-orders.mjs): two monthly summaries (guard: another
 *               kind), one region table (fills the selection set), then the feedback task, a
 *               region table that lacks the column only the user's feedback names; every task
 *               writes one file, runs `node --test checks/<task>.test.mjs` (a test command the
 *               host re-runs as the task's check) and presents it. The checks accept the table
 *               with or without avg_order_value (and check it when present), so the
 *               deterministic checks pass on both arms and only the feedback check tells them apart
 *   feedback    FEEDBACK (step5-orders.mjs): five entries on the feedback task's table, three
 *               counted; `runFeedbackProject` submits them through `@nexgent/sdk`
 *   playbooks   what the scripted model does in the improvement session:
 *                 improve        该改进: diagnosis (task verification and termination, proposalKind
 *                                skill) → in the snapshot copy: draft and try a skill naming the
 *                                column, load it, write the table with the column, run the check,
 *                                present, propose the skill → a candidate
 *                 not-capability 不是能力问题: diagnosis with proposalKind none → no-proposal
 *                 broken         提案跑不起来: diagnosis (function-module) → draft and try a function
 *                                module whose only function throws, call it (error), propose it
 *                                (refused: never used successfully) → no candidate
 *
 * The improvement-session side follows the W0 contract (PR #104): the diagnosis is a
 * `DiagnosisReport` (fixtures spec validates it with the session package's schema), job
 * states are `IMPROVEMENT_STATUSES`; the proposal session's first message is evolve's
 * brief ending in `# The task` followed by the feedback task's own ask.
 * `capability_draft / try / propose` arguments are step 4's.
 *
 * Never calls a real model. Linux, macOS and Windows; no shell syntax in check
 * commands (`node <script> <args>` runs the same under bash and pwsh).
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONVENTION_COLUMN, countsTowardImprovement, FEEDBACK, MONTHS, ordersCsv, regionTable } from '../real-task/step5-orders.mjs'
import { expectedSummary } from '../real-task/step4-orders.mjs'
import { shellCall } from './scenario-step2.mjs'
import { registerHome } from './data-dir.mjs'
import { runTurn } from './step2-runtime.mjs'
import { createStep3Sdk } from './step3-runtime.mjs'
import { VERIFY_SOURCE as SUMMARY_VERIFY_SOURCE } from './step4-fixtures.mjs'

/** A key the scripted layers send; never a real one. */
export const SCRIPTED_API_KEY = 'sk-step5-scripted-test-key'

/** The diagnosis tool the improvement session reports through (plan §诊断). */
export const DIAGNOSIS_TOOL = 'improve_report_diagnosis'

/** MAST's three failure categories (contract `FAILURE_CATEGORIES`: 规格与系统设计、成员之间不一致、任务验证与终止). */
export const MAST = ['system-design', 'inter-agent-misalignment', 'task-verification']

/**
 * Job states (plan §触发与作业, plus the contract's `cancelled`): terminal ones end a job, parked
 * ones wait for history or an approval (they free the job slot). The fixtures spec pins them to
 * @nexgent/evolve's sets (the kernel contract's).
 */
export const JOB_STATES = ['queued', 'diagnosing', 'proposing', 'trialing', 'adopted', 'rejected', 'awaiting-approval', 'no-proposal', 'waiting-history', 'budget-exhausted', 'failed', 'interrupted', 'cancelled']
export const TERMINAL_STATES = ['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled']
export const PARKED_STATES = ['waiting-history', 'awaiting-approval']

const ordersPath = month => `data/orders-${month}.csv`
const checkPath = id => `checks/${id}.test.mjs`

/** The region table checker: base columns must match; avg_order_value is optional but checked when present. */
export const REGIONS_VERIFY_SOURCE = `// Region-table checker of the step-5 feedback project:
// node checks/regions-verify.mjs <orders.csv> <regions.csv>; exit 0 right, 1 wrong, 2 usage.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const cents = value => Math.round(value * 100) / 100
function totals(csvText) {
  const table = {}
  for (const line of String(csvText).split(/\\r?\\n/).filter(l => l.trim() !== '').slice(1)) {
    const cells = line.split(',')
    const entry = table[cells[2]] ?? (table[cells[2]] = { orders: 0, revenue: 0 })
    entry.orders += 1
    entry.revenue += Number(cells[4]) * Number(cells[5]) * (1 - Number(cells[6]))
  }
  return Object.keys(table).sort().map(region => ({ region, orders: table[region].orders, revenue: cents(table[region].revenue) }))
}

export function verify(ordersPath, outputPath) {
  if (!ordersPath || !outputPath) return { code: 2, message: 'usage: node checks/regions-verify.mjs <orders.csv> <regions.csv>' }
  let output
  try {
    output = readFileSync(outputPath, 'utf8')
  } catch {
    return { code: 1, message: 'FAIL ' + outputPath + ' does not exist' }
  }
  const lines = output.split(/\\r?\\n/).filter(l => l.trim() !== '')
  const header = (lines[0] ?? '').split(',')
  const at = name => header.indexOf(name)
  const problems = []
  for (const name of ['region', 'orders', 'revenue']) if (at(name) < 0) problems.push('column ' + name + ' is missing')
  if (problems.length === 0) {
    const want = totals(readFileSync(ordersPath, 'utf8'))
    const rows = lines.slice(1).map(l => l.split(','))
    if (rows.map(r => r[at('region')]).join() !== want.map(w => w.region).join()) problems.push('regions differ or are not sorted by name')
    const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.005
    for (const w of want) {
      const row = rows.find(r => r[at('region')] === w.region)
      if (row === undefined) continue
      if (Number(row[at('orders')]) !== w.orders) problems.push(w.region + ' orders ' + row[at('orders')] + ', expected ' + w.orders)
      if (!near(Number(row[at('revenue')]), w.revenue)) problems.push(w.region + ' revenue ' + row[at('revenue')] + ', expected ' + w.revenue)
      if (at('${CONVENTION_COLUMN}') >= 0 && !near(Number(row[at('${CONVENTION_COLUMN}')]), cents(w.revenue / w.orders))) problems.push(w.region + ' ${CONVENTION_COLUMN} ' + row[at('${CONVENTION_COLUMN}')] + ', expected ' + cents(w.revenue / w.orders))
    }
  }
  return problems.length > 0 ? { code: 1, message: 'FAIL ' + problems.join('; ') } : { code: 0, message: 'PASS ' + outputPath }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verify(...process.argv.slice(2))
  console.log(result.message)
  process.exit(result.code)
}
`

/** A task's test file (`node --test checks/<id>.test.mjs`, a test command the host re-runs). */
export function checkSource(entry) {
  const call = entry.kind === 'summary'
    ? `import { verify } from './verify.mjs'\nconst run = () => verify('summary', ${JSON.stringify(entry.input)}, ${JSON.stringify(entry.output)})`
    : `import { verify } from './regions-verify.mjs'\nconst run = () => verify(${JSON.stringify(entry.input)}, ${JSON.stringify(entry.output)})`
  return `import assert from 'node:assert/strict'
import test from 'node:test'
${call}

test(${JSON.stringify(entry.id)}, () => {
  const result = run()
  assert.equal(result.code, 0, result.message)
})
`
}

/**
 * One task of the family. The region-table ask names three columns only; neither ask
 * mentions avg_order_value or a capability tool.
 */
export function familyTask(id, kind, month, { set } = {}) {
  const output = kind === 'summary' ? `out/summary-${month}.json` : `out/regions-${month}.csv`
  const checkCommand = `node --test ${checkPath(id)}`
  const what = kind === 'summary'
    ? `Summarise the orders in ${ordersPath(month)} into ${output} (JSON: month, orders, units, revenue, byRegion, topProduct; amounts are quantity × unit_price × (1 − discount), rounded to cents)`
    : `Write the region table of ${ordersPath(month)} to ${output} (CSV with region, orders and revenue per region, sorted by region; revenue is quantity × unit_price × (1 − discount), rounded to cents)`
  return { id, kind, month, ...(set === undefined ? {} : { set }), input: ordersPath(month), output, checkCommand, ask: `${what}. Check it with \`${checkCommand}\` and present it.` }
}

/** History tasks: two summaries (guard: another kind) and one region table (fills the selection set). */
export const HISTORY_TASKS = [
  familyTask('summary-2026-06', 'summary', MONTHS.history[0], { set: 'guard' }),
  familyTask('summary-2026-07', 'summary', MONTHS.history[1], { set: 'guard' }),
  familyTask('regions-2026-08', 'regions', MONTHS.history[2], { set: 'selection' }),
]
/** The task the feedback is about; always in the selection set (plan §门控). */
export const FEEDBACK_TASK = familyTask('regions-2026-09', 'regions', MONTHS.feedback, { set: 'selection' })
/** The next task after adoption: same kind, new data, no hint of a component. */
export const NEXT_TASK = familyTask('regions-2026-10', 'regions', MONTHS.next)

/** Write the project's files: every month's orders, both checkers, every task's test file. */
export async function writeFeedbackProject(root) {
  const months = [...MONTHS.history, MONTHS.feedback, MONTHS.next]
  await mkdir(join(root, 'data'), { recursive: true })
  for (const month of months) await writeFile(join(root, ordersPath(month)), ordersCsv(month))
  await mkdir(join(root, 'checks'), { recursive: true })
  await writeFile(join(root, 'checks/verify.mjs'), SUMMARY_VERIFY_SOURCE)
  await writeFile(join(root, 'checks/regions-verify.mjs'), REGIONS_VERIFY_SOURCE)
  const tasks = [...HISTORY_TASKS, FEEDBACK_TASK, NEXT_TASK]
  for (const entry of tasks) await writeFile(join(root, checkPath(entry.id)), checkSource(entry))
  return { root, months, files: [...months.map(ordersPath), 'checks/verify.mjs', 'checks/regions-verify.mjs', ...tasks.map(entry => checkPath(entry.id))] }
}

/**
 * The file a task writes. `withAverage: false` is how the user tasks did it before the
 * feedback (the problem); `true` is the table the user wants.
 */
export function outputFor(entry, { withAverage = false } = {}) {
  const csv = ordersCsv(entry.month)
  if (entry.kind === 'regions') return regionTable(csv, { withAverage })
  return `${JSON.stringify(expectedSummary(csv), null, 2)}\n`
}

/** Run a task's test command in `root` the way a replay re-runs it. */
export function runCheck(root, entry) {
  const [, ...args] = entry.checkCommand.split(' ')
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: run.status, passed: run.status === 0, stdout: run.stdout.trim() }
}

const usage = { inputTokens: 40, outputTokens: 12 }

/** Scripted entries for user tasks: write → test command → present → answer (tables without the column). */
export function taskScript(h, tasks, { withAverage = false } = {}) {
  const lead = []
  for (const entry of tasks) {
    const mine = body => h.requestText(body).includes(entry.ask)
    lead.push(
      h.expectRequest(`${entry.id}: task`, mine, { toolCalls: [{ name: 'write_file', arguments: { path: entry.output, content: outputFor(entry, { withAverage }) } }], usage }),
      h.expectRequest(`${entry.id}: written`, mine, { toolCalls: [shellCall({ bash: entry.checkCommand, pwsh: entry.checkCommand })], usage }),
      h.expectRequest(`${entry.id}: checked`, mine, { toolCalls: [{ name: 'present', arguments: { paths: [entry.output], summary: `${entry.kind} for ${entry.month}` } }], usage }),
      h.expectRequest(`${entry.id}: presented`, mine, { content: `${entry.output} presented.`, usage }),
    )
  }
  return lead
}

/** Scripted answers to feedback turns: one plain acknowledgement each (the table is not revised). */
export function feedbackScript(h, feedback) {
  return feedback.map(entry => h.expectRequest(`feedback ${entry.key}`, body => h.requestText(body).includes(entry.comment), { content: 'Noted.', usage }))
}

// ---- playbooks -----------------------------------------------------------------------------

/** The skill the 该改进 playbook drafts: the user's region-table convention. */
export const CONVENTION_SKILL = {
  kind: 'skill',
  name: 'region-table-convention',
  files: [{
    path: 'SKILL.md',
    content: `---
name: region-table-convention
description: The shop's region table always carries the average order value per region.
---

When writing a region table from the order CSV:

1. Columns: region, orders, revenue, ${CONVENTION_COLUMN}; rows sorted by region.
2. revenue = sum of quantity × unit_price × (1 − discount), rounded to cents.
3. ${CONVENTION_COLUMN} = revenue / orders, rounded to cents. The user asks for this column every month even when the task does not name it.
4. Run the project's check command before presenting.
`,
  }],
}

/** The function module the 提案跑不起来 playbook drafts: its only function throws. */
export const BROKEN_MODULE = {
  kind: 'function-module',
  name: 'region-table',
  function: 'regionTable',
  /** `functionToolName('region-table', 'regionTable')`; the fixtures spec checks it against the kernel. */
  tool: 'cap_region-table_regionTable',
  files: [
    {
      path: 'functions.json',
      content: `${JSON.stringify({
        formatVersion: 1,
        name: 'region-table',
        description: 'Region table of the shop\'s order CSV, with the average order value.',
        entry: 'index.mjs',
        functions: [{
          name: 'regionTable',
          description: 'Region table (region, orders, revenue, avg_order_value) of the order CSV. Pass the CSV text.',
          inputSchema: { type: 'object', additionalProperties: false, required: ['csvText'], properties: { csvText: { type: 'string', description: 'The whole order CSV, header included.' } } },
          effects: [],
        }],
      }, null, 2)}\n`,
    },
    { path: 'index.mjs', content: 'export function regionTable() {\n  throw new Error(\'region-table: not finished\')\n}\n' },
  ],
}

const ref = component => ({ kind: component.kind, name: component.name })

/**
 * The diagnosis a playbook reports (contract `DiagnosisReport`, the input of
 * `improve_report_diagnosis`). `memberCosts` is left to the host (it sums the ledger).
 * @param ctx - `{ sessionId, turn, seq }` of the feedback record the evidence cites.
 */
function diagnosis(proposalKind, hypothesis, ctx, category = MAST[2]) {
  return {
    failureTypes: [{ category, label: category === MAST[2] ? 'output not checked against the user\'s convention' : 'requirement changed after delivery', evidence: [{ sessionId: ctx.sessionId, seq: ctx.seq, turn: ctx.turn }] }],
    involved: { members: ['root'], tools: ['write_file', 'present'], skills: [], components: [] },
    hypothesis,
    proposalKind,
  }
}

/**
 * The three playbooks. `steps` is the improvement session's model side in order:
 * `{ phase, toolCalls }` or `{ phase, content }`. `expect` is what the judges check
 * after the job: whether a candidate exists, its one component, the job's end state
 * family, and that the adopted version is unchanged before the gate.
 */
export function playbook(name, ctx) {
  if (name === 'improve') {
    const table = outputFor(FEEDBACK_TASK, { withAverage: true })
    return {
      name, title: '该改进',
      steps: [
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: diagnosis('skill', `The region table lacks the ${CONVENTION_COLUMN} column the user expects every month; nothing in the project records that convention.`, ctx) }] },
        { phase: 'diagnose', content: 'Diagnosis reported.' },
        { phase: 'propose', toolCalls: [{ name: 'capability_draft', arguments: { kind: CONVENTION_SKILL.kind, name: CONVENTION_SKILL.name, files: CONVENTION_SKILL.files } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_try', arguments: ref(CONVENTION_SKILL) }] },
        { phase: 'propose', toolCalls: [{ name: 'load_skill', arguments: { name: CONVENTION_SKILL.name } }] },
        { phase: 'propose', toolCalls: [{ name: 'write_file', arguments: { path: FEEDBACK_TASK.output, content: table } }] },
        { phase: 'propose', toolCalls: [shellCall({ bash: FEEDBACK_TASK.checkCommand, pwsh: FEEDBACK_TASK.checkCommand })] },
        { phase: 'propose', toolCalls: [{ name: 'present', arguments: { paths: [FEEDBACK_TASK.output], summary: 'region table with the average order value' } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_propose', arguments: { components: [ref(CONVENTION_SKILL)], summary: `Region tables carry ${CONVENTION_COLUMN}.` } }] },
        { phase: 'propose', content: 'Proposed the region-table convention skill.' },
      ],
      expect: { candidate: true, component: ref(CONVENTION_SKILL), outcome: 'trialing', output: table },
    }
  }
  if (name === 'not-capability') {
    return {
      name, title: '不是能力问题',
      steps: [
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: diagnosis('none', 'The feedback changes what the user wants this month; no capability was missing.', ctx, MAST[0]) }] },
        { phase: 'diagnose', content: 'Diagnosis reported: not a capability problem.' },
      ],
      expect: { candidate: false, outcome: 'no-proposal' },
    }
  }
  if (name === 'broken') {
    return {
      name, title: '提案跑不起来',
      steps: [
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: diagnosis('function-module', 'A region-table function would add the missing column every month.', ctx) }] },
        { phase: 'diagnose', content: 'Diagnosis reported.' },
        { phase: 'propose', toolCalls: [{ name: 'capability_draft', arguments: { kind: BROKEN_MODULE.kind, name: BROKEN_MODULE.name, files: BROKEN_MODULE.files } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_try', arguments: ref(BROKEN_MODULE) }] },
        { phase: 'propose', toolCalls: [{ name: BROKEN_MODULE.tool, arguments: { csvText: ordersCsv(FEEDBACK_TASK.month) } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_propose', arguments: { components: [ref(BROKEN_MODULE)], summary: 'Region table function.' } }] },
        { phase: 'propose', content: 'The function failed; nothing to propose.' },
      ],
      // A component never used successfully cannot be proposed (step 4 rule); the job ends without a candidate.
      expect: { candidate: false, outcome: ['no-proposal', 'failed'] },
    }
  }
  if (name === 'invalid') {
    // Three reports the host refuses: a category outside MAST (the tool's own schema), evidence citing a
    // record the session does not have, evidence citing a session the project does not have.
    const report = failure => ({ ...diagnosis('skill', 'The table lacks a column.', ctx), failureTypes: [{ category: MAST[2], label: 'missing column', ...failure }] })
    return {
      name, title: '诊断不合 schema',
      steps: [
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: report({ category: 'not-a-category', evidence: [{ sessionId: ctx.sessionId, seq: ctx.seq, turn: ctx.turn }] }) }] },
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: report({ evidence: [{ sessionId: ctx.sessionId, seq: 99_999 }] }) }] },
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: report({ evidence: [{ sessionId: MISSING_SESSION, seq: 1 }] }) }] },
        { phase: 'diagnose', content: 'I could not produce an acceptable diagnosis.' },
      ],
      expect: { candidate: false, outcome: 'failed' },
    }
  }
  if (name === 'two') {
    // Two skills, both tried and loaded, proposed together: an improvement job proposes exactly one.
    const second = { kind: 'skill', name: SECOND_SKILL.name, files: SECOND_SKILL.files }
    return {
      name, title: '多于一个组件',
      steps: [
        { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: diagnosis('skill', `The region table lacks the ${CONVENTION_COLUMN} column the user expects every month.`, ctx) }] },
        { phase: 'diagnose', content: 'Diagnosis reported.' },
        { phase: 'propose', toolCalls: [{ name: 'capability_draft', arguments: { kind: CONVENTION_SKILL.kind, name: CONVENTION_SKILL.name, files: CONVENTION_SKILL.files } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_draft', arguments: second }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_try', arguments: ref(CONVENTION_SKILL) }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_try', arguments: ref(second) }] },
        { phase: 'propose', toolCalls: [{ name: 'load_skill', arguments: { name: CONVENTION_SKILL.name } }] },
        { phase: 'propose', toolCalls: [{ name: 'load_skill', arguments: { name: second.name } }] },
        { phase: 'propose', toolCalls: [{ name: 'write_file', arguments: { path: FEEDBACK_TASK.output, content: outputFor(FEEDBACK_TASK, { withAverage: true }) } }] },
        { phase: 'propose', toolCalls: [{ name: 'present', arguments: { paths: [FEEDBACK_TASK.output], summary: 'region table with the average order value' } }] },
        { phase: 'propose', toolCalls: [{ name: 'capability_propose', arguments: { components: [ref(CONVENTION_SKILL), ref(second)], summary: 'Region table convention and a note.' } }] },
        { phase: 'propose', content: 'Proposed two skills.' },
      ],
      expect: { candidate: false, outcome: 'failed' },
    }
  }
  throw new Error(`unknown playbook ${name}`)
}

/** A session id no project has (the 诊断不合 schema playbook cites it). */
export const MISSING_SESSION = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d'

/** The second skill of the 多于一个组件 playbook. */
export const SECOND_SKILL = {
  kind: 'skill',
  name: 'region-table-notes',
  files: [{ path: 'SKILL.md', content: '---\nname: region-table-notes\ndescription: Notes on the shop\'s region tables.\n---\n\nRegions are sorted by name.\n' }],
}

/** The plan's three playbooks, in the order the plan lists them. */
export const PLAYBOOKS = ['improve', 'not-capability', 'broken']

/** Two more failure cases: a diagnosis refused three times (H05), a proposal of two components (H07). */
export const EXTRA_PLAYBOOKS = ['invalid', 'two']

/** The first line of evolve's proposal brief (`proposalBrief`); the task's own ask follows `# The task`. */
export const PROPOSAL_MARKER = '# Improvement job'

const toolsOf = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)

/** A request of the improvement session's diagnosis phase: the diagnosis tool is offered. */
export const isDiagnosisRequest = body => toolsOf(body).includes(DIAGNOSIS_TOOL)

/**
 * A request of the proposal phase: the redo of the feedback task in the snapshot copy
 * (evolve's brief, then the task's ask) with the capability tools offered.
 */
export const isProposalRequest = h => body => toolsOf(body).includes('capability_draft') && h.requestText(body).includes(PROPOSAL_MARKER) && h.requestText(body).includes(FEEDBACK_TASK.ask)

/** Scripted entries for a playbook: diagnosis steps on diagnosis requests, proposal steps on proposal requests. */
export function playbookScript(h, name, ctx) {
  const book = playbook(name, ctx)
  return book.steps.map((step, index) => h.expectRequest(
    `${name} ${step.phase} ${index + 1}`,
    step.phase === 'diagnose' ? isDiagnosisRequest : isProposalRequest(h),
    step.toolCalls === undefined ? { content: step.content, usage } : { toolCalls: step.toolCalls, usage },
  ))
}

/**
 * Drive the history tasks, the feedback task and the feedback through `@nexgent/sdk`
 * in a fresh project (scripted model only). What an improvement job starts from.
 * @param h - the loaded test-support harness.
 * @param pkgs - from `loadStep3Packages()` (or step 5's).
 * @param options - `feedback` (default FEEDBACK), `log`; `config` (written to
 *   `.nexgent/config.json` before the project opens, as a user would); `createSdk(env, home)`
 *   (default: step 3's SDK); `server` (a scripted server the caller owns and closes; default one
 *   scripted with `taskScript` and `feedbackScript`); `tasks` (default the history tasks, then the
 *   feedback task; the feedback goes to the last one); `beforeFeedback(ctx)` and `afterFeedback(entry, ctx)` hooks, whose
 *   results are kept as `obs.before` and each feedback entry's `observed`
 *   (`ctx`: `{ sdk, projectId, root, feedbackSession, id? }`); `home` (the NEXGENT_HOME the
 *   project opens under; default `<work>/home`; pass another project's to share one user).
 * @returns `{ root, home, projectId, tasks, deliverable, deliverables, feedback, listing }`; each
 *   feedback entry carries the oracle's `counted` and the feedback turn's end reason.
 */
export async function runFeedbackProject(h, pkgs, work, options = {}) {
  const { feedback = FEEDBACK, log = () => undefined, config, beforeFeedback, afterFeedback } = options
  const root = join(work, 'project')
  const home = options.home ?? join(work, 'home')
  await mkdir(root, { recursive: true })
  await writeFeedbackProject(root)
  if (config !== undefined) {
    await mkdir(join(root, '.nexgent'), { recursive: true })
    await writeFile(join(root, '.nexgent', 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  }
  const tasks = options.tasks ?? [...HISTORY_TASKS, FEEDBACK_TASK]
  const own = options.server === undefined
  const server = own ? await h.scriptedModelServer({ script: [...taskScript(h, tasks), ...feedbackScript(h, feedback)] }) : options.server
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  registerHome(root, home)
  const sdk = options.createSdk === undefined ? createStep3Sdk(pkgs, { env, home }) : options.createSdk(env, home)
  const obs = { root, home, tasks: [], feedback: [] }
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    obs.projectId = projectId
    for (const entry of tasks) {
      log(`task ${entry.id}`)
      const { sessionId } = await sdk.call('sessions.create', { projectId, title: entry.id })
      const { result, error } = await runTurn(sdk, { projectId, sessionId, text: entry.ask })
      obs.tasks.push({
        id: entry.id,
        set: entry.set,
        sessionId,
        reason: result?.reason,
        error: error === undefined ? undefined : String(error),
        output: await readFile(join(root, entry.output), 'utf8').catch(() => null),
        check: runCheck(root, entry),
      })
    }
    const feedbackSession = obs.tasks.at(-1).sessionId
    const deliverables = await sdk.call('deliverables.list', { projectId })
    obs.deliverables = deliverables.map(d => d.versions?.at(-1)).filter(Boolean).map(v => ({ deliverableId: v.deliverableId, version: v.version, sessionId: v.sessionId }))
    obs.deliverable = obs.deliverables.find(d => d.sessionId === feedbackSession)
    const ctx = { sdk, projectId, root, feedbackSession }
    if (beforeFeedback !== undefined) obs.before = await beforeFeedback(ctx)
    if (obs.deliverable !== undefined) {
      for (const entry of feedback) {
        log(`feedback ${entry.key}`)
        const events = []
        const unsubscribe = sdk.onAgentEvent(event => { if (event.projectId === projectId && event.sessionId === feedbackSession) events.push(event) })
        try {
          await sdk.call('feedback.submit', {
            projectId, sessionId: feedbackSession, deliverableId: obs.deliverable.deliverableId, version: obs.deliverable.version,
            ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment,
          })
          await h.waitFor(() => events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, feedbackSession), { timeoutMs: 60_000, intervalMs: 20, label: `feedback ${entry.key}` })
        } finally {
          unsubscribe()
        }
        const id = (await sdk.call('feedback.list', { projectId, sessionId: feedbackSession })).find(l => l.comment === entry.comment)?.id
        const record = { key: entry.key, rating: entry.rating, comment: entry.comment, counted: countsTowardImprovement(entry), reason: events.find(e => e.type === 'turn.end')?.reason, id }
        if (afterFeedback !== undefined) record.observed = await afterFeedback(entry, { ...ctx, id })
        obs.feedback.push(record)
      }
    }
    obs.listing = await sdk.call('feedback.list', { projectId })
  } finally {
    await sdk.dispose()
    if (own) await server.close()
  }
  return obs
}
