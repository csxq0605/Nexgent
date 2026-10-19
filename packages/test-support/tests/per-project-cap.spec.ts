/**
 * `costCaps.perProject` across OS processes (partition step 4 §现状与差距:
 * "需一个测试确认"). The kernel's unit tests count a shared in-memory ledger;
 * this test runs each turn in its own `node` process through `@nexgent/sdk`,
 * so the only thing the processes share is the project's ledger on disk.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadStep3Packages, createStep3Sdk } from '../../../scripts/accept-common/step3-runtime.mjs'
import { readLedgerRecords, scriptedModelServer, type ScriptedModelServer } from '../src/index.js'

const driver = fileURLToPath(new URL('../../../scripts/accept-common/step3-driver.mjs', import.meta.url))
const KEY = 'sk-per-project-cap-test-key'
const usage = { inputTokens: 30, outputTokens: 10 }

/** The slice of `@nexgent/sdk` this test calls (test-support does not depend on the SDK package). */
interface Sdk {
  call(method: 'projects.open', input: { root: string; create: boolean }): Promise<{ projectId: string }>
  call(method: 'settings.update', input: { projectId: string; patch: unknown }): Promise<unknown>
  call(method: 'sessions.create', input: { projectId: string; title: string }): Promise<{ sessionId: string }>
  dispose(): Promise<void>
}

interface DriverLine { readonly type: string; readonly reason?: { readonly kind: string; readonly cause?: string } }

/** One turn in a fresh `node` process (async: the scripted server answers from this process); returns the driver's last line. */
async function turnInChild(spec: Record<string, unknown>): Promise<DriverLine> {
  const child = spawn(process.execPath, [driver, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  const lines = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as DriverLine)
  const done = lines.find(line => line.type === 'driver.done')
  if (done === undefined) throw new Error(`driver did not finish (exit ${code}): ${stderr || stdout}`)
  return done
}

async function ledgerRecords(root: string, home: string): Promise<Record<string, unknown>[]> {
  // The ledger lives in the user data directory (ADR 0017), shared by the child processes through NEXGENT_HOME (the test's own home).
  return (await readLedgerRecords(root, { home })).records as unknown as Record<string, unknown>[]
}

describe('costCaps.perProject across processes (step 4 round 1 confirmation)', () => {
  let work: string
  let server: ScriptedModelServer

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'nexgent-per-project-'))
    server = await scriptedModelServer({
      script: [
        { content: 'first answer', usage },
        { content: 'second answer', usage },
        { content: 'must never be sent: over the per-project cap', usage },
      ],
    })
  })

  afterAll(async () => {
    await server?.close()
    await rm(work, { recursive: true, force: true })
  })

  it('a third process is stopped before any request once the project ledger holds maxRequests', async () => {
    const loaded = await loadStep3Packages()
    if (!loaded.ok) throw new Error(loaded.reason)
    const root = join(work, 'project')
    const home = join(work, 'home')
    await mkdir(root, { recursive: true })
    const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: KEY, NEXGENT_HOME: home }
    const sdk = createStep3Sdk(loaded.pkgs, { env, home }) as Sdk
    const sessions: string[] = []
    try {
      const { projectId } = await sdk.call('projects.open', { root, create: true })
      await sdk.call('settings.update', { projectId, patch: { costCaps: { perProject: { maxRequests: 2 } } } })
      for (const title of ['first', 'second']) sessions.push((await sdk.call('sessions.create', { projectId, title })).sessionId)
    } finally {
      await sdk.dispose()
    }

    // Two processes, two sessions: one request each, both under the cap.
    expect((await turnInChild({ root, home, env, sessionId: sessions[0], text: 'turn one' })).reason).toEqual({ kind: 'completed' })
    expect((await turnInChild({ root, home, env, sessionId: sessions[1], text: 'turn two' })).reason).toEqual({ kind: 'completed' })
    expect(server.requests).toHaveLength(2)

    // A third process sees two requests in the ledger on disk and sends nothing.
    expect((await turnInChild({ root, home, env, sessionId: sessions[0], text: 'turn three' })).reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(server.requests).toHaveLength(2)
    expect(server.remaining).toBe(1)

    const records = await ledgerRecords(root, home)
    expect(records.filter(record => record['type'] === 'llm.request.start')).toHaveLength(2)
    const outcomes = records.filter(record => record['type'] === 'task.outcome')
    expect(outcomes).toHaveLength(3)
    expect(outcomes.at(-1)).toMatchObject({
      status: 'cancelled',
      requestCount: 0,
      error: { code: 'budget/exhausted', details: { scope: 'project', metric: 'requests', used: 2, limit: 2 } },
    })
    // The key never reaches the ledger.
    expect(JSON.stringify(records)).not.toContain(KEY)
  }, 120_000)
})
