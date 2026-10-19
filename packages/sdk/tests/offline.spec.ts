/**
 * ADR 0026/0027 through the SDK: `offline.list` shows the practice counts
 * and the defaults; a plan needs train, selection and holdout cases and
 * spends nothing; a run starts only when approved at exactly the planned
 * cap, once; stopping writes the stop file; `offline.revert` removes the
 * applied version.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { practiceCasesDirectory, writeAppliedProfile } from '@nexgent/capabilities'
import { offlineRunDirectory } from '@nexgent/evolve'
import { DEFAULT_OFFLINE_RETRIEVAL, OFFLINE_STOP_FILE } from '@nexgent/kernel'
import { testSdk } from './helpers.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function practice(home: string, splits: readonly ('train' | 'selection' | 'holdout' | 'guard')[]): Promise<void> {
  const directory = practiceCasesDirectory(home)
  await mkdir(directory, { recursive: true })
  for (const [index, split] of splits.entries()) {
    const generic = split === 'guard'
    await writeFile(nodePath.join(directory, `${id(index + 1)}.json`), JSON.stringify({
      formatVersion: 1,
      id: id(index + 1),
      source: generic ? 'generic' : 'task',
      createdAt: '2026-10-19T00:00:00.000Z',
      prompt: `task ${index + 1}`,
      similarityKey: ['task'],
      clusterId: `c${index}`,
      split,
    }))
  }
}

describe('offline.*', () => {
  it('plans for free, starts only when approved at the planned cap, once, and stops on request', async () => {
    const launched: string[] = []
    const t = await testSdk([], { offlineLauncher: (_home, runId) => launched.push(runId) })
    try {
      const empty = await t.sdk.call('offline.list', {})
      expect(empty).toMatchObject({ runs: [], practice: { train: 0, selection: 0, holdout: 0, guard: 0 }, defaults: { executionGuidance: '', retrieval: DEFAULT_OFFLINE_RETRIEVAL } })
      await expect(t.sdk.call('offline.plan', {})).rejects.toMatchObject({ code: 'tool/invalid-input' })

      await practice(t.home, ['train', 'train', 'selection', 'holdout', 'guard'])
      const planned = await t.sdk.call('offline.plan', {})
      expect(planned).toMatchObject({ status: 'awaiting-approval', live: false, spentUsd: 0, cases: { minibatch: 2, selection: 1, holdout: 1, guard: 1 }, resumable: false })
      expect(launched).toEqual([])
      await expect(t.sdk.call('offline.approve', { runId: planned.runId, capUsd: planned.capUsd + 1 })).rejects.toMatchObject({ code: 'tool/invalid-input' })
      expect(launched).toEqual([])
      const approved = await t.sdk.call('offline.approve', { runId: planned.runId, capUsd: planned.capUsd })
      expect(approved.approvedAt).toBeDefined()
      expect(launched).toEqual([planned.runId])
      await expect(t.sdk.call('offline.approve', { runId: planned.runId, capUsd: planned.capUsd })).rejects.toMatchObject({ code: 'tool/invalid-input' })
      // Approved but no process holds it (the stub started none): it can be continued.
      expect((await t.sdk.call('offline.list', {})).runs[0]).toMatchObject({ runId: planned.runId, resumable: true })
      await t.sdk.call('offline.resume', { runId: planned.runId })
      expect(launched).toEqual([planned.runId, planned.runId])
      await t.sdk.call('offline.stop', { runId: planned.runId })
      await access(nodePath.join(offlineRunDirectory(t.home, planned.runId), OFFLINE_STOP_FILE))
      await expect(t.sdk.call('offline.decide', { runId: planned.runId, answer: 'apply' })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    } finally {
      await t.sdk.dispose()
    }
  })

  it('reverts the applied version', async () => {
    const t = await testSdk([], { offlineLauncher: () => undefined })
    try {
      await writeAppliedProfile(t.home, { formatVersion: 1, runId: id(9), versionId: 1, candidate: { executionGuidance: 'Check the result.', retrieval: DEFAULT_OFFLINE_RETRIEVAL }, appliedAt: '2026-10-19T00:00:00.000Z' })
      expect((await t.sdk.call('offline.list', {})).applied?.candidate.executionGuidance).toBe('Check the result.')
      expect((await t.sdk.call('offline.revert', {})).applied).toBeUndefined()
    } finally {
      await t.sdk.dispose()
    }
  })
})
