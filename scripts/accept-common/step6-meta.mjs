/**
 * The step-6 meta-improvement scenario (docs/plan/step-6-work-partition.md §`accept-step6`
 * H04–H17), scripted model server only, through `@nexgent/sdk` as shipped: the SDK installs
 * `@nexgent/evolve`, whose improve entry runs every job (meta jobs and their comparison
 * arms included) in a detached process; the arms' gates run their replays in processes of
 * their own. One scripted model answers every request of a project. Never calls a real model.
 *
 * The model (MetaModel) is step 5's plus: the 'notes' playbook (step6-headless.mjs), meta
 * diagnose playbooks (`none`, `change`, `invalid`, `stall`), meta propose playbooks (`append`
 * appends the improve-the-improver paragraph; `bounds` proposes an evaluator field, an
 * out-of-bounds value and two changes), and per-arm playbooks: an arm's diagnose session is
 * told apart by the child's paragraph in its diagnosis policy (only the child improver has it).
 *
 *   trigger   autoImprove off, meta off: three explicit jobs finish, no meta job; an explicit
 *             meta job runs (`none` → no-proposal); meta turned on in settings; a cancelled
 *             and an interrupted job are not counted; after the 2nd counted job no meta job,
 *             after the 3rd one starts by itself (`job-count`). Then (H15) a meta job held in
 *             its diagnosis: an ordinary job is refused (one slot), the meta job's process is
 *             killed, the next SDK start marks it interrupted without rerunning it. Then (H14)
 *             the meta budget lowered just above what was spent: a meta job stops
 *             budget-exhausted, the next is refused
 *   adopt     the step-5 feedback project (autoImprove on): the third counted feedback starts
 *             the source job (该改进 → adopted). An explicit meta job: meta diagnosis cites the
 *             jobs, the change appends a paragraph; the parent arm proposes the notes skill
 *             (its gate rejects), the child arm the convention skill (its gate adopts):
 *             adopt (gate-passed). The project before and after the meta job (H08); the next
 *             job, started from a new OS process, runs on the child (H11); costs by job and
 *             phase (H14); copies removed by default (H16)
 *   reject    same, the parent arm adopts and the child arm finds no capability problem:
 *             reject (no-offspring), `keepCopies` on (H16 kept); the next job on v0 (H12).
 *             Then the `bounds` proposals (H06) and a meta diagnosis refused three times
 *             (H05), the evaluator settings changed through settings (H13 epoch)
 *
 * The copies go to a phase-local temporary directory (TMPDIR / TEMP / TMP), so what is left
 * there after a meta job is that job's.
 *
 * The comparison's origin rule is being changed (user decision C, 2026-10-13, ADR 0009 to
 * come); H07 is not judged here until it lands.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_BIN } from './harness.mjs'
import { filesContaining } from './step2-headless.mjs'
import { ledgerOf, sessionsOf } from './step4-headless.mjs'
import { DIAGNOSIS_TOOL, runFeedbackProject, SCRIPTED_API_KEY } from './step5-fixtures.mjs'
import { createStep5Sdk, improvementsPath, readImprovements, readJsonFile } from './step5-runtime.mjs'
import { changeFor, PLAYBOOKS as META_PLAYBOOKS } from './step6-improver-rule.mjs'
import { PinnedModel, settle, versionFacts, waitJob } from './step6-headless.mjs'

const DRIVER = fileURLToPath(new URL('./step6-driver.mjs', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? error.message : String(error))
const USAGE = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
const MISSING_JOB = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e'
const ACTIVE = new Set(['queued', 'diagnosing', 'proposing', 'trialing', 'meta-diagnosing', 'meta-proposing', 'comparing'])
const SETTLED = status => !ACTIVE.has(status)

/** The child's paragraph: the improve-the-improver playbook's change (step6-improver-rule.mjs). */
export const CHILD_PARAGRAPH = META_PLAYBOOKS.find(p => p.id === 'improve-the-improver').change.text

const toolNames = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)
const assistantSteps = body => (body?.messages ?? []).filter(message => message.role === 'assistant').length
const calls = toolCalls => ({ toolCalls, usage: USAGE })
const answer = content => ({ content, usage: USAGE })

/**
 * Step 5's model with meta sessions and per-arm playbooks. `metaDiagnose` / `metaPropose`:
 * playbooks in order, one per session; `arms`: `{ parent, child }` step-5 playbooks for the
 * arms of the next comparison (set while a meta job runs).
 */
class MetaModel extends PinnedModel {
  constructor(h, options) {
    super(h, { ...options, childParagraph: CHILD_PARAGRAPH })
    this.hold = false
    this.metaDiagnose = [...(options.metaDiagnose ?? [])]
    this.metaPropose = [...(options.metaPropose ?? [])]
    this.arms = undefined
    this.metaSessions = []
    this.armSessions = []
    this.currentMeta = undefined
  }

