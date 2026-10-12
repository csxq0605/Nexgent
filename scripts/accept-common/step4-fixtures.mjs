/**
 * Fixtures of accept-step4 (docs/plan/step-4-work-partition.md §W5, round 1):
 * the replay project and the "good" and "bad" candidates whose deterministic
 * checks come out differently on it.
 *
 *   components   a PTC function module and a skill that summarise one month of orders;
 *                `good` applies the discount column, `bad` ignores it (its revenue is wrong
 *                on every month: each month has a discounted order)
 *   replay       history tasks of one project: two monthly summaries (selection set, the
 *                candidate's own kind) and one region table (guard set); each task writes
 *                one file and runs `node --test checks/<task>.test.mjs`, a test command
 *                the host recognises and re-runs (deterministic check `test-command`)
 *   tasks A, B   task A asks for a reusable function or skill (user decision 8); task B is
 *                the same kind of task on new data and does not mention a component
 *
 * `runReplayHistory` drives the history tasks through `@nexgent/sdk` against
 * the scripted model server, writing outputs as the given candidate would,
 * so a test can see the check pass for `good` and fail for `bad`. The calls
 * of `capability_draft / try / propose` are not scripted here: their argument
 * shapes come with the W0 contract (round 2).
 *
 * Never calls a real model. Linux, macOS and Windows; no shell syntax in the
 * check command (`node <script> <args>` runs the same under bash and pwsh).
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MONTHS, expectedRegionsCsv, ordersCsv } from '../real-task/step4-orders.mjs'
import { shellCall } from './scenario-step2.mjs'
import { runTurn } from './step2-runtime.mjs'
import { createStep3Sdk } from './step3-runtime.mjs'

/** A key the scripted layers send; never a real one. */
export const SCRIPTED_API_KEY = 'sk-step4-scripted-test-key'

/** The project's test command script. */
export const VERIFY_PATH = 'checks/verify.mjs'

/**
 * `function summarize(csvText)`: the monthly summary. `applyDiscount: false` is the bad
 * candidate: revenue = quantity × unit price, ignoring the discount column.
 */
function summarizeFunction({ applyDiscount }) {
  const factor = applyDiscount ? ' * (1 - Number(cells[6]))' : ''
  return `function summarize(csvText) {
  const rows = String(csvText).split(/\\r?\\n/).filter(line => line.trim() !== '').slice(1).map(line => line.split(','))
  const byRegion = {}
  const units = {}
  let revenue = 0
  for (const cells of rows) {
    const amount = Number(cells[4]) * Number(cells[5])${factor}
    revenue += amount
    byRegion[cells[2]] = (byRegion[cells[2]] ?? 0) + amount
    units[cells[3]] = (units[cells[3]] ?? 0) + Number(cells[4])
  }
  const round = value => Math.round(value * 100) / 100
  const order = (a, b) => units[b] - units[a] || (a < b ? -1 : a > b ? 1 : 0)
  return {
    month: rows.length > 0 ? rows[0][1].slice(0, 7) : null,
    orders: rows.length,
    units: Object.values(units).reduce((sum, value) => sum + value, 0),
    revenue: round(revenue),
    byRegion: Object.fromEntries(Object.keys(byRegion).sort().map(region => [region, round(byRegion[region])])),
    topProduct: Object.keys(units).sort(order)[0] ?? null,
  }
}
`
}

/**
 * `index.mjs` of the function module: one exported function taking one argument object
 * (`FunctionModuleSpec`: each function's single argument is `{ csvText }`).
 */
export function summarizerSource({ applyDiscount }) {
  return `// Monthly order summary: month, orders, units, revenue (cents), revenue by region, top product by units.
${summarizeFunction({ applyDiscount })}
export function summarizeOrders(input) {
  if (typeof input?.csvText !== 'string' || !input.csvText.startsWith('order_id,')) throw new Error('summarizeOrders: csvText must be the order CSV with its header (order_id,date,region,product,quantity,unit_price,discount)')
  return summarize(input.csvText)
}
`
}

