/**
 * The step-6 headless scenario (docs/plan/step-6-work-partition.md §`accept-step6`),
 * scripted model server only, through the packages as shipped: `@nexgent/sdk` (which
 * installs `@nexgent/evolve` and starts each job in its own improve entry) and the
 * improver store of `@nexgent/capabilities`. Never calls a real model.
 *
 *   v0       (H01) the step-5 projects the regression ran (H18's scenarios, under
 *            `<headless work>/regression/step5`): every job pinned `v0` in job.json, every
 *            improvement session's header and every ledger record of a job reads `v0`, and
 *            no project got an `.nexgent/improvers/` directory
 *   store    (H02) `ImproverStore` in a scratch project: the same content gives the same
 *            version, adoptions form a digest chain, a rollback is a new revision and deletes
 *            nothing, an improver in force whose file is damaged is not loaded and is rolled
 *            back (`load-failure`), a damaged revision blocks new revisions
 *   pinned   (H03) the feedback project with autoImprove off; explicit job A (the 该改进
 *            playbook) is held in its diagnosis by a slow scripted reply; while it is there a
 *            child improver (the improve-the-improver playbook's change) is written and
 *            adopted through `ImproverStore`; A finishes its propose and gate phases; then
 *            explicit job B (a playbook proposing a second skill, so B also reaches the gate)
 *            runs. A's job.json, sessions and ledger say `v0`; B's say the child's version,
 *            and B's diagnosis prompt carries the child's paragraph while A's does not
 *
 * The meta job that would adopt a child itself is not merged yet (W2 part 2); the
 * pinned phase adopts through the store directly, under a stand-in meta job id, and
 * says so in its observations. Meta-job items (H04–H16) are not wired.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ledgerOf, sessionsOf } from './step4-headless.mjs'
import { DIAGNOSIS_TOOL, FEEDBACK_TASK, MAST, outputFor, PROPOSAL_MARKER, runFeedbackProject, SCRIPTED_API_KEY, SECOND_SKILL, TERMINAL_STATES } from './step5-fixtures.mjs'
import { evidenceFor, firstUserText, Step5Model, USAGE } from './step5-model.mjs'
import { createStep5Sdk, readImprovements, loadStep5Packages, scriptedEnvironment } from './step5-runtime.mjs'
import { changeFor, PLAYBOOKS as META_PLAYBOOKS } from './step6-improver-rule.mjs'
import { shellCall } from './scenario-step2.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? error.message : String(error))
const sha256 = text => createHash('sha256').update(text).digest('hex')
const JOB_WAIT = 240_000
/** Per-chunk delay of job A's diagnosis replies: long enough to adopt the child while A is diagnosing. */
const HOLD_CHUNK_MS = 1_000

/** `@nexgent/capabilities` as built (the improver store). */
export async function loadCapabilities() {
  return import(new URL('../../packages/capabilities/dist/index.js', import.meta.url).href)
}

export async function settle(probe, done, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let value = await probe()
  while (!done(value) && Date.now() < deadline) {
    await sleep(intervalMs)
    value = await probe()
  }
  return value
}

/** Project roots under `dir`: directories holding a `.nexgent/` (not descending into one). */
export async function projectRoots(dir) {
  const out = []
  const walk = async (current, depth) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    if (entries.some(entry => entry.isDirectory() && entry.name === '.nexgent')) {
      out.push(current)
      return
    }
    if (depth === 0) return
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'home') await walk(join(current, entry.name), depth - 1)
    }
  }
  await walk(dir, 4)
  return out.sort()
}

/** What one project's files say about improver versions: jobs, improvement session headers, ledger records of jobs. */
export async function versionFacts(pkgs, root) {
  const { jobs } = await readImprovements(pkgs, root)
  const sessions = []
  for (const [id, records] of Object.entries(await sessionsOf(root))) {
    const start = records.find(record => record.type === 'session.start')
    if (start?.purpose === 'improvement') sessions.push({ id, jobId: start.improvement?.jobId, phase: start.improvement?.phase, improverVersion: start.improvement?.improverVersion })
  }
  const ledger = (await ledgerOf(root))
    .filter(record => record.improvementId !== undefined)
    .map(record => ({ type: record.type, improvementId: record.improvementId, improvementPhase: record.improvementPhase, improverVersion: record.improverVersion }))
  return {
    jobs: jobs.map(job => ({ jobId: job.id, status: job.status, improverVersion: job.improverVersion, history: (job.history ?? []).map(change => change.status) })),
    sessions,
    ledger,
    improversDir: await readdir(join(root, '.nexgent', 'improvers')).then(() => true, () => false),
  }
}