  respond(body) {
    const tools = toolNames(body)
    const at = assistantSteps(body)
    if (tools.includes('improve_report_meta_diagnosis')) return this.#metaDiagnose(body, tools, at)
    if (tools.includes('improve_propose_change')) return this.#metaPropose(body, tools, at)
    if (tools.includes(DIAGNOSIS_TOOL) && at === 0 && this.arms !== undefined) {
      const arm = this.h.requestText(body).includes(CHILD_PARAGRAPH) ? 'child' : 'parent'
      this.armSessions.push({ arm, playbook: this.arms[arm] })
      this.playbooks.unshift(this.arms[arm])
    }
    return super.respond(body)
  }

  #metaDiagnose(body, tools, at) {
    if (at === 0) {
      this.currentMeta = this.metaDiagnose.shift() ?? 'none'
      this.metaSessions.push({ phase: 'meta-diagnose', playbook: this.currentMeta, tools })
    }
    this.requests.push({ phase: this.phase, kind: 'meta-diagnose', playbook: this.currentMeta, step: at })
    const book = this.currentMeta
    if (book === 'stall') return { fault: { kind: 'timeout' } }
    if (book === 'invalid') {
      const bad = [
        { findings: [{ stage: 'diagnose', label: 'cites a job the project does not have', jobIds: [MISSING_JOB] }], hypothesis: 'The improver misses failed checks.', proposal: 'change' },
        { findings: [{ stage: 'not-a-stage', label: 'a stage outside the schema', jobIds: [MISSING_JOB] }], hypothesis: 'The improver misses failed checks.', proposal: 'change' },
        { findings: [], hypothesis: '', proposal: 'maybe' },
      ]
      return at < bad.length ? calls([{ name: 'improve_report_meta_diagnosis', arguments: bad[at] }]) : answer('I could not produce an acceptable meta diagnosis.')
    }
    if (at === 0) return calls([{ name: 'improve_list_jobs', arguments: {} }])
    if (at === 1) {
      // The jobs the prompt names as the batch, else the job lines improve_list_jobs returned.
      const text = this.h.requestText(body)
      const batch = /Jobs that finished since the last meta job[^:]*:([^\n]*)/.exec(text)?.[1] ?? ''
      const listed = [...text.matchAll(/\\?"id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].map(m => m[1])
      const ids = [...new Set([...[...batch.matchAll(UUID)].map(m => m[0]), ...listed])].filter(id => id !== MISSING_JOB)
      return calls([{
        name: 'improve_report_meta_diagnosis',
        arguments: book === 'none'
          ? { findings: [{ stage: 'other', label: 'the jobs failed for reasons the improver cannot change', jobIds: ids.slice(0, 1) }], hypothesis: 'The improver is fine; the feedback changed what the user wanted.', proposal: 'none' }
          : { findings: [{ stage: 'diagnose', label: 'diagnoses keep skipping the failed check records', jobIds: ids.slice(0, 2) }], hypothesis: 'A diagnosis policy that reads every failed check would find the missing convention.', proposal: 'change' },
      }])
    }
    return answer('Meta diagnosis reported.')
  }

  #metaPropose(body, tools, at) {
    if (at === 0) {
      this.currentPropose = this.metaPropose.shift() ?? 'append'
      this.metaSessions.push({ phase: 'meta-propose', playbook: this.currentPropose, tools })
    }
    this.requests.push({ phase: this.phase, kind: 'meta-propose', playbook: this.currentPropose, step: at })
    if (this.currentPropose === 'bounds') {
      const bad = [
        { change: { op: 'set-comparison-param', param: 'costApprovalRatio', value: 10 }, rationale: 'The gate rejects too often.' },
        { change: { op: 'set-comparison-param', param: 'repeats', value: 9 }, rationale: 'More repeats.' },
        { change: [{ op: 'set-comparison-param', param: 'repeats', value: 3 }, { op: 'set-proposal-kinds', kinds: ['skill'] }], rationale: 'Two changes at once.' },
      ]
      return at < bad.length ? calls([{ name: 'improve_propose_change', arguments: bad[at] }]) : answer('No acceptable change.')
    }
    if (at === 0) return calls([{ name: 'improve_read_improver', arguments: {} }])
    if (at === 1) {
      const change = changeFor(META_PLAYBOOKS.find(p => p.id === 'improve-the-improver'), { diagnosis: { paragraphs: this.parentParagraphs } })
      return calls([{ name: 'improve_propose_change', arguments: { change, rationale: 'Diagnoses keep skipping the failed check records.' } }])
    }
    return answer('Change proposed.')
  }
}

const modelServer = (h, model) => h.scriptedModelServer({ script: Array.from({ length: 10_000 }, () => model.entry) })
const envOf = (server, home) => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })

/** Point the temporary directory of this process and of the processes it starts at `dir`. */
function localTemp(dir) {
  const names = ['TMPDIR', 'TEMP', 'TMP']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) process.env[name] = dir
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

const armDirs = async dir => (await readdir(dir).catch(() => [])).filter(name => name.startsWith('nexgent-arm-')).sort()