/** `functions.json` of the function module (`FunctionModuleSpec`, contracts/capabilities.ts). */
export const FUNCTION_SPEC = {
  formatVersion: 1,
  name: 'order-summary',
  description: 'Monthly summary of the shop\'s order CSV.',
  entry: 'index.mjs',
  functions: [{
    name: 'summarizeOrders',
    description: 'Summarise one month of orders: month, orders, units, revenue, byRegion, topProduct. Pass the CSV text.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['csvText'], properties: { csvText: { type: 'string', description: 'The whole order CSV, header included.' } } },
    effects: [],
  }],
}

const skillSource = ({ applyDiscount }) => `---
name: monthly-order-summary
description: Summarise one month of the shop's order CSV into a JSON summary.
---

1. Read the CSV (columns ${['order_id', 'date', 'region', 'product', 'quantity', 'unit_price', 'discount'].join(', ')}).
2. For each order, the amount is ${applyDiscount ? 'quantity × unit_price × (1 − discount)' : 'quantity × unit_price'}.
3. Write JSON with month (YYYY-MM), orders, units, revenue (rounded to cents), byRegion (region → revenue, rounded to cents, sorted by region) and topProduct (most units; ties by name).
4. Run the project's check command on the result before presenting it.
`

const candidate = applyDiscount => ({
  functionModule: {
    kind: 'function-module',
    name: FUNCTION_SPEC.name,
    function: FUNCTION_SPEC.functions[0].name,
    source: summarizerSource({ applyDiscount }),
    files: [
      { path: 'functions.json', content: `${JSON.stringify(FUNCTION_SPEC, null, 2)}\n` },
      { path: 'index.mjs', content: summarizerSource({ applyDiscount }) },
    ],
  },
  skill: {
    kind: 'skill',
    name: 'monthly-order-summary',
    source: skillSource({ applyDiscount }),
    files: [{ path: 'SKILL.md', content: skillSource({ applyDiscount }) }],
  },
})

/**
 * The two candidates: the same components (contract kinds, names and entry files), right
 * (`good`) and wrong (`bad`). `files` are what `capability_draft` writes.
 */
export const COMPONENTS = { good: candidate(true), bad: candidate(false) }

/** A skill task A drafts and tries but never uses: proposing it must be refused (H04). */
export const UNUSED_SKILL = {
  kind: 'skill',
  name: 'unused-notes',
  files: [{ path: 'SKILL.md', content: '---\nname: unused-notes\ndescription: Notes nobody loads.\n---\n\nNever loaded in the scenario.\n' }],
}

/**
 * The project's test command: `node checks/verify.mjs summary <orders.csv> <summary.json>`
 * or `node checks/verify.mjs regions <orders.csv> <regions.csv>`. Exit 0 when the file
 * matches the orders, 1 when it does not (problems on stdout), 2 on a usage error.
 * Self-contained: replays copy the project, not this repository.
 */