/** H01: the step-5 regression's projects (no improver ever written there). */
export async function v0Phase(pkgs, step5Work) {
  const roots = await projectRoots(step5Work)
  const projects = []
  for (const root of roots) projects.push({ root: relative(step5Work, root).split('\\').join('/'), ...(await versionFacts(pkgs, root)) })
  return { step5Work, projects }
}

/** H02: the improver store in a scratch project, through `@nexgent/capabilities` as built. */
export async function storePhase(capabilities, kernel, work) {
  const root = join(work, 'project')
  await mkdir(join(root, '.nexgent'), { recursive: true })
  const dir = capabilities.improversDir({ dataDir: join(root, '.nexgent') })
  const store = new capabilities.ImproverStore(dir)
  const out = {}
  const bundleFile = version => join(store.bundlesDirectory, `${version}.json`)
  const revisionFiles = async () => (await readdir(store.activationDirectory).catch(() => [])).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  const attempt = async fn => {
    try {
      return { value: await fn() }
    } catch (error) {
      return { code: error?.code, error: errorText(error) }
    }
  }

  const v0 = kernel.IMPROVER_V0
  const childA = kernel.applyImproverChange(v0, changeFor(META_PLAYBOOKS[0], v0))
  const childB = kernel.applyImproverChange(v0, { op: 'set-comparison-param', param: 'repeats', value: 3 })
  // Same content, same version: written twice, and once more from a re-parsed copy with its keys reordered.
  const first = await store.write(childA)
  const again = await store.write(childA)
  const reordered = await store.write(JSON.parse(JSON.stringify({ comparison: childA.comparison, proposal: childA.proposal, diagnosis: childA.diagnosis, formatVersion: childA.formatVersion })))
  const other = await store.write(childB)
  const v0Write = await store.write(v0)
  out.content = {
    first, again, reordered, other, v0Write,
    versionOfContent: capabilities.improverVersionOf(childA),
    canonicalSha: sha256(kernel.canonicalImproverText(childA)),
    storedVersions: await store.versions(),
  }

  // Adoption history: two adoptions, then a rollback; every revision names the digest of the one before.
  const jobA = randomUUID()
  const jobB = randomUUID()
  out.adoptA = await attempt(() => store.adopt(first.version, { jobId: jobA }))
  out.adoptB = await attempt(() => store.adopt(other.version, { jobId: jobB }))
  out.adoptAgain = await attempt(() => store.adopt(other.version, { jobId: jobB }))
  out.rollback = await attempt(() => store.rollback({ trigger: 'manual', reason: 'accept-step6 H02' }))
  const files = await revisionFiles()
  const raws = []
  for (const name of files) raws.push(await readFile(join(store.activationDirectory, name), 'utf8'))
  out.chain = {
    files,
    revisions: raws.map(raw => {
      const revision = JSON.parse(raw)
      return { revision: revision.revision, type: revision.type, version: revision.version, from: revision.from, trigger: revision.trigger, previous: revision.previous }
    }),
    digests: raws.map(sha256),
    activation: await store.activation(),
    bundlesKept: await store.versions(),
  }

  // A damaged improver in force: corrupt the file of the improver the rollback returned to.
  const inForce = out.chain.activation.version
  out.damage = { version: inForce }
  await writeFile(bundleFile(inForce), '{ "formatVersion": 1, "diagnosis": ')
  const resolved = await attempt(() => store.resolve())
  out.damage.resolved = resolved.value === undefined
    ? resolved
    : { version: resolved.value.version, rollbacks: resolved.value.rollbacks.map(r => ({ version: r.version, code: r.error?.code, revision: r.revision?.revision })), problem: resolved.value.problem }
  out.damage.loadAfter = await attempt(() => store.load(inForce))
  out.damage.fileKept = await readFile(bundleFile(inForce), 'utf8').then(() => true, () => false)
  const tail = (await store.chain()).revisions.at(-1)
  out.damage.tail = tail === undefined ? undefined : { revision: tail.revision, type: tail.type, version: tail.version, trigger: tail.trigger, reason: tail.reason }

  // A damaged revision: the chain stops before it and no revision can be added.
  const damagedName = (await revisionFiles()).at(-1)
  const damaged = join(store.activationDirectory, damagedName)
  const before = await readFile(damaged, 'utf8')
  await writeFile(damaged, `${JSON.stringify({ ...JSON.parse(before), previous: '0'.repeat(64) })}\n`)
  const chain = await store.chain()
  out.damagedRevision = {
    file: damagedName,
    problem: chain.problem,
    activationRevision: chain.activation.revision,
    adopt: await attempt(() => store.adopt(other.version, { jobId: randomUUID() })),
    filesAfter: await revisionFiles(),
  }
  return out
}

// ---- pinned -------------------------------------------------------------------------------

