/**
 * Which improver a job runs on (step 6, ADR 0008 decision 1). A job reads
 * the improver in force once, when it starts, writes its version into
 * `job.json` (`improverVersion`) and uses only that bundle from then on:
 * the diagnosis policy, the proposal kinds and briefs, and the gate's
 * comparison parameters. An improver adopted while the job runs does not
 * affect it. Step-5 jobs carry no version and read as `v0`.
 *
 * The project's improvers live in `@nexgent/capabilities`' `ImproverStore`
 * (`.nexgent/improvers/`); {@link PROJECT_IMPROVERS} reads them there. A
 * project without revisions runs the built-in `v0`; an improver in force
 * that no longer loads is rolled back by the store (`load-failure`).
 */
import {
  effectiveTrialCounts,
  IMPROVER_V0_VERSION,
  type CapabilitiesConfig,
  type ImproverBundle,
  type ImproverComparisonParams,
  type ImproverVersion,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { improversDir, ImproverStore } from '@nexgent/capabilities'
import type { ImprovementJob } from './types.js'

/** The improver a job runs on. */
export interface PinnedImprover {
  readonly version: ImproverVersion
  readonly bundle: ImproverBundle
}

/** Where jobs read improvers (tests substitute their own). */
export interface ImproverSource {
  /** The improver in force now: the tail of the project's activation chain, `v0` without one. */
  current(layout: WorkspaceLayout): Promise<PinnedImprover>
  /**
   * The bundle of a version (a pinned job keeps loading its own after a newer one was adopted).
   * @throws `improver/not-found` or `improver/invalid`.
   */
  load(layout: WorkspaceLayout, version: ImproverVersion): Promise<ImproverBundle>
}

/** The project's improver store (`ImproverStore.resolve` / `load`). */
export const PROJECT_IMPROVERS: ImproverSource = {
  async current(layout) {
    const resolved = await new ImproverStore(improversDir(layout)).resolve()
    return { version: resolved.version, bundle: resolved.bundle }
  },
  load(layout, version) {
    return new ImproverStore(improversDir(layout)).load(version)
  },
}

/** The version a job pinned (`v0` for a step-5 job). */
export function jobImproverVersion(job: Pick<ImprovementJob, 'improverVersion'>): ImproverVersion {
  return job.improverVersion ?? IMPROVER_V0_VERSION
}

/** The gate parameters of a job's trial: the counts never below the project's (`effectiveTrialCounts`), the improver's selection. */
export function trialComparison(capabilities: Pick<CapabilitiesConfig, 'selectionCases' | 'repeats'>, improver: ImproverBundle): ImproverComparisonParams {
  return { ...effectiveTrialCounts(capabilities, improver), selection: improver.comparison.selection }
}
