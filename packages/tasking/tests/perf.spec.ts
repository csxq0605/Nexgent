/**
 * Snapshot and turn-file timings on a large project. Skipped unless
 * `NEXGENT_PERF=1`; prints the numbers (`NEXGENT_PERF_FILES` sets the count,
 * default 20000).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalTaskRecorder, LocalTurnFileTracker, walkProject } from '../src/index.js'
import { project, SESSION_A } from './helpers.js'

const FILES = Number(process.env.NEXGENT_PERF_FILES ?? 20_000)

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now()
  const result = await run()
  return [result, Math.round(performance.now() - start)]
}

describe.skipIf(process.env.NEXGENT_PERF !== '1')('performance', () => {
  it(`snapshots and tracks a ${FILES}-file project`, async () => {
    const p = await project()
    await writeFile(p.abs('.gitignore'), 'dist/\n')
    const dirs = Math.ceil(FILES / 100)
    for (let d = 0; d < dirs; d++) {
      const dir = p.abs(`src/d${d}`)
      await mkdir(dir, { recursive: true })
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(nodePath.join(dir, `f${i}.ts`), `export const v = ${d * 100 + i}\n`)))
    }
    // a big ignored directory the walk must not enter
    for (let d = 0; d < 100; d++) {
      await mkdir(p.abs(`dist/d${d}`), { recursive: true })
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(p.abs(`dist/d${d}/f${i}.js`), 'x')))
    }
    const recorder = new LocalTaskRecorder(p.workspace.layout)
    const [, first] = await timed(() => recorder.begin({ taskId: '0b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e', sessionId: SESSION_A, capabilityVersion: 'baseline', turn: 1 }))
    const [, second] = await timed(() => recorder.begin({ taskId: '0b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e', sessionId: SESSION_A, capabilityVersion: 'baseline', turn: 2 }))
    const [walked, walk] = await timed(() => walkProject(p.root))
    const tracker = new LocalTurnFileTracker(p.root)
    const [, begin] = await timed(() => tracker.beginTurn(SESSION_A, 1))
    tracker.observe({ sessionId: SESSION_A, turn: 1, callId: 'c', name: 'bash', isError: false })
    const [changes, end] = await timed(() => tracker.endTurn(SESSION_A, 1))
    console.log(`PERF files=${walked.files.length} snapshot#1=${first}ms snapshot#2(no changes)=${second}ms lstat-walk=${walk}ms beginTurn=${begin}ms endTurn(shell scan)=${end}ms`)
    expect(walked.files.length).toBe(FILES + 1)
    expect(changes).toEqual([])
  }, 600_000)
})
