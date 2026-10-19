/**
 * ADR 0026/0027: the SDK's `offline.*` methods (user level). Planning spends
 * nothing; a run starts only when the user approves its planned cap, in a
 * detached `offline-entry.js run <runId>` process; a finished run's
 * recommended version takes effect only when the user applies it, for
 * every project, from the next task on, and can be stopped again
 * (`offline.revert`).
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clearAppliedProfile, listPracticeCases, practiceCounts, readAppliedProfile } from '@nexgent/capabilities'
import {
  approveOfflineRun,
  decideOfflineRun,
  listOfflineRuns,
  offlineRunDirectory,
  offlineStartingVersion,
  planOfflineRun,
  readOfflineRun,
  stopOfflineRun,
} from '@nexgent/evolve'
import { DEFAULT_OFFLINE_RETRIEVAL, NexgentError, type OfflineRunState } from '@nexgent/kernel'
import type { OfflineListing, OfflineRunView } from './api.js'
import { OFFLINE_ENTRY, OFFLINE_LOCK_FILE } from './offline-entry.js'

/** Starts a run's process. */
export type OfflineLauncher = (home: string, runId: string) => void

/** The default launcher: a detached Node process, its output in `<run>/run.log`. */
export const spawnOfflineRun: OfflineLauncher = (home, runId) => {
  const directory = offlineRunDirectory(home, runId)
  mkdirSync(directory, { recursive: true })
  const log = openSync(join(directory, 'run.log'), 'a')
  try {
    const child = spawn(process.execPath, [OFFLINE_ENTRY, 'run', runId], {
      detached: true,
      stdio: ['ignore', log, log],
      // Under Electron `process.execPath` is the app binary: run it as plain Node.
      env: { ...process.env, NEXGENT_HOME: home, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
      windowsHide: true,
    })
    child.on('error', () => undefined)
    child.unref()
  } finally {
    closeSync(log)
  }
}

/** Whether a process is working on the run (its lock names a live pid). */
export async function offlineRunLive(home: string, runId: string): Promise<boolean> {
  const text = await readFile(join(offlineRunDirectory(home, runId), OFFLINE_LOCK_FILE), 'utf8').catch(() => undefined)
  const pid = text === undefined ? NaN : Number.parseInt(text, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The page's view of a run. */
export async function runView(home: string, state: OfflineRunState): Promise<OfflineRunView> {
  const isLive = await offlineRunLive(home, state.plan.runId)
  const best = state.result?.verdict === 'recommended' ? state.archive.find(entry => entry.id === state.result!.bestId)?.candidate : undefined
  const approved = state.approval !== undefined && state.approval.capUsd === state.plan.capUsd
  const interrupted = state.status === 'running' && !isLive
  // Approved but never started (the launch failed), interrupted, or stopped by the user or an error: the same plan and cap continue.
  const resumable = approved && !isLive && (interrupted || state.status === 'awaiting-approval' || (state.status === 'stopped' && state.stop?.reason !== 'budget'))
  return {
    runId: state.plan.runId,
    createdAt: state.plan.createdAt,
    status: state.status,
    live: isLive,
    capUsd: state.plan.capUsd,
    estimateUsd: state.plan.estimate.usd,
    ...(state.approval === undefined ? {} : { approvedAt: state.approval.at }),
    spentUsd: state.spentUsd,
    iteration: state.iteration,
    maxIterations: state.plan.maxIterations,
    versions: state.archive.length,
    cases: { minibatch: state.plan.cases.minibatch.length, selection: state.plan.cases.selection.length, holdout: state.plan.cases.holdout.length, guard: state.plan.cases.guard.length },
    ...(state.stop === undefined ? {} : { stop: state.stop }),
    ...(state.result === undefined ? {} : { result: state.result }),
    ...(state.decision === undefined ? {} : { decision: state.decision }),
    start: state.archive[0]!.candidate,
    ...(best === undefined ? {} : { best }),
    resumable,
  }
}

/** `offline.list`. */
export async function list(home: string): Promise<OfflineListing> {
  const [runs, applied, cases] = await Promise.all([listOfflineRuns(home), readAppliedProfile(home), listPracticeCases(home, { audience: 'measure' })])
  return {
    runs: await Promise.all(runs.map(state => runView(home, state))),
    ...(applied === undefined ? {} : { applied }),
    defaults: { executionGuidance: '', retrieval: { ...DEFAULT_OFFLINE_RETRIEVAL } },
    practice: practiceCounts(cases),
  }
}

/** `offline.plan`: from the whole practice set (the run keeps holdout and guard cases out of the search). */
export async function plan(home: string): Promise<OfflineRunView> {
  const cases = await listPracticeCases(home, { audience: 'measure' })
  const state = await planOfflineRun({ home, cases, start: await offlineStartingVersion(home) })
  return runView(home, state)
}

async function start(home: string, runId: string, launch: OfflineLauncher): Promise<OfflineRunView> {
  if (await offlineRunLive(home, runId)) throw new NexgentError('tool/invalid-input', `offline run ${runId} is already running`)
  launch(home, runId)
  return runView(home, await readOfflineRun(home, runId))
}

/** `offline.approve`: exactly the planned cap, then start. */
export async function approve(home: string, input: { readonly runId: string; readonly capUsd: number }, launch: OfflineLauncher): Promise<OfflineRunView> {
  if ((await readOfflineRun(home, input.runId)).approval !== undefined) throw new NexgentError('tool/invalid-input', `offline run ${input.runId} is already approved`)
  await approveOfflineRun(home, input.runId, input.capUsd)
  return start(home, input.runId, launch)
}

/** `offline.resume`. */
export async function resume(home: string, runId: string, launch: OfflineLauncher): Promise<OfflineRunView> {
  const view = await runView(home, await readOfflineRun(home, runId))
  if (!view.resumable) throw new NexgentError('tool/invalid-input', `offline run ${runId} cannot be continued (${view.status}${view.stop === undefined ? '' : `, ${view.stop.reason}`})`)
  return start(home, runId, launch)
}

/** `offline.stop`. */
export async function stop(home: string, runId: string): Promise<OfflineRunView> {
  await readOfflineRun(home, runId)
  await stopOfflineRun(home, runId)
  return runView(home, await readOfflineRun(home, runId))
}

/** `offline.decide`. */
export async function decide(home: string, input: { readonly runId: string; readonly answer: 'apply' | 'decline' }): Promise<OfflineRunView> {
  if (input.answer !== 'apply' && input.answer !== 'decline') throw new NexgentError('tool/invalid-input', 'answer is apply or decline')
  return runView(home, await decideOfflineRun(home, input.runId, input.answer))
}

/** `offline.revert`. */
export async function revert(home: string): Promise<OfflineListing> {
  await clearAppliedProfile(home)
  return list(home)
}