/** The diagnosis job B reports: a second skill would help (so B reaches the propose phase and the gate). */
function notesDiagnosis(ctx) {
  return {
    failureTypes: [{ category: MAST[2], label: 'region-table notes are not recorded', evidence: [{ sessionId: ctx.sessionId, seq: ctx.seq, turn: ctx.turn }] }],
    involved: { members: ['root'], tools: ['write_file', 'present'], skills: [], components: [] },
    hypothesis: 'Notes on how the shop sorts its region tables would keep the tables consistent.',
    proposalKind: 'skill',
  }
}

const notesRef = { kind: SECOND_SKILL.kind, name: SECOND_SKILL.name }

/** Job B's steps: diagnose (skill), then draft, try, load and use the notes skill, propose it. */
function notesSteps(ctx) {
  return [
    { phase: 'diagnose', toolCalls: [{ name: DIAGNOSIS_TOOL, arguments: notesDiagnosis(ctx) }] },
    { phase: 'diagnose', content: 'Diagnosis reported.' },
    { phase: 'propose', toolCalls: [{ name: 'capability_draft', arguments: { kind: SECOND_SKILL.kind, name: SECOND_SKILL.name, files: SECOND_SKILL.files } }] },
    { phase: 'propose', toolCalls: [{ name: 'capability_try', arguments: notesRef }] },
    { phase: 'propose', toolCalls: [{ name: 'load_skill', arguments: { name: SECOND_SKILL.name } }] },
    { phase: 'propose', toolCalls: [{ name: 'write_file', arguments: { path: FEEDBACK_TASK.output, content: outputFor(FEEDBACK_TASK) } }] },
    { phase: 'propose', toolCalls: [shellCall({ bash: FEEDBACK_TASK.checkCommand, pwsh: FEEDBACK_TASK.checkCommand })] },
    { phase: 'propose', toolCalls: [{ name: 'present', arguments: { paths: [FEEDBACK_TASK.output], summary: 'region table' } }] },
    { phase: 'propose', toolCalls: [{ name: 'capability_propose', arguments: { components: [notesRef], summary: 'Region-table notes.' } }] },
    { phase: 'propose', content: 'Proposed the region-table notes skill.' },
  ]
}

const toolNames = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)
const assistantSteps = body => (body?.messages ?? []).filter(message => message.role === 'assistant').length
const answerOf = entry => (entry.toolCalls === undefined ? { content: entry.content, usage: USAGE } : { toolCalls: entry.toolCalls, usage: USAGE })

/**
 * Step 5's scripted model plus: the `notes` playbook (job B), the `hold` flag that slows
 * the 该改进 diagnosis replies (job A), and a note of whether each diagnosis request
 * carries the child improver's paragraph.
 */
export class PinnedModel extends Step5Model {
  constructor(h, options) {
    super(h, options)
    this.childParagraph = options.childParagraph
    this.hold = true
    this.diagnoseTexts = []
  }

  respond(body) {
    const tools = toolNames(body)
    const at = assistantSteps(body)
    const first = firstUserText(body)
    if (tools.includes(DIAGNOSIS_TOOL)) {
      if (at === 0 && this.playbooks[0] === 'notes') {
        this.playbooks.shift()
        this.current = 'notes'
        this.diagnoseSessions.push({ playbook: 'notes', tools })
      } else if (at === 0 && this.current === 'notes') {
        // A new diagnose session on another playbook: the step-5 model picks it below.
        this.current = undefined
      }
      if (at === 0) this.diagnoseTexts.push({ playbook: this.current === 'notes' ? 'notes' : this.playbooks[0] ?? 'not-capability', hasChildParagraph: this.h.requestText(body).includes(this.childParagraph) })
      if (this.current === 'notes') {
        this.requests.push({ phase: this.phase, kind: 'diagnose', playbook: 'notes', step: at })
        const book = notesSteps(evidenceFor(this.root, first)).filter(entry => entry.phase === 'diagnose')
        return answerOf(book[Math.min(at, book.length - 1)])
      }
      const turn = super.respond(body)
      return this.hold && this.current === 'improve' ? { ...turn, chunkDelayMs: HOLD_CHUNK_MS } : turn
    }
    if (this.current === 'notes' && first.includes(PROPOSAL_MARKER)) {
      this.requests.push({ phase: this.phase, kind: 'propose', playbook: 'notes', step: at, tools })
      const book = notesSteps({ sessionId: '00000000-0000-4000-8000-000000000000', seq: 1 }).filter(entry => entry.phase === 'propose')
      return answerOf(book[Math.min(at, book.length - 1)])
    }
    return super.respond(body)
  }
}

