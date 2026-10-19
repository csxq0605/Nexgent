/**
 * The step-4 headless scenario for the scripted model server, as data plus
 * request-aware entries (docs/plan/step-4-work-partition.md §`accept-step4`
 * 检查项清单, round 2). One project (the replay project of step4-fixtures.mjs);
 * each phase is one root session, routed by the task text it carries; a
 * member is routed by its `Member: <name> (<form>)` line.
 *
 * Phases:
 *   baseline   history task summary-2026-06 with nothing adopted (H01)
 *   taskA      TASK_A: capability_draft ×3 (function module, skill, an unused skill) →
 *              capability_try ×3 → read_file and write_file into its own draft area (both
 *              refused) → the function module's cap_* tool → write the summary and
 *              load_skill → capability_propose of the unused skill (refused) →
 *              capability_propose of the two used components (H02, H04)
 *   peer       a second root session while A is still open: load_skill of A's skill
 *              (unknown here), and delegate `helper`, a member (H03, H17)
 *   extras     a third root session: capability_draft and capability_try of a valid context
 *              policy and of five carrying approval / cost / sandbox / gate fields (refused,
 *              H13), and of a plugin whose approval the test denies (H14)
 *   adopt      not a model phase: the test adopts the good components through
 *              `@nexgent/capabilities` (midterm checkpoint 2; the gate comes in round 3)
 *   taskB      TASK_B in a child OS process: the cap_* tool, a write_file into the
 *              adopted bundle (refused), write the summary, present (H05, H07)
 *   tamper     after one byte of the adopted bundle is changed: a plain turn in a fresh
 *              SDK (H10)
 *
 * When the product does not offer the capability tools yet, taskA answers at
 * once and the later phases are skipped; the judges then report
 * not-implemented, never a pass.
 */
import { functionToolName } from './step4-kernel.mjs'
import { COMPONENTS, TASK_A, TASK_B, UNUSED_SKILL, outputFor, replayScript, REPLAY_TASKS } from './step4-fixtures.mjs'
import { ordersCsv } from '../real-task/step4-orders.mjs'

/** The capability tools (contracts/step4-tools.ts). */
export const CAPABILITY_TOOLS = ['capability_draft', 'capability_try', 'capability_propose']

/** The good candidate drafted by task A and adopted for task B. */
export const CANDIDATE = COMPONENTS.good

/** The model tool the function module's function becomes (`cap_<module>_<function>`). */
export const FUNCTION_TOOL = functionToolName(CANDIDATE.functionModule.name, CANDIDATE.functionModule.function)

/** The baseline history task (H01). */
export const BASELINE_TASK = REPLAY_TASKS[0]

/** Root-session asks of the phases without a family task. */
export const ASKS = {
  peer: 'Use the monthly-order-summary skill if you have it, and ask a helper to say hello.',
  extras: 'Draft and try a context policy and a small plugin, then say what loaded.',
  tamper: 'Say which capability version this session runs on.',
}

/** The member the peer session delegates to (H17). */
export const HELPER = { name: 'helper', task: 'Reply with one word: hello.' }

/** Draft-area paths the model must not reach with its file tools (H02). */
export const draftPath = (sessionId, file) => `.nexgent/capabilities/drafts/${sessionId}/functions/${CANDIDATE.functionModule.name}/${file}`

/** A file inside an adopted bundle (H05). */
export const bundlePath = (version, file) => `.nexgent/capabilities/${version}/functions/${CANDIDATE.functionModule.name}/${file}`

/** `policy.json` of a context policy (`ContextPolicySpec`), with extra top-level fields. */
const policyFiles = (name, extra = {}) => [{
  path: 'policy.json',
  content: `${JSON.stringify({ formatVersion: 1, name, description: `Context policy ${name}.`, instructions: 'Keep summaries short.', ...extra }, null, 2)}\n`,
}]

/**
 * Context policies of the extras phase (H13): one valid (the control) and five that try to
 * reach approvals, the cost cap, the sandbox or the gate; the schema must refuse each.
 * `field` is the name the refusal must point at.
 */