/** A job's files under `.nexgent/improvements/<id>/`. */
async function jobFiles(root, jobId) {
  const dir = join(improvementsPath(root), jobId)
  return {
    job: await readJsonFile(join(dir, 'job.json')),
    metaDiagnosis: await readJsonFile(join(dir, 'meta-diagnosis.json')),
    change: await readJsonFile(join(dir, 'change.json')),
    comparison: await readJsonFile(join(dir, 'comparison.json')),
    starts: ((await readFile(join(dir, 'job.log'), 'utf8').catch(() => '')).match(new RegExp(`improve-entry start ${jobId}`, 'g')) ?? []).length,
  }
}

const queueOf = async (pkgs, root) => {
  const { queue } = await readImprovements(pkgs, root)
  return { metaPending: [...(queue?.metaPending ?? [])], metaCounted: [...(queue?.metaCounted ?? [])], activeJobId: queue?.activeJobId }
}

const jobsOf = async (pkgs, root) => (await readImprovements(pkgs, root)).jobs.map(job => ({ id: job.id, kind: job.kind ?? 'capability', trigger: job.trigger, status: job.status, improverVersion: job.improverVersion, arm: job.arm, meta: job.meta, createdAt: job.createdAt, history: (job.history ?? []).map(change => change.status) }))

async function attempt(fn) {
  try {
    return { value: await fn() }
  } catch (error) {
    return { code: error?.code, error: errorText(error) }
  }
}

/** Start an explicit job; wait for it to settle (or for `done`). */
async function explicitJob(pkgs, sdk, root, projectId, sessionId, done = SETTLED) {
  const started = await attempt(() => sdk.call('improvements.run', { projectId, sessionId }))
  if (started.value === undefined) return started
  const job = await waitJob(pkgs, root, started.value.id, done)
  return { id: job.id, status: job.status, improverVersion: job.improverVersion }
}

/** Start a meta job through the SDK; wait for it to settle (or for `done`). */
async function metaJob(pkgs, sdk, root, projectId, options = {}, done = SETTLED) {
  const started = await attempt(() => sdk.call('improvements.runMeta', { projectId, ...options }))
  if (started.value === undefined) return started
  const job = await waitJob(pkgs, root, started.value.id, done)
  return { id: job.id, trigger: job.trigger, status: job.status, files: await jobFiles(root, job.id) }
}

async function killJob(pkgs, root, jobId) {
  const lock = join(improvementsPath(root), jobId, 'job.lock')
  const pid = await settle(() => pkgs.evolve.readLockPid(lock).catch(() => undefined), value => typeof value === 'number', { timeoutMs: 15_000 })
  if (typeof pid !== 'number') return { error: 'no job process id in job.lock' }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    return { pid, error: errorText(error) }
  }
  await settle(() => pkgs.evolve.processAlive(pid), alive => !alive, { timeoutMs: 5_000 })
  return { pid }
}

async function killAll(pkgs, root) {
  for (const name of await readdir(improvementsPath(root)).catch(() => [])) {
    const pid = await pkgs.evolve.readLockPid(join(improvementsPath(root), name, 'job.lock')).catch(() => undefined)
    if (typeof pid === 'number' && pid !== process.pid && pkgs.evolve.processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch { /* gone */ }
    }
  }
}

// ---- trigger, concurrency, budget -------------------------------------------------------

