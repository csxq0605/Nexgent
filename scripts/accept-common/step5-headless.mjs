/**
 * The step-5 headless scenario (docs/plan/step-5-work-partition.md §`accept-step5`),
 * scripted model server only, through `@nexgent/sdk`.
 *
 * Round 1 runs the part today's product can carry: the feedback project
 * (step5-fixtures.mjs `runFeedbackProject`: history tasks, the feedback task, five
 * feedbacks of which three count) and records whether `@nexgent/evolve` is in the
 * product. The flow counts only when it is reachable the way a user reaches it: the
 * SDK exposes `improvements.*` (it installs `EvolvePlugin`, W4). The package alone
 * (`@nexgent/evolve`, PR #102) is not enough: without the plugin nothing counts.
 * The phases that need it (counting and the three triggers, the switch, concurrency
 * and recovery, then diagnosis, proposal and the gate) are added here as the SDK
 * wiring and the W0 contract land; until then the judges report not-implemented.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ordersCsv } from '../real-task/step5-orders.mjs'
import { loadStep3Packages } from './step3-runtime.mjs'
import { runFeedbackProject } from './step5-fixtures.mjs'

/** Whether the built `@nexgent/evolve` package is in the workspace (evidence only). */
export function evolvePackageBuilt() {
  return existsSync(new URL('../../packages/evolve/dist/index.js', import.meta.url))
}

/** Whether the SDK exposes the improvement flow (`improvements.*` methods): what the judges wait for. */
export function evolveInSdk(sdkPackage) {
  return (sdkPackage?.SDK_METHOD_NAMES ?? []).some(name => String(name).startsWith('improvements.'))
}

/** The CSV a fixture task read (for the fixture check). */
export const csvOf = task => ordersCsv(task.id.slice(-7))

/**
 * @param h - the loaded test-support harness.
 * @returns `{ features: { evolve, evolvePackage }, project }`.
 */
export async function runStep5Headless(h, work, { log = () => undefined } = {}) {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const obs = { features: { evolve: evolveInSdk(loaded.pkgs.sdk), evolvePackage: evolvePackageBuilt() } }
  log(`@nexgent/evolve package ${obs.features.evolvePackage ? 'built' : 'missing'}; SDK improvements.* ${obs.features.evolve ? 'present' : 'not wired yet'}`)
  obs.project = await runFeedbackProject(h, loaded.pkgs, join(work, 'feedback'), { log })
  return obs
}