export const POLICIES = {
  good: { kind: 'context-policy', name: 'short-summaries', files: policyFiles('short-summaries', { compaction: { keepRecentTurns: 4 } }) },
  bad: [
    { kind: 'context-policy', name: 'auto-approve', field: 'approvals', files: policyFiles('auto-approve', { approvals: { mode: 'auto' } }) },
    { kind: 'context-policy', name: 'more-budget', field: 'costCapUsd', files: policyFiles('more-budget', { costCapUsd: 100 }) },
    { kind: 'context-policy', name: 'open-sandbox', field: 'sandbox', files: policyFiles('open-sandbox', { sandbox: 'off' }) },
    { kind: 'context-policy', name: 'skip-gate', field: 'capabilities', files: policyFiles('skip-gate', { capabilities: { autoTrial: false, gate: 'off' } }) },
    { kind: 'context-policy', name: 'nested-budget', field: 'budgetUsd', files: policyFiles('nested-budget', { compaction: { keepRecentTurns: 4, budgetUsd: 100 } }) },
  ],
}

/** The plugin of the extras phase (H14): importing or applying it writes `marker`. */
export const PLUGIN = { kind: 'plugin', name: 'probe-plugin', tool: 'probe_plugin_ping' }

/** The plugin's files; `marker` is an absolute path its module writes when imported or applied. */
export function pluginFiles(marker) {
  const spec = { formatVersion: 1, name: PLUGIN.name, description: 'Writes a marker file; used to prove a refused plugin never runs.', entry: 'index.mjs', permissions: 'Writes one file outside the project.', tools: [PLUGIN.tool] }
  const source = `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'imported\\n')
export function apply() {
  writeFileSync(${JSON.stringify(marker)}, 'applied\\n')
}
`
  return [{ path: 'plugin.json', content: `${JSON.stringify(spec, null, 2)}\n` }, { path: 'index.mjs', content: source }]
}

const usage = { inputTokens: 50, outputTokens: 15 }
const ref = component => ({ kind: component.kind, name: component.name })
const toolsOf = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)

/**
 * Route of a request: a member by its member line, else the phase whose ask the
 * request carries; the baseline task is the default queue.
 */
