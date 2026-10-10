/**
 * Boot the shipped default profile with in-memory fakes registered under the
 * host plugin names, the way the CLI will register the real packages.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import {
  createApp,
  type AppProfilePatchEntry,
  type NexgentApp,
  type Workspace,
} from '../../src/index.js'
import { fakeWorkspace, MemoryLedger, MemorySessionStore, ScriptedLLM, type ScriptStep } from './fakes.js'

export interface Harness {
  readonly app: NexgentApp
  readonly llm: ScriptedLLM
  readonly store: MemorySessionStore
  readonly ledger: MemoryLedger
  readonly workspace: Workspace
  readonly root: string
  dispose(): Promise<void>
}

export interface HarnessOptions {
  readonly script?: ScriptStep[]
  readonly patches?: AppProfilePatchEntry[]
  readonly store?: MemorySessionStore
  readonly ledger?: MemoryLedger
  readonly root?: string
}

/** Fast test settings for the agents row. */
export const FAST_AGENTS: AppProfilePatchEntry = {
  id: 'agents',
  config: { toolAbortGraceMs: 200 },
}

export async function bootHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'nexgent-kernel-'))
  const llm = new ScriptedLLM(options.script ?? [])
  const store = options.store ?? new MemorySessionStore()
  const ledger = options.ledger ?? new MemoryLedger()
  const workspace = fakeWorkspace(root)
  const registry: Record<string, Plugin> = {
    '@nexgent/llm': { name: 'fake-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
    '@nexgent/session': {
      name: 'fake-session',
      apply: (ctx: Context) => {
        ctx.provide('session', store)
        ctx.provide('ledger', ledger)
      },
    },
    '@nexgent/workspace': { name: 'fake-workspace', apply: (ctx: Context) => { ctx.provide('workspace', workspace) } },
  }
  const app = await createApp({ registry, patches: [FAST_AGENTS, ...(options.patches ?? [])] })
  return {
    app,
    llm,
    store,
    ledger,
    workspace,
    root,
    dispose: async () => {
      await app.dispose()
      if (options.root === undefined) rmSync(root, { recursive: true, force: true })
    },
  }
}