export const VERIFY_SOURCE = `// Checker of the step-4 replay project: verify(mode, orders, output) for the per-task tests,
// or from the command line: node checks/verify.mjs summary|regions <orders.csv> <output>
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
${summarizeFunction({ applyDiscount: true })}
function regionsCsv(csvText) {
  const rows = String(csvText).split(/\\r?\\n/).filter(line => line.trim() !== '').slice(1).map(line => line.split(','))
  const table = {}
  for (const cells of rows) {
    const entry = table[cells[2]] ?? (table[cells[2]] = { orders: 0, revenue: 0 })
    entry.orders += 1
    entry.revenue += Number(cells[4]) * Number(cells[5]) * (1 - Number(cells[6]))
  }
  return ['region,orders,revenue', ...Object.keys(table).sort().map(region => region + ',' + table[region].orders + ',' + (Math.round(table[region].revenue * 100) / 100).toFixed(2))].join('\\n') + '\\n'
}

/** { code, message }: 0 the output matches the orders, 1 it does not, 2 usage error. */
export function verify(mode, ordersPath, outputPath) {
  if (!['summary', 'regions'].includes(mode) || !ordersPath || !outputPath) return { code: 2, message: 'usage: node checks/verify.mjs summary|regions <orders.csv> <output>' }
  const orders = readFileSync(ordersPath, 'utf8')
  let output
  try {
    output = readFileSync(outputPath, 'utf8')
  } catch {
    return { code: 1, message: 'FAIL ' + outputPath + ' does not exist' }
  }
  const problems = []
  if (mode === 'regions') {
    if (output.replace(/\\r\\n/g, '\\n') !== regionsCsv(orders)) problems.push('region table does not match the orders')
  } else {
    let got
    try {
      got = JSON.parse(output)
    } catch {
      got = undefined
      problems.push('summary is not JSON')
    }
    if (got !== undefined) {
      const want = summarize(orders)
      for (const key of ['month', 'orders', 'units', 'topProduct']) if (got[key] !== want[key]) problems.push(key + ' ' + JSON.stringify(got[key]) + ', expected ' + JSON.stringify(want[key]))
      const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005
      if (!near(got.revenue, want.revenue)) problems.push('revenue ' + JSON.stringify(got.revenue) + ', expected ' + want.revenue)
      const regions = Object.keys(want.byRegion)
      if (Object.keys(got.byRegion ?? {}).sort().join() !== regions.join()) problems.push('byRegion keys differ')
      for (const region of regions) if (!near(got.byRegion?.[region], want.byRegion[region])) problems.push(region + ' revenue ' + JSON.stringify(got.byRegion?.[region]) + ', expected ' + want.byRegion[region])
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

const ordersPath = month => `data/orders-${month}.csv`
const checkPath = id => `checks/${id}.test.mjs`

/**
 * A task's test file: `node --test checks/<id>.test.mjs` is a test command the host
 * recognises (`TEST_COMMAND_PATTERN`, packages/tasking), so the host re-runs it as the
 * task's `test-command` check and replays compare it between the two arms.
 */
export function checkSource(taskEntry) {
  return `import assert from 'node:assert/strict'
import test from 'node:test'
import { verify } from './verify.mjs'

test(${JSON.stringify(taskEntry.id)}, () => {
  const result = verify(${JSON.stringify(taskEntry.kind)}, ${JSON.stringify(taskEntry.input)}, ${JSON.stringify(taskEntry.output)})
  assert.equal(result.code, 0, result.message)
})
`
}

/**
 * One task of the family: what the user asks, the file it writes and the test command it runs.
 * @param options - `set` (selection / guard, for the replay tasks), `extra` (text appended to the ask).
 */
export function familyTask(id, kind, month, { set, extra = '' } = {}) {
  const output = kind === 'summary' ? `out/summary-${month}.json` : `out/regions-${month}.csv`
  const checkCommand = `node --test ${checkPath(id)}`
  const what = kind === 'summary'
    ? `Summarise the orders in ${ordersPath(month)} into ${output} (JSON: month, orders, units, revenue, byRegion, topProduct; amounts are quantity × unit_price × (1 − discount), rounded to cents)`
    : `Write the region table of ${ordersPath(month)} to ${output} (CSV region,orders,revenue sorted by region; revenue rounded to cents)`
  return { id, kind, month, ...(set === undefined ? {} : { set }), input: ordersPath(month), output, checkCommand, ask: `${what}. Check it with \`${checkCommand}\` and present it.${extra}` }
}

/** History tasks of the replay project: selection = the candidate's own kind, guard = another kind; never overlapping. */
export const REPLAY_TASKS = [
  familyTask('summary-2026-06', 'summary', MONTHS.history[0], { set: 'selection' }),
  familyTask('summary-2026-07', 'summary', MONTHS.history[1], { set: 'selection' }),
  familyTask('regions-2026-08', 'regions', MONTHS.history[2], { set: 'guard' }),
]

/** Task A asks for a reusable component (user decision 8, 2026-10-12); task B does not mention one. */
export const TASK_A = familyTask('summary-2026-09', 'summary', MONTHS.taskA, { extra: ' Also make the summary step a reusable function or skill for later months.' })
export const TASK_B = familyTask('summary-2026-10', 'summary', MONTHS.taskB)

