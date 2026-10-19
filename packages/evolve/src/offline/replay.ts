/**
 * The product evaluator of a layer-3 run (ADR 0026 decision 7, ADR 0027):
 * each practice case replays in a throw-away copy of its input snapshot with
 * the candidate as the copy's execution profile, and is scored from the copy
 * by the external reviewer on the case's frozen rubric.
 *
 * - **Copy**: the source project's snapshot tree, config and materials as
 *   the gate's replay copy writes them (`prepareReplayProject`), on the
 *   source project's adopted capability version, with
 *   `offline-candidate.json` holding the candidate. The starting version is
 *   scored the same way, so both arms differ only in the candidate.
 * - **Run**: the gate's runner (the product runs each replay in its own
 *   process), sending the task's user messages up to the evaluated turn in
 *   one new session; approvals are denied, nobody is asked. Its records go
 *   to the run's own ledger (`<run>/ledgers/`), never to the project's.
 * - **Score**: the checks the copy's kernel recorded for the run plus the
 *   generic checks, and the external reviewer's scores on the case's rubric
 *   with the same prompt the self-evaluator's calibration uses; the score is
 *   `combineScore` (the mean of the check pass rate and the rubric score).
 *   The feedback the proposal reads is the reviewer's note per rubric item
 *   and the failed checks. A case without a rubric, a run that did not
 *   finish, or a reviewer without usable scores is an unknown result (0).
 *
 * Nothing here names a kind of task.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  combineScore,
  layoutOfDataDir,
  perTurnFileName,
  resolveProjectLayout,
  resolveProjectDataLayout,
  resolveUserDataLayout,
  resolveWorkspaceLayout,
  SNAPSHOTS_DIR,
  type CapabilityVersion,
  type CostCap,
  type OfflineCandidate,
  type PracticeCase,
  type Rubric,
  type RubricScore,
  type SessionRecord,
  type SnapshotTree,
  type TaskCheck,
  type TaskChecksRecord,
  type TaskSnapshotRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import {
  CapabilityStore,
  fileText,
  genericChecks,
  handbookProjectId,
  listPracticeCases,
  parseScores,
  prepareReplayProject,
  readEvaluation,
  evaluationsDirectory,
  runOutput,
  scorePrompt,
  SELF_EVAL_PROMPT_LIMITS,
  type DocumentText,
  type ReplayCase,
  type ReplayProject,
  type RunOutput,
  type TrialRunner,
} from '@nexgent/capabilities'
import { JsonlSessionStore } from '@nexgent/session'
import { offlineRunDirectory } from './engine.js'
import { ReplayPracticeEvaluator, type PracticeRunOutcome } from './evaluator.js'

/** One request to the external reviewer. */
export interface OfflineScorerRequest {
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  readonly signal: AbortSignal
}

/** The external reviewer of a run: one scoring request, priced. */
export interface OfflineScorer {
  score(request: OfflineScorerRequest): Promise<{ readonly text: string; readonly usd: number | 'unknown'; readonly failure?: string }>
}

/** Options of {@link practiceReplayEvaluator}. */
export interface PracticeReplayOptions {
  readonly home: string
  readonly runId: string
  /** The gate's runner (the product: one process per replay). */
  readonly runner: TrialRunner
  readonly scorer: OfflineScorer
  /** Deadline of one replay (default 30 minutes). */
  readonly timeoutMs?: number
  /** Per-task cap of a replay (default: the source project's own). */
  readonly perRunCap?: CostCap
  /** Dollars counted for a run or a review whose price is unknown (default `OFFLINE_LIMITS.defaultUsdPerRun`). */
  readonly unknownUsd?: number
  readonly documentText?: DocumentText
  /** Parent directory of the copies (default the OS temporary directory). */
  readonly tempRoot?: string
  /** Where a case's project is (default {@link locatePracticeProject}). */
  readonly locate?: (projectId: string) => Promise<WorkspaceLayout | undefined>
}