/** H04, H05 (none, read-only tools), H15, H14 (budget). */
export async function triggerPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const model = new MetaModel(h, {
    root,
    playbooks: ['not-capability', 'not-capability', 'not-capability', 'stall', 'stall', 'not-capability', 'not-capability', 'not-capability'],
    metaDiagnose: ['none', 'none', 'stall', 'change'],
    metaPropose: ['append'],
  })
  model.parentParagraphs = pkgs.kernel.IMPROVER_V0.diagnosis.paragraphs
  const server = await modelServer(h, model)
  const out = { steps: [] }
  const step = async (name, fn) => {
    log(`trigger: ${name}`)
    const before = await queueOf(pkgs, root)
    const result = await fn()
    const after = await queueOf(pkgs, root)
    const jobs = await jobsOf(pkgs, root)
    out.steps.push({ name, result, pendingBefore: before.metaPending.length, pendingAfter: after.metaPending.length, metaJobs: jobs.filter(job => job.kind === 'meta').map(job => ({ id: job.id, trigger: job.trigger, status: job.status, basis: job.meta?.basis })) })
    return result
  }
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      feedback: [],
      log: line => log(`trigger: ${line}`),
      config: { autoImprove: false, improvement: { meta: { enabled: false, everyJobs: 3 } } },
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
    })
    const session = project.tasks.at(-1)?.sessionId
    model.phase = 'job'
    out.home = project.home
    let sdk = createStep5Sdk(pkgs, { env: envOf(server, project.home), home: project.home })
    try {
      let { projectId } = await sdk.call('projects.open', { root, create: true })
      for (const n of [1, 2, 3]) await step(`off: explicit job ${n}`, () => explicitJob(pkgs, sdk, root, projectId, session))
      await sleep(500)
      out.offNoMeta = (await jobsOf(pkgs, root)).filter(job => job.kind === 'meta').length
      await step('off: explicit meta job', () => metaJob(pkgs, sdk, root, projectId))
      const settings = await sdk.call('settings.get', { projectId })
      const updated = await sdk.call('settings.update', { projectId, patch: { improvement: { ...settings.improvement, meta: { ...settings.improvement.meta, enabled: true, everyJobs: 3 } } } })
      out.metaSetting = updated.improvement?.meta
      await step('on: cancelled job', async () => {
        const left = model.playbooks.length
        const started = await sdk.call('improvements.run', { projectId, sessionId: session })
        await waitJob(pkgs, root, started.id, status => status === 'diagnosing')
        await settle(async () => model.playbooks.length, n => n < left, { timeoutMs: 20_000 })
        const cancelled = await attempt(() => sdk.call('improvements.cancel', { projectId, jobId: started.id }))
        const job = await waitJob(pkgs, root, started.id, status => !ACTIVE.has(status))
        return { id: job.id, status: job.status, cancel: cancelled.code ?? 'ok' }
      })
      await step('on: interrupted job', async () => {
        const left = model.playbooks.length
        const started = await sdk.call('improvements.run', { projectId, sessionId: session })
        await waitJob(pkgs, root, started.id, status => status === 'diagnosing')
        await settle(async () => model.playbooks.length, n => n < left, { timeoutMs: 20_000 })
        const killed = await killJob(pkgs, root, started.id)
        await sdk.dispose()
        sdk = createStep5Sdk(pkgs, { env: envOf(server, project.home), home: project.home })
        ;({ projectId } = await sdk.call('projects.open', { root, create: true }))
        const job = await waitJob(pkgs, root, started.id, status => status === 'interrupted', 20_000).catch(() => undefined)
        const files = await jobFiles(root, started.id)
        return { id: started.id, status: files.job?.status, killed, seen: job?.status }
      })
      for (const n of [1, 2]) await step(`on: counted job ${n}`, () => explicitJob(pkgs, sdk, root, projectId, session))
      await sleep(1_000)
      out.afterSecond = (await jobsOf(pkgs, root)).filter(job => job.kind === 'meta').length
      await step('on: counted job 3', async () => {
        const result = await explicitJob(pkgs, sdk, root, projectId, session)
        const meta = await settle(async () => (await jobsOf(pkgs, root)).filter(job => job.kind === 'meta' && job.trigger === 'job-count'), list => list.length > 0, { timeoutMs: 20_000 })
        if (meta[0] !== undefined) await waitJob(pkgs, root, meta[0].id)
        return { ...result, metaJobId: meta[0]?.id }
      })

      // H15: one slot; the meta job's process killed, interrupted at the next start, not rerun.
      log('trigger: meta job held in its diagnosis')
      const held = await sdk.call('improvements.runMeta', { projectId })
      await waitJob(pkgs, root, held.id, status => status === 'meta-diagnosing')
      const stalled = () => model.requests.filter(r => r.kind === 'meta-diagnose' && r.playbook === 'stall').length
      await settle(async () => stalled(), n => n > 0, { timeoutMs: 20_000 })
      out.h15 = { metaJobId: held.id, busy: await attempt(() => sdk.call('improvements.run', { projectId, sessionId: session })) }
      out.h15.statusBeforeKill = (await jobFiles(root, held.id)).job?.status
      out.h15.killed = await killJob(pkgs, root, held.id)
      await sdk.dispose()
      sdk = createStep5Sdk(pkgs, { env: envOf(server, project.home), home: project.home })
      ;({ projectId } = await sdk.call('projects.open', { root, create: true }))
      await waitJob(pkgs, root, held.id, status => status === 'interrupted', 20_000).catch(() => undefined)
      await sleep(1_000)
      const heldFiles = await jobFiles(root, held.id)
      out.h15.statusAfter = heldFiles.job?.status
      out.h15.starts = heldFiles.starts
      out.h15.metaDiagnoseRequests = stalled()

      // H14: the meta budget lowered to just above what meta jobs spent.
      const listing = await sdk.call('improvements.list', { projectId })
      const used = listing.meta?.budget?.usedTokens ?? 0
      const current = await sdk.call('settings.get', { projectId })
      out.budget = { used, limit: used + 60 }
      log(`trigger: meta budget lowered to ${out.budget.limit} tokens`)
      await sdk.call('settings.update', { projectId, patch: { improvement: { ...current.improvement, meta: { ...current.improvement.meta, budget: { ...current.improvement.meta.budget, maxTokens: out.budget.limit } } } } })
      out.budget.stopped = await metaJob(pkgs, sdk, root, projectId)
      out.budget.refused = await attempt(() => sdk.call('improvements.runMeta', { projectId }))
      out.budget.listing = (await sdk.call('improvements.list', { projectId })).meta
    } finally {
      await sdk.dispose()
    }
    out.jobs = await jobsOf(pkgs, root)
    out.metaSessions = model.metaSessions.map(s => ({ phase: s.phase, playbook: s.playbook, tools: s.tools }))
    out.records = await projectRecords(pkgs, root)
  } finally {
    await killAll(pkgs, root)
    await server.close()
  }
  return out
}

