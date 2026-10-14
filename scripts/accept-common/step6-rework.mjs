/**
 * The step-6 rework scenario (docs/plan/step-6-rework-partition.md R7 part 2; ADR 0012, 0013):
 * checks H19–H24, scripted model server only, through `@nexgent/sdk` as shipped (it installs
 * `@nexgent/evolve`, whose improve entry runs every job in a detached process; the gate runs
 * its replays in processes of its own). One scripted model answers every request of a project.
 * Never calls a real model.
 *
 *   shared       (H19; H05's outside-the-batch read) two feedback projects under one NEXGENT_HOME,
 *                the second with `improvement.shareImproverEvidence` off; the first carries a
 *                step-6-era project-level line `.nexgent/improvers/` with an adopted improver. A
 *                child improver is adopted in the user's line (`ImproverStore.user`): one job in
 *                each project pins it; rolled back, one more job in each pins v0. The user queue
 *                counts the first project's jobs only; an explicit meta job of the first project
 *                asks improve_list_jobs for the second (refused) and for its own (answered)
 *   literal      (H20, H23) a feedback project whose tasks share a constant (250 units, in three
 *                task messages and a feedback comment). Job 1 (`literal`): the proposal carries the
 *                constant, the avg_order_value column and a revenue figure of the feedback task's
 *                table: capability_propose refuses it naming only the figure; redrafted without it,
 *                the same skill is proposed. Job 2 (`late-literal`): a skill carrying a value no
 *                source has yet is proposed (accepted); while the proposal session ends, the user
 *                presents a note with that value in the feedback session; the gate then refuses the
 *                candidate before any replay (instance-literal). The rules id and epoch are read
 *   similar      (H21, H22) three feedback projects, the job proposing the convention skill each
 *                time: `fail` — in the candidate's replay of the similar history task the scripted
 *                model writes a broken table (similar-regression); `unknown` — that replay's model
 *                request fails (unknown-runs; the similar tally carries the unknown); `none` — the
 *                history tasks are asked in words the feedback task's ask does not share, so the
 *                selection has no similar case (await-approval, no-similar-cases)
 *   metaLiteral  (H24) a feedback project whose third counted feedback starts a job (no-proposal);
 *                an explicit meta job proposes a change whose paragraph carries a revenue figure of
 *                the feedback task's table: improve_propose_change refuses it (instance-literal),
 *                no change.json, nothing stored in the user's improver line
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ledgerOf } from './step4-headless.mjs'
import { CONVENTION_COLUMN, FEEDBACK } from '../real-task/step5-orders.mjs'
import { shellCall } from './scenario-step2.mjs'
import { runTurn } from './step2-runtime.mjs'
import { CONVENTION_SKILL, DIAGNOSIS_TOOL, FEEDBACK_TASK, HISTORY_TASKS, outputFor, playbook, PROPOSAL_MARKER, runFeedbackProject, SCRIPTED_API_KEY } from './step5-fixtures.mjs'
import { evidenceFor, firstUserText, USAGE } from './step5-model.mjs'
import { createStep5Sdk, loadStep5Packages, readImprovements, scriptedEnvironment } from './step5-runtime.mjs'
import { changeFor, PLAYBOOKS as META_PLAYBOOKS } from './step6-improver-rule.mjs'
import { homeImprovers, loadCapabilities, settle, versionFacts, waitJob } from './step6-headless.mjs'
import { attempt, envOf, explicitJob, jobFiles, killAll, metaJob, MetaModel, modelServer, userLine } from './step6-meta.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? error.message : String(error))
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g

const blocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [])
const toolNames = body => (body?.tools ?? []).map(tool => tool?.name).filter(Boolean)
const assistantSteps = body => (body?.messages ?? []).filter(message => message.role === 'assistant').length
const calls = toolCalls => ({ toolCalls, usage: USAGE })
const answer = content => ({ content, usage: USAGE })
const resultText = block => (typeof block.content === 'string' ? block.content : blocks(block.content).map(b => b.text ?? '').join('\n'))

/** The tool results the request carries for the calls of the assistant message before it: `{ name, input, isError, text }`. */
export function lastToolResults(body) {
  const messages = body?.messages ?? []
  const last = messages.at(-1)
  if (last?.role !== 'user') return []
  const assistant = [...messages].reverse().find(message => message.role === 'assistant')
  const uses = new Map(blocks(assistant?.content).filter(b => b.type === 'tool_use').map(b => [b.id, b]))
  return blocks(last.content).filter(b => b.type === 'tool_result').map(b => ({ name: uses.get(b.tool_use_id)?.name, input: uses.get(b.tool_use_id)?.input, isError: b.is_error === true, text: resultText(b).slice(0, 4000) }))
}

