import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { Context, LLMRequest } from '@nexgent/kernel'
import { scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { afterEach } from 'vitest'
import { createSdk, type LocalNexgentSdk, type LocalSdkOptions, type SdkEvent } from '../src/index.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined)
})

/** A fresh temp directory removed after the test. */
export async function tempDir(prefix = 'nexgent-sdk-'): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

export const TEST_KEY = 'sk-test-sdk-key-0123456789abcdef'

/** Script per project root (each project app gets its own provider). */
export type ScriptFor = (root: string) => ScriptEntry<LLMRequest>[]

export interface TestSdk {
  readonly sdk: LocalNexgentSdk
  readonly home: string
  readonly base: string
  /** Providers in boot order, with the root they serve. */
  readonly providers: Array<{ root: string; llm: ScriptedProvider }>
  readonly events: SdkEvent[]
  /** Events of one session. */
  eventsOf(sessionId: string): SdkEvent[]
}

/** An SDK over a scripted model with a hermetic env and home. */
export async function testSdk(script: ScriptFor | ScriptEntry<LLMRequest>[], options: Partial<LocalSdkOptions> = {}): Promise<TestSdk> {
  const base = await tempDir()
  const home = nodePath.join(base, 'home')
  await mkdir(home)
  const providers: Array<{ root: string; llm: ScriptedProvider }> = []
  const scriptFor: ScriptFor = typeof script === 'function' ? script : () => script
  const sdk = createSdk({
    appVersion: '0.0.0-test',
    env: { NEXGENT_API_KEY: TEST_KEY, NEXGENT_HOME: home },
    home,
    registry: {
      '@nexgent/llm': {
        name: 'scripted-llm',
        inject: ['workspace'],
        apply(ctx: Context) {
          const root = ctx.workspace.root
          const llm = scriptedProvider(scriptFor(root))
          providers.push({ root, llm })
          ctx.provide('llm', llm)
        },
      },
    },
    ...options,
  })
  cleanups.push(() => sdk.dispose())
  const events: SdkEvent[] = []
  sdk.subscribe(event => events.push(event))
  return { sdk, home, base, providers, events, eventsOf: sessionId => events.filter(event => event.sessionId === sessionId) }
}

/** Resolve once `predicate` holds for an event (checks already-received ones first). */
export function waitForEvent(t: TestSdk, predicate: (event: SdkEvent) => boolean, timeoutMs = 10_000): Promise<SdkEvent> {
  const hit = t.events.find(predicate)
  if (hit !== undefined) return Promise.resolve(hit)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for an SDK event'))
    }, timeoutMs)
    const unsubscribe = t.sdk.subscribe(event => {
      if (!predicate(event)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(event)
    })
  })
}

/** The system prompt of a request. */
export function systemOf(request: LLMRequest): string {
  const first = request.messages[0]
  return first?.role === 'system' ? String(first.content) : ''
}