export async function waitJob(pkgs, root, jobId, done = status => TERMINAL_STATES.includes(status) || status === 'awaiting-approval' || status === 'waiting-history') {
  const pick = jobs => jobs.find(job => job.id === jobId)
  const state = await settle(() => readImprovements(pkgs, root), ({ jobs }) => pick(jobs) !== undefined && done(pick(jobs).status), { timeoutMs: JOB_WAIT, intervalMs: 200 })
  const job = pick(state.jobs)
  if (job === undefined || !done(job.status)) throw new Error(`job ${jobId} did not settle within ${JOB_WAIT / 1000}s (status ${job?.status ?? 'none'})`)
  return job
}

/** H03: a job keeps the improver it started on; the next job uses the adopted one. */
export async function pinnedPhase(h, pkgs, capabilities, work, log) {
  const root = join(work, 'project')
  const playbook = META_PLAYBOOKS.find(entry => entry.id === 'improve-the-improver')
  const child = pkgs.kernel.applyImproverChange(pkgs.kernel.IMPROVER_V0, changeFor(playbook, pkgs.kernel.IMPROVER_V0))
  const model = new PinnedModel(h, { root, playbooks: ['improve', 'notes'], childParagraph: playbook.change.text })
  const server = await h.scriptedModelServer({ script: Array.from({ length: 5_000 }, () => model.entry) })
  const out = { adoptedBy: 'ImproverStore.adopt (stand-in meta job id; meta jobs are not merged yet)' }
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      log: line => log(`pinned: ${line}`),
      config: { autoImprove: false },
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
    })
    const feedbackSession = project.tasks.at(-1)?.sessionId
    model.phase = 'job'
    const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: project.home }
    const sdk = createStep5Sdk(pkgs, { env, home: project.home })
    try {
      const { projectId } = await sdk.call('projects.open', { root, create: true })
      log('pinned: explicit job A (held in its diagnosis)')
      const a = await sdk.call('improvements.run', { projectId, sessionId: feedbackSession })
      out.jobA = { id: a.id }
      const held = await settle(async () => (await readImprovements(pkgs, root)).jobs.find(job => job.id === a.id), job => job?.status === 'diagnosing' && job?.improverVersion !== undefined, { timeoutMs: 60_000 })
      out.jobA.pinnedBeforeAdoption = held?.improverVersion
      out.jobA.statusBeforeAdoption = held?.status

      const store = new capabilities.ImproverStore(capabilities.improversDir({ dataDir: join(root, '.nexgent') }))
      const written = await store.write(child)
      out.child = { version: written.version, created: written.created }
      const commit = await store.adopt(written.version, { jobId: randomUUID() })
      out.adoption = { revision: commit?.revision?.revision, version: commit?.revision?.version, inForce: (await store.activation()).version }
      out.jobA.statusAtAdoption = (await readImprovements(pkgs, root)).jobs.find(job => job.id === a.id)?.status
      model.hold = false
      log(`pinned: child ${written.version.slice(0, 12)} adopted while job A was ${out.jobA.statusAtAdoption}`)

      const doneA = await waitJob(pkgs, root, a.id)
      out.jobA.status = doneA.status
      out.jobA.improverVersion = doneA.improverVersion
      out.jobA.history = (doneA.history ?? []).map(change => change.status)

      log('pinned: explicit job B')
      const b = await sdk.call('improvements.run', { projectId, sessionId: feedbackSession })
      const doneB = await waitJob(pkgs, root, b.id)
      out.jobB = { id: b.id, status: doneB.status, improverVersion: doneB.improverVersion, history: (doneB.history ?? []).map(change => change.status) }
      out.inForceAfter = (await store.activation()).version
    } finally {
      await sdk.dispose()
    }
    out.facts = await versionFacts(pkgs, root)
    out.diagnoseTexts = model.diagnoseTexts
  } finally {
    await server.close()
  }
  return out
}

/**
 * @param h - the loaded test-support harness.
 * @param work - this scenario's own work dir.
 * @param options - `step5Work`: where the regression ran step 5's headless scenario (for H01).
 * @returns `{ v0, store, pinned, errors }`; a phase that crashes is recorded under `errors.<phase>`.
 */
export async function runStep6Headless(h, work, { step5Work, log = () => undefined } = {}) {
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const capabilities = await loadCapabilities()
  const obs = { errors: {} }
  const phase = async (name, run) => {
    const dir = join(work, name)
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      return await run(dir)
    } catch (error) {
      obs.errors[name] = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log(`${name} failed: ${obs.errors[name].split('\n')[0]}`)
      return undefined
    }
  }
  const restore = scriptedEnvironment(SCRIPTED_API_KEY)
  try {
    if (step5Work !== undefined) obs.v0 = await phase('v0', () => v0Phase(pkgs, step5Work))
    obs.store = await phase('store', dir => storePhase(capabilities, pkgs.kernel, dir))
    obs.pinned = await phase('pinned', dir => pinnedPhase(h, pkgs, capabilities, dir, log))
  } finally {
    restore()
  }
  return obs
}