/** The first literal value of `kind` in a text, by the contract's own tokenizer. */
const literalIn = (kernel, text, kind) => kernel.literalTokens(text).find(token => token.kind === kind)?.value

/** The constant the literal project's tasks share (in three task messages and a feedback comment). */
export const BULK_CONSTANT = '250'
const BULK_SENTENCE = `Orders of ${BULK_CONSTANT} units or more count as bulk.`
/** A value no source of the literal project has until the user presents it (H23). */
export const LATE_VALUE = '4321.09'
const LATE_MARKER = 'save the bulk total note'
const LATE_NOTE = 'out/bulk-note.md'

/** Skills of the custom playbooks. */
const skill = (name, description, lines) => ({ kind: 'skill', name, files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${lines.join('\n')}\n` }] })
const ref = component => ({ kind: component.kind, name: component.name })

/**
 * The step-6 meta model plus: custom diagnose playbooks (`literal`, `late-literal`) whose
 * proposals carry concrete values, a similar-case mode for the candidate's replay of the history
 * region table (`fail` writes a broken table, `unknown` fails the request), asks rewritten to the
 * fixture's (`askMap`, so tasks asked in other words still get the fixture's answers), the
 * user's late note (H23), meta playbooks `probe` (diagnose) and `literal` (propose), and every
 * tool result it is sent, kept by tool name.
 */
export class ReworkModel extends MetaModel {
  constructor(h, options) {
    super(h, options)
    this.kernel = options.kernel
    this.figure = options.figure
    this.similarMode = options.similarMode
    this.askMap = options.askMap ?? []
    this.probe = options.probe
    this.toolResults = []
    this.similarReplays = []
    this.lateNotes = 0
    this.currentCustom = undefined
    this.currentMetaCustom = undefined
  }

  respond(raw) {
    let body = raw
    if (this.askMap.length > 0) {
      let text = JSON.stringify(raw)
      for (const { from, to } of this.askMap) text = text.split(from).join(to)
      body = JSON.parse(text)
    }
    const tools = toolNames(body)
    const at = assistantSteps(body)
    const first = firstUserText(body)
    for (const result of lastToolResults(body)) this.toolResults.push({ phase: this.phase, custom: this.currentCustom ?? this.currentMetaCustom, ...result })

    if (tools.includes('improve_report_meta_diagnosis')) {
      if (at === 0) this.currentMetaCustom = this.metaDiagnose[0] === 'probe' ? this.metaDiagnose.shift() : undefined
      if (this.currentMetaCustom === 'probe') return this.#probe(body, tools, at)
      return super.respond(body)
    }
    if (tools.includes('improve_propose_change')) {
      if (at === 0) this.currentMetaCustom = this.metaPropose[0] === 'literal' ? this.metaPropose.shift() : undefined
      if (this.currentMetaCustom === 'literal') return this.#metaLiteral(tools, at)
      return super.respond(body)
    }
    if (tools.includes(DIAGNOSIS_TOOL) && this.arms === undefined) {
      if (at === 0) this.currentCustom = ['literal', 'late-literal'].includes(this.playbooks[0]) ? this.playbooks.shift() : undefined
      if (this.currentCustom !== undefined) {
        if (at === 0) this.diagnoseSessions.push({ playbook: this.currentCustom, tools })
        this.requests.push({ phase: this.phase, kind: 'diagnose', playbook: this.currentCustom, step: at })
        const book = playbook('improve', evidenceFor(this.root, first)).steps.filter(entry => entry.phase === 'diagnose')
        const entry = book[Math.min(at, book.length - 1)]
        return entry.toolCalls === undefined ? answer(entry.content) : calls(entry.toolCalls)
      }
    }
    if (this.currentCustom !== undefined && first.includes(PROPOSAL_MARKER)) {
      this.requests.push({ phase: this.phase, kind: 'propose', playbook: this.currentCustom, step: at, tools })
      const book = this.currentCustom === 'literal' ? this.#literalSteps() : this.#lateSteps()
      return book[Math.min(at, book.length - 1)]
    }
    const late = this.#lateNote(body)
    if (late !== undefined) return late
    const similar = this.#similarReplay(body, tools, at, first)
    if (similar !== undefined) return similar
    return super.respond(body)
  }

  /** H20: a skill carrying the constant, the column name and the feedback table's figure; refused, redrafted without the figure, proposed. */
  #literalSteps() {
    const table = outputFor(FEEDBACK_TASK, { withAverage: true })
    const lines = [
      'When writing a region table from the order CSV:',
      '',
      `1. Columns: region, orders, revenue, ${CONVENTION_COLUMN}; rows sorted by region.`,
      `2. ${CONVENTION_COLUMN} = revenue / orders, rounded to cents.`,
      `3. ${BULK_SENTENCE}`,
    ]
    const withFigure = skill('region-table-figures', 'How the shop writes its region tables.', [...lines, `4. Last month the first region's revenue was ${this.figure}.`])
    const without = skill('region-table-figures', 'How the shop writes its region tables.', lines)
    const use = component => [
      calls([{ name: 'capability_draft', arguments: { kind: component.kind, name: component.name, files: component.files } }]),
      calls([{ name: 'capability_try', arguments: ref(component) }]),
      calls([{ name: 'load_skill', arguments: { name: component.name } }]),
    ]
    return [
      ...use(withFigure),
      calls([{ name: 'write_file', arguments: { path: FEEDBACK_TASK.output, content: table } }]),
      calls([shellCall({ bash: FEEDBACK_TASK.checkCommand, pwsh: FEEDBACK_TASK.checkCommand })]),
      calls([{ name: 'present', arguments: { paths: [FEEDBACK_TASK.output], summary: 'region table with the average order value' } }]),
      calls([{ name: 'capability_propose', arguments: { components: [ref(withFigure)], summary: 'Region-table rules.' } }]),
      ...use(without),
      calls([{ name: 'capability_propose', arguments: { components: [ref(without)], summary: 'Region-table rules.' } }]),
      answer('Proposed the region-table rules.'),
    ]
  }

  /** H23: a skill carrying a value no source has yet; proposed; the session's last answer is slow so the user can present the value meanwhile. */
  #lateSteps() {
    const notes = skill('region-bulk-notes', 'Notes on the shop\'s bulk orders.', [`The bulk total to compare against is ${LATE_VALUE}.`, BULK_SENTENCE])
    return [
      calls([{ name: 'capability_draft', arguments: { kind: notes.kind, name: notes.name, files: notes.files } }]),
      calls([{ name: 'capability_try', arguments: ref(notes) }]),
      calls([{ name: 'load_skill', arguments: { name: notes.name } }]),
      calls([{ name: 'write_file', arguments: { path: FEEDBACK_TASK.output, content: outputFor(FEEDBACK_TASK, { withAverage: true }) } }]),
      calls([shellCall({ bash: FEEDBACK_TASK.checkCommand, pwsh: FEEDBACK_TASK.checkCommand })]),
      calls([{ name: 'present', arguments: { paths: [FEEDBACK_TASK.output], summary: 'region table' } }]),
      calls([{ name: 'capability_propose', arguments: { components: [ref(notes)], summary: 'Bulk-order notes.' } }]),
      { content: Array.from({ length: 15 }, () => '.'), chunkDelayMs: 1_000, usage: USAGE },
    ]
  }

  /** The user's turn asking for the note with the late value (H23), counted from the message that asks for it. */
  #lateNote(body) {
    const messages = body?.messages ?? []
    const index = messages.findIndex(message => message.role === 'user' && blocks(message.content).some(b => b.type === 'text' && (b.text ?? '').includes(LATE_MARKER)))
    if (index < 0) return undefined
    const after = messages.slice(index + 1).filter(message => message.role === 'assistant').length
    this.lateNotes += 1
    if (after === 0) return calls([{ name: 'write_file', arguments: { path: LATE_NOTE, content: `Bulk total: ${LATE_VALUE}\n` } }])
    if (after === 1) return calls([{ name: 'present', arguments: { paths: [LATE_NOTE], summary: 'bulk total note' } }])
    return answer(`${LATE_NOTE} presented.`)
  }

  /** The candidate's replay of the history region table (the feedback task's similar case), in `fail` / `unknown` mode. */
  #similarReplay(body, tools, at, first) {
    if (this.similarMode === undefined) return undefined
    const similar = HISTORY_TASKS.find(task => task.kind === 'regions')
    if (!first.includes(similar.ask) || first.includes(FEEDBACK_TASK.ask)) return undefined
    const offered = tools.includes('load_skill') && JSON.stringify(body?.system ?? '').includes(CONVENTION_SKILL.name)
    const used = (body?.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => blocks(m.content)).some(b => b.type === 'tool_use' && b.name === 'load_skill')
    if (!(at === 0 ? offered : used)) return undefined
    // Only the first of the candidate's replays of the similar case goes wrong: the candidate still wins
    // on quality overall (it fixes the feedback task), so only the similar-case rule can stop it.
    if (at === 0) this.similarSessions = (this.similarSessions ?? 0) + 1
    if (this.similarSessions > 1) return undefined
    this.similarReplays.push({ mode: this.similarMode, step: at })
    if (this.similarMode === 'unknown') return { fault: { kind: 'http-error', status: 400, message: 'scripted: this replay cannot be answered' }, usage: USAGE }
    const script = [
      calls([{ name: 'load_skill', arguments: { name: CONVENTION_SKILL.name } }, { name: 'write_file', arguments: { path: similar.output, content: 'region,orders,revenue\n' } }]),
      calls([shellCall({ bash: similar.checkCommand, pwsh: similar.checkCommand })]),
      calls([{ name: 'present', arguments: { paths: [similar.output], summary: 'region table' } }]),
      answer(`${similar.output} presented.`),
    ]
    return at < script.length ? script[at] : answer('Noted.')
  }

  /** Meta diagnose `probe`: improve_list_jobs for a project outside the batch, then for its own, then `none`. */
  #probe(body, tools, at) {
    if (at === 0) this.metaSessions.push({ phase: 'meta-diagnose', playbook: 'probe', tools })
    this.requests.push({ phase: this.phase, kind: 'meta-diagnose', playbook: 'probe', step: at })
    if (at === 0) return calls([{ name: 'improve_list_jobs', arguments: { projectId: this.probe.outside } }])
    if (at === 1) return calls([{ name: 'improve_list_jobs', arguments: { projectId: this.probe.inside } }])
    if (at === 2) {
      const text = this.h.requestText(body)
      const ids = [...new Set([...text.matchAll(UUID)].map(m => m[0]))]
      return calls([{ name: 'improve_report_meta_diagnosis', arguments: { findings: [{ stage: 'other', label: 'the jobs failed for reasons the improver cannot change', jobIds: ids.slice(0, 1) }], hypothesis: 'The improver is fine.', proposal: 'none' } }])
    }
    return answer('Meta diagnosis reported.')
  }

  /** Meta propose `literal`: one change whose paragraph carries the feedback table's figure. */
  #metaLiteral(tools, at) {
    if (at === 0) this.metaSessions.push({ phase: 'meta-propose', playbook: 'literal', tools })
    this.requests.push({ phase: this.phase, kind: 'meta-propose', playbook: 'literal', step: at })
    if (at === 0) return calls([{ name: 'improve_read_improver', arguments: {} }])
    if (at === 1) {
      const base = changeFor(META_PLAYBOOKS.find(p => p.id === 'improve-the-improver'), { diagnosis: { paragraphs: this.parentParagraphs } })
      const change = { ...base, text: `${base.text} For example the first region's revenue of ${this.figure} was missed.` }
      return calls([{ name: 'improve_propose_change', arguments: { change, rationale: 'Diagnoses keep skipping the failed check records.' } }])
    }
    return answer('No acceptable change.')
  }
}

