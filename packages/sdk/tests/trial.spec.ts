/**
 * The step-4 gate end to end through the SDK (W3), on the scripted model
 * server (every request, the gate's and its replay processes' included, goes
 * to the local server; the key is a fake one):
 *
 * 1. Past tasks present their outputs (checks: the file exists and parses).
 * 2. A task drafts, tries, uses and proposes a function module; when the
 *    turn ends the plugin starts the gate process, which replays the
 *    selection and guard tasks in copies, each run in its own process. The
 *    candidate's runs write valid JSON, the baseline's do not: adopted.
 * 3. A second candidate makes the runs worse: rejected and kept.
 * 4. A task on the adopted version whose new tool fails three times in a
 *    row: rolled back automatically.
 * 5. With `autoTrial` off nothing starts by itself; `capabilities.trial`
 *    starts the gate on request.
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_BUNDLE, CapabilitiesPlugin, CapabilityStore, gateOf, listCandidates, listTrials, writeCandidate, type CapabilitiesPluginConfig, type GateHost } from '@nexgent/capabilities'
import { IMPROVEMENT_FILES, IMPROVEMENTS_DIR, resolveWorkspaceLayout, type Context, type ImprovementJob, type LedgerRecord, type Plugin } from '@nexgent/kernel'
import { estimateUsdTotal } from '@nexgent/llm'
import { readLedgerRecords, scriptedModelServer, type MessagesRequestBody, type ScriptedModelServer, type ScriptedTurn } from '@nexgent/test-support'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSdk, type LocalNexgentSdk } from '../src/index.js'
import { parseFeedbackCheck } from '../src/trial-entry.js'
import { tempDir } from './helpers.js'

const DIST_ENTRY = fileURLToPath(new URL('../dist/trial-entry.js', import.meta.url))
const KEY = 'sk-trial-test-key-3b7c9e1d'
const usage = { inputTokens: 40, outputTokens: 10 }

const SPEC = (name: string) => ({ formatVersion: 1, name, description: 'Order totals.', functions: [{ name: 'total', description: 'Sum.', inputSchema: { type: 'object' }, effects: [] }] })
const SOURCE = 'export function total(input) { return input.values.reduce((a, b) => a + b, 0) }\n'

/** Each task's text and the file it delivers (distinct, so a later snapshot never holds the file a replay writes). */
const TASKS = {
  june: { text: 'summarize the june orders by region', path: 'out/june.json' },
  lookup: { text: 'build the region lookup table', path: 'out/lookup.json' },
  july: { text: 'summarize the july orders by region', path: 'out/july.json' },
  august: { text: 'summarize the august orders by region', path: 'out/august.json' },
  september: { text: 'summarize the september orders by region', path: 'out/september.json' },
  october: { text: 'summarize the october orders by region', path: 'out/october.json' },
  regress: { text: 'add up the order totals with the helper', path: '' },
} as const

type Body = MessagesRequestBody
type Block = { type?: string; text?: string }

function blocks(content: unknown): Block[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : []
}

function firstUserText(body: Body): string {
  for (const message of body.messages ?? []) {
    if (message.role !== 'user') continue
    const text = blocks(message.content).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text !== '') return text
  }
  return ''
}

function toolNames(body: Body): string[] {
  return (body.tools ?? []).map(tool => (tool as { name?: string }).name ?? '')
}

/** Assistant messages so far: the step of a scripted one-turn task. */
function step(body: Body): number {
  return (body.messages ?? []).filter(message => message.role === 'assistant').length
}

function taskOf(body: Body): (typeof TASKS)[keyof typeof TASKS] | undefined {
  const text = firstUserText(body)
  return Object.values(TASKS).find(task => text.includes(task.text))
}

function deliver(path: string, extra: ScriptedTurn[] = []): ScriptedTurn[] {
  return [
    { toolCalls: [{ name: 'write_file', arguments: { path, content: '{"total": 3}\n' } }], usage },
    { toolCalls: [{ name: 'present', arguments: { paths: [path], summary: 'The totals.' } }], usage },
    ...extra,
    { content: 'Done.', usage },
  ]
}

