/**
 * K1 done criterion: on a large project the start of the second and later
 * root tasks with learning on (snapshot) is within 10% of learning off (no
 * snapshot). Real kernel loop, scripted model. Skipped unless
 * `NEXGENT_PERF=1`; prints the numbers (`NEXGENT_PERF_FILES`, default 20000).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { createApp, type Context, type ContextProvider, type ContextService, type LLMRequest } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { describe, expect, it } from 'vitest'
import { TaskingPlugin } from '../src/index.js'
import { tempDir } from './helpers.js'

const FILES = Number(process.env.NEXGENT_PERF_FILES ?? 20_000)
const TASKS = 4
/** Simulated model latency: delay between streamed events (`NEXGENT_PERF_MODEL_MS`, default 0). */
const MODEL_MS = Number(process.env.NEXGENT_PERF_MODEL_MS ?? 0)

function contextPlugin(): { name: string; apply(ctx: Context): void } {
  const providers: ContextProvider[] = []
  const service: ContextService = { providers, register: provider => (providers.push(provider), () => undefined) }
  return { name: 'test-context', apply: ctx => void ctx.provide('context', service) }
}

async function bigProject(learning: boolean): Promise<string> {
  const root = nodePath.join(await tempDir(), 'proj')
  for (let d = 0; d < Math.ceil(FILES / 100); d++) {
    const dir = nodePath.join(root, 'src', `d${d}`)
    await mkdir(dir, { recursive: true })
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(nodePath.join(dir, `f${i}.ts`), `export const v = ${d * 100 + i}\n`)))
  }
  await mkdir(nodePath.join(root, '.nexgent'), { recursive: true })
  await writeFile(nodePath.join(root, '.nexgent', 'config.json'), JSON.stringify({ version: 1, learning: { enabled: learning } }))
  return root
}

/** Per root task: ms from `run` to the first model request, to the end of its first tool call, and in all. */
async function measure(root: string): Promise<{ request: number; tool: number; total: number }[]> {
  let started = 0
  const marks: { request: number; tool: number; total: number }[] = []
  const script = Array.from({ length: TASKS }, () => [
    (_: LLMRequest) => {
      marks.push({ request: performance.now() - started, tool: 0, total: 0 })
      return { chunkDelayMs: MODEL_MS, toolCalls: [{ name: 'read_file', arguments: { path: 'src/d0/f0.ts' } }] }
    },
    (_: LLMRequest) => {
      marks.at(-1)!.tool = performance.now() - started
      return { chunkDelayMs: MODEL_MS, content: 'done' }
    },
  ]).flat()
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', scriptedProvider(script)) },
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
  try {
    await app.ctx.plugin(contextPlugin())
    await app.ctx.plugin(TaskingPlugin)
    for (let i = 0; i < TASKS; i++) {
      const agent = await app.agents.create({ title: `task ${i}` })
      started = performance.now()
      const result = await agent.run({ text: 'Read src/d0/f0.ts and say done.' })
      marks.at(-1)!.total = performance.now() - started
      expect(result.reason).toEqual({ kind: 'completed' })
    }
  } finally {
    await app.dispose()
  }
  return marks.map(mark => ({ request: Math.round(mark.request), tool: Math.round(mark.tool), total: Math.round(mark.total) }))
}

describe.skipIf(process.env.NEXGENT_PERF !== '1')('start time on a large project', () => {
  it(`root tasks on ${FILES} files, learning on and off`, async () => {
    const off = await measure(await bigProject(false))
    const on = await measure(await bigProject(true))
    console.log(`PERF-START files=${FILES} modelDelayMs=${MODEL_MS}\n  learning off: ${JSON.stringify(off)}\n  learning on:  ${JSON.stringify(on)}`)
    expect(on).toHaveLength(TASKS)
  }, 900_000)
})
