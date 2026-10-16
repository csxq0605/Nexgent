/**
 * The step-6 desktop items D24–D27: Playwright drives the built Electron app
 * (real renderer, real `@nexgent/sdk` in the main process) against the scripted
 * Claude Messages API server — no real model, only the scripted key. Follows
 * step5-desktop.mjs; the improver-version and meta screens are W5's
 * (apps/desktop/tests/meta-e2e.spec.ts and gate-reasons-e2e.spec.ts show the
 * same screens). Since the rework R5 (ADR 0012, 0013) the improver and the
 * meta settings are the USER's: `<NEXGENT_HOME>/improvers/`,
 * `<NEXGENT_HOME>/config.json` and the queue `<NEXGENT_HOME>/improvements/queue.json`;
 * a project keeps only `improvement.shareImproverEvidence`.
 *
 * What is the product's own path and what is seeded:
 *
 *   real      every capability job (explicit jobs started through the SDK, and one started with
 *             "改进" on the deliverable card) and the meta jobs started with 立即元改进 (and, for
 *             the other project, through the SDK) and by the job-count rule: each runs in the
 *             SDK's improve entry as its own process, with its own sessions and ledger records;
 *             the improver rollback is clicked in the UI and written by the host; the settings
 *             are typed into the settings page (user section -> `<home>/config.json`, project
 *             section -> `.nexgent/config.json`) and written by the host
 *   seeded    ONE adopted meta job (D25's detail needs a finished comparison): its job file,
 *             `meta-diagnosis.json`, `change.json` and `comparison.json` are written here in the
 *             shape the flow leaves them, the child improver is written and adopted through
 *             `ImproverStore.user({ home })` (as the meta job does it: revision first, then the
 *             job's status); ONE finished job of a second project ("reports") pinned on the
 *             child and counted into the user queue (so the rollback confirmation can list it);
 *             and, in the last launch, three improvement jobs whose candidates the gate decided
 *             with the ADR 0013 reasons (`instance-literal`, `similar-regression`,
 *             `no-similar-cases`), as gate-reasons-e2e.spec.ts writes them. The scripted
 *             evaluator would need full arm projects / replays to produce them for real
 *             (partition W7, headless H04–H24); this scenario is about the screens. The seeded
 *             ids are in `obs.seeded` so the judges say what was seeded.
 *
 *   prep      the step-5 feedback project (headless, autoImprove off); real explicit job J1
 *             (no-proposal, improver v0); seed the adopted meta job (child improver C in force)
 *             and the other project's job on C; real explicit job J2 (no-proposal, pinned on C)
 *   launch 1  D24 cards (version and scope) and the improver section; D25 the seeded meta job's
 *             detail against its files; D27 rollback with a reason (the confirmation lists the
 *             projects that used C) -> revision 2 in the HOME, then the next jobs (J3 from the
 *             deliverable card, then 立即元改进, then a meta job of the other project) pin the
 *             rolled-back improver; D25 again for the real meta job (diagnosis only,
 *             ledger-priced); D26 meta switch on, K = 2, budget and window typed into the user
 *             section and saved, this project's 参与改进器学习 switched off and saved (no approval)
 *   launch 2  D26 the values survived; switched off with another budget, sharing back on
 *   launch 3  D26 the values survived again
 *   after     D26 switch off, K = 2 finished jobs (J4, J5) are counted by the USER queue: no meta
 *             job starts; as a control the switch is turned on (user settings) and one more
 *             finished job (J6) starts one on the job-count rule
 *   launch 4  D25 the three ADR 0013 conclusions (seeded now so that nothing before sees them)
 *             in the detail and, for the original-case-only one, in the approval dialog
 *
 * The scenario only observes; step6-desktop-judges.mjs decides. A step that throws is
 * recorded under `obs.errors.<item>` and stops what depends on it.
 */
import { appendFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDirSync, registerHome } from './data-dir.mjs'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { DESKTOP_DIR, VITE_BIN, ensureDisplay, poll, run } from './step2-desktop.mjs'
import { ledgerOf } from './step4-headless.mjs'
import { FEEDBACK_TASK, runFeedbackProject, SCRIPTED_API_KEY, TERMINAL_STATES } from './step5-fixtures.mjs'
import { Step5Model, USAGE } from './step5-model.mjs'
import { createStep5Sdk, improvementsPath, loadStep5Packages, readImprovements, scriptedEnvironment } from './step5-runtime.mjs'
import { loadCapabilities } from './step6-headless.mjs'
import { commitSettings, showTab, fillProjectPath } from './desktop-ui.mjs'

const TIMEOUT = 60_000
const WAIT = 45_000
const JOB_WAIT = 240_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))
const readJson = path => readFile(path, 'utf8').then(text => JSON.parse(text), () => undefined)
const SETTLED = new Set(TERMINAL_STATES)

/** Fake key the desktop app runs with. */
export const META_DESKTOP_KEY = 'sk-accept-step6-desktop'
/**
 * What the scenario types into the settings page: the user-level meta settings (enabled, everyJobs,
 * budget tokens, window days) and the project's 参与改进器学习 (`share`, saved on its own).
 */
export const META_SETTINGS = {
  on: { enabled: true, every: 2, budget: 2_000_000, window: 15, share: false },
  off: { enabled: false, every: 2, budget: 1_500_000, window: 20, share: true },
}
/** The paragraph the seeded child improver rewrites. */
export const SEEDED_CHANGE = { op: 'set-diagnosis-paragraph', index: 0, text: 'Before naming a failure, read every failed check of the task and quote its output; a diagnosis that ignores a failed check is wrong.' }

/**
 * Step 5's scripted model plus the meta-diagnose session of a meta job: it reports
 * `proposal: none` (the improver is fine), so a real meta job ends `no-proposal`.
 */
class MetaStep6Model extends Step5Model {
  respond(body) {
    const tools = (body?.tools ?? []).map(tool => tool?.name)
    if (tools.includes('improve_report_meta_diagnosis')) {
      const reported = (body?.messages ?? []).some(message => message.role === 'assistant')
      this.requests.push({ phase: this.phase, kind: 'meta-diagnose', step: reported ? 1 : 0 })
      if (reported) return { content: 'Reported.', usage: USAGE }
      return { toolCalls: [{ name: 'improve_report_meta_diagnosis', arguments: { findings: [], hypothesis: 'No improver problem is visible in the recent jobs.', proposal: 'none' } }], usage: USAGE }
    }
    return super.respond(body)
  }
}

