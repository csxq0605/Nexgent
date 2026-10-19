/**
 * `JobWatch` (step 5 W4; the D27 slot race): a job process writes the job's
 * final status before it frees the project's job slot, so the watch reports
 * the job again once the slot changes hands, and a subscriber re-reading the
 * listing then sees the slot free.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImprovementHost, ImprovementJob } from '@nexgent/evolve'
import { describe, expect, it } from 'vitest'
import { JobWatch } from '../src/index.js'

function fakeHost(directory: string) {
  const state = { jobs: [] as ImprovementJob[], activeJobId: undefined as string | undefined }
  const host = {
    directory,
    list: async () => state.jobs,
    queue: async () => ({ formatVersion: 1, pending: [], ...(state.activeJobId === undefined ? {} : { activeJobId: state.activeJobId }) }),
  } as unknown as ImprovementHost
  return { host, state }
}

const job = (id: string, status: string): ImprovementJob => ({ id, status } as unknown as ImprovementJob)

describe('JobWatch', () => {
  it('reports a finished job again when its slot is freed after its last status', async () => {
    const { host, state } = fakeHost(await mkdtemp(join(tmpdir(), 'nexgent-watch-')))
    state.jobs = [job('a', 'diagnosing')]
    state.activeJobId = 'a'
    const seen: string[] = []
    const watch = new JobWatch(host, changed => seen.push(`${changed.id}:${changed.status}`))
    await watch.start()
    try {
      // The process wrote the final status; the slot is still held.
      state.jobs = [job('a', 'no-proposal')]
      await watch.check()
      expect(seen).toEqual(['a:no-proposal'])
      // Then it frees the slot: no status changed, the job is reported again.
      state.activeJobId = undefined
      await watch.check()
      expect(seen).toEqual(['a:no-proposal', 'a:no-proposal'])
      // Nothing changed: nothing reported.
      await watch.check()
      expect(seen).toHaveLength(2)
    } finally {
      watch.stop()
    }
  })

  it('reports a job once when its status and the slot change in the same look; a slot passed on reports the released job', async () => {
    const { host, state } = fakeHost(await mkdtemp(join(tmpdir(), 'nexgent-watch-')))
    state.jobs = [job('a', 'diagnosing')]
    state.activeJobId = 'a'
    const seen: string[] = []
    const watch = new JobWatch(host, changed => seen.push(`${changed.id}:${changed.status}`))
    await watch.start()
    try {
      state.jobs = [job('a', 'failed')]
      state.activeJobId = undefined
      await watch.check()
      expect(seen).toEqual(['a:failed'])
      // b starts and runs; a chained job c takes the slot after b finished.
      state.jobs = [job('a', 'failed'), job('b', 'diagnosing')]
      state.activeJobId = 'b'
      await watch.check()
      state.jobs = [job('a', 'failed'), job('b', 'rejected'), job('c', 'queued')]
      await watch.check()
      state.activeJobId = 'c'
      await watch.check()
      expect(seen).toEqual(['a:failed', 'b:diagnosing', 'b:rejected', 'c:queued', 'b:rejected'])
    } finally {
      watch.stop()
    }
  })
})