// ---- adopt / reject -----------------------------------------------------------------------

/** The project's state a meta job must not change (H08): everything but its own records. */
async function projectState(sdk, projectId, root) {
  const { filesUnder } = await import('./step4-headless.mjs')
  const { createHash } = await import('node:crypto')
  const hashOf = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  const work = {}
  for (const rel of await filesUnder(root)) {
    if (rel.startsWith('.nexgent/')) continue
    work[rel] = await hashOf(join(root, rel))
  }
  const capabilities = {}
  for (const rel of await filesUnder(join(root, '.nexgent', 'capabilities'))) capabilities[rel] = await hashOf(join(root, '.nexgent', 'capabilities', rel))
  const sessions = {}
  for (const [id, records] of Object.entries(await sessionsOf(root))) {
    const start = records.find(r => r.type === 'session.start')
    sessions[id] = { records: records.length, purpose: start?.purpose, phase: start?.improvement?.phase, metaJobId: start?.improvement?.metaJobId }
  }
  const deliverables = (await sdk.call('deliverables.list', { projectId })).map(d => ({ id: d.deliverableId, versions: (d.versions ?? []).map(v => v.version) }))
  const config = await readFile(join(root, '.nexgent', 'config.json'), 'utf8').catch(() => '')
  return { work, capabilities, sessions, deliverables, config }
}

/** Every session and ledger record and improvement file of a project, checked against its schema (H17). */
async function projectRecords(pkgs, root) {
  const { validateSessionRecord, validateLedgerRecord, validateImprovementFile } = pkgs.session
  const sessions = await sessionsOf(root)
  const ledger = await ledgerOf(root)
  const files = []
  const dir = improvementsPath(root)
  const queue = await readJsonFile(join(dir, 'queue.json'))
  if (queue !== undefined) files.push({ kind: 'queue', path: 'improvements/queue.json', value: queue })
  for (const name of await readdir(dir).catch(() => [])) {
    for (const [kind, file] of [['job', 'job.json'], ['diagnosis', 'diagnosis.json'], ['metaDiagnosis', 'meta-diagnosis.json'], ['change', 'change.json'], ['comparison', 'comparison.json']]) {
      const value = await readJsonFile(join(dir, name, file))
      if (value !== undefined) files.push({ kind, path: `improvements/${name}/${file}`, value })
    }
  }
  const improvers = join(root, '.nexgent', 'improvers')
  for (const name of await readdir(join(improvers, 'bundles')).catch(() => [])) files.push({ kind: 'improver', path: `improvers/bundles/${name}`, value: await readJsonFile(join(improvers, 'bundles', name)) })
  for (const name of await readdir(join(improvers, 'activation')).catch(() => [])) files.push({ kind: 'improverRevision', path: `improvers/activation/${name}`, value: await readJsonFile(join(improvers, 'activation', name)) })
  const text = issue => `${issue.path ?? ''} ${issue.message ?? JSON.stringify(issue)}`
  const issuesOf = (records, validate, where) => records.flatMap((record, index) => validate(record).map(issue => `${where}#${index + 1} ${record.type ?? ''}: ${text(issue)}`))
  const issues = [
    ...Object.entries(sessions).flatMap(([id, records]) => issuesOf(records, validateSessionRecord, `session ${id.slice(0, 8)}`)),
    ...issuesOf(ledger, validateLedgerRecord, 'ledger'),
  ]
  const fileIssues = files.flatMap(file => validateImprovementFile(file.kind, file.value).map(issue => ({ kind: file.kind, path: file.path, message: text(issue) })))
  const checked = {
    sessions: Object.values(sessions).reduce((n, records) => n + records.length, 0),
    ledger: ledger.length,
    files: files.length,
    kinds: [...new Set(files.map(file => file.kind))].sort(),
  }
  return { root, sessions, ledger, files, issues, fileIssues, checked, secretHits: await filesContaining(join(root, '.nexgent'), SCRIPTED_API_KEY, root) }
}