/** Write the project's own files: order CSVs of every month the family uses and the test command. */
export async function writeReplayProject(root) {
  const months = [...MONTHS.history, MONTHS.taskA, MONTHS.taskB]
  for (const month of months) {
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(join(root, ordersPath(month)), ordersCsv(month))
  }
  await mkdir(join(root, dirname(VERIFY_PATH)), { recursive: true })
  await writeFile(join(root, VERIFY_PATH), VERIFY_SOURCE)
  const tests = [...REPLAY_TASKS, TASK_A, TASK_B]
  for (const entry of tests) await writeFile(join(root, checkPath(entry.id)), checkSource(entry))
  return { root, months, files: [...months.map(ordersPath), VERIFY_PATH, ...tests.map(entry => checkPath(entry.id))] }
}

const loaded = new Map()
/** The candidate's summary function, imported from its own module source. */
async function summarizer(quality) {
  if (!loaded.has(quality)) {
    const source = COMPONENTS[quality].functionModule.source
    loaded.set(quality, import(`data:text/javascript,${encodeURIComponent(source)}`).then(module => csvText => module.summarizeOrders({ csvText })))
  }
  return loaded.get(quality)
}

/**
 * The file a task writes when it is done the way the `good` or `bad` candidate does it.
 * The region table does not use the component, so it is right under both.
 */
export async function outputFor(taskEntry, quality) {
  const csv = ordersCsv(taskEntry.month)
  if (taskEntry.kind === 'regions') return expectedRegionsCsv(csv)
  return `${JSON.stringify((await summarizer(quality))(csv), null, 2)}\n`
}

const usage = { inputTokens: 40, outputTokens: 12 }

/**
 * Scripted model entries for the given tasks, one root session each:
 * write the output → run the test command → present → answer.
 */
export async function replayScript(h, tasks, quality) {
  const lead = []
  for (const entry of tasks) {
    const mine = body => h.requestText(body).includes(entry.ask)
    const content = await outputFor(entry, quality)
    lead.push(
      h.expectRequest(`${entry.id}: task`, mine, { toolCalls: [{ name: 'write_file', arguments: { path: entry.output, content } }], usage }),
      h.expectRequest(`${entry.id}: written`, mine, { toolCalls: [shellCall({ bash: entry.checkCommand, pwsh: entry.checkCommand })], usage }),
      h.expectRequest(`${entry.id}: checked`, mine, { toolCalls: [{ name: 'present', arguments: { paths: [entry.output], summary: `${entry.kind} for ${entry.month}` } }], usage }),
      h.expectRequest(`${entry.id}: presented`, mine, { content: `${entry.output} presented.`, usage }),
    )
  }
  return lead
}

/** Run a task's test command in `root` the way a replay re-runs it. */
export function runCheck(root, taskEntry) {
  const [, ...args] = taskEntry.checkCommand.split(' ')
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: run.status, passed: run.status === 0, stdout: run.stdout.trim() }
}

/**
 * Drive the history tasks through `@nexgent/sdk` in a fresh project (scripted model only).
 * @param h - the loaded test-support harness.
 * @param pkgs - from `loadStep3Packages()`.
 * @param options - `quality` (`good` default, or `bad`), `tasks` (default {@link REPLAY_TASKS}), `log`.
 * @returns `{ root, quality, tasks: [{ id, set, sessionId, reason, error, output, check }] }`.
 */
export async function runReplayHistory(h, pkgs, work, { quality = 'good', tasks = REPLAY_TASKS, log = () => undefined } = {}) {
  const root = join(work, `replay-${quality}`)
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await writeReplayProject(root)
  const server = await h.scriptedModelServer({ script: await replayScript(h, tasks, quality) })
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  const sdk = createStep3Sdk(pkgs, { env, home })
  const obs = { root, quality, tasks: [] }
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    for (const entry of tasks) {
      log(`replay ${quality}: ${entry.id}`)
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
  } finally {
    await sdk.dispose()
    await server.close()
  }
  return obs
}