// ---- files -----------------------------------------------------------------------------

/** The improver revisions (`<home>/improvers/activation/<n>.json`, the user-level line) in order. */
async function revisionsOf(home) {
  const dir = join(home, 'improvers', 'activation')
  const names = (await readdir(dir).catch(() => [])).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  const out = []
  for (const name of names) {
    const revision = await readJson(join(dir, name))
    out.push(revision === undefined ? { file: name, error: 'unreadable' } : { file: name, revision: revision.revision, type: revision.type, version: revision.version, from: revision.from, trigger: revision.trigger, reason: revision.reason, jobId: revision.jobId, committedAt: revision.committedAt })
  }
  return out
}

/** The user-level meta settings the host wrote (`<home>/config.json`, ADR 0012). */
async function userConfigOf(home) {
  const config = await readJson(join(home, 'config.json'))
  const meta = config?.improvement?.meta
  return { enabled: meta?.enabled, every: meta?.everyJobs, budget: meta?.budget?.maxTokens, window: meta?.budget?.windowDays }
}

/** What the project's own config holds on improvement (`.nexgent/config.json`): the sharing switch, and whatever `meta` it has (it must have none). */
async function projectConfigOf(root) {
  const config = await readJson(join(root, '.nexgent', 'config.json'))
  const improvement = config?.improvement
  return { share: improvement?.shareImproverEvidence, meta: improvement?.meta === undefined ? undefined : JSON.parse(JSON.stringify(improvement.meta)) }
}

/** A job file as the judges compare it with the screen. */
function jobFile(job) {
  return {
    id: job.id,
    kind: job.kind === 'meta' ? 'meta' : 'capability',
    trigger: job.trigger,
    status: job.status,
    improverVersion: job.improverVersion,
    improverScope: job.improverScope,
    createdAt: job.createdAt,
    arm: job.arm !== undefined,
    meta: job.meta === undefined ? undefined : {
      parentVersion: job.meta.parentVersion,
      childVersion: job.meta.childVersion,
      basis: (job.meta.basis ?? []).length,
      outcome: job.meta.compared?.outcome,
      reason: job.meta.compared?.reason,
      revision: job.meta.revision,
    },
  }
}

/**
 * The job files, the USER queue (`<home>/improvements/queue.json`: the counted jobs and the ones
 * waiting for a meta job), the user-level improver chain and both configs of a project right now.
 */
async function snapshot(pkgs, root, home) {
  const { jobs } = await readImprovements(pkgs, root)
  const queue = await pkgs.evolve.readUserQueue(home).catch(() => undefined)
  return {
    jobs: jobs.map(jobFile),
    queue: {
      projectId: await pkgs.evolve.userProjectId(root),
      counted: [...(queue?.counted ?? [])],
      pending: (queue?.pending ?? []).map(entry => ({ projectId: entry.projectId, jobId: entry.jobId })),
      activeJobId: queue?.active?.jobId,
    },
    revisions: await revisionsOf(home),
    userConfig: await userConfigOf(home),
    projectConfig: await projectConfigOf(root),
    legacyProjectImprovers: (await readdir(join(dataDirSync(root), 'improvers')).catch(() => [])).length > 0,
  }
}

/** The jobs of the project at `root` that ran on the user-level improver, as files say. */
async function jobsOfRoot(pkgs, root) {
  const { jobs } = await readImprovements(pkgs, root)
  return { root, name: basename(root), jobs: jobs.map(jobFile) }
}

