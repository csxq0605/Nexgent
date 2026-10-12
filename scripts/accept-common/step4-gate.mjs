/**
 * The gate scenario of accept-step4 (W5 after the gate, PR #90): drives the
 * real gate — `@nexgent/capabilities`' GateHost, the SDK's trial entry, one
 * process per replay — against the scripted model server in its own
 * project, and collects raw observations for H06, H08, H09, H11, H12, H14
 * (adoption half), H15 and H16. It judges nothing (step4-judges.mjs does).
 *
 * One project, one root session per task, in this order:
 *
 *   A0       a summary task proposes the good function module before there is any
 *            history: the automatic gate waits; capabilities.trial says it cannot run (H15)
 *   H1–H3    history: two monthly summaries and a region table, each with its test command
 *   trial A0 capabilities.trial in the same app (`retry`): 3 cases × 2 repeats ×
 *            2 arms; the candidate's runs call the module and pass, the baseline's do not:
 *            adopted (H06, H11, H15)
 *   C        proposes the bad module (no discount) on A0's version: the automatic gate
 *            rejects it (H08)
 *   B2       a plain summary on A0's version: the module works as before (H08)
 *   R        the module fails three times in a row on a new export format: rolled back
 *            by the usage watch, within the rule's window of tasks (H09)
 *   D        with `trialBudget.maxRequests` 3, proposes a skill: the gate stops,
 *            budget-exhausted, nothing adopted; D itself runs on the previous version (H09, H12)
 *   E        drafts a plugin, the try is approved once, proposes it: the checks tie and the
 *            reviewer prefers it, so the gate stops at awaiting-approval;
 *            capabilities.approve adopts it (H06 reviewer, H14)
 *   F        proposes a skill; its replays stall; the gate's process group is killed;
 *            a restarted SDK marks the trial interrupted and does not run it again (H16)
 *   G        a plain summary on the version F found: it still works (H16)
 *
 * The trial side files (`trials/<candidateId>.attempt`, `<trialId>.lock`,
 * `<candidateId>.log`) are not in data-formats.md yet; they are observed as
 * the product writes them (handoff step4-w3-trial.md).
 *
 * The gate and replay processes inherit this process's environment, so the
 * scenario sets the fake key and the local server URL in `process.env` while
 * it runs (and restores them), as packages/sdk/tests/trial.spec.ts does.
 * Never calls a real model.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expectedRegionsCsv, ordersCsv } from '../real-task/step4-orders.mjs'
import { shellCall } from './scenario-step2.mjs'
import { runTurn } from './step2-runtime.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'
import { COMPONENTS, REPLAY_TASKS, SCRIPTED_API_KEY, VERIFY_PATH, VERIFY_SOURCE, checkSource, familyTask, outputFor } from './step4-fixtures.mjs'
import { activationOf, candidatesOf, filesUnder, jsonl, ledgerOf, sessionsOf } from './step4-headless.mjs'
import { FUNCTION_TOOL } from './step4-scenario.mjs'

/** How long one gate may take to settle (12 replay processes on a slow runner). */
const GATE_WAIT = 240_000
const usage = { inputTokens: 40, outputTokens: 12 }
const errorText = error => (error instanceof Error ? error.message : String(error))
const sha256 = data => createHash('sha256').update(data).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The plugin E drafts: one tool; its output marks the files a run with it writes. */
export const GATE_PLUGIN = { kind: 'plugin', name: 'greeter', tool: 'greet_user', marker: 'greeted' }