/** Where a practice case came from, and how to replay it. */
export interface PracticeSource {
  readonly layout: WorkspaceLayout
  readonly replay: ReplayCase
  readonly version: CapabilityVersion
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_UNKNOWN_USD = 0.5

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * The source project's layout of a case: its data directory by id, else a
 * project of the user's data directory or of the recent-projects list whose
 * id it is (a project that keeps its data inside itself).
 */
export async function locatePracticeProject(home: string, projectId: string): Promise<WorkspaceLayout | undefined> {
  const direct = layoutOfDataDir(resolveProjectDataLayout(home, projectId).dataDir)
  if (direct !== undefined) return direct
  const user = resolveUserDataLayout(home)
  const candidates: WorkspaceLayout[] = []
  for (const name of await readdir(user.projects).catch(() => [] as string[])) {
    const layout = layoutOfDataDir(join(user.projects, name))
    if (layout !== undefined) candidates.push(layout)
  }
  const recent = (await readJson(user.recentProjectsFile)) as { projects?: unknown } | undefined
  const entries = Array.isArray(recent?.projects) ? (recent.projects as readonly { root?: unknown }[]) : []
  for (const entry of entries) {
    if (typeof entry?.root !== 'string') continue
    try {
      candidates.push(resolveProjectLayout(entry.root, { home }))
    } catch {
      // A recent project that is gone or not absolute.
    }
  }
  for (const layout of candidates) {
    if ((await handbookProjectId(layout.root).catch(() => undefined)) === projectId) return layout
  }
  return undefined
}

/**
 * How to replay a practice case: its project, snapshot, user messages up to
 * the evaluated turn, and the project's adopted version.
 * @throws `Error` naming what is missing.
 */
export async function practiceSource(home: string, practiceCase: PracticeCase, locate: (projectId: string) => Promise<WorkspaceLayout | undefined> = id => locatePracticeProject(home, id)): Promise<PracticeSource> {
  const { projectId, taskId, sessionId, input } = practiceCase
  if (projectId === undefined || taskId === undefined || sessionId === undefined || input === undefined) throw new Error('the case is not a task case with an input snapshot')
  const layout = await locate(projectId)
  if (layout === undefined) throw new Error(`its project ${projectId} is not on this computer`)
  const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
  let snapshot: TaskSnapshotRecord | undefined
  for (const name of [perTurnFileName(taskId, 1), `${taskId}.json`]) {
    const value = (await readJson(join(snapshots, 'tasks', name))) as TaskSnapshotRecord | undefined
    if (value?.taskId === taskId) {
      snapshot = value
      break
    }
  }
  if (snapshot === undefined) throw new Error(`the task's snapshot record is gone`)
  const evaluation = await readEvaluation(evaluationsDirectory(layout), taskId)
  let records: readonly SessionRecord[]
  try {
    records = (await new JsonlSessionStore({ sessionsDir: layout.sessions }).readAll(sessionId)).records
  } catch {
    throw new Error(`the task's session is unreadable`)
  }
  const turn = evaluation?.turn
  const messages = records.flatMap(record =>
    record.type === 'user.message' && record.source === 'user' && (turn === undefined || record.turn <= turn)
      ? [{ text: record.content, ...(record.materials === undefined || record.materials.length === 0 ? {} : { materialIds: [...record.materials] }) }]
      : [])
  if (messages.length === 0) throw new Error('the task has no user message to replay')
  const version = (await new CapabilityStore(layout.capabilities).chain()).activation.version
  return {
    layout,
    version,
    replay: { caseId: taskId, sessionId, tree: input.tree, checks: [], takenAt: snapshot.takenAt, messages, feedback: [], ...(turn === undefined ? {} : { throughTurn: turn }) },
  }
}

/** The input files a reviewer sees (files the messages name first), from the source snapshot. */
async function snapshotInputs(layout: WorkspaceLayout, tree: string, messages: readonly string[], documentText: DocumentText): Promise<RunOutput> {
  const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
  const value = (await readJson(join(snapshots, 'trees', `${tree}.json`))) as SnapshotTree | undefined
  if (value === undefined || !Array.isArray(value.files)) return { files: [] }
  const said = messages.join('\n')
  const named = (path: string) => said.includes(path) || said.includes(path.slice(path.lastIndexOf('/') + 1))
  const paths = value.files.map(file => file.path).filter(path => !path.startsWith('.nexgent/')).sort((left, right) => Number(named(right)) - Number(named(left)) || (left < right ? -1 : left > right ? 1 : 0))
  const byPath = new Map(value.files.map(file => [file.path, file.sha256]))
  const files: { path: string; text: string }[] = []
  for (const path of paths.slice(0, SELF_EVAL_PROMPT_LIMITS.inputFiles)) {
    const bytes = await readFile(join(snapshots, 'objects', byPath.get(path)!)).catch(() => undefined)
    if (bytes !== undefined) files.push({ path, text: await fileText(path, bytes, documentText, SELF_EVAL_PROMPT_LIMITS.inputFileChars) })
  }
  const rest = paths.slice(SELF_EVAL_PROMPT_LIMITS.inputFiles)
  return { files, ...(rest.length === 0 ? {} : { unshown: rest.slice(0, 100) }) }
}

/** The copy's root session: its final answer and the checks its kernel recorded at its last turn. */
async function copyRun(root: string): Promise<{ readonly answer: string; readonly checks: TaskCheck[] }> {
  const layout = resolveWorkspaceLayout(root)
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  let answer = ''
  let sessionId: string | undefined
  for (const name of (await readdir(layout.sessions).catch(() => [] as string[])).sort()) {
    const records = await store.readAll(name).then(result => result.records, () => [] as readonly SessionRecord[])
    const start = records[0]
    if (start?.type !== 'session.start' || start.parentSessionId !== undefined) continue
    sessionId = name
    for (const record of records) if (record.type === 'assistant.message' && record.content.trim() !== '') answer = record.content
  }
  const checksDir = join(layout.dataDir, SNAPSHOTS_DIR, 'checks')
  let best: { readonly turn: number; readonly record: TaskChecksRecord } | undefined
  for (const name of await readdir(checksDir).catch(() => [] as string[])) {
    const record = (await readJson(join(checksDir, name))) as TaskChecksRecord | undefined
    if (record === undefined || !Array.isArray(record.results) || (sessionId !== undefined && record.sessionId !== sessionId)) continue
    const turn = record.turn ?? 0
    if (best === undefined || turn > best.turn) best = { turn, record }
  }
  return { answer, checks: [...(best?.record.results ?? [])] }
}

/** The proposal's feedback: each rubric item with its score and the reviewer's note, then the failed checks. */
export function scoreFeedback(rubric: Pick<Rubric, 'items'>, scores: readonly RubricScore[], checks: readonly TaskCheck[]): string {
  const lines = rubric.items.map(item => {
    const scored = scores.find(score => score.itemId === item.id)
    const mark = scored === undefined ? 'not scored' : scored.score === 1 ? 'met' : scored.score === 0.5 ? 'partly met' : 'not met'
    return `- ${item.text}: ${mark}${scored?.note === undefined ? '' : ` (${scored.note})`}`
  })
  const failed = checks.filter(check => !check.passed).map(check => `- check ${check.name} failed${check.detail === undefined ? '' : `: ${check.detail}`}`)
  return [...lines, ...failed].join('\n')
}

/** The product evaluator of one offline run (see the module comment). */
export function practiceReplayEvaluator(options: PracticeReplayOptions): ReplayPracticeEvaluator {
  const unknownUsd = options.unknownUsd ?? DEFAULT_UNKNOWN_USD
  const priced = (usd: number | 'unknown' | undefined) => (typeof usd === 'number' && Number.isFinite(usd) ? usd : unknownUsd)
  let cases: Promise<Map<string, PracticeCase>> | undefined
  const copies = new Map<string, { readonly source: PracticeSource; readonly project: ReplayProject }>()
  const ledgersDir = join(offlineRunDirectory(options.home, options.runId), 'ledgers')
  return new ReplayPracticeEvaluator({
    practiceCase: async caseId => {
      cases ??= listPracticeCases(options.home, { audience: 'measure' }).then(all => new Map(all.map(item => [item.id, item])))
      return (await cases).get(caseId)
    },
    prepare: async (practiceCase, candidate: OfflineCandidate) => {
      const source = await practiceSource(options.home, practiceCase, options.locate)
      const project = await prepareReplayProject({
        layout: source.layout,
        replay: source.replay,
        version: source.version,
        budget: options.perRunCap ?? {},
        profile: candidate,
        ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
      })
      copies.set(project.root, { source, project })
      return {
        projectRoot: project.root,
        dispose: async () => {
          copies.delete(project.root)
          await project.dispose()
        },
      }
    },
    run: async ({ practiceCase, projectRoot, repeat, signal }): Promise<PracticeRunOutcome> => {
      const copy = copies.get(projectRoot)
      if (copy === undefined) return { outcome: 'error', detail: 'the copy is gone' }
      const result = await options.runner.run({
        trialId: options.runId,
        arm: 'candidate',
        set: practiceCase.split === 'guard' ? 'guard' : 'selection',
        caseId: practiceCase.id,
        repeat,
        projectRoot,
        ledgersDir,
        messages: copy.source.replay.messages,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }, signal)
      const { answer } = await copyRun(projectRoot)
      return { outcome: result.outcome, ...(result.detail === undefined ? {} : { detail: result.detail }), usd: priced(result.estimatedUsd), ...(answer === '' ? {} : { output: answer.slice(0, 1500) }) }
    },
    score: async ({ practiceCase, projectRoot, signal }) => {
      const copy = copies.get(projectRoot)
      if (copy === undefined) throw new Error('the copy is gone')
      const rubric = practiceCase.rubric
      if (rubric === undefined) throw new Error('the case has no rubric to score by')
      const messages = copy.source.replay.messages.map(message => message.text)
      const { answer, checks: recorded } = await copyRun(projectRoot)
      const shown = await runOutput(projectRoot, copy.project.files, options.documentText)
      const outputs: RunOutput = {
        ...shown,
        files: shown.files.slice(0, SELF_EVAL_PROMPT_LIMITS.outputFiles),
        ...(shown.files.length > SELF_EVAL_PROMPT_LIMITS.outputFiles || (shown.unshown ?? []).length > 0 ? { unshown: [...shown.files.slice(SELF_EVAL_PROMPT_LIMITS.outputFiles).map(file => file.path), ...(shown.unshown ?? [])] } : {}),
      }
      const changed = [...shown.files.map(file => file.path), ...(shown.unshown ?? [])]
      const checks = [...recorded, ...(await genericChecks(projectRoot, changed, answer))]
      const inputs = await snapshotInputs(copy.source.layout, copy.source.replay.tree, messages, options.documentText)
      const prompt = scorePrompt(rubric, messages, inputs, outputs, answer, checks)
      const reply = await options.scorer.score({ ...prompt, maxTokens: SELF_EVAL_PROMPT_LIMITS.calibrationTokens, signal })
      const usd = priced(reply.usd)
      const scores = reply.failure === undefined ? parseScores(reply.text, rubric) : undefined
      const score = scores === undefined ? undefined : combineScore(checks, rubric, scores)
      if (scores === undefined || score === undefined) throw Object.assign(new Error(reply.failure ?? 'the reviewer gave no usable scores'), { usd })
      return { score, feedback: scoreFeedback(rubric, scores, checks), usd }
    },
  })
}