/** Wait until job `jobId` of the project at `root` has a final status. */
async function waitJob(pkgs, root, jobId, timeoutMs = JOB_WAIT) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === jobId)
    if (job !== undefined && SETTLED.has(job.status)) return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle within ${timeoutMs / 1000}s (status ${job?.status ?? 'none'})`)
    await sleep(200)
  }
}

/** Wait until the user queue counted job `jobId` of the project at `root` (its process released the slot: the meta rule has run). */
async function waitCounted(pkgs, root, home, jobId, timeoutMs = 60_000) {
  const key = `${await pkgs.evolve.userProjectId(root)}:${jobId}`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const queue = await pkgs.evolve.readUserQueue(home).catch(() => undefined)
    if ((queue?.counted ?? []).includes(key)) return
    if (Date.now() > deadline) throw new Error(`job ${jobId} was not counted by the user queue within ${timeoutMs / 1000}s`)
    await sleep(200)
  }
}

/** Kill every job process still named in a job lock under `root` (cleanup). */
async function killJobProcesses(pkgs, root) {
  const dir = improvementsPath(root)
  for (const name of await readdir(dir).catch(() => [])) {
    const pid = await pkgs.evolve.readLockPid(join(dir, name, 'job.lock')).catch(() => undefined)
    if (typeof pid === 'number' && pid !== process.pid && pkgs.evolve.processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch { /* already gone */ }
    }
  }
}

/** The meta job's three files, its job file's improver facts and the revision naming it, as files say. */
async function metaFilesOf(pkgs, root, home, jobId) {
  const dir = improvementsPath(root)
  const paths = pkgs.evolve.jobPaths(dir, jobId)
  const diagnosis = await readJson(paths.metaDiagnosis)
  const change = await readJson(paths.change)
  const comparison = await readJson(paths.comparison)
  const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === jobId)
  const arm = a => a === undefined ? undefined : {
    arm: a.arm,
    improverVersion: a.improverVersion,
    candidateId: a.candidateId,
    status: a.status,
    verdictOutcome: a.verdict?.outcome,
    verdictReason: a.verdict?.reason,
    quality: a.verdict?.passRate?.candidate,
    usd: a.cost?.estimatedUsd,
    tokens: a.cost?.usage?.totalTokens,
  }
  const childBundle = change === undefined ? undefined : await readJson(join(home, 'improvers', 'bundles', `${change.childVersion}.json`))
  const requests = (await ledgerOf(root)).filter(record => record.type === 'llm.request.end' && record.improvementId === jobId)
  return {
    job: job === undefined ? undefined : jobFile(job),
    diagnosis: diagnosis === undefined ? undefined : { hypothesis: diagnosis.hypothesis, proposal: diagnosis.proposal, findings: (diagnosis.findings ?? []).map(f => ({ stage: f.stage, label: f.label, jobs: (f.jobIds ?? []).length })) },
    change: change === undefined ? undefined : {
      op: change.change?.op,
      index: change.change?.index,
      text: change.change?.text,
      rationale: change.rationale,
      parentVersion: change.parentVersion,
      childVersion: change.childVersion,
      childParagraph: change.change?.index === undefined ? undefined : childBundle?.diagnosis?.paragraphs?.[change.change.index],
    },
    comparison: comparison === undefined ? undefined : { parent: arm(comparison.parent), child: arm(comparison.child), outcome: comparison.verdict?.outcome, reason: comparison.verdict?.reason },
    ledger: {
      requests: requests.length,
      phases: [...new Set(requests.map(record => record.improvementPhase))].sort(),
      tokens: requests.every(record => typeof record.usage?.totalTokens === 'number') ? requests.reduce((sum, record) => sum + record.usage.totalTokens, 0) : undefined,
    },
  }
}

// ---- seeding ---------------------------------------------------------------------------

/**
 * A finished capability job of the project at `root` that ran on `version` of the user line,
 * counted into the user queue (ADR 0012: that is how the SDK finds the projects that used an
 * improver). Written in the shape the improve entry leaves a finished job.
 */
async function seedFinishedJob(pkgs, home, root, version) {
  const evolve = pkgs.evolve
  const dir = improvementsPath(root)
  await mkdir(root, { recursive: true })
  const job = await evolve.createJob(dir, { trigger: 'explicit', items: [] })
  await evolve.transitionJob(dir, job.id, 'diagnosing', { expect: ['queued'] })
  await evolve.updateJob(dir, job.id, { improverVersion: version, improverScope: 'user' })
  const done = await evolve.transitionJob(dir, job.id, 'no-proposal', { expect: ['diagnosing'], detail: 'Nothing to change.' })
  await evolve.countFinishedJobForUser(home, pkgs.kernel.resolveProjectLayout(root, { home }), done)
  return job.id
}

/**
 * One adopted meta job as the flow leaves it: the child improver written and adopted on the user
 * line (revision first, then the job's status), the job's three files, and the arms' costs in
 * `comparison.json`.
 */
async function seedAdoptedMetaJob(pkgs, capabilities, root, home) {
  const kernel = pkgs.kernel
  const evolve = pkgs.evolve
  const dir = improvementsPath(root)
  const store = capabilities.ImproverStore.user({ home })
  const { version: child } = await store.write(kernel.applyImproverChange(kernel.IMPROVER_V0, SEEDED_CHANGE))
  const basis = [randomUUID(), randomUUID(), randomUUID()]
  const job = await evolve.createJob(dir, { trigger: 'job-count', items: [], kind: 'meta', meta: { parentVersion: 'v0', basis } })
  for (const [from, to] of [['queued', 'meta-diagnosing'], ['meta-diagnosing', 'meta-proposing'], ['meta-proposing', 'comparing']]) await evolve.transitionJob(dir, job.id, to, { expect: [from] })
  const at = new Date().toISOString()
  const commit = await store.adopt(child, { jobId: job.id })
  await evolve.transitionJob(dir, job.id, 'adopted', { expect: ['comparing'], detail: 'The child improver\'s offspring passed its gate; the parent\'s did not.' })
  const big = { inputTokens: 120_000, outputTokens: 6_000, totalTokens: 126_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  await evolve.updateJob(dir, job.id, {
    improverVersion: 'v0',
    improverScope: 'user',
    meta: { parentVersion: 'v0', basis, childVersion: child, diagnosed: { at, attempts: 1, proposal: 'change' }, compared: { at, outcome: 'adopt', reason: 'gate-passed' }, ...(commit === null ? {} : { revision: commit.revision.revision }) },
    phases: { 'meta-diagnose': { usage: big, requestCount: 3 }, 'meta-propose': { usage: big, requestCount: 2 }, compare: { usage: big, requestCount: 14 } },
  })
  const paths = evolve.jobPaths(dir, job.id)
  const { writeFile } = await import('node:fs/promises')
  const diagnosis = {
    formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, improverVersion: 'v0', basis, statusCounts: { adopted: 1, rejected: 2 },
    findings: [{ stage: 'diagnose', label: '诊断常漏读失败的检查', jobIds: basis.slice(0, 2) }, { stage: 'trial', label: '后代两次没通过门控', jobIds: basis.slice(1) }],
    hypothesis: '诊断策略没有要求先读失败的检查，所以诊断常把需求变化误判成能力缺口。',
    proposal: 'change',
  }
  const change = { formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, parentVersion: 'v0', childVersion: child, change: SEEDED_CHANGE, rationale: '让诊断先读失败的检查。' }
  const origin = { kind: 'unresolved', sourceJobId: basis[2], tree: 'a'.repeat(64), feedbackIds: [randomUUID()], capabilityVersion: 'baseline', epoch: 'e'.repeat(64) }
  const arm = side => side === 'parent'
    ? { arm: 'parent', improverVersion: 'v0', origin, jobId: randomUUID(), status: 'rejected', candidateId: randomUUID(), verdict: { outcome: 'reject', reason: 'similar-regression', passRate: { candidate: 0.5, baseline: 0.75 }, similarPassRate: { candidate: 0.5, baseline: 1 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.52 } }
    : { arm: 'child', improverVersion: child, origin, jobId: randomUUID(), status: 'adopted', candidateId: randomUUID(), verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.75 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.61 } }
  const comparison = { formatVersion: 1, jobId: job.id, createdAt: at, origin, parent: arm('parent'), child: arm('child'), verdict: { outcome: 'adopt', reason: 'gate-passed' } }
  await writeFile(paths.metaDiagnosis, JSON.stringify(diagnosis))
  await writeFile(paths.change, JSON.stringify(change))
  await writeFile(paths.comparison, JSON.stringify(comparison))
  return { jobId: job.id, child, revision: commit?.revision?.revision }
}

const skill = (name, text) => ({ kind: 'skill', name, files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${text}\n---\n\n1. ${text}\n` }] })
const armCost = (usd, tokens) => ({ usage: { inputTokens: tokens - 1000, outputTokens: 1000, totalTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestCount: 4, estimatedUsd: usd })

/** The three ADR 0013 conclusions the last launch shows: what the gate decided and what the screen must say about it. */
export const GATE_SEEDS = [
  {
    key: 'literal',
    reason: 'instance-literal',
    outcome: 'rejected',
    component: skill('region-table', 'Region tables show the average order value 2384.13 for 2026-09.'),
    summary: '地区表带均价',
    instanceLiterals: [
      { value: '2384.13', kind: 'decimal', path: 'skill/region-table/SKILL.md', source: 'feedback:0b7a6c1e' },
      { value: '2026-09', kind: 'date', path: 'skill/region-table/SKILL.md', source: 'deliverable:4f2d/v2/regions.csv' },
    ],
    detail: 'The candidate carries values of its feedback task (2384.13, 2026-09); rejected before any replay.',
  },
  {
    key: 'similar',
    reason: 'similar-regression',
    outcome: 'rejected',
    component: skill('sort-rows', 'Sort every table by its first column.'),
    summary: '表格按首列排序',
    verdict: { outcome: 'reject', reason: 'similar-regression', passRate: { candidate: 0.75, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, similarPassRate: { candidate: 0.5, baseline: 1 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false },
    detail: 'Similar cases (1) passed: candidate 50%, baseline 100%; rejected.',
  },
  {
    key: 'original',
    reason: 'no-similar-cases',
    outcome: 'awaiting-approval',
    component: skill('units-note', 'State the unit of every numeric column in its header.'),
    summary: '列名带单位',
    verdict: { outcome: 'await-approval', reason: 'no-similar-cases', passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false },
    detail: 'Checked on the feedback task only; waits for approval.',
  },
]

/**
 * One improvement job of `root` whose candidate the gate decided as `seed` says (the trial's receipts
 * too when there is a verdict), written the way gate-reasons-e2e.spec.ts writes it.
 * @returns the job id, the candidate's id and version, the decision's id.
 */
async function seedGateJob(pkgs, capabilities, root, store, seed) {
  const evolve = pkgs.evolve
  const jobs = improvementsPath(root)
  const dir = join(dataDirSync(root), 'capabilities')
  const job = await evolve.createJob(jobs, { trigger: 'explicit', items: [] })
  await evolve.transitionJob(jobs, job.id, 'diagnosing', { expect: ['queued'] })
  await evolve.transitionJob(jobs, job.id, 'proposing', { expect: ['diagnosing'] })
  const base = await store.load((await store.activation()).version)
  const { record } = await capabilities.writeCandidate(dir, {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    turn: 1,
    base,
    components: [{ kind: seed.component.kind, name: seed.component.name, files: new Map(seed.component.files.map(file => [file.path, Buffer.from(file.content)])) }],
    proofs: [{ kind: seed.component.kind, name: seed.component.name, turn: 1, toolCallId: 'call-1' }],
    summary: seed.summary,
    origin: 'improvement',
    jobId: job.id,
  })
  await evolve.transitionJob(jobs, job.id, 'trialing', { expect: ['proposing'] })
  let trialId
  const cost = { candidate: armCost(0.12, 20_000), baseline: armCost(0.1, 18_000), review: armCost(0.01, 2_000) }
  if (seed.verdict !== undefined) {
    trialId = randomUUID()
    const ts = new Date().toISOString()
    const ref = caseId => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })
    const lines = [
      { type: 'trial.start', format: 1, trialId, ts, candidateId: record.id, candidateVersion: record.version, baselineVersion: record.base, plan: { selection: [ref('s1'), ref('s2')], guard: [ref('g1')], repeats: 2, costRatioCap: 1.2, costApprovalRatio: 2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } } },
      { type: 'trial.end', format: 1, trialId, ts, status: seed.outcome === 'rejected' ? 'fail' : 'pass', verdict: seed.verdict, cost },
    ]
    await mkdir(join(dir, 'trials'), { recursive: true })
    await appendFile(join(dir, 'trials', `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  }
  const current = (await store.activation()).version
  const written = await store.recordDecision({
    outcome: seed.outcome,
    reason: seed.reason,
    trigger: 'gate',
    candidateId: record.id,
    ...(trialId === undefined ? {} : { trialId, verdict: seed.verdict, cost }),
    fromVersion: current,
    toVersion: current,
    ...(seed.instanceLiterals === undefined ? {} : { instanceLiterals: seed.instanceLiterals }),
    detail: seed.detail,
  })
  await evolve.updateJob(jobs, job.id, { improverVersion: 'v0', improverScope: 'user', candidateId: record.id, decisionId: written.id, ...(trialId === undefined ? {} : { trialId }) })
  await evolve.transitionJob(jobs, job.id, seed.outcome, { expect: ['trialing'], detail: seed.detail })
  return { jobId: job.id, candidateId: record.id, candidateVersion: record.version, decisionId: written.id, trialId }
}

/** What a gate job's files say: its status and scope, and the decision record (outcome, reason, the literals found, the similar-case rates). */
async function gateFilesOf(pkgs, capabilities, root, seeded) {
  const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === seeded.jobId)
  const decision = await capabilities.readDecision(join(dataDirSync(root), 'capabilities', capabilities.DECISIONS_DIR), seeded.decisionId).catch(() => undefined)
  return {
    job: job === undefined ? undefined : jobFile(job),
    decisionId: job?.decisionId,
    candidateId: job?.candidateId,
    decision: decision === undefined ? undefined : {
      outcome: decision.outcome,
      reason: decision.reason,
      detail: decision.detail,
      literals: (decision.instanceLiterals ?? []).map(hit => ({ value: hit.value, path: hit.path, source: hit.source })),
      similar: decision.verdict?.similarPassRate,
      passRate: decision.verdict?.passRate,
      feedbackPassRate: decision.verdict?.feedbackPassRate,
    },
  }
}

// ---- the screen ------------------------------------------------------------------------

/** Every job card of the 改进 tab as shown. */
const cardsOf = page => page.evaluate(() => {
  const text = (el, id) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
  return [...document.querySelectorAll('[data-testid="improvement-job"]')].map(el => ({
    id: el.dataset.job ?? null,
    kind: el.dataset.kind ?? null,
    status: el.dataset.status ?? null,
    badge: el.querySelector('[data-testid="improvement-meta-badge"]') !== null,
    badgeText: text(el, 'improvement-meta-badge'),
    improverVersion: el.querySelector('[data-testid="improvement-improver"]')?.dataset.version ?? null,
    improverScope: el.querySelector('[data-testid="improvement-improver"]')?.dataset.scope ?? null,
    improverText: text(el, 'improvement-improver'),
    cost: text(el, 'improvement-cost'),
    child: text(el, 'improvement-meta-child'),
  }))
})

/** The improver section as shown: the version in force, the revisions, the meta status line. */
const improverOf = page => page.evaluate(() => {
  const current = document.querySelector('[data-testid="improver-current"]')
  const text = id => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
  return {
    present: document.querySelector('[data-testid="improver-section"]') !== null,
    version: current?.dataset.version ?? null,
    revision: current?.dataset.revision ?? null,
    versionText: text('improver-version'),
    problem: text('improver-problem'),
    sharedNote: text('improver-shared-note'),
    revisions: [...document.querySelectorAll('[data-testid="improver-revision"]')].map(el => ({ type: el.dataset.type ?? null, version: el.dataset.version ?? null, text: el.textContent ?? '' })),
    metaStatus: text('improvement-meta-status'),
    metaBudget: text('improvement-meta-budget'),
    rollbackButton: document.querySelector('[data-testid="improver-rollback"]') !== null,
  }
})

/** A meta job's opened detail, or null when it is not open. */
const metaDetailOf = (page, id) => page.evaluate((jobId) => {
  const card = [...document.querySelectorAll('[data-testid="improvement-job"]')].find(el => el.dataset.job === jobId)
  const el = card?.querySelector('[data-testid="improvement-detail"]')
  if (el === null || el === undefined) return null
  const one = testId => el.querySelector(`[data-testid="${testId}"]`)
  const text = testId => one(testId)?.textContent ?? null
  const armOf = a => ({
    arm: a.dataset.arm ?? null,
    version: a.querySelector('[data-testid="improvement-arm-version"]')?.textContent ?? null,
    offspring: a.querySelector('[data-testid="improvement-arm-offspring"]')?.textContent ?? null,
    gate: a.querySelector('[data-testid="improvement-arm-gate"]')?.textContent ?? null,
    quality: a.querySelector('[data-testid="improvement-arm-quality"]')?.textContent ?? null,
    cost: a.querySelector('[data-testid="improvement-arm-cost"]')?.textContent ?? null,
  })
  const verdict = one('improvement-comparison-verdict')
  return {
    diagnosis: text('improvement-meta-diagnosis'),
    findings: [...el.querySelectorAll('[data-testid="improvement-meta-finding"]')].map(x => ({ stage: x.dataset.stage ?? null, text: x.textContent ?? '' })),
    change: one('improvement-change') === null ? null : {
      op: one('improvement-change').dataset.op ?? null,
      before: text('improvement-change-before'),
      after: text('improvement-change-after'),
      rationale: text('improvement-change-rationale'),
    },
    comparison: one('improvement-comparison') === null ? null : {
      arms: [...el.querySelectorAll('[data-testid="improvement-arm"]')].map(armOf),
      verdict: verdict === null ? null : { outcome: verdict.dataset.outcome ?? null, reason: verdict.dataset.reason ?? null, text: verdict.textContent ?? '' },
    },
    cost: text('improvement-meta-cost'),
    phases: [...el.querySelectorAll('[data-testid="improvement-phases"] li')].map(x => ({ phase: x.dataset.phase ?? null, text: x.textContent ?? '' })),
  }
}, id)

/** Make job `id`'s detail open (the card toggles), and read it once it has loaded. */
async function openMetaDetail(page, id) {
  const card = page.locator(`[data-testid="improvement-job"][data-job="${id}"]`)
  await card.waitFor({ timeout: WAIT })
  if ((await card.getByTestId('improvement-detail').count()) === 0) await card.getByTestId('improvement-trigger').click()
  return poll(() => metaDetailOf(page, id), d => d !== null && d.cost !== null && (d.change === null || !String(d.change.before).includes('未取得')), `the detail of meta job ${id}`, WAIT)
}

/** The settings page's values (opened, left open): the user section (meta) and the project section (sharing). */
async function readSettings(page) {
  await page.getByTestId('open-settings').click()
  const settings = page.getByTestId('settings-page')
  await settings.waitFor({ timeout: WAIT })
  const section = settings.getByTestId('settings-user-section')
  await section.waitFor({ timeout: WAIT })
  await poll(() => section.getByTestId('settings-meta-budget').inputValue(), v => v !== '', 'the meta budget field', WAIT)
  // The project section fills its fields in an effect after its first render: read the sharing switch only once they are there.
  await poll(() => settings.getByTestId('settings-improvement-budget').inputValue(), v => v !== '', 'the project section\'s fields', WAIT)
  return {
    metaInUserSection: (await section.getByTestId('settings-meta-budget').count()) === 1,
    enabled: await section.getByTestId('settings-meta-enabled').isChecked(),
    every: await section.getByTestId('settings-meta-every').inputValue(),
    budget: await section.getByTestId('settings-meta-budget').inputValue(),
    window: await section.getByTestId('settings-meta-window').inputValue(),
    share: await settings.getByTestId('settings-share-improver').isChecked(),
  }
}

const closeSettings = async page => {
  await page.keyboard.press('Escape')
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: WAIT }).catch(() => undefined)
}

/** Change the user-level meta settings and save them (the user section's own button); returns what the page says. */
async function saveUserSettings(page, { enabled, every, budget, window }) {
  const settings = page.getByTestId('settings-page')
  const section = settings.getByTestId('settings-user-section')
  if (enabled) await section.getByTestId('settings-meta-enabled').check()
  else await section.getByTestId('settings-meta-enabled').uncheck()
  await section.getByTestId('settings-meta-every').fill(String(every))
  await section.getByTestId('settings-meta-budget').fill(String(budget))
  await section.getByTestId('settings-meta-window').fill(String(window))
  await commitSettings(page, { timeout: WAIT }, true)
  return { approvalDialogs: await page.getByTestId('approval-dialog').count() }
}

/** Change this project's 参与改进器学习 switch and save the project section; returns what the page says. */
async function saveProjectSharing(page, share) {
  const settings = page.getByTestId('settings-page')
  if (share) await settings.getByTestId('settings-share-improver').check()
  else await settings.getByTestId('settings-share-improver').uncheck()
  await commitSettings(page, { timeout: WAIT })
  return { approvalDialogs: await page.getByTestId('approval-dialog').count() }
}

/** A gate job's opened detail as shown (the card toggles), or null when it is not open. */
const gateDetailOf = (page, id) => page.evaluate((jobId) => {
  const card = [...document.querySelectorAll('[data-testid="improvement-job"]')].find(el => el.dataset.job === jobId)
  const el = card?.querySelector('[data-testid="improvement-detail"]')
  if (el === null || el === undefined) return null
  const one = testId => el.querySelector(`[data-testid="${testId}"]`)
  const text = testId => one(testId)?.textContent ?? null
  return {
    status: card.dataset.status ?? null,
    scope: card.querySelector('[data-testid="improvement-improver"]')?.dataset.scope ?? null,
    verdict: text('improvement-gate-verdict'),
    refused: text('improvement-refused'),
    literalsTitle: text('improvement-literals'),
    literals: [...el.querySelectorAll('[data-testid="improvement-literal"]')].map(x => x.textContent ?? ''),
    similarRate: text('improvement-similar-rate'),
    originalOnly: text('improvement-original-only'),
    passRate: text('improvement-gate-rate'),
    feedbackRate: text('improvement-gate-feedback'),
    text: el.textContent ?? '',
  }
}, id)

/** Open job `id`'s detail (the card toggles) and read it once the gate section has loaded. */
async function openGateDetail(page, id) {
  const card = page.locator(`[data-testid="improvement-job"][data-job="${id}"]`)
  await card.waitFor({ timeout: WAIT })
  if ((await card.getByTestId('improvement-detail').count()) === 0) await card.getByTestId('improvement-trigger').click()
  return poll(() => gateDetailOf(page, id), d => d !== null && d.verdict !== null, `the gate section of job ${id}`, WAIT)
}

/**
 * Run the step-6 desktop scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer, listSessionIds, ...).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 * @returns plain observations: `seeded`, `prepared`, `d24`, `d25`, `d26`, `d27`, `consoleErrors`, `errors`.
 */
export async function runStep6DesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const capabilities = await loadCapabilities()
  await mkdir(work, { recursive: true })
  work = await realpath(work)
  const obs = {
    consoleErrors: { first: [], second: [], third: [], fourth: [] },
    prepared: {},
    seeded: undefined,
    d24: {},
    d25: {},
    d26: { typed: META_SETTINGS },
    d27: {},
    errors: {},
  }
  const rendererDir = join(work, 'renderer')
  const root = join(work, 'project')
  const home = join(work, 'home')
  registerHome(root, home)
  const other = join(work, 'reports')
  // The other project of the same user: its data sits under the same NEXGENT_HOME.
  registerHome(other, home)
  createRequire(join(DESKTOP_DIR, 'package.json'))('electron')

  let server
  let display
  let app
  let model
  /** Run one item's section; a crash is recorded under `errors.<item>`. */
  const item = async (name, body) => {
    try {
      await body()
    } catch (error) {
      obs.errors[name] = obs.errors[name] === undefined ? errorText(error) : `${obs.errors[name]}\n---\n${errorText(error)}`
      log(`${name} stopped: ${errorText(error).split('\n')[0]}`)
    }
  }
  /** Run an explicit job through the SDK and wait for its end. */
  const explicitJob = async (sdk, projectId, name) => {
    log(`job ${name}`)
    const started = await sdk.call('improvements.run', { projectId, sessionId: obs.prepared.feedbackSession })
    const job = await waitJob(pkgs, root, started.id)
    obs.prepared[name] = { id: started.id, status: job.status, improverVersion: job.improverVersion }
    return job
  }

  try {
    // ---- setup and prep (a crash here stops everything) -----------------------------------
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)
    display = await ensureDisplay()
    model = new MetaStep6Model(harness, { root, playbooks: [], feedbackAnswer: 'by-output' })
    server = await harness.scriptedModelServer({ script: Array.from({ length: 5_000 }, () => model.entry) })
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)
    const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }

    const restore = scriptedEnvironment(SCRIPTED_API_KEY)
    try {
      log('preparing the feedback project (headless)')
      const project = await runFeedbackProject(harness, pkgs, work, {
        server,
        log: line => log(`prep: ${line}`),
        config: { autoImprove: false, learning: { enabled: true } },
        createSdk: (e, h) => createStep5Sdk(pkgs, { env: e, home: h }),
      })
      obs.prepared.feedbackSession = project.tasks.at(-1)?.sessionId
      obs.prepared.deliverableId = project.deliverable?.deliverableId
      if (obs.prepared.feedbackSession === undefined || obs.prepared.deliverableId === undefined) throw new Error('the feedback project produced no deliverable')
      model.phase = 'job'
      const sdk = createStep5Sdk(pkgs, { env, home })
      try {
        const { projectId } = await sdk.call('projects.open', { root, create: true })
        await explicitJob(sdk, projectId, 'j1')
        log('prep: seeding the adopted meta job and the other project\'s job')
        const meta = await seedAdoptedMetaJob(pkgs, capabilities, root, home)
        const otherJob = await seedFinishedJob(pkgs, home, other, meta.child)
        obs.seeded = {
          ...meta,
          other: { root: other, name: basename(other), jobId: otherJob, version: meta.child },
          what: 'meta job record (job.json, meta-diagnosis.json, change.json, comparison.json) and the child improver revision written by this scenario through ImproverStore.user({ home }); one finished job of a second project (\'reports\') pinned on the child and counted into the user queue; the three ADR 0013 gate conclusions of the last launch; the rest (capability jobs, rollback, next jobs, settings) is the product\'s',
        }
        await explicitJob(sdk, projectId, 'j2')
      } finally {
        await sdk.dispose()
      }
    } finally {
      restore()
    }
    model.phase = 'main'
    obs.prepared.files = await snapshot(pkgs, root, home)

    // ---- launch helper ---------------------------------------------------------------------
    const launch = async (which) => {
      const appEnv = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') appEnv[key] = value
      Object.assign(appEnv, display.display === undefined ? {} : { DISPLAY: display.display }, {
        NEXGENT_HOME: home,
        NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
        NEXGENT_API_KEY: META_DESKTOP_KEY,
        NEXGENT_API_BASE_URL: server.baseUrl,
      })
      app = await electron.launch({ args: ROOT_USER ? [DESKTOP_DIR, '--no-sandbox'] : [DESKTOP_DIR], env: appEnv, timeout: TIMEOUT })
      const page = await app.firstWindow({ timeout: TIMEOUT })
      page.on('console', (message) => {
        if (message.type() === 'error') obs.consoleErrors[which].push(message.text())
      })
      page.on('pageerror', error => obs.consoleErrors[which].push(error.message))
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
      await page.waitForLoadState('load')
      await poll(async () => {
        if ((await page.getByTestId('workspace').count()) > 0) return 'workspace'
        return (await page.getByTestId('start-screen').count()) > 0 ? 'start' : 'loading'
      }, state => state !== 'loading', 'the workspace or the start screen', WAIT)
      await sleep(1_500)
      if ((await page.getByTestId('workspace').count()) === 0) {
        await fillProjectPath(page, root, { timeout: 10_000 })
        await page.getByRole('button', { name: '打开', exact: true }).click()
        await page.getByTestId('workspace').waitFor({ timeout: WAIT })
      }
      return page
    }
    const closeApp = async () => {
      await app?.close().catch(() => undefined)
      app = undefined
    }
    /** Wait for the card of a job that is not in `known`, and for it to reach a final status on screen. */
    const newSettledCard = async (page, known, what) => {
      const found = await poll(async () => (await cardsOf(page)).find(c => !known.includes(c.id ?? '')) ?? null, c => c !== null, `the new job card (${what})`, WAIT)
      const final = await poll(async () => (await cardsOf(page)).find(c => c.id === found.id) ?? null, c => c !== null && SETTLED.has(c.status ?? ''), `the ${what} job to end on screen`, JOB_WAIT)
      await waitJob(pkgs, root, found.id)
      return final
    }

    // ---- launch 1 --------------------------------------------------------------------------
    log('launch 1: the 改进 tab')
    let page
    let seededId
    seededId = obs.seeded.jobId
    await item('d24', async () => {
      page = await launch('first')
      await showTab(page, 'improvements')
      const ids = [obs.prepared.j1.id, obs.prepared.j2.id, seededId]
      await poll(() => cardsOf(page), cards => ids.every(id => cards.some(c => c.id === id)), 'the three job cards', WAIT)
      await poll(() => improverOf(page), v => v.present && v.version === obs.seeded.child, 'the improver section with the child in force', WAIT)
      obs.d24.initial = { cards: await cardsOf(page), improver: await improverOf(page), files: await snapshot(pkgs, root, home) }
    })
    if (page === undefined) throw new Error(`launch 1 failed: ${obs.errors.d24 ?? 'no page'}`)

    await item('d25', async () => {
      obs.d25.seeded = { jobId: seededId, child: obs.seeded.child, dom: await openMetaDetail(page, seededId), files: await metaFilesOf(pkgs, root, home, seededId) }
      obs.d25.seeded.parentParagraph = pkgs.kernel.IMPROVER_V0.diagnosis.paragraphs[SEEDED_CHANGE.index]
    })

    // D27: roll back in the UI (the confirmation lists the projects that used the child), then the next jobs.
    await item('d27', async () => {
      const before = await snapshot(pkgs, root, home)
      const otherBefore = await jobsOfRoot(pkgs, other)
      const mainBefore = await jobsOfRoot(pkgs, root)
      const reason = '子改进器的诊断太慢（accept-step6 D27）'
      await page.getByTestId('improver-rollback').click()
      const readConfirmation = () => page.evaluate(() => ({
        text: document.querySelector('[data-testid="improver-rollback-projects"]')?.textContent ?? null,
        projects: [...document.querySelectorAll('[data-testid="improver-rollback-project"]')].map(el => ({ text: el.textContent ?? '', root: el.getAttribute('title') ?? '' })),
      }))
      // The projects are read afresh when the confirmation opens: give the list time to fill, then take what is there.
      let confirmation = await readConfirmation()
      for (const deadline = Date.now() + 20_000; confirmation.projects.length < 2 && Date.now() < deadline;) {
        await sleep(200)
        confirmation = await readConfirmation()
      }
      await page.getByTestId('improver-rollback-reason').fill(reason)
      await page.getByTestId('improver-rollback-confirm').click()
      await poll(() => improverOf(page), v => v.version === 'v0' && v.revision === '2' && v.revisions.length === 2, 'the improver rolled back on screen, with its history', WAIT)
      obs.d27 = { reason, before, mainBefore, otherBefore, confirmation, rolledBackAt: new Date().toISOString(), afterImprover: await improverOf(page), after: await snapshot(pkgs, root, home), next: [] }
      // The next job: 改进 on the deliverable card (a capability job).
      model.phase = 'job'
      const known = (await cardsOf(page)).map(c => c.id)
      await page.getByTestId('session-item').filter({ hasText: FEEDBACK_TASK.id }).first().click()
      const button = page.getByTestId('deliverable-improve').last()
      await button.waitFor({ timeout: WAIT })
      await button.click()
      await showTab(page, 'improvements')
      const card = await newSettledCard(page, known, 'capability')
      obs.d27.next.push({ via: 'deliverable-improve', id: card.id, card })
      // Counted by the user queue before the meta job takes its batch, so the queue is empty afterwards.
      await waitCounted(pkgs, root, home, card.id)
      // Then 立即元改进: a meta job on the rolled-back improver.
      const known2 = (await cardsOf(page)).map(c => c.id)
      const meta = page.getByTestId('improvement-run-meta')
      await poll(() => meta.isEnabled(), enabled => enabled === true, 'the 立即元改进 button to be enabled', WAIT)
      await meta.click()
      const metaCard = await newSettledCard(page, known2, 'meta')
      obs.d27.next.push({ via: 'improvement-run-meta', id: metaCard.id, card: metaCard })
      // The other project's next job (the desktop shows one project at a time: started through the SDK, the same host path).
      const restoreOther = scriptedEnvironment(SCRIPTED_API_KEY)
      try {
        const sdk = createStep5Sdk(pkgs, { env, home })
        try {
          const { projectId } = await sdk.call('projects.open', { root: other, create: true })
          // The user's single meta slot may still be released by the job just ended: retry while it is busy.
          const startedOther = await poll(() => sdk.call('improvements.runMeta', { projectId }), job => typeof job?.id === 'string', 'the other project\'s meta job to start', WAIT)
          const done = await waitJob(pkgs, other, startedOther.id)
          obs.d27.otherNext = { via: 'sdk improvements.runMeta', id: startedOther.id, root: other, status: done.status }
          // Opening a project makes it the one the desktop restores: put this project back (the next launches show it).
          await sdk.call('projects.open', { root })
        } finally {
          await sdk.dispose()
        }
      } finally {
        restoreOther()
      }
      model.phase = 'main'
      obs.d27.otherFinal = await jobsOfRoot(pkgs, other)
      obs.d27.final = { improver: await improverOf(page), files: await snapshot(pkgs, root, home), cards: await cardsOf(page) }
      obs.d24.later = { cards: obs.d27.final.cards, improver: obs.d27.final.improver, files: obs.d27.final.files }
    })

    // D25 for the real meta job (no change was proposed: the diagnosis, its cost from the ledger).
    await item('d25', async () => {
      const real = obs.d27.next?.find(n => n.via === 'improvement-run-meta')
      if (real === undefined) throw new Error('no real meta job was started (see d27)')
      obs.d25.real = { jobId: real.id, dom: await openMetaDetail(page, real.id), files: await metaFilesOf(pkgs, root, home, real.id) }
    })

    // D26: meta improvement on (user section), K = 2, budget and window typed in; this project stops sharing; no approval asked.
    await item('d26', async () => {
      const configs = async () => ({ user: await userConfigOf(home), project: await projectConfigOf(root) })
      obs.d26.initial = await readSettings(page)
      obs.d26.configBefore = await configs()
      obs.d26.saveOn = await saveUserSettings(page, META_SETTINGS.on)
      obs.d26.saveShareOff = await saveProjectSharing(page, false)
      obs.d26.configOn = await configs()
      await closeSettings(page)
      await showTab(page, 'improvements')
      obs.d26.screenOn = await poll(() => improverOf(page), v => (v.metaStatus ?? '').includes('开') && (v.metaBudget ?? '').includes(META_SETTINGS.on.budget.toLocaleString('en-US')), 'the meta status line to read 开 with the new budget', WAIT)
      await closeApp()

      log('launch 2: settings after the restart')
      page = await launch('second')
      obs.d26.restartOn = await readSettings(page)
      obs.d26.configAfterRestartOn = await configs()
      obs.d26.saveOff = await saveUserSettings(page, META_SETTINGS.off)
      obs.d26.saveShareOn = await saveProjectSharing(page, true)
      obs.d26.configOff = await configs()
      await closeSettings(page)
      await closeApp()

      log('launch 3: settings after the second restart')
      page = await launch('third')
      obs.d26.restartOff = await readSettings(page)
      obs.d26.configAfterRestartOff = await configs()
      await closeSettings(page)
      await showTab(page, 'improvements')
      obs.d26.screenOff = await poll(() => improverOf(page), v => v.metaStatus !== null, 'the meta status line', WAIT)
      obs.d26.filesAtRestart = await snapshot(pkgs, root, home)
      await closeApp()
    })
    await closeApp()

    // ---- after: switch off, K finished jobs; then the control with the switch on --------------
    await item('d26', async () => {
      if (obs.d26.restartOff === undefined) throw new Error('the settings were not saved off and read back (see above)')
      model.phase = 'job'
      const before = await snapshot(pkgs, root, home)
      const restoreAfter = scriptedEnvironment(SCRIPTED_API_KEY)
      try {
        const sdk = createStep5Sdk(pkgs, { env, home })
        try {
          const { projectId } = await sdk.call('projects.open', { root, create: true })
          const ran = []
          for (const name of ['j4', 'j5']) {
            const job = await explicitJob(sdk, projectId, name)
            await waitCounted(pkgs, root, home, job.id)
            ran.push({ id: job.id, status: job.status })
          }
          await sleep(3_000)
          obs.d26.autoOff = { ran, before, after: await snapshot(pkgs, root, home) }

          // Control: the same count with the switch on (user settings) starts a meta job on the job-count rule.
          await sdk.call('userSettings.update', { patch: { improvement: { meta: { enabled: true, everyJobs: META_SETTINGS.off.every, budget: { maxTokens: META_SETTINGS.off.budget, windowDays: META_SETTINGS.off.window } } } } })
          const control = { configEnabled: (await userConfigOf(home)).enabled, before: await snapshot(pkgs, root, home) }
          const job = await explicitJob(sdk, projectId, 'j6')
          await waitCounted(pkgs, root, home, job.id)
          const known = control.before.jobs.map(j => j.id)
          const started = await poll(async () => (await snapshot(pkgs, root, home)).jobs.find(j => j.kind === 'meta' && j.trigger === 'job-count' && !known.includes(j.id)) ?? null, j => j !== null, 'the automatic meta job', 60_000)
          await waitJob(pkgs, root, started.id)
          control.ran = { id: job.id, status: job.status }
          control.started = started.id
          control.after = await snapshot(pkgs, root, home)
          obs.d26.control = control
        } finally {
          await sdk.dispose()
        }
      } finally {
        restoreAfter()
        model.phase = 'main'
      }
    })

    // ---- launch 4: the ADR 0013 conclusions (seeded now: nothing above should see them) -----
    await item('d25', async () => {
      log('seeding the three gate conclusions')
      const store = new capabilities.CapabilityStore(join(dataDirSync(root), 'capabilities'))
      const gates = []
      for (const seed of GATE_SEEDS) {
        const written = await seedGateJob(pkgs, capabilities, root, store, seed)
        gates.push({ key: seed.key, reason: seed.reason, outcome: seed.outcome, summary: seed.summary, literals: seed.instanceLiterals, similar: seed.verdict?.similarPassRate, ...written })
      }
      obs.seeded.gates = gates
      obs.d25.gates = []
      log('launch 4: the gate conclusions')
      page = await launch('fourth')
      // The candidate that was verified on the original case only waits for approval: the dialog comes by itself.
      const dialog = page.getByTestId('plugin-approval-dialog')
      await dialog.waitFor({ timeout: WAIT })
      const textOf = async locator => ((await locator.count()) === 0 ? null : await locator.first().textContent())
      obs.d25.approval = {
        text: await dialog.textContent(),
        originalOnly: await textOf(dialog.getByTestId('approval-original-only')),
        hash: await textOf(dialog.getByTestId('plugin-approval-hash')),
      }
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached', timeout: WAIT })
      await showTab(page, 'improvements')
      await poll(() => cardsOf(page), cards => gates.every(g => cards.some(c => c.id === g.jobId)), 'the three gate job cards', WAIT)
      for (const gate of gates) {
        const dom = await openGateDetail(page, gate.jobId)
        obs.d25.gates.push({ ...gate, dom, files: await gateFilesOf(pkgs, capabilities, root, gate) })
      }
      await closeApp()
    })
  } catch (error) {
    obs.error = { step: 'setup', message: errorText(error) }
    log(`step-6 desktop scenario stopped: ${errorText(error).split('\n')[0]}`)
  } finally {
    await app?.close().catch(() => undefined)
    await killJobProcesses(pkgs, root).catch(() => undefined)
    await killJobProcesses(pkgs, other).catch(() => undefined)
    obs.modelRequests = server === undefined ? null : server.requests.length
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