function propose(name: string): ScriptedTurn[] {
  const component = { kind: 'function-module', name }
  return [
    { toolCalls: [{ name: 'capability_draft', arguments: { ...component, files: [{ path: 'functions.json', content: JSON.stringify(SPEC(name)) }, { path: 'index.mjs', content: SOURCE }] } }], usage },
    { toolCalls: [{ name: 'capability_try', arguments: component }], usage },
    { toolCalls: [{ name: `cap_${name}_total`, arguments: { values: [1, 2] } }], usage },
    { toolCalls: [{ name: 'capability_propose', arguments: { components: [component], summary: `Reusable ${name} totals.` } }], usage },
  ]
}

/** The model: main tasks by their text; while a gate runs, replays by the arm's tools; the reviewer by its prompt. */
class Model {
  phase: 'main' | 'trial' = 'main'
  readonly replays: { tools: string[]; text: string; wrote: string }[] = []
  readonly feedbackChecks: string[] = []

  respond(body: Body): ScriptedTurn {
    const system = JSON.stringify(body.system ?? '')
    if (system.includes('You check one attempt')) {
      // The feedback check: solved when the attempt wrote the well-formed total.
      const text = firstUserText(body)
      this.feedbackChecks.push(text)
      return { content: JSON.stringify({ solved: text.includes('{"total": 3}'), reason: 'checked the totals' }), usage }
    }
    if (system.includes('quality gate')) return { content: '{"better": "tie", "reason": "same"}', usage }
    const task = taskOf(body)
    if (task === undefined) return { content: 'Unknown task.', usage }
    const at = step(body)
    if (this.phase === 'trial') {
      if (at > 0) return { content: 'Done.', usage }
      const tools = toolNames(body)
      // probe2 makes things worse; probe makes them better; without either the output is broken.
      const good = !tools.includes('cap_probe2_total') && tools.includes('cap_probe_total')
      const wrote = good ? '{"total": 3}\n' : 'total: three\n'
      this.replays.push({ tools: tools.filter(name => name.startsWith('cap_')), text: task.text, wrote })
      return { toolCalls: [{ name: 'write_file', arguments: { path: task.path, content: wrote } }], usage }
    }
    let script: ScriptedTurn[]
    if (task === TASKS.july || task === TASKS.september) script = deliver(task.path, propose('probe'))
    else if (task === TASKS.august) script = deliver(task.path, propose('probe2'))
    else if (task === TASKS.regress) {
      script = [
        { toolCalls: [{ name: 'cap_probe_total', arguments: { values: 'none' } }], usage },
        { toolCalls: [{ name: 'cap_probe_total', arguments: {} }], usage },
        { toolCalls: [{ name: 'cap_probe_total', arguments: { values: null } }], usage },
        { content: 'The helper failed.', usage },
      ]
    } else script = deliver(task.path)
    return script[Math.min(at, script.length - 1)]!
  }
}

let restoreEnv: () => void = () => undefined
afterEach(() => restoreEnv())

beforeAll(async () => {
  await access(DIST_ENTRY).catch(() => {
    throw new Error(`${DIST_ENTRY} is missing: run pnpm build first (the gate process runs the built entry)`)
  })
})