const capDir = root => join(root, '.nexgent', 'capabilities')

/** A job's decision and the runs of its trial, per case (`{ caseId: { candidate: [statuses], baseline: [...] } }`). */
async function decisionOf(capabilities, root, job) {
  if (job?.decisionId === undefined) return { job: job?.status }
  const decision = await capabilities.readDecision(join(capDir(root), capabilities.DECISIONS_DIR), job.decisionId).catch(error => ({ error: errorText(error) }))
  const runs = {}
  if (decision?.trialId !== undefined) {
    for (const receipt of await capabilities.readTrialReceipts(capDir(root), decision.trialId).catch(() => [])) {
      if (receipt.type !== 'trial.run' || receipt.set !== 'selection') continue
      const entry = runs[receipt.caseId] ?? { candidate: [], baseline: [] }
      entry[receipt.arm].push(receipt.status)
      runs[receipt.caseId] = entry
    }
  }
  return {
    job: job.status,
    id: decision?.id,
    outcome: decision?.outcome,
    reason: decision?.reason,
    trialId: decision?.trialId,
    verdict: decision?.verdict,
    instanceLiterals: decision?.instanceLiterals,
    detail: decision?.detail,
    error: decision?.error,
    runs,
  }
}

/** One feedback project with its own scripted model; `home` shares another project's NEXGENT_HOME. */
async function feedbackProject(h, pkgs, dir, model, log, { home, config, feedback, tasks } = {}) {
  const server = await modelServer(h, model)
  const project = await runFeedbackProject(h, pkgs, dir, {
    server,
    log,
    ...(config === undefined ? {} : { config }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(tasks === undefined ? {} : { tasks }),
    createSdk: (env, own) => createStep5Sdk(pkgs, { env: { ...env, NEXGENT_HOME: home ?? own }, home: home ?? own }),
  })
  return { server, root: project.root, home: home ?? project.home, project, session: project.tasks.at(-1)?.sessionId, taskSessions: Object.fromEntries(project.tasks.map(task => [task.sessionId, task.id])) }
}

// ---- shared (H19) ---------------------------------------------------------------------------

export async function sharedPhase(h, pkgs, capabilities, work, log) {
  const kernel = pkgs.kernel
  const out = {}
  const rootOne = join(work, 'one', 'project')
  const rootTwo = join(work, 'two', 'project')
  const one = new ReworkModel(h, { root: rootOne, kernel, playbooks: ['not-capability', 'not-capability'], metaDiagnose: ['probe'] })
  const two = new ReworkModel(h, { root: rootTwo, kernel, playbooks: ['not-capability', 'not-capability'] })
  one.parentParagraphs = kernel.IMPROVER_V0.diagnosis.paragraphs
  two.parentParagraphs = kernel.IMPROVER_V0.diagnosis.paragraphs
  const servers = []
  let sdkOne
  let sdkTwo
  try {
    const p1 = await feedbackProject(h, pkgs, join(work, 'one'), one, line => log(`shared one: ${line}`), { config: { autoImprove: false }, feedback: [] })
    servers.push(p1.server)
    const home = p1.home
    const p2 = await feedbackProject(h, pkgs, join(work, 'two'), two, line => log(`shared two: ${line}`), { home, config: { autoImprove: false, improvement: { shareImproverEvidence: false } }, feedback: [] })
    servers.push(p2.server)
    one.phase = 'job'
    two.phase = 'job'
    out.projectIds = { one: await pkgs.evolve.userProjectId(rootOne), two: await pkgs.evolve.userProjectId(rootTwo) }
    out.shares = { one: await pkgs.evolve.projectShares(rootOne), two: await pkgs.evolve.projectShares(rootTwo) }

    // A step-6-era project line in project one: written through a store on its directory, as step 6 did.
    const planted = kernel.applyImproverChange(kernel.IMPROVER_V0, { op: 'set-comparison-param', param: 'repeats', value: 3 })
    const oldLine = new capabilities.ImproverStore(capabilities.improversDir({ dataDir: join(rootOne, '.nexgent') }))
    const plantedWrite = await oldLine.write(planted)
    await oldLine.adopt(plantedWrite.version, { jobId: '11111111-1111-4111-8111-111111111111' })
    const projectView = capabilities.ImproverStore.project(kernel.resolveWorkspaceLayout(rootOne))
    out.projectLine = {
      planted: plantedWrite.version,
      scope: projectView.scope,
      readOnly: projectView.readOnly,
      resolved: (await projectView.resolve().catch(error => ({ version: `error: ${errorText(error)}` }))).version,
      write: (await attempt(() => projectView.write(kernel.IMPROVER_V0))).code ?? 'accepted',
      adopt: (await attempt(() => projectView.adopt(plantedWrite.version, { jobId: '22222222-2222-4222-8222-222222222222' }))).code ?? 'accepted',
    }

    // The child in the user's line.
    const store = capabilities.ImproverStore.user({ home })
    const child = kernel.applyImproverChange(kernel.IMPROVER_V0, changeFor(META_PLAYBOOKS.find(p => p.id === 'improve-the-improver'), kernel.IMPROVER_V0))
    const written = await store.write(child)
    await store.adopt(written.version, { jobId: '33333333-3333-4333-8333-333333333333' })
    out.child = written.version

    sdkOne = createStep5Sdk(pkgs, { env: envOf(p1.server, home), home })
    sdkTwo = createStep5Sdk(pkgs, { env: envOf(p2.server, home), home })
    const { projectId: idOne } = await sdkOne.call('projects.open', { root: rootOne, create: true })
    const { projectId: idTwo } = await sdkTwo.call('projects.open', { root: rootTwo, create: true })
    const job = async (sdk, root, id, session, label) => {
      log(`shared: ${label}`)
      const done = await explicitJob(pkgs, sdk, root, id, session)
      const files = done.id === undefined ? {} : await jobFiles(root, done.id)
      return { ...done, improverScope: files.job?.improverScope }
    }
    out.jobs = {}
    out.jobs.oneOnChild = await job(sdkOne, rootOne, idOne, p1.session, 'job in project one on the child')
    out.jobs.twoOnChild = await job(sdkTwo, rootTwo, idTwo, p2.session, 'job in project two (sharing off) on the child')
    const back = await store.rollback({ trigger: 'manual', reason: 'accept-step6 H19: back to v0 for every project' })
    out.rollback = { revision: back?.revision?.revision, version: back?.revision?.version, inForce: (await store.activation()).version }
    out.jobs.oneAfterRollback = await job(sdkOne, rootOne, idOne, p1.session, 'job in project one after the rollback')
    out.jobs.twoAfterRollback = await job(sdkTwo, rootTwo, idTwo, p2.session, 'job in project two after the rollback')
    await sleep(500)
    const queue = await pkgs.evolve.readUserQueue(home).catch(() => undefined)
    out.queue = { counted: [...(queue?.counted ?? [])], pending: (queue?.pending ?? []).map(entry => ({ projectId: entry.projectId, jobId: entry.jobId })) }

    // An explicit meta job of project one reads project one only (project two does not share).
    log('shared: explicit meta job probing project two')
    one.probe = { outside: out.projectIds.two, inside: out.projectIds.one }
    const meta = await metaJob(pkgs, sdkOne, rootOne, idOne)
    out.probe = {
      metaJobId: meta.id,
      status: meta.status,
      batch: (meta.files?.job?.meta?.batch ?? []).map(entry => entry.projectId),
      outsideProjectId: one.probe.outside,
      insideProjectId: one.probe.inside,
      toolResults: one.toolResults.filter(r => r.name === 'improve_list_jobs').map(r => ({ projectId: r.input?.projectId, isError: r.isError, text: r.text.slice(0, 600) })),
    }
    out.sdkProjectIds = { one: idOne, two: idTwo }
    out.ledger = {}
    for (const [label, root] of [['one', rootOne], ['two', rootTwo]]) {
      const facts = await versionFacts(pkgs, root)
      out.ledger[label] = facts.ledger.filter(r => r.type === 'improvement.end').map(r => ({ improvementId: r.improvementId, improverVersion: r.improverVersion, improverScope: r.improverScope }))
    }
    out.projectLineAfter = await homeImprovers(join(rootOne, '.nexgent'))
    out.userLine = await userLine(capabilities, home)
  } finally {
    await sdkOne?.dispose()
    await sdkTwo?.dispose()
    await killAll(pkgs, rootOne)
    await killAll(pkgs, rootTwo)
    for (const server of servers) await server.close()
  }
  return out
}

// ---- literal (H20, H23) ---------------------------------------------------------------------

export async function literalPhase(h, pkgs, capabilities, work, log) {
  const kernel = pkgs.kernel
  const root = join(work, 'project')
  const figure = literalIn(kernel, outputFor(FEEDBACK_TASK).split('\n').slice(1).join('\n'), 'decimal')
  const model = new ReworkModel(h, { root, kernel, figure, playbooks: ['literal', 'late-literal'] })
  const out = { figure, constant: BULK_CONSTANT, lateValue: LATE_VALUE }
  // The constant in three task messages and in one feedback comment.
  const tasks = [...HISTORY_TASKS, FEEDBACK_TASK].map((task, i) => (i === 0 ? task : { ...task, ask: `${task.ask} ${BULK_SENTENCE}` }))
  const feedback = FEEDBACK.map(entry => (entry.key === 'first' ? { ...entry, comment: `${entry.comment}（${BULK_CONSTANT} 件以上算大单的规则不变。）` } : entry))
  let server
  let sdk
  try {
    const p = await feedbackProject(h, pkgs, work, model, line => log(`literal: ${line}`), { config: { autoImprove: false }, feedback, tasks })
    server = p.server
    model.phase = 'job'
    sdk = createStep5Sdk(pkgs, { env: envOf(server, p.home), home: p.home })
    const { projectId } = await sdk.call('projects.open', { root, create: true })

    log('literal: job 1 (proposal carries the feedback table\'s figure)')
    const first = await explicitJob(pkgs, sdk, root, projectId, p.session)
    out.first = { ...first, decision: await decisionOf(capabilities, root, (await readImprovements(pkgs, root)).jobs.find(job => job.id === first.id)) }
    out.first.proposals = model.toolResults.filter(r => r.custom === 'literal' && r.name === 'capability_propose').map(r => ({ isError: r.isError, text: r.text, components: r.input?.components }))
    const firstFiles = await jobFiles(root, first.id)
    out.first.candidateId = firstFiles.job?.candidateId

    log('literal: job 2 (a value no source has yet; the user presents it while the proposal ends)')
    const ledgerBefore = (await ledgerOf(root)).length
    const requestsBefore = model.requests.length
    const started = await sdk.call('improvements.run', { projectId, sessionId: p.session })
    out.second = { id: started.id }
    const proposed = await settle(async () => model.toolResults.find(r => r.custom === 'late-literal' && r.name === 'capability_propose'), r => r !== undefined, { timeoutMs: 120_000, intervalMs: 100 })
    out.second.proposal = proposed === undefined ? undefined : { isError: proposed.isError, text: proposed.text }
    out.second.statusAtNote = (await readImprovements(pkgs, root)).jobs.find(job => job.id === started.id)?.status
    await sdk.openSession({ projectId, sessionId: p.session })
    const note = await runTurn(sdk, { projectId, sessionId: p.session, text: `Please ${LATE_MARKER}: write the bulk total ${LATE_VALUE} to ${LATE_NOTE} and present it.` })
    out.second.note = { reason: note.result?.reason?.kind ?? note.result?.reason, error: note.error === undefined ? undefined : errorText(note.error) }
    out.second.statusAfterNote = (await readImprovements(pkgs, root)).jobs.find(job => job.id === started.id)?.status
    const done = await waitJob(pkgs, root, started.id)
    out.second.status = done.status
    out.second.decision = await decisionOf(capabilities, root, done)
    out.second.candidateId = done.candidateId
    out.second.trials = done.candidateId === undefined ? [] : (await capabilities.listTrials(capDir(root), done.candidateId).catch(() => [])).map(t => t.trialId ?? t.id)
    out.second.newTrialRecords = (await ledgerOf(root)).slice(ledgerBefore).filter(r => r.trialId !== undefined).length
    out.second.replayRequests = model.requests.slice(requestsBefore).filter(r => r.kind === 'task' || r.kind === 'feedback-check' || r.kind === 'review').length
    out.second.notePresented = (await sdk.call('deliverables.list', { projectId })).some(d => (d.versions ?? []).some(v => v.sessionId === p.session && JSON.stringify(v).includes('bulk-note')))

    // The rules id the gate judged by, and the epoch it gives (ADR 0013).
    const layout = kernel.resolveWorkspaceLayout(root)
    const settings = kernel.evaluatorSettings((await kernel.readProjectConfig(layout.configFile)).config.capabilities)
    const epochUnder = rules => createHash('sha256').update(kernel.canonicalEvaluatorText({ ...settings, rules }), 'utf8').digest('hex')
    out.rules = { id: settings.rules, projectEpoch: await capabilities.projectEpoch(layout), epoch: epochUnder(settings.rules), epochAdr0008: epochUnder('adr-0008') }
    const firstTrial = out.first.decision?.trialId
    out.rules.firstTrialEpoch = firstTrial === undefined ? undefined : capabilities.trialEpoch(await capabilities.readTrialReceipts(capDir(root), firstTrial).catch(() => []))
  } finally {
    await sdk?.dispose()
    await killAll(pkgs, root)
    await server?.close()
  }
  return out
}

// ---- similar (H21, H22) ---------------------------------------------------------------------

/** History asks in words the feedback task's ask does not share (H22). */
export const UNSHARED_ASKS = {
  'summary-2026-06': '请汇总六月份的订单并展示结果。',
  'summary-2026-07': '请汇总七月份的订单并展示结果。',
  'regions-2026-08': '请按地区整理八月份的订单表并展示。',
}

async function similarCase(h, pkgs, capabilities, dir, log, { name, similarMode, unshared = false }) {
  const kernel = pkgs.kernel
  const root = join(dir, 'project')
  const askMap = unshared ? HISTORY_TASKS.map(task => ({ from: UNSHARED_ASKS[task.id], to: task.ask })) : []
  const model = new ReworkModel(h, { root, kernel, playbooks: ['improve'], similarMode, askMap })
  const tasks = unshared ? HISTORY_TASKS.map(task => ({ ...task, ask: UNSHARED_ASKS[task.id] })).concat([FEEDBACK_TASK]) : undefined
  const out = { name }
  let server
  try {
    const p = await feedbackProject(h, pkgs, dir, model, line => log(`similar ${name}: ${line}`), { ...(tasks === undefined ? {} : { tasks }) })
    server = p.server
    model.phase = 'job'
    out.tasks = p.taskSessions
    out.asks = p.project.tasks.map(task => ({ id: task.id, check: task.check?.passed }))
    // autoImprove is on by default: the third counted feedback starts the job.
    const job = await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.trigger === 'feedback-count'), j => j !== undefined, { timeoutMs: 30_000 })
    if (job === undefined) throw new Error('no job started from the feedback')
    const done = await waitJob(pkgs, root, job.id)
    out.job = { id: done.id, status: done.status, history: (done.history ?? []).map(entry => entry.status) }
    out.decision = await decisionOf(capabilities, root, done)
    out.similarReplays = model.similarReplays.length
    // Trial runs name cases by task id (the root task snapshot's taskId), not by session id.
    const snapDir = join(root, '.nexgent', 'snapshots', 'tasks')
    const snapshots = await Promise.all((await readdir(snapDir).catch(() => [])).filter(name => /^[^.]+\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(snapDir, name), 'utf8'))))
    const taskIdOf = sessionId => snapshots.find(snapshot => snapshot.sessionId === sessionId)?.taskId
    out.taskIds = Object.fromEntries(Object.entries(p.taskSessions).map(([sessionId, label]) => [label, taskIdOf(sessionId)]))
    out.feedbackTaskCase = out.taskIds[FEEDBACK_TASK.id]
    out.similarTaskCase = out.taskIds['regions-2026-08']
  } finally {
    await killAll(pkgs, root)
    await server?.close()
  }
  return out
}