/** What the origin rule (ADR 0009) reads, gathered from the project's own files (H07). */
async function originFacts(capabilities, root, metaId) {
  const capDir = join(root, '.nexgent', 'capabilities')
  const chain = await capabilities.readActivationChain(join(capDir, capabilities.ACTIVATION_DIR)).catch(error => ({ revisions: [], error: errorText(error) }))
  const sessions = await sessionsOf(root)
  const taskVersion = sessionId => {
    let version
    for (const record of sessions[sessionId] ?? []) {
      if (record.type === 'feedback') break
      if (record.type === 'session.start') version = record.capabilityVersion
      else if (record.type === 'capability.version') version = record.version
    }
    return version ?? 'baseline'
  }
  const jobs = []
  for (const name of await readdir(improvementsPath(root)).catch(() => [])) {
    const job = await readJsonFile(join(improvementsPath(root), name, 'job.json'))
    if (job === undefined) continue
    const decision = job.decisionId === undefined ? undefined : await capabilities.readDecision(join(capDir, capabilities.DECISIONS_DIR), job.decisionId).catch(() => undefined)
    const feedback = (job.items ?? []).filter(item => item.kind === 'feedback')
    jobs.push({
      id: job.id,
      kind: job.kind ?? 'capability',
      arm: job.arm,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      history: (job.history ?? []).map(entry => ({ status: entry.status, at: entry.at })),
      baseVersion: job.baseVersion,
      feedbackIds: feedback.map(item => item.feedbackId).sort(),
      taskVersions: Object.fromEntries([...new Set(feedback.map(item => item.sessionId))].map(id => [id, taskVersion(id)])),
      baselineFeedbackPassRate: decision?.verdict?.feedbackPassRate?.baseline,
    })
  }
  const log = metaId === undefined ? '' : await readFile(join(improvementsPath(root), metaId, 'job.log'), 'utf8').catch(() => '')
  return {
    revisions: (chain.revisions ?? []).map(revision => ({ revision: revision.revision, version: revision.version, committedAt: revision.committedAt })),
    chainError: chain.error,
    jobs,
    logLine: log.split('\n').find(line => /compare: \S+ origin/.test(line)),
  }
}

/** The product's decision on the recorded comparison with one field of the child's origin changed (H07, H13). */
function tampered(kernel, comparison, epochAfter) {
  if (comparison?.origin === undefined || comparison.parent === undefined || comparison.child === undefined) return undefined
  const o = comparison.child.origin
  const other = kernel.COMPARISON_ORIGIN_KINDS.find(kind => kind !== o.kind)
  const changes = {
    none: {},
    sourceJobId: { sourceJobId: `${o.sourceJobId}-other` },
    tree: { tree: o.tree.replace(/^./, c => (c === '0' ? '1' : '0')) },
    feedbackIds: { feedbackIds: [...o.feedbackIds, 'another-feedback'] },
    capabilityVersion: { capabilityVersion: o.capabilityVersion === 'baseline' ? 'f'.repeat(64) : 'baseline' },
    kind: { kind: other },
    epoch: { epoch: epochAfter ?? 'e'.repeat(64) },
  }
  return Object.fromEntries(Object.entries(changes).map(([field, change]) => [field, kernel.decideImprover(comparison.origin, comparison.parent, { ...comparison.child, origin: { ...o, ...change } }).reason]))
}

function runDriver(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, lines: stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { type: 'raw', line } } }), stderr: stderr.slice(0, 2000) }))
  })
}

/**
 * One comparison end to end (adopt or reject), in a fresh feedback project.
 * @param arms - `{ parent, child }` step-5 playbooks of the two arms.
 */