const pluginFiles = () => {
  const spec = { formatVersion: 1, name: GATE_PLUGIN.name, description: 'Greets the user.', entry: 'index.mjs', permissions: 'Adds one tool that returns a greeting; reads and writes nothing.', tools: [GATE_PLUGIN.tool] }
  const source = `export default {
  name: ${JSON.stringify(GATE_PLUGIN.name)},
  apply(ctx) {
    ctx.tools.register({
      definition: { name: ${JSON.stringify(GATE_PLUGIN.tool)}, description: 'Greet the user.', inputSchema: { type: 'object' }, effects: [], approval: 'never' },
      handler: async () => ({ content: 'hello from greeter' }),
    })
  },
}
`
  return [{ path: 'plugin.json', content: `${JSON.stringify(spec, null, 2)}\n` }, { path: 'index.mjs', content: source }]
}

const skillFiles = name => [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Steps for the monthly order summary.\n---\n\n1. Read the month's CSV.\n2. Apply the discount to every amount.\n3. Run the task's test command before presenting.\n` }]

const reusable = ' Also make the summary step a reusable function for later months.'
/** The tasks of the gate project, by key (months are distinct, so no task's output is in another's snapshot). */
export const GATE_TASKS = {
  A0: familyTask('gate-summary-2026-09', 'summary', '2026-09', { extra: reusable }),
  H1: REPLAY_TASKS[0],
  H2: REPLAY_TASKS[1],
  H3: REPLAY_TASKS[2],
  C: familyTask('gate-summary-2026-10', 'summary', '2026-10', { extra: `${reusable} A simpler version is fine.` }),
  B2: familyTask('gate-summary-2026-11', 'summary', '2026-11'),
  D: familyTask('gate-summary-2027-01', 'summary', '2027-01', { extra: ' Also write the steps down as a reusable skill.' }),
  E: familyTask('gate-summary-2027-02', 'summary', '2027-02', { extra: ' Also add a small greeter plugin with a greet tool.' }),
  F: familyTask('gate-summary-2027-03', 'summary', '2027-03', { extra: ' Also write the steps down as a reusable skill for next time.' }),
  G: familyTask('gate-summary-2027-04', 'summary', '2027-04'),
}

/** R: the module on an export it cannot read (semicolons, another header). */
export const REGRESS = {
  input: 'data/export-2026-12.csv',
  ask: 'Summarise the orders in data/export-2026-12.csv (the new semicolon export) with the order-summary function and report the totals.',
}

/** Settings the scenario writes into `.nexgent/config.json` for D (H12). */
export const BUDGET = { maxRequests: 3, maxTokens: 8_000_000 }

/** Skills D and F propose. */
export const SKILLS = { D: 'summary-notes', F: 'summary-notes-next' }

// --- requests -----------------------------------------------------------------

const blocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const blockText = block => (typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : blocks(block?.content).map(blockText).join('\n'))
const toolNames = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)
const steps = body => (body?.messages ?? []).filter(message => message.role === 'assistant').length

function firstUserText(body) {
  for (const message of body?.messages ?? []) {
    if (message.role !== 'user') continue
    const text = blocks(message.content).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text !== '') return text
  }
  return ''
}

/** Text of the latest tool result in the request. */
function lastToolResult(body) {
  const user = [...(body?.messages ?? [])].reverse().find(message => message.role === 'user')
  const result = blocks(user?.content).filter(block => block.type === 'tool_result').at(-1)
  return result === undefined ? '' : blockText(result)
}

/** The summary a cap_* call returned (its result is "…Result:\n<json>"), pretty-printed; null when it failed. */
function summaryFromResult(text) {
  const at = text.indexOf('Result:')
  const start = text.indexOf('{', at < 0 ? 0 : at)
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return `${JSON.stringify(JSON.parse(text.slice(start, end + 1)), null, 2)}\n`
  } catch {
    return null
  }
}

const turn = (name, args) => ({ toolCalls: [{ name, arguments: args }], usage })
const answer = content => ({ content, usage })

/**
 * The scripted model: main tasks by their ask; replays (while a gate runs) by
 * the tools their arm offers; the reviewer by its system prompt.
 */
class GateModel {
  constructor() {
    /** `main`, `trial` (replays answer), or `slow` (replays stall). */
    this.phase = 'main'
    this.requests = []
    this.reviews = []
    this.tasks = Object.entries(GATE_TASKS).map(([key, task]) => ({ key, task }))
  }

  taskOf(body) {
    const text = firstUserText(body)
    if (text.includes(REGRESS.ask)) return { key: 'R' }
    return this.tasks.filter(entry => text.includes(entry.task.ask)).sort((a, b) => b.task.ask.length - a.task.ask.length)[0]
  }

  respond(body) {
    const system = JSON.stringify(body?.system ?? '')
    if (system.includes('quality gate')) return this.review(body)
    const found = this.taskOf(body)
    const tools = toolNames(body)
    const at = steps(body)
    const kind = this.phase === 'main' ? 'main' : 'replay'
    this.requests.push({ phase: this.phase, kind, task: found?.key ?? null, step: at, tools: tools.filter(name => name.startsWith('cap_') || name === GATE_PLUGIN.tool) })
    if (found === undefined) return answer('Done.')
    if (this.phase === 'slow') return { content: 'Done.', usage, chunkDelayMs: 120_000 }
    if (this.phase === 'trial') return this.replay(found, tools, at, body)
    const script = this.main(found, body)
    const entry = script[Math.min(at, script.length - 1)]
    // The gate starts once the proposing turn ends: from its last answer on, requests are replays.
    if (at >= script.length - 1 && found.after !== undefined) this.phase = found.after
    return typeof entry === 'function' ? entry(body) : entry
  }

  /** One replay step: read, write (good with the module, bad without), done. Both arms take three requests. */
  replay({ task }, tools, at, body) {
    if (task.kind === 'regions') return [turn('read_file', { path: task.input }), turn('write_file', { path: task.output, content: expectedRegionsCsv(ordersCsv(task.month)) }), answer('Done.')][Math.min(at, 2)]
    if (tools.includes(FUNCTION_TOOL)) {
      if (at === 0) return turn(FUNCTION_TOOL, { csvText: ordersCsv(task.month) })
      if (at === 1) return turn('write_file', { path: task.output, content: summaryFromResult(lastToolResult(body)) ?? 'not a summary\n' })
      return answer('Done.')
    }
    if (at === 0) return turn('read_file', { path: task.input })
    if (at === 1) {
      // Without the module the summary ignores the discount (fails its check); a run with the plugin marks its file.
      const bad = JSON.parse(this.badSummary(task))
      const content = `${JSON.stringify(tools.includes(GATE_PLUGIN.tool) ? { ...bad, note: GATE_PLUGIN.marker } : bad, null, 2)}\n`
      return turn('write_file', { path: task.output, content })
    }
    return answer('Done.')
  }

  badSummary(task) {
    return this.bad?.get(task.month) ?? '{}'
  }

  /** The reviewer prefers the attempt whose files carry the plugin's marker; otherwise a tie. */
  review(body) {
    const text = (body?.messages ?? []).map(message => blocks(message.content).map(blockText).join('\n')).join('\n')
    const split = text.indexOf('## Attempt B')
    const a = split < 0 ? '' : text.slice(0, split)
    const b = split < 0 ? '' : text.slice(split)
    const marked = value => value.includes(`"note": "${GATE_PLUGIN.marker}"`)
    const better = marked(a) && !marked(b) ? 'A' : marked(b) && !marked(a) ? 'B' : 'tie'
    this.reviews.push({ better })
    return answer(JSON.stringify({ better, reason: better === 'tie' ? 'Both attempts are the same.' : 'This attempt also greets the user.' }))
  }

  /** The main script of a task, one entry per step. */
  main(found, body) {
    const { key, task } = found
    const write = content => turn('write_file', { path: task.output, content })
    const shell = shellCall({ bash: task?.checkCommand, pwsh: task?.checkCommand })
    const finish = [turn(shell.name, shell.arguments), turn('present', { paths: [task?.output], summary: `Summary for ${task?.month}.` })]
    const good = this.good?.get(task?.month)
    const fm = quality => COMPONENTS[quality].functionModule
    const ref = c => ({ kind: c.kind, name: c.name })
    const fromTool = () => write(summaryFromResult(lastToolResult(body)) ?? good)
    switch (key) {
      case 'H1': case 'H2': case 'H3': case 'G':
        return [write(task.kind === 'regions' ? expectedRegionsCsv(ordersCsv(task.month)) : good), ...finish, answer(`${task.output} presented.`)]
      case 'B2':
        return [turn(FUNCTION_TOOL, { csvText: ordersCsv(task.month) }), () => fromTool(), ...finish, answer(`${task.output} presented.`)]
      case 'A0':
      case 'C': {
        const c = fm(key === 'A0' ? 'good' : 'bad')
        return [
          turn('capability_draft', { ...ref(c), files: c.files }),
          turn('capability_try', ref(c)),
          turn(FUNCTION_TOOL, { csvText: ordersCsv(task.month) }),
          // C's module gives a wrong revenue; the model writes the right summary by hand.
          key === 'A0' ? () => fromTool() : write(good),
          ...finish,
          turn('capability_propose', { components: [ref(c)], summary: key === 'A0' ? 'Monthly order summary function.' : 'A simpler summary function.' }),
          answer('Done; the summary function is proposed.'),
        ]
      }
      case 'R':
        return [
          turn(FUNCTION_TOOL, { csvText: this.export ?? '' }),
          turn(FUNCTION_TOOL, { csvText: this.export ?? '' }),
          turn(FUNCTION_TOOL, { csvText: (this.export ?? '').trim() }),
          answer('The order-summary function failed on this export three times.'),
        ]
      case 'D':
      case 'F': {
        const skill = { kind: 'skill', name: SKILLS[key] }
        return [
          turn('capability_draft', { ...skill, files: skillFiles(skill.name) }),
          turn('capability_try', skill),
          turn('load_skill', { name: skill.name }),
          write(good),
          ...finish,
          turn('capability_propose', { components: [skill], summary: 'Steps for the monthly summary.' }),
          answer('Done; the skill is proposed.'),
        ]
      }
      case 'E':
        return [
          turn('capability_draft', { kind: GATE_PLUGIN.kind, name: GATE_PLUGIN.name, files: pluginFiles() }),
          turn('capability_try', { kind: GATE_PLUGIN.kind, name: GATE_PLUGIN.name }),
          turn(GATE_PLUGIN.tool, {}),
          write(good),
          ...finish,
          turn('capability_propose', { components: [{ kind: GATE_PLUGIN.kind, name: GATE_PLUGIN.name }], summary: 'A greeter plugin.' }),
          answer('Done; the greeter plugin is proposed.'),
        ]
      default:
        return [answer('Done.')]
    }
  }
}

/** Which phase follows the last answer of a proposing task (the gate starts then). */
const AFTER = { C: 'trial', D: 'trial', E: 'trial', F: 'slow' }

// --- files --------------------------------------------------------------------

const capDir = root => join(root, '.nexgent', 'capabilities')
const trialsDir = root => join(capDir(root), 'trials')

async function writeGateProject(root) {
  await mkdir(join(root, 'data'), { recursive: true })
  await mkdir(join(root, 'checks'), { recursive: true })
  for (const task of Object.values(GATE_TASKS)) {
    await writeFile(join(root, task.input), ordersCsv(task.month))
    await writeFile(join(root, 'checks', `${task.id}.test.mjs`), checkSource(task))
  }
  await writeFile(join(root, REGRESS.input), ordersCsv('2026-12').replaceAll(',', ';'))
  await writeFile(join(root, VERIFY_PATH), VERIFY_SOURCE)
}

/** Every receipt file: `{ <trialId>: receipts[] }`. */
export async function trialsOf(root) {
  const out = {}
  for (const name of (await readdir(trialsDir(root)).catch(() => [])).filter(n => n.endsWith('.jsonl'))) out[name.slice(0, -6)] = await jsonl(join(trialsDir(root), name))
  return out
}

/** The trial files beside the receipts: name → `{ size, text }` (logs and locks are small). */
async function trialSideFiles(root) {
  const out = {}
  for (const name of (await readdir(trialsDir(root)).catch(() => [])).filter(n => !n.endsWith('.jsonl'))) {
    const path = join(trialsDir(root), name)
    const text = await readFile(path, 'utf8').catch(() => null)
    out[name] = { size: (await stat(path).catch(() => ({ size: -1 }))).size, ...(name.endsWith('.attempt') || name.endsWith('.lock') ? { text } : {}) }
  }
  return out
}

/** The JSON status lines a candidate's gate processes printed into `trials/<candidateId>.log`. */
export async function gateLines(root, candidateId) {
  const text = await readFile(join(trialsDir(root), `${candidateId}.log`), 'utf8').catch(() => '')
  return text.split('\n').filter(line => line.startsWith('{')).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

export async function decisionsOf(root) {
  const dir = join(capDir(root), 'decisions')
  const out = []
  for (const name of (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.json'))) out.push(await readFile(join(dir, name), 'utf8').then(JSON.parse, error => ({ file: name, error: errorText(error) })))
  return out.sort((a, b) => String(a.decidedAt).localeCompare(String(b.decidedAt)))
}

/** Hashes of every file under a directory (relative paths), optionally skipping top-level names. */
async function treeHashes(dir, skip = []) {
  const out = {}
  for (const path of await filesUnder(dir)) {
    if (skip.some(name => path === name || path.startsWith(`${name}/`))) continue
    out[path] = sha256(await readFile(join(dir, path)))
  }
  return out
}

async function poll(read, done, what, timeoutMs = GATE_WAIT) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (done(last)) return last
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Kill a process and everything it started (the gate is a detached group leader on POSIX). */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    process.kill(pid, 'SIGKILL')
  }
}

/** Set the fake key and the local server for the gate's child processes; returns the restore function. */
function gateEnvironment(baseUrl) {
  const names = ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY', 'NEXGENT_API_BASE_URL']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.NEXGENT_API_KEY = SCRIPTED_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  process.env.NEXGENT_API_BASE_URL = baseUrl
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

export async function editConfig(root, edit) {
  const path = join(root, '.nexgent', 'config.json')
  const config = await readFile(path, 'utf8').then(JSON.parse, () => ({}))
  await writeFile(path, `${JSON.stringify(edit(config), null, 2)}\n`)
}

// --- scenario -----------------------------------------------------------------

/**
 * Run the gate scenario.
 * @param h - the loaded test-support harness.
 * @returns observations (see the module comment); `error: { step, message }` when a step threw.
 */
export async function runStep4Gate(h, work, { log = () => {} } = {}) {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeGateProject(root)

  const model = new GateModel()
  model.good = new Map()
  model.bad = new Map()
  for (const task of Object.values(GATE_TASKS)) {
    if (task.kind !== 'summary') continue
    model.good.set(task.month, await outputFor(task, 'good'))
    model.bad.set(task.month, await outputFor(task, 'bad'))
  }
  model.export = ordersCsv('2026-12').replaceAll(',', ';')
  for (const entry of model.tasks) if (AFTER[entry.key] !== undefined) entry.after = AFTER[entry.key]

  const server = await h.scriptedModelServer({ script: Array.from({ length: 3_000 }, () => body => model.respond(body)) })
  const restoreEnv = gateEnvironment(server.baseUrl)
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  const approvals = []
  const responder = async (request) => {
    const allow = String(request.summary ?? '').includes(`"${GATE_PLUGIN.name}"`)
    approvals.push({ sessionId: request.sessionId, summary: request.summary, risk: request.risk, decision: allow ? 'allow' : 'deny' })
    return { id: request.id, decision: allow ? 'allow' : 'deny', scope: 'once', decidedBy: 'user' }
  }
  const obs = { root, key: SCRIPTED_API_KEY, tasks: {}, candidates: {}, budget: BUDGET }
  let step = 'setup'
  let sdk
  let projectId
  const open = async () => {
    sdk = createStep3Sdk(pkgs, { env, home, approvals: responder })
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
  }
  const ledgerTask = async (sessionId) => (await ledgerOf(root)).find(r => r.sessionId === sessionId && r.taskId !== undefined && r.trialId === undefined)?.taskId
  const task = async (key, text) => {
    step = `task ${key}`
    log(step)
    const sessionId = (await sdk.call('sessions.create', { projectId, title: `gate ${key}` })).sessionId
    const { result, error } = await runTurn(sdk, { projectId, sessionId, text })
    obs.tasks[key] = { sessionId, reason: result?.reason, ...(error === undefined ? {} : { error: errorText(error) }), taskId: await ledgerTask(sessionId) }
    return sessionId
  }
  const proposed = async (key) => {
    const found = (await candidatesOf(root)).find(c => c.record?.sessionId === obs.tasks[key].sessionId)
    if (found === undefined) throw new Error(`task ${key} proposed no candidate`)
    obs.candidates[key] = { id: found.id, version: found.record.version, taskId: found.record.taskId, components: found.record.components }
    return found.id
  }
  const settle = async (key, count = 1) => {
    const id = obs.candidates[key].id
    const lines = await poll(() => gateLines(root, id), l => l.length >= count, `the gate of ${key} to finish`)
    model.phase = 'main'
    return lines.at(-1)
  }
  const show = async key => (await sdk.call('capabilities.show', { projectId, candidateId: obs.candidates[key].id })).view
  const tryTrial = key => sdk.call('capabilities.trial', { projectId, candidateId: obs.candidates[key].id }).then(view => ({ status: view.status }), error => ({ error: errorText(error), code: error?.code }))

  try {
    await open()

    // H15: no history yet. The automatic gate waits and writes nothing; a manual start is refused.
    await task('A0', GATE_TASKS.A0.ask)
    await proposed('A0')
    step = 'waiting gate of A0'
    obs.waiting = { line: await settle('A0') }
    obs.waiting.trial = await tryTrial('A0')
    obs.waiting.status = (await show('A0')).status
    obs.waiting.trials = Object.keys(await trialsOf(root)).length
    obs.waiting.files = await trialSideFiles(root)
    obs.waiting.decisions = (await decisionsOf(root)).length

    for (const key of ['H1', 'H2', 'H3']) await task(key, GATE_TASKS[key].ask)

    // H11: the project's files and sessions before the trial.
    obs.isolation = { before: { files: await treeHashes(root, ['.nexgent']), sessions: await treeHashes(join(root, '.nexgent', 'sessions')) } }
    // Once there is history the same app starts the gate on request (the waiting process has exited).
    step = 'trial A0'
    model.phase = 'trial'
    obs.retry = { sameApp: await tryTrial('A0') }
    obs.adopted = { line: await settle('A0', 2) }
    obs.isolation.after = { files: await treeHashes(root, ['.nexgent']), sessions: await treeHashes(join(root, '.nexgent', 'sessions')) }
    obs.adopted.status = (await show('A0')).status

    // H08: a worse candidate is rejected by the automatic gate; the next task uses the adopted version.
    await task('C', GATE_TASKS.C.ask)
    await proposed('C')
    obs.rejected = { line: await settle('C') }
    obs.rejected.status = (await show('C')).status
    await task('B2', GATE_TASKS.B2.ask)

    // H09: the adopted module fails three times in a row; the next task (D) runs on the previous version.
    await task('R', REGRESS.ask)

    // H12: a tiny trial budget.
    step = 'budget config'
    await editConfig(root, config => ({ ...config, capabilities: { ...config.capabilities, trialBudget: BUDGET } }))
    await task('D', GATE_TASKS.D.ask)
    await proposed('D')
    obs.budgetRun = { line: await settle('D') }
    obs.budgetRun.status = (await show('D')).status
    await editConfig(root, config => {
      const { trialBudget: _dropped, ...rest } = config.capabilities ?? {}
      return { ...config, capabilities: rest }
    })

    // H14: the plugin's try is approved once; after its gate it waits for capabilities.approve.
    await task('E', GATE_TASKS.E.ask)
    await proposed('E')
    obs.plugin = { line: await settle('E') }
    obs.plugin.awaiting = (await show('E')).status
    obs.plugin.versionAwaiting = (await activationOf(root)).at(-1)?.version ?? 'baseline'
    step = 'approve E'
    obs.plugin.approved = (await sdk.call('capabilities.approve', { projectId, candidateId: obs.candidates.E.id, decision: 'allow' })).status

    // H16: kill the gate of F while its replays stall, then restart.
    await task('F', GATE_TASKS.F.ask)
    await proposed('F')
    step = 'kill the gate of F'
    const lock = await poll(async () => {
      const names = (await readdir(trialsDir(root)).catch(() => [])).filter(n => n.endsWith('.lock'))
      const replays = model.requests.filter(r => r.phase === 'slow').length
      return { names, replays }
    }, s => s.names.length === 1 && s.replays > 0, 'the gate of F to lock its trial and start a replay')
    const trialId = lock.names[0].slice(0, -5)
    const pid = Number.parseInt(await readFile(join(trialsDir(root), lock.names[0]), 'utf8'), 10)
    obs.kill = { trialId, pid, aliveBefore: alive(pid), receiptsBefore: (await jsonl(join(trialsDir(root), `${trialId}.jsonl`))).map(r => r.type) }
    killTree(pid)
    await poll(async () => alive(pid), a => a === false, `the gate process ${pid} to die`, 30_000)
    obs.kill.deadAfter = true
    model.phase = 'main'
    obs.kill.versionBefore = (await activationOf(root)).at(-1)?.version ?? 'baseline'
    step = 'restart after the kill'
    await sdk.dispose()
    await open()
    obs.recovered = { decision: await poll(async () => (await decisionsOf(root)).find(d => d.candidateId === obs.candidates.F.id), Boolean, 'the interrupted trial to be recorded', 30_000) }
    obs.recovered.status = (await show('F')).status
    obs.recovered.trial = await tryTrial('F')
    await sleep(1_000)
    obs.recovered.trialsOfF = Object.values(await trialsOf(root)).filter(r => r[0]?.candidateId === obs.candidates.F.id).length
    await task('G', GATE_TASKS.G.ask)
  } catch (error) {
    obs.error = { step, message: errorText(error) }
  } finally {
    await sdk?.dispose().catch(() => undefined)
    restoreEnv()
    obs.requests = model.requests
    obs.reviews = model.reviews
    obs.serverRequests = server.requests.length
    await server.close()
  }
  obs.approvals = approvals
  obs.sessions = await sessionsOf(root)
  obs.ledger = await ledgerOf(root)
  obs.activation = await activationOf(root)
  obs.decisions = await decisionsOf(root)
  obs.trials = await trialsOf(root)
  obs.trialFiles = await trialSideFiles(root)
  obs.candidateDirs = (await candidatesOf(root)).filter(c => c.record?.error === undefined).map(c => c.id)
  obs.logs = {}
  for (const [key, c] of Object.entries(obs.candidates)) obs.logs[key] = await gateLines(root, c.id)
  obs.outputs = {}
  for (const [key, t] of Object.entries(GATE_TASKS)) obs.outputs[key] = await readFile(join(root, t.output), 'utf8').catch(() => null)
  return obs
}