export async function similarPhase(h, pkgs, capabilities, work, log) {
  const out = {}
  for (const [name, options] of [['fail', { similarMode: 'fail' }], ['unknown', { similarMode: 'unknown' }], ['none', { unshared: true }]]) {
    const dir = join(work, name)
    await mkdir(dir, { recursive: true })
    try {
      out[name] = await similarCase(h, pkgs, capabilities, dir, log, { name, ...options })
    } catch (error) {
      out[name] = { name, error: errorText(error) }
    }
  }
  return out
}

// ---- metaLiteral (H24) ----------------------------------------------------------------------

export async function metaLiteralPhase(h, pkgs, capabilities, work, log) {
  const kernel = pkgs.kernel
  const root = join(work, 'project')
  const figure = literalIn(kernel, outputFor(FEEDBACK_TASK).split('\n').slice(1).join('\n'), 'decimal')
  const model = new ReworkModel(h, { root, kernel, figure, playbooks: ['not-capability'], metaDiagnose: ['change'], metaPropose: ['literal'] })
  model.parentParagraphs = kernel.IMPROVER_V0.diagnosis.paragraphs
  const out = { figure }
  let server
  let sdk
  try {
    const p = await feedbackProject(h, pkgs, work, model, line => log(`meta literal: ${line}`))
    server = p.server
    model.phase = 'job'
    const source = await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.trigger === 'feedback-count'), j => j !== undefined, { timeoutMs: 30_000 })
    if (source === undefined) throw new Error('no job started from the feedback')
    out.source = { id: source.id, status: (await waitJob(pkgs, root, source.id)).status }
    await sleep(500)
    sdk = createStep5Sdk(pkgs, { env: envOf(server, p.home), home: p.home })
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    out.lineBefore = await userLine(capabilities, p.home)
    log('meta literal: explicit meta job')
    const meta = await metaJob(pkgs, sdk, root, projectId)
    out.meta = { id: meta.id, status: meta.status, code: meta.code, change: meta.files?.change, batch: (meta.files?.job?.meta?.batch ?? []).map(entry => entry.jobId) }
    const refusals = model.toolResults.filter(r => r.custom === 'literal' && r.name === 'improve_propose_change')
    out.refusal = refusals[0] === undefined ? undefined : { isError: refusals[0].isError, text: refusals[0].text }
    out.proposals = model.requests.filter(r => r.kind === 'meta-propose' && r.playbook === 'literal').length
    out.lineAfter = await userLine(capabilities, p.home)
    out.bundlesAfter = (await readdir(join(p.home, 'improvers', 'bundles')).catch(() => [])).length
  } finally {
    await sdk?.dispose()
    await killAll(pkgs, root)
    await server?.close()
  }
  return out
}

/**
 * @returns `{ shared, literal, similar, metaLiteral, errors }`; a phase that crashes is recorded under `errors.<phase>`.
 */
export async function runStep6Rework(h, work, { log = () => undefined } = {}) {
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
    obs.shared = await phase('shared', dir => sharedPhase(h, pkgs, capabilities, dir, log))
    obs.literal = await phase('literal', dir => literalPhase(h, pkgs, capabilities, dir, log))
    obs.similar = await phase('similar', dir => similarPhase(h, pkgs, capabilities, dir, log))
    obs.metaLiteral = await phase('metaLiteral', dir => metaLiteralPhase(h, pkgs, capabilities, dir, log))
  } finally {
    restore()
  }
  return obs
}