/** A project app over the scripted model server, with the real capabilities plugin and its gate captured. */
async function gateSdk() {
  const base = await tempDir('nexgent-trial-')
  const home = nodePath.join(base, 'home')
  const root = nodePath.join(base, 'project')
  await mkdir(home)
  await mkdir(root)
  await writeFile(nodePath.join(root, 'orders.csv'), 'region,amount\nnorth,1\nsouth,2\n')

  const model = new Model()
  const server: ScriptedModelServer = await scriptedModelServer({ script: Array.from({ length: 1_000 }, () => (body: Body) => model.respond(body)) })
  // The gate and replay processes inherit this process's environment: only the fake key and the local server.
  const saved = { key: process.env.NEXGENT_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, url: process.env.NEXGENT_API_BASE_URL }
  process.env.NEXGENT_API_KEY = KEY
  delete process.env.ANTHROPIC_API_KEY
  process.env.NEXGENT_API_BASE_URL = server.baseUrl
  restoreEnv = () => {
    for (const [name, value] of [['NEXGENT_API_KEY', saved.key], ['ANTHROPIC_API_KEY', saved.anthropic], ['NEXGENT_API_BASE_URL', saved.url]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  // The real plugin, with the built entry (vitest runs the SDK from source) and the gate captured.
  let captured: Context | undefined
  const gateHost = (): GateHost | undefined => (captured === undefined ? undefined : gateOf(captured))
  const capabilities = {
    ...CapabilitiesPlugin,
    apply(ctx: Context, config: CapabilitiesPluginConfig = {}) {
      CapabilitiesPlugin.apply(ctx, { ...config, trial: { ...config.trial, entry: DIST_ENTRY } })
      captured = ctx
    },
  } as Plugin
  const env = { NEXGENT_HOME: home, NEXGENT_API_KEY: KEY, NEXGENT_API_BASE_URL: server.baseUrl }
  const sdk: LocalNexgentSdk = createSdk({
    appVersion: '0.0.0-test',
    env,
    home,
    approvalResponder: async request => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }),
    registry: { '@nexgent/capabilities': capabilities },
  })
  const project = await sdk.call('projects.open', { root, create: true })
  const layout = resolveWorkspaceLayout(project.root)
  const store = new CapabilityStore(layout.capabilities)
  const run = async (text: string) => {
    const session = await sdk.call('sessions.create', { projectId: project.projectId })
    const started = await sdk.startTurn({ projectId: project.projectId, sessionId: session.sessionId, text })
    expect((await started.done).reason).toEqual({ kind: 'completed' })
    return session.sessionId
  }
  const settle = async (candidateId: string) => {
    model.phase = 'trial'
    // The gate starts right after the turn ends (the plugin follows the agent's turn.end).
    for (let i = 0; i < 100 && gateHost()?.started.has(candidateId) !== true; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    await gateHost()!.settled()
    model.phase = 'main'
  }
  const dispose = async () => {
    await sdk.dispose()
    await server.close()
  }
  return { sdk, project, layout, store, run, settle, gateHost, model, server, root, dispose }
}

describe('the capability gate through the SDK', () => {
  it('adopts a better candidate, rejects a worse one, and rolls back a regression', { timeout: 300_000 }, async () => {
    const { sdk, project, layout, store, run, settle, gateHost, model, server, root, dispose } = await gateSdk()
    try {
      // 1. History, then the proposing task.
      await run(TASKS.june.text)
      await run(TASKS.lookup.text)
      expect(gateHost()?.started.size).toBe(0)
      const july = await run(TASKS.july.text)
      const [first] = await listCandidates(layout.capabilities)
      expect(first).toMatchObject({ sessionId: july })
      await settle(first!.id)
      expect(gateHost()!.started.has(first!.id)).toBe(true)
      const [trial] = await listTrials(layout.capabilities, first!.id)
      expect(trial?.end, await readFile(nodePath.join(layout.capabilities, 'trials', `${first!.id}.log`), 'utf8').catch(() => '')).toBeDefined()
      expect(trial!.end!.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0 } })
      // 3 cases × 2 repeats × 2 arms, each its own process.
      expect(trial!.receipts.filter(receipt => receipt.type === 'trial.run')).toHaveLength(12)
      expect(model.replays).toHaveLength(12)
      expect(new Set(model.replays.map(item => item.text))).toEqual(new Set([TASKS.july.text, TASKS.june.text, TASKS.lookup.text]))
      expect((await store.activation()).version).toBe(first!.version)
      expect((await store.history()).at(-1)).toMatchObject({ type: 'adopt', trigger: 'gate', version: first!.version })
      // The real project's outputs are the tasks' own; the replays wrote only to their copies.
      expect(await readFile(nodePath.join(root, TASKS.june.path), 'utf8')).toBe('{"total": 3}\n')
      const ledger = (await readLedgerRecords(project.root)).records as LedgerRecord[]
      const trialRequests = ledger.filter(record => record.type === 'llm.request.end' && record.trialId === trial!.trialId)
      expect(new Set(trialRequests.map(record => record.arm))).toEqual(new Set(['candidate', 'baseline']))
      expect(ledger.some(record => record.type === 'capability.decision' && record.trigger === 'gate' && record.outcome === 'adopted')).toBe(true)

      // 2. A worse candidate: rejected, kept with its receipts; the adopted version stays.
      model.replays.length = 0
      await run(TASKS.august.text)
      const second = (await listCandidates(layout.capabilities)).find(candidate => candidate.id !== first!.id)!
      await settle(second.id)
      const [rejected] = await listTrials(layout.capabilities, second.id)
      expect(rejected!.end!.verdict.outcome).toBe('reject')
      expect(['quality-down', 'guard-regressed']).toContain(rejected!.end!.verdict.reason)
      expect((await store.decisions()).find(decision => decision.candidateId === second.id)).toMatchObject({ outcome: 'rejected', trigger: 'gate' })
      expect(await store.versions()).toContain(second.version)
      expect((await store.activation()).version).toBe(first!.version)

      // 3. The new tool fails three times in a row on the adopted version: rolled back after the turn.
      await run(TASKS.regress.text)
      await gateHost()!.watchUsage()
      expect((await store.activation()).version).toBe('baseline')
      const rollback = (await store.decisions()).find(decision => decision.outcome === 'rolled-back')
      expect(rollback).toMatchObject({ trigger: 'usage-regression', reason: 'component-errors', candidateId: first!.id, regression: { consecutiveErrors: 3 } })

      // 4. autoTrial off: the candidate waits for capabilities.trial.
      await writeFile(layout.configFile, JSON.stringify({ capabilities: { autoTrial: false } }))
      await run(TASKS.september.text)
      const third = (await listCandidates(layout.capabilities)).find(candidate => candidate.id !== first!.id && candidate.id !== second.id)!
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(gateHost()!.started.has(third.id)).toBe(false)
      model.phase = 'trial'
      const view = await sdk.call('capabilities.trial', { projectId: project.projectId, candidateId: third.id })
      expect(['trialing', 'adopted']).toContain(view.status)
      await settle(third.id)
      expect((await sdk.call('capabilities.show', { projectId: project.projectId, candidateId: third.id })).view.status).toBe('adopted')
      expect((await store.activation()).version).toBe(third.version)
      await expect(sdk.call('capabilities.trial', { projectId: project.projectId, candidateId: third.id })).rejects.toMatchObject({ code: 'tool/invalid-input' })

      // Nothing went anywhere but the local server, and nothing wrote the key.
      expect(server.requests.length).toBeGreaterThan(30)
      const files = (await readdir(layout.dataDir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
      for (const file of files) expect(await readFile(nodePath.join(file.parentPath, file.name), 'utf8')).not.toContain(KEY)
    } finally {
      await dispose()
    }
  })

  it('starts the gate again on capabilities.trial after an automatic gate waited for history, without a restart', { timeout: 300_000 }, async () => {
    const { sdk, project, layout, store, run, settle, gateHost, model, dispose } = await gateSdk()
    try {
      // The proposing task comes first: the automatic gate finds no history, waits and exits.
      await run(TASKS.july.text)
      const [candidate] = await listCandidates(layout.capabilities)
      await settle(candidate!.id)
      const waited = gateHost()!.started.get(candidate!.id)!
      expect(await waited.exited).toBe(0)
      expect(await listTrials(layout.capabilities, candidate!.id)).toEqual([])
      expect(await readFile(nodePath.join(layout.capabilities, 'trials', `${candidate!.id}.log`), 'utf8')).toContain('"status":"waiting"')
      await expect(sdk.call('capabilities.trial', { projectId: project.projectId, candidateId: candidate!.id })).rejects.toMatchObject({ code: 'tool/invalid-input', message: expect.stringContaining('the gate cannot run yet') })

      // History arrives in the same app; capabilities.trial now starts a new gate process.
      await run(TASKS.june.text)
      await run(TASKS.lookup.text)
      model.phase = 'trial'
      const view = await sdk.call('capabilities.trial', { projectId: project.projectId, candidateId: candidate!.id })
      expect(['trialing', 'adopted']).toContain(view.status)
      const restarted = gateHost()!.started.get(candidate!.id)!
      expect(restarted).not.toBe(waited)
      await settle(candidate!.id)
      expect(await restarted.exited).toBe(0)
      const [trial] = await listTrials(layout.capabilities, candidate!.id)
      expect(trial!.end!.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up' })
      expect((await sdk.call('capabilities.show', { projectId: project.projectId, candidateId: candidate!.id })).view.status).toBe('adopted')
      expect((await store.activation()).version).toBe(candidate!.version)
    } finally {
      await dispose()
    }
  })

  it('judges an improvement job\'s candidate on its feedback task: replays before the feedback, feedback checks, the job\'s trial phase', { timeout: 300_000 }, async () => {
    const { sdk, project, layout, store, run, settle, model, dispose } = await gateSdk()
    try {
      // History; the june task then gets feedback (a second turn that must never be replayed).
      const june = await run(TASKS.june.text)
      await run(TASKS.lookup.text)
      await run(TASKS.october.text)
      expect(await listCandidates(layout.capabilities)).toEqual([])
      const deliverable = (await sdk.call('deliverables.list', { projectId: project.projectId })).find(item => item.versions[0]!.files.some(file => file.path === TASKS.june.path))!
      const comment = 'The totals must be JSON, not prose.'
      const feedbackTurnEnded = new Promise<void>(resolve => {
        const off = sdk.subscribe(event => {
          if (event.type === 'turn.end' && event.sessionId === june && event.turn === 2) {
            off()
            resolve()
          }
        })
      })
      await sdk.call('feedback.submit', { projectId: project.projectId, sessionId: june, deliverableId: deliverable.deliverableId, version: 1, rating: 2, comment })
      await feedbackTurnEnded
      const [feedback] = await sdk.call('feedback.list', { projectId: project.projectId, sessionId: june })

      // An improvement job answering that feedback, and its candidate (proposed from the job's own session, not the june task).
      const at = new Date().toISOString()
      const job: ImprovementJob = {
        formatVersion: 1,
        id: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
        createdAt: at,
        updatedAt: at,
        trigger: 'explicit',
        status: 'trialing',
        items: [{ kind: 'feedback', feedbackId: feedback!.id, sessionId: june, deliverableId: deliverable.deliverableId, version: 1, rating: 2, at }],
        history: [{ status: 'queued', at }, { status: 'trialing', at }],
        phases: {},
        // Step 6: a comparison arm's job pinned on a child improver; the trial records name both.
        improverVersion: 'a'.repeat(64),
        arm: { metaJobId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d', arm: 'child' },
      }
      await mkdir(nodePath.join(layout.dataDir, IMPROVEMENTS_DIR, job.id), { recursive: true })
      await writeFile(nodePath.join(layout.dataDir, IMPROVEMENTS_DIR, job.id, IMPROVEMENT_FILES.job), JSON.stringify(job))
      const component = { kind: 'function-module' as const, name: 'probe' }
      const { record: candidate } = await writeCandidate(layout.capabilities, {
        sessionId: '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e',
        taskId: '1b2c3d4e-5f60-4172-8839-4a5b6c7d8e9f',
        turn: 1,
        base: BASELINE_BUNDLE,
        components: [{ ...component, files: new Map([['functions.json', Buffer.from(JSON.stringify(SPEC('probe')))], ['index.mjs', Buffer.from(SOURCE)]]) }],
        proofs: [{ ...component, turn: 1, toolCallId: 'call-1' }],
        origin: 'improvement',
        jobId: job.id,
      })

      model.replays.length = 0
      model.phase = 'trial'
      await sdk.call('capabilities.trial', { projectId: project.projectId, candidateId: candidate.id })
      await settle(candidate.id)
      const [trial] = await listTrials(layout.capabilities, candidate.id)
      expect(trial?.end, await readFile(nodePath.join(layout.capabilities, 'trials', `${candidate.id}.log`), 'utf8').catch(() => '')).toBeDefined()
      const start = trial!.receipts[0]
      if (start?.type !== 'trial.start') throw new Error('no start')
      expect(start.plan.selection[0]).toMatchObject({ sessionId: june, throughTurn: 1, feedbackIds: [feedback!.id] })
      // The june task replays its first turn only: the feedback text never reaches a replay.
      const juneReplays = model.replays.filter(item => item.text === TASKS.june.text)
      expect(juneReplays).toHaveLength(4)
      expect(trial!.receipts.filter(receipt => receipt.type === 'trial.feedback').map(receipt => receipt.type === 'trial.feedback' && [receipt.arm, receipt.status]))
        .toEqual([['candidate', 'pass'], ['baseline', 'fail'], ['candidate', 'pass'], ['baseline', 'fail']])
      expect(model.feedbackChecks.every(text => text.includes(comment))).toBe(true)
      expect(trial!.end!.verdict).toMatchObject({ outcome: 'adopt', feedbackPassRate: { candidate: 1, baseline: 0 } })
      expect((await store.activation()).version).toBe(candidate.version)
      // Every request of the trial (replays and feedback checks) belongs to the job's trial phase.
      const ledger = (await readLedgerRecords(project.root)).records as LedgerRecord[]
      const requests = ledger.filter(record => record.type === 'llm.request.end' && record.trialId === trial!.trialId)
      expect(requests.length).toBeGreaterThan(12)
      expect(requests.every(record => record.improvementId === job.id && record.improvementPhase === 'trial')).toBe(true)
      expect(requests.every(record => record.improverVersion === job.improverVersion && record.metaJobId === job.arm!.metaJobId && record.comparisonArm === 'child')).toBe(true)
      // Replays and reviews both: the replay sessions' records carry an arm, the reviewer's none.
      expect(new Set(requests.map(record => record.arm))).toEqual(new Set(['candidate', 'baseline', undefined]))
      // Display-only USD: the price table over the ledger's own records (unknown when a usage field is).
      const priced = (arm?: string) => estimateUsdTotal(requests.flatMap(record => (record.type === 'llm.request.end' && record.arm === arm ? [{ model: record.model, usage: record.usage }] : [])))
      expect(trial!.end!.cost.candidate.estimatedUsd).toEqual(priced('candidate'))
      expect(trial!.end!.cost.review.estimatedUsd).toEqual(priced(undefined))
    } finally {
      await dispose()
    }
  })
})

describe('the feedback check answer', () => {
  it('reads solved true / false / null, and nothing else', () => {
    expect(parseFeedbackCheck('{"solved": true, "reason": "fixed"}')).toEqual({ status: 'pass', reason: 'fixed' })
    expect(parseFeedbackCheck('Here: {"solved": false, "reason": "still prose"} done')).toEqual({ status: 'fail', reason: 'still prose' })
    expect(parseFeedbackCheck('{"solved": null, "reason": "cannot tell"}')).toEqual({ status: 'unknown', reason: 'cannot tell' })
    expect(parseFeedbackCheck('{"solved": "yes"}')).toBeUndefined()
    expect(parseFeedbackCheck('no json')).toBeUndefined()
  })
})
