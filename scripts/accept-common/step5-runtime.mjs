/**
 * SEAM: how the step-5 acceptance scripts reach the improvement flow.
 *
 * The SDK's own boot does not install `@nexgent/evolve` yet (W4 wires
 * `EvolvePlugin`, the job entry and `improvements.*`). Until it does, the
 * scripted layer inserts the plugin row itself (`createStep5Sdk({ evolve })`),
 * pointing it at a test job entry (`step5-job-entry.mjs`). Everything else is
 * the shipped product: feedback through `feedback.submit`, check failures from
 * the kernel's signal, the plugin's counting, the job host's processes and
 * recovery. Judges read `features.shipped` and never report a pass for an item
 * that only works with the inserted row (step5-judges.mjs).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { loadStep3Packages } from './step3-runtime.mjs'

/** The test job entry the inserted row starts jobs with (`improve <root> <jobId>`). */
export const JOB_ENTRY = fileURLToPath(new URL('./step5-job-entry.mjs', import.meta.url))

/** Stages the test job entry runs: `pending` (evolve's PENDING_STAGES: ends failed) or `hold` (stays diagnosing until killed). */
export const JOB_STAGES = ['pending', 'hold']

/** `@nexgent/sdk` and friends (step 3's set) plus `@nexgent/evolve` and `@nexgent/kernel`. */
export async function loadStep5Packages() {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) return loaded
  try {
    const evolve = await import(new URL('../../packages/evolve/dist/index.js', import.meta.url).href)
    const kernel = await import(new URL('../../packages/kernel/dist/index.js', import.meta.url).href)
    return { ok: true, pkgs: { ...loaded.pkgs, evolve, kernel } }
  } catch (error) {
    return { ok: false, reason: `@nexgent/evolve or @nexgent/kernel is not built (${error instanceof Error ? error.message : String(error)}); run \`pnpm build\`` }
  }
}

/**
 * An SDK for the scripted layer, optionally with the evolve row inserted.
 * @param options - `env` (loopback base URL, scripted key, home), `home`, `evolve`:
 *   `false` (the SDK as shipped) or `{ stages }` (insert `@nexgent/evolve` with the test entry).
 */
export function createStep5Sdk(pkgs, { env, home, evolve = false }) {
  if (!isLoopbackUrl(env.NEXGENT_API_BASE_URL)) throw new Error(`createStep5Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  const rows = evolve === false
    ? {}
    : {
        registry: { [pkgs.evolve.EvolvePlugin.name]: pkgs.evolve.EvolvePlugin },
        patches: [{ insert: [{ id: 'evolve', name: pkgs.evolve.EvolvePlugin.name, config: { entry: JOB_ENTRY, env: { STEP5_JOB_STAGES: evolve.stages ?? 'pending' } } }] }],
      }
  return pkgs.sdk.createSdk({ appVersion: 'accept-step5', env, home, ...rows })
}

/** `.nexgent/improvements/` of a project root. */
export const improvementsPath = root => join(root, '.nexgent', 'improvements')

/** The queue and the jobs of a project, as files say (no host). */
export async function readImprovements(pkgs, root) {
  const dir = improvementsPath(root)
  const queue = await pkgs.evolve.readQueue(dir).catch(() => undefined)
  const jobs = await pkgs.evolve.listJobs(dir).catch(() => [])
  return { queue, jobs }
}

/** A job as the judges see it: id, trigger, status, the feedback ids it cites, its history's statuses. */
export function jobView(job) {
  return {
    jobId: job.id,
    trigger: job.trigger,
    status: job.status,
    feedbackIds: (job.items ?? []).filter(item => item.kind === 'feedback').map(item => item.feedbackId),
    checkItems: (job.items ?? []).filter(item => item.kind === 'check-failure').length,
    history: (job.history ?? []).map(change => change.status),
  }
}

/** The feedback ids waiting in the queue (`pending`). */
export const pendingFeedback = queue => (queue?.pending ?? []).filter(item => item.kind === 'feedback').map(item => item.feedbackId)

/** Read a JSON file, or undefined. */
export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}
