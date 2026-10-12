/**
 * A project with gate history for the trial tests: past root tasks with
 * sessions, snapshots and check records (written by the real
 * `LocalTaskRecorder`), a proposed candidate, and a scripted in-process
 * {@link TrialRunner} whose result per arm the test controls.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type CandidateRecord,
  type LLMUsage,
  type TaskCheckSpec,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { LocalTaskRecorder } from '@nexgent/tasking'
import { BASELINE_BUNDLE, writeCandidate, type ReplayRunRequest, type ReplayRunResult, type TrialRunner } from '../src/index.js'
import { tempDir } from './helpers.js'

/** The check every past task recorded: the output exists and says `good`. */
export const CHECK_COMMAND = 'node check.mjs'

export function specs(): TaskCheckSpec[] {
  return [
    { id: 'file-1', name: 'file-exists', path: 'out/result.txt' },
    { id: 'test-1', name: 'test-command', command: CHECK_COMMAND, shell: 'bash' },
  ]
}

/** A past root task: session with its user messages, snapshot at start, checks at end. */
export async function pastTask(layout: WorkspaceLayout, text: string, options: { readonly specs?: TaskCheckSpec[] } = {}): Promise<{ taskId: string; sessionId: string }> {
  const sessionId = randomUUID()
  const taskId = randomUUID()
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const lock = await store.create({ sessionId, projectRoot: layout.root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', capabilityVersion: 'baseline' })
  await store.append(sessionId, { type: 'turn.start', turn: 1 })
  await store.append(sessionId, { type: 'user.message', turn: 1, content: text, source: 'user' })
  await store.append(sessionId, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
  await store.release(lock)
  const recorder = new LocalTaskRecorder(layout)
  await recorder.begin({ taskId, sessionId, capabilityVersion: 'baseline' })
  const list = options.specs ?? specs()
  await mkdir(join(layout.dataDir, 'snapshots', 'checks'), { recursive: true })
  await writeFile(join(layout.dataDir, 'snapshots', 'checks', `${taskId}.json`), JSON.stringify({
    formatVersion: 1,
    taskId,
    sessionId,
    checkedAt: new Date().toISOString(),
    specs: list,
    results: list.map(spec => ({ name: spec.name, passed: true, target: spec.id })),
  }))
  return { taskId, sessionId }
}

/** A project with the checker script and `count` past order-summary / region tasks. */
export async function historyProject(texts: readonly string[] = [
  'summarize the june orders by region',
  'summarize the july orders by region',
  'build the region lookup table',
]): Promise<{ layout: WorkspaceLayout; tasks: { taskId: string; sessionId: string }[] }> {
  const root = await tempDir()
  const layout = resolveWorkspaceLayout(root)
  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'\nprocess.exit(readFileSync('out/result.txt', 'utf8') === 'good' ? 0 : 1)\n")
  await writeFile(join(root, 'data.csv'), 'region,amount\nnorth,1\n')
  const tasks = []
  for (const text of texts) tasks.push(await pastTask(layout, text))
  return { layout, tasks }
}

const MODULE = JSON.stringify({
  formatVersion: 1,
  name: 'order-summary',
  description: 'Summaries.',
  functions: [{ name: 'summarize', description: 'Summarize orders.', inputSchema: { type: 'object' }, effects: ['read'] }],
})

/** Propose a candidate from `taskId` with one function module (or a plugin). */
export async function proposeCandidate(layout: WorkspaceLayout, origin: { taskId: string; sessionId: string }, kind: 'function-module' | 'plugin' = 'function-module'): Promise<CandidateRecord> {
  const files = kind === 'function-module'
    ? new Map<string, Uint8Array>([['functions.json', Buffer.from(MODULE)], ['index.mjs', Buffer.from('export function summarize() { return 1 }\n')]])
    : new Map<string, Uint8Array>([
      ['plugin.json', Buffer.from(JSON.stringify({ formatVersion: 1, name: 'order-plugin', description: 'p', permissions: 'none', tools: [] }))],
      ['index.mjs', Buffer.from('export default { apply() {} }\n')],
    ])
  const name = kind === 'function-module' ? 'order-summary' : 'order-plugin'
  const { record } = await writeCandidate(layout.capabilities, {
    sessionId: origin.sessionId,
    taskId: origin.taskId,
    turn: 1,
    base: BASELINE_BUNDLE,
    components: [{ kind, name, files }],
    proofs: [{ kind, name, turn: 1, toolCallId: 'call-1' }],
    summary: 'reusable order summary',
  })
  return record
}

/** What a scripted arm does in one run. */
export interface ArmScript {
  /** Content written to `out/result.txt` (`undefined`: nothing written). */
  readonly output?: string
  readonly outcome?: ReplayRunResult['outcome']
  readonly tokens?: number
  /** Called with the run request (to look at the copy). */
  readonly inspect?: (request: ReplayRunRequest) => Promise<void> | void
}

export function usage(tokens: number): LLMUsage {
  return { ...ZERO_USAGE, inputTokens: Math.floor(tokens / 2), outputTokens: tokens - Math.floor(tokens / 2), totalTokens: tokens }
}

/** An in-process runner: per arm (and optionally per case), what the run does. */
export function scriptedRunner(script: (request: ReplayRunRequest) => ArmScript): TrialRunner & { readonly requests: ReplayRunRequest[] } {
  const requests: ReplayRunRequest[] = []
  return {
    requests,
    async run(request) {
      requests.push(request)
      const arm = script(request)
      await arm.inspect?.(request)
      if (arm.output !== undefined) {
        await mkdir(join(request.projectRoot, 'out'), { recursive: true })
        await writeFile(join(request.projectRoot, 'out', 'result.txt'), arm.output)
      }
      return { outcome: arm.outcome ?? 'completed', usage: usage(arm.tokens ?? 100), requestCount: 1 }
    },
  }
}

export async function readJsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}
