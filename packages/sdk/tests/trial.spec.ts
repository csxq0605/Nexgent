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
import { CapabilitiesPlugin, CapabilityStore, gateOf, listCandidates, listTrials, type CapabilitiesPluginConfig, type GateHost } from '@nexgent/capabilities'
import { resolveWorkspaceLayout, type Context, type LedgerRecord, type Plugin } from '@nexgent/kernel'
import { readLedgerRecords, scriptedModelServer, type MessagesRequestBody, type ScriptedModelServer, type ScriptedTurn } from '@nexgent/test-support'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createSdk, type LocalNexgentSdk } from '../src/index.js'
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

  respond(body: Body): ScriptedTurn {
    if (JSON.stringify(body.system ?? '').includes('quality gate')) return { content: '{"better": "tie", "reason": "same"}', usage }
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

describe('the capability gate through the SDK', () => {
  it('adopts a better candidate, rejects a worse one, and rolls back a regression', { timeout: 300_000 }, async () => {
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
    try {
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
      await sdk.dispose()
      await server.close()
    }
  })
})