async function comparisonPhase(h, pkgs, capabilities, work, log, { name, arms, source: sourcePlaybook = 'improve', keepCopies, extra }) {
  const root = join(work, 'project')
  const temp = join(work, 'tmp')
  await mkdir(temp, { recursive: true })
  const restoreTemp = localTemp(temp)
  const model = new MetaModel(h, { root, playbooks: [sourcePlaybook], metaDiagnose: ['change'], metaPropose: ['append'] })
  model.parentParagraphs = pkgs.kernel.IMPROVER_V0.diagnosis.paragraphs
  const server = await modelServer(h, model)
  const out = { name, sourcePlaybook }
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      log: line => log(`${name}: ${line}`),
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
    })
    const session = project.tasks.at(-1)?.sessionId
    model.phase = 'job'
    let sdk = createStep5Sdk(pkgs, { env: envOf(server, project.home), home: project.home })
    try {
      const { projectId } = await sdk.call('projects.open', { root, create: true })
      // The source job: started by the third counted feedback.
      const source = await settle(async () => (await jobsOf(pkgs, root)).find(job => job.trigger === 'feedback-count'), job => job !== undefined, { timeoutMs: 30_000 })
      out.source = source === undefined ? undefined : await waitJob(pkgs, root, source.id).then(job => ({ id: job.id, status: job.status, improverVersion: job.improverVersion }))
      await sleep(500)
      out.before = await projectState(sdk, projectId, root)
      out.tempBefore = await armDirs(temp)
      out.improversBefore = await sdk.call('improvers.list', { projectId }).catch(error => ({ error: errorText(error) }))
      const ledgerBefore = (await ledgerOf(root)).length
      log(`${name}: meta job (arms: parent ${arms.parent}, child ${arms.child})`)
      model.arms = arms
      out.meta = await metaJob(pkgs, sdk, root, projectId, keepCopies ? { keepCopies: true } : {})
      model.arms = undefined
      out.armSessions = [...model.armSessions]
      out.origin = await originFacts(capabilities, root, out.meta.id)
      out.tampered = tampered(pkgs.kernel, out.meta.files?.comparison)
      out.tempAfter = await armDirs(temp)
      out.after = await projectState(sdk, projectId, root)
      out.newLedger = (await ledgerOf(root)).slice(ledgerBefore).map(r => ({ type: r.type, improvementId: r.improvementId, improvementPhase: r.improvementPhase, improverVersion: r.improverVersion, metaJobId: r.metaJobId, comparisonArm: r.comparisonArm, sessionId: r.sessionId }))
      out.improvers = await sdk.call('improvers.list', { projectId }).catch(error => ({ error: errorText(error) }))
      out.show = out.meta.files?.change?.childVersion === undefined ? undefined : await sdk.call('improvers.show', { projectId, version: out.meta.files.change.childVersion }).catch(error => ({ error: errorText(error) }))
      out.listing = (await sdk.call('improvements.list', { projectId }).catch(() => ({ jobs: [] }))).jobs?.map(job => ({ id: job.id ?? job.jobId, kind: job.kind, improverVersion: job.improverVersion, estimatedUsd: job.cost?.estimatedUsd ?? job.estimatedUsd }))
      out.kept = []
      for (const kept of Object.values(out.meta.files?.comparison?.kept ?? {})) out.kept.push({ root: kept.root, bytes: kept.bytes, exists: await readdir(kept.root).then(() => true, () => false), hasProject: await readdir(join(kept.root, '.nexgent')).then(() => true, () => false) })
      await sdk.dispose()
      sdk = undefined
      // The next job, from a process that never saw the meta job.
      log(`${name}: next job from a new process`)
      const before = Date.now()
      const driven = await runDriver({ mode: 'improve', root, home: project.home, baseUrl: server.baseUrl, key: SCRIPTED_API_KEY, sessionId: session })
      const done = driven.lines.find(line => line.type === 'driver.done')
      out.next = { code: driven.code, pid: done?.pid, parentPid: process.pid, jobId: done?.jobId, status: done?.status, improverVersion: done?.improverVersion, error: driven.lines.find(line => line.type === 'driver.error')?.message ?? (driven.code === 0 ? undefined : driven.stderr), startedAfter: new Date(before).toISOString() }
      out.jobs = await jobsOf(pkgs, root)
      out.facts = await versionFacts(pkgs, root)
      if (extra !== undefined) {
        sdk = createStep5Sdk(pkgs, { env: envOf(server, project.home), home: project.home })
        const reopened = await sdk.call('projects.open', { root, create: true })
        out.extra = await extra({ sdk, projectId: reopened.projectId, root, model, session, comparison: out.meta.files?.comparison, work })
      }
    } finally {
      if (sdk !== undefined) await sdk.dispose()
    }
    out.records = await projectRecords(pkgs, root)
    out.metaSessions = model.metaSessions.map(s => ({ phase: s.phase, playbook: s.playbook, tools: s.tools }))
    // H17: the meta diagnosis session exported through the CLI carries no key.
    const exported = out.meta?.files?.job?.sessions?.['meta-diagnose']
    if (exported !== undefined) {
      const exportDir = join(work, 'export')
      const cli = h.spawnNode([CLI_BIN, 'export', exported, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: project.home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
      const cliExit = await cli.exit
      out.export = { session: exported, code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: (await readdir(exportDir).catch(() => [])).sort(), secretHits: await filesContaining(exportDir, SCRIPTED_API_KEY, work) }
    }
    // Costs by attribution (H14), through the product's own ledger reads.
    const ledger = new pkgs.session.JsonlLedger({ ledgersDir: join(root, '.nexgent', 'ledgers') })
    const cost = async query => {
      const sum = await pkgs.kernel.sumLedgerCost(ledger, query)
      return { requests: sum.total.requestCount, tokens: sum.total.usage?.totalTokens ?? null }
    }
    const metaId = out.meta?.id
    out.costs = metaId === undefined ? undefined : {
      meta: await cost({ metaJobId: metaId }),
      metaDiagnose: await cost({ improvementId: metaId, improvementPhase: 'meta-diagnose' }),
      metaPropose: await cost({ improvementId: metaId, improvementPhase: 'meta-propose' }),
      parentArm: await cost({ metaJobId: metaId, comparisonArm: 'parent' }),
      childArm: await cost({ metaJobId: metaId, comparisonArm: 'child' }),
      source: out.source === undefined ? undefined : await cost({ improvementId: out.source.id }),
    }
  } finally {
    restoreTemp()
    await killAll(pkgs, root)
    await server.close()
  }
  return out
}

