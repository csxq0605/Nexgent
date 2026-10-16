/**
 * How the step-5 acceptance scripts reach the improvement flow: the SDK as
 * shipped. `@nexgent/sdk` installs `@nexgent/evolve` itself (row `evolve`,
 * W4, PR #110) and starts each job through its own improve entry
 * (`improve-entry.js improve <root> <jobId>`, a detached process that runs
 * the diagnose and propose sessions and the gate). The scripts insert no
 * plugin row and no test entry; they read the queue and the jobs from the
 * files the product writes.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDirSync } from './data-dir.mjs'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { loadStep3Packages } from './step3-runtime.mjs'

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
 * The SDK as shipped, against the local scripted server.
 * @param options - `env` (loopback base URL, scripted key, home), `home`.
 */
export function createStep5Sdk(pkgs, { env, home }) {
  if (!isLoopbackUrl(env.NEXGENT_API_BASE_URL)) throw new Error(`createStep5Sdk: NEXGENT_API_BASE_URL must point at the local scripted server (got ${String(env.NEXGENT_API_BASE_URL)})`)
  return pkgs.sdk.createSdk({ appVersion: 'accept-step5', env, home })
}

/** `<dataDir>/improvements/` of a project root (its home registered by `withSdk` / the fixtures). */
export const improvementsPath = root => join(dataDirSync(root), 'improvements')

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
    detail: job.history?.at(-1)?.detail,
    candidateId: job.candidateId,
    trialId: job.trialId,
    decisionId: job.decisionId,
    sessions: job.sessions,
    phases: job.phases,
    firstUse: job.firstUse,
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

/**
 * Point the processes the SDK starts (improvement jobs, gates, replays) at the scripted key:
 * they inherit this process's environment, and the real key may be in it. The base URL goes
 * to them through the SDK's own row config. Returns the restore function.
 */
export function scriptedEnvironment(key) {
  const names = ['NEXGENT_API_KEY', 'ANTHROPIC_API_KEY']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.NEXGENT_API_KEY = key
  delete process.env.ANTHROPIC_API_KEY
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}