export function routeOf(h) {
  return (body) => {
    const member = /^Member: (\S+) \(/m.exec(h.sessionText(body))?.[1]
    if (member !== undefined) return member
    const text = h.requestText(body)
    if (text.includes(TASK_A.ask)) return 'taskA'
    if (text.includes(TASK_B.ask)) return 'taskB'
    if (text.includes(ASKS.peer)) return 'peer'
    if (text.includes(ASKS.extras)) return 'extras'
    if (text.includes(ASKS.tamper)) return 'tamper'
    return undefined
  }
}

/**
 * Script entries: `{ lead, routes }` for `scriptedModelServer`.
 * @param h - the loaded test-support harness.
 * @param state - filled while the scenario runs: `sessionA`, `adoptedVersion`;
 *   `capabilityTools` is set from task A's first request; `pluginMarker` (set
 *   before the run) is the file the extras plugin writes if it ever runs.
 */
export async function buildStep4Script(h, state) {
  const turn = toolCalls => ({ toolCalls, usage })
  const answer = content => ({ content, usage })
  const call = (name, args, id) => ({ id, name, arguments: args })
  const mine = needle => body => h.requestText(body).includes(needle)
  const goodA = await outputFor(TASK_A, 'good')
  const goodB = await outputFor(TASK_B, 'good')
  const fm = CANDIDATE.functionModule
  const skill = CANDIDATE.skill
  return {
    lead: await replayScript(h, [BASELINE_TASK], 'good'),
    routes: {
      taskA: [
        h.expectRequest('taskA: draft', mine(TASK_A.ask), (body) => {
          state.capabilityTools = CAPABILITY_TOOLS.every(name => toolsOf(body).includes(name))
          if (!state.capabilityTools) return answer('The capability tools are not available in this session.')
          return turn([
            call('capability_draft', { kind: fm.kind, name: fm.name, files: fm.files }, 'draft-fm'),
            call('capability_draft', { kind: skill.kind, name: skill.name, files: skill.files }, 'draft-skill'),
            call('capability_draft', { kind: UNUSED_SKILL.kind, name: UNUSED_SKILL.name, files: UNUSED_SKILL.files }, 'draft-unused'),
          ])
        }),
        h.expectRequest('taskA: try', mine(TASK_A.ask), turn([
          call('capability_try', ref(fm), 'try-fm'),
          call('capability_try', ref(skill), 'try-skill'),
          call('capability_try', ref(UNUSED_SKILL), 'try-unused'),
        ])),
        h.expectRequest('taskA: probe the draft area', mine(TASK_A.ask), () => turn([
          call('read_file', { path: draftPath(state.sessionA, 'index.mjs') }, 'probe-read'),
          call('write_file', { path: draftPath(state.sessionA, 'extra.mjs'), content: 'export const x = 1\n' }, 'probe-write'),
        ])),
        h.expectRequest('taskA: use the function', mine(TASK_A.ask), turn([
          call(FUNCTION_TOOL, { csvText: ordersCsv(TASK_A.month) }, 'use-fm'),
        ])),
        h.expectRequest('taskA: write and load the skill', mine(TASK_A.ask), turn([
          call('write_file', { path: TASK_A.output, content: goodA }, 'write-a'),
          call('load_skill', { name: skill.name }, 'use-skill'),
        ])),
        h.expectRequest('taskA: propose the unused skill', mine(TASK_A.ask), turn([
          call('capability_propose', { components: [ref(UNUSED_SKILL)], summary: 'Notes nobody used.' }, 'propose-unused'),
        ])),
        h.expectRequest('taskA: propose', mine(TASK_A.ask), turn([
          call('capability_propose', { components: [ref(fm), ref(skill)], summary: 'Monthly order summary as a function and a skill.' }, 'propose-good'),
        ])),
        h.expectRequest('taskA: done', mine(TASK_A.ask), answer(`${TASK_A.output} written; the summary is now a reusable function and skill.`)),
      ],
      peer: [
        h.expectRequest('peer: skill and helper', mine(ASKS.peer), turn([
          call('load_skill', { name: skill.name }, 'peer-skill'),
          call('delegate', { name: HELPER.name, task: HELPER.task, mode: 'fresh' }, 'peer-helper'),
        ])),
        h.expectRequest('peer: done', mine(ASKS.peer), answer('The helper said hello.')),
      ],
      extras: [
        h.expectRequest('extras: draft', mine(ASKS.extras), () => turn([
          ...[POLICIES.good, ...POLICIES.bad].map(p => call('capability_draft', { kind: p.kind, name: p.name, files: p.files }, `draft-policy-${p.name}`)),
          call('capability_draft', { kind: PLUGIN.kind, name: PLUGIN.name, files: pluginFiles(state.pluginMarker) }, 'draft-plugin'),
        ])),
        h.expectRequest('extras: try', mine(ASKS.extras), turn([
          ...[POLICIES.good, ...POLICIES.bad].map(p => call('capability_try', ref(p), `try-policy-${p.name}`)),
          call('capability_try', ref(PLUGIN), 'try-plugin'),
        ])),
        h.expectRequest('extras: done', mine(ASKS.extras), answer('The short-summaries policy loaded; the others were refused.')),
      ],
      [HELPER.name]: [
        h.expectRequest('helper: answer', mine(HELPER.task), answer('hello')),
      ],
      taskB: [
        h.expectRequest('taskB: use the adopted function', mine(TASK_B.ask), () => turn([
          call(FUNCTION_TOOL, { csvText: ordersCsv(TASK_B.month) }, 'use-fm-b'),
          call('write_file', { path: bundlePath(state.adoptedVersion, 'index.mjs'), content: 'export const broken = true\n' }, 'probe-bundle'),
        ])),
        h.expectRequest('taskB: write', mine(TASK_B.ask), turn([call('write_file', { path: TASK_B.output, content: goodB }, 'write-b')])),
        h.expectRequest('taskB: present', mine(TASK_B.ask), turn([call('present', { paths: [TASK_B.output], summary: 'October summary.' }, 'present-b')])),
        h.expectRequest('taskB: done', mine(TASK_B.ask), answer(`${TASK_B.output} presented.`)),
      ],
      tamper: [
        h.expectRequest('tamper: answer', mine(ASKS.tamper), answer('This session runs on the version the host loaded.')),
      ],
    },
  }
}
