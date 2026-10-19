/**
 * ADR 0027: the execution profile running sessions use. The applied
 * version is user level; a trial copy reads only its own candidate; the
 * guidance is given once per root task; retrieval thresholds and the skill
 * draw follow the profile; a replay copy is a trial copy whatever version it
 * runs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASELINE_VERSION, DEFAULT_OFFLINE_RETRIEVAL, resolveWorkspaceLayout, type HandbookEntry, type OfflineCandidate, type SessionRecord } from '@nexgent/kernel'
import {
  CapabilityStore,
  clearAppliedProfile,
  EXECUTION_GUIDANCE_HEADER,
  guidanceForTurn,
  HandbookIndex,
  isTrialCopy,
  prepareReplayProject,
  readAppliedProfile,
  readExecutionProfile,
  withGuidance,
  writeAppliedProfile,
} from '../src/index.js'
import { tempDir } from './helpers.js'
import { pastTask } from './trial-fixture.js'

const CANDIDATE: OfflineCandidate = { executionGuidance: 'Check the result against the request before finishing.', retrieval: { ...DEFAULT_OFFLINE_RETRIEVAL, handbookTopK: 3 } }

const start = (extra: Record<string, unknown> = {}): SessionRecord => ({ type: 'session.start', seq: 1, at: 'x', sessionId: 's', projectRoot: '/p', model: 'm', sandboxMode: 'workspace-write', ...extra }) as unknown as SessionRecord
const inject = (content: string): SessionRecord => ({ type: 'user.message', seq: 2, at: 'x', turn: 1, content, source: 'inject' }) as unknown as SessionRecord

describe('execution profile', () => {
  it('reads the applied version in a real project and only the copy candidate in a trial copy', async () => {
    const home = await tempDir()
    const dataDir = await tempDir()
    expect(await readExecutionProfile({ home, dataDir, trialCopy: false })).toBeUndefined()
    await writeAppliedProfile(home, { formatVersion: 1, runId: '00000000-0000-4000-8000-000000000001', versionId: 2, candidate: CANDIDATE, appliedAt: '2026-10-19T00:00:00.000Z' })
    expect(await readExecutionProfile({ home, dataDir, trialCopy: false })).toEqual(CANDIDATE)
    // A copy never reads the applied version: without its own candidate it runs the defaults.
    expect(await readExecutionProfile({ home, dataDir, trialCopy: true })).toBeUndefined()
    await expect(writeAppliedProfile(home, { formatVersion: 1, runId: 'r', versionId: 1, candidate: { ...CANDIDATE, sandbox: 'off' } as unknown as OfflineCandidate, appliedAt: 'x' })).rejects.toThrow(/frozen/)
    await clearAppliedProfile(home)
    expect(await readAppliedProfile(home)).toBeUndefined()
  })

  it('gives the guidance once, first, to root tasks only', () => {
    const block = guidanceForTurn([start()], CANDIDATE.executionGuidance)
    expect(block).toBe(`${EXECUTION_GUIDANCE_HEADER}\n${CANDIDATE.executionGuidance}`)
    expect(guidanceForTurn([start(), inject(block!)], CANDIDATE.executionGuidance)).toBeUndefined()
    expect(guidanceForTurn([start({ parentSessionId: 'p' })], CANDIDATE.executionGuidance)).toBeUndefined()
    expect(guidanceForTurn([start({ purpose: 'improvement' })], CANDIDATE.executionGuidance)).toBeUndefined()
    expect(guidanceForTurn([start()], '  ')).toBeUndefined()
    expect(withGuidance({ ids: ['e1'], text: 'entries' }, block)).toEqual({ ids: ['e1'], text: `${block}\n\nentries` })
    expect(withGuidance(undefined, block)).toEqual({ ids: [], text: block })
  })

  it('applies the relevance thresholds of the profile', () => {
    const entry: HandbookEntry = { id: 'e1', text: 'When totals are reported, add a row that sums every column so a reader can check them.', keywords: [], scope: 'project', status: 'active', helpful: 0, harmful: 0, sources: [], supersedes: [], createdAt: 'x', updatedAt: 'x' }
    const index = new HandbookIndex([entry, { ...entry, id: 'e2', text: 'Name output files after what they hold.' }])
    const query = 'report the totals'
    expect(index.search(query, 5)).toEqual([])
    expect(index.search(query, 5, new Set(), undefined, { minSharedTerms: 1, minCoverage: 0.05 }).map(hit => hit.entry.id)).toEqual(['e1'])
  })

  it('marks a replay copy as a trial copy even on the baseline version, and puts the candidate in it', async () => {
    const layout = resolveWorkspaceLayout(await tempDir())
    await mkdir(layout.dataDir, { recursive: true })
    await writeFile(join(layout.root, 'input.txt'), 'x')
    const task = await pastTask(layout, 'write out/result.txt')
    const tree = JSON.parse(await readFile(join(layout.dataDir, 'snapshots', 'tasks', `${task.taskId}.json`), 'utf8')).tree as string
    const copy = await prepareReplayProject({ layout, replay: { caseId: task.taskId, sessionId: task.sessionId, tree, checks: [], takenAt: new Date().toISOString(), messages: [{ text: 'write out/result.txt' }], feedback: [] }, version: BASELINE_VERSION, budget: {}, profile: CANDIDATE })
    try {
      const copyLayout = resolveWorkspaceLayout(copy.root)
      expect(await isTrialCopy(new CapabilityStore(copyLayout.capabilities))).toBe(true)
      expect(await readExecutionProfile({ home: await tempDir(), dataDir: copyLayout.dataDir, trialCopy: true })).toEqual(CANDIDATE)
      expect(await isTrialCopy(new CapabilityStore(layout.capabilities))).toBe(false)
    } finally {
      await copy.dispose()
    }
  })
})