/** H06 (refused proposals), H05 (refused diagnosis), H13 (epoch): after the reject comparison. */
async function rejectExtra(pkgs, capabilities, { sdk, projectId, root, model, comparison, work }) {
  const out = {}
  const config = () => readFile(join(root, '.nexgent', 'config.json'), 'utf8').catch(() => '')
  const versions = async () => (await readdir(join(root, '.nexgent', 'improvers', 'bundles')).catch(() => [])).sort()
  out.configBefore = await config()
  out.versionsBefore = await versions()
  model.metaDiagnose.push('change', 'invalid')
  model.metaPropose.push('bounds')
  out.bounds = await metaJob(pkgs, sdk, root, projectId)
  out.invalid = await metaJob(pkgs, sdk, root, projectId)
  out.configAfter = await config()
  out.versionsAfter = await versions()
  out.proposeRequests = model.requests.filter(r => r.kind === 'meta-propose' && r.playbook === 'bounds').length
  // Epoch: the evaluator settings (config.json `capabilities`, which settings.update does not
  // take: a read-only field there) edited in the project's config file, as a user would.
  const layout = { root, dataDir: join(root, '.nexgent'), configFile: join(root, '.nexgent', 'config.json') }
  out.epochBefore = await capabilities.projectEpoch(layout)
  const raw = JSON.parse(await config())
  const cap = raw.capabilities?.costRatioCap
  out.costRatioCap = { before: cap, via: 'config.json' }
  out.costRatioCap.settingsPatch = (await attempt(() => sdk.call('settings.update', { projectId, patch: { capabilities: { costRatioCap: 3 } } }))).code
  try {
    await writeFile(layout.configFile, `${JSON.stringify({ ...raw, capabilities: { ...raw.capabilities, costRatioCap: (typeof cap === 'number' ? cap : 2) + 0.5 } }, null, 2)}\n`)
    out.costRatioCap.after = (await sdk.call('settings.get', { projectId })).capabilities?.costRatioCap ?? JSON.parse(await config()).capabilities?.costRatioCap
  } catch (error) {
    out.costRatioCap.error = errorText(error)
  }
  out.epochAfter = await capabilities.projectEpoch(layout)
  // A non-evaluator setting leaves the epoch as it is.
  const again = await sdk.call('settings.get', { projectId })
  await attempt(() => sdk.call('settings.update', { projectId, patch: { improvement: { ...again.improvement, feedbackThreshold: (again.improvement?.feedbackThreshold ?? 3) === 3 ? 4 : 3 } } }))
  out.epochAfterOther = await capabilities.projectEpoch(layout)
  out.crossEpoch = tampered(pkgs.kernel, comparison, out.epochAfter)?.epoch
  // H16 over the limit: the keep limit is not settable through the SDK, so the package call
  // with a lowered limit, on the comparison's own origin.
  if (comparison?.origin !== undefined) {
    const keepMaxBytes = 1_024
    const tempRoot = join(work, 'limit')
    await mkdir(tempRoot, { recursive: true })
    try {
      const copy = await capabilities.prepareProjectCopy({ layout: pkgs.kernel.resolveWorkspaceLayout(root), origin: { tree: comparison.origin.tree, caseId: comparison.origin.sourceJobId }, version: comparison.origin.capabilityVersion, tempRoot, keepMaxBytes })
      const released = await copy.release({ keep: true })
      out.copyLimit = { keepMaxBytes, status: released.status, bytes: released.bytes, exists: await readdir(copy.root).then(() => true, () => false) }
    } catch (error) {
      out.copyLimit = { keepMaxBytes, error: errorText(error) }
    }
  }
  return out
}

/**
 * @returns `{ trigger, adopt, reject, errors }`; a phase that crashes is recorded under `errors.<phase>`.
 */
export async function runStep6Meta(h, pkgs, capabilities, work, { log = () => undefined } = {}) {
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
  obs.trigger = await phase('trigger', dir => triggerPhase(h, pkgs, dir, log))
  obs.adopt = await phase('adopt', dir => comparisonPhase(h, pkgs, capabilities, dir, log, { name: 'adopt', arms: { parent: 'notes', child: 'improve' }, keepCopies: false }))
  obs.reject = await phase('reject', dir => comparisonPhase(h, pkgs, capabilities, dir, log, { name: 'reject', arms: { parent: 'improve', child: 'not-capability' }, source: 'not-capability', keepCopies: true, extra: ctx => rejectExtra(pkgs, capabilities, ctx) }))
  obs.export = obs.adopt?.export
  obs.copyLimit = obs.reject?.extra?.copyLimit
  if (obs.reject?.extra?.crossEpoch !== undefined) obs.crossEpochProduct = { reason: obs.reject.extra.crossEpoch }
  // Evaluator settings named anywhere inside a stored improver bundle (H13).
  const evaluator = new Set(pkgs.kernel.EVALUATOR_FIELDS)
  const keysOf = value => (value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => [...(Array.isArray(value) ? [] : [key]), ...keysOf(inner)]) : [])
  obs.evaluatorKeysInImprovers = [...new Set(['trigger', 'adopt', 'reject'].flatMap(name => (obs[name]?.records?.files ?? []).filter(file => file.kind === 'improver').flatMap(file => keysOf(file.value?.bundle ?? file.value).filter(key => evaluator.has(key)))))].sort()
  return obs
}
