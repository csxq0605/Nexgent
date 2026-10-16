/**
 * The self-evaluator (ADR 0018 decision 2, ADR 0019 decisions 1, 6 and 7).
 * At the end of a root task it records, once:
 *
 * 1. the deterministic checks: the ones the kernel recorded for the turn
 *    (`file-exists`, `parses`, `test-command`) and the generic ones
 *    ({@link genericChecks});
 * 2. when the task is sampled ({@link selfEvalSample}), a rubric written from
 *    the task text and its input files only, never the result, then frozen,
 *    and the execution model's score of the result against it;
 * 3. on a share of the scored tasks, the external reviewer's score with the
 *    same rubric and checks (calibration), whose agreement decides whether
 *    the self-scorer is trusted ({@link scorerReliabilityOf}).
 *
 * The rubric instructions are fixed here (`generator: v0`): no improver or
 * learner rewrites them. Nothing is task-type specific: the same checks,
 * prompts and thresholds apply to any task. Spend stays under the
 * project's per-task ceiling and counts against the learning budget
 * (ledger `learningPhase`), never against the task's own caps.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  addUsage,
  CALIBRATION_SAMPLE_RATE,
  combineScore,
  LEARNING_RULES,
  perTurnFileName,
  rubricScore,
  SELF_EVAL_LIMITS,
  selfEvalOutcome,
  selfEvalSample,
  SNAPSHOTS_DIR,
  ZERO_USAGE,
  type LearningConfig,
  type LearningCost,
  type LLMProvider,
  type LLMUsage,
  type Rubric,
  type RubricItem,
  type RubricScore,
  type SelfEvalCalibration,
  type SelfEvaluation,
  type SessionRecord,
  type SnapshotTree,
  type TaskCheck,
  type TaskChecksRecord,
  type TaskSnapshotRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore, validateCapabilityFile } from '@nexgent/session'
import { randomUUID } from 'node:crypto'
import { CapabilityStore } from '../capability-store.js'
import { handbookProjectId } from '../handbook/handbook.js'
import { isTrialCopy } from '../handbook/host.js'
import { fileText, runOutput, type DocumentText, type RunOutput } from '../trial/gate.js'
import { genericChecks } from './generic-checks.js'
import { evaluationsDirectory, readEvaluation, recordCalibration, recordEvaluationFeedback, withFeedback, writeEvaluation } from './evaluations.js'
import { addPracticeCase } from './practice.js'

/** Version of the rubric instructions below; fixed (ADR 0019 decision 7). */
export const RUBRIC_GENERATOR = 'v0'
/** Default external reviewer of calibrations. */
export const CALIBRATION_MODEL = 'claude-opus-5-5'

/** Prompt bounds: they keep one evaluation well under the default per-task ceiling. */
export const SELF_EVAL_PROMPT_LIMITS = {
  /** Characters of the task's messages shown. */
  taskChars: 6_000,
  /** Input files shown, and characters of each. */
  inputFiles: 6,
  inputFileChars: 1_500,
  /** Result files shown, and characters of each. */
  outputFiles: 6,
  outputFileChars: 2_000,
  /** Characters of the final answer shown. */
  answerChars: 3_000,
  /** Output tokens of the rubric and of a scoring request. */
  rubricTokens: 900,
  scoreTokens: 1_200,
  /** Output tokens of a calibration (with reasoning). */
  calibrationTokens: 6_000,
} as const

/** One request of the self-evaluator. */
export interface SelfEvalRequest {
  /** `self-eval` (rubric and self-score) or `calibrate` (external score). */
  readonly phase: 'self-eval' | 'calibrate'
  readonly model: string
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  /** Reasoning: off for the self-scorer (cheap); on for the external reviewer (models without a no-thinking mode). */
  readonly thinking: 'off' | 'on'
  /** Effort; the provider's default when absent. */
  readonly effort?: 'low' | 'medium' | 'high'
  /** The task learned from (ledger `taskId`). */
  readonly taskId: string
  readonly signal?: AbortSignal
}

/** Its answer. */
export interface SelfEvalReply {
  readonly text: string
  readonly usage: LLMUsage
  readonly estimatedUsd: number | 'unknown'
  /** Set when the request failed. */
  readonly failure?: string
}

/**
 * The model the self-evaluator talks to. The host builds it so that every
 * request is an auxiliary one with `learningPhase` (= `phase`) and `taskId`
 * on its ledger records ({@link providerSelfEvalModel}).
 */
export interface SelfEvalModel {
  complete(request: SelfEvalRequest): Promise<SelfEvalReply>
}

/**
 * Whether a request failure is the model refusing `thinking: off` (HTTP 400
 * naming the thinking parameter): some models have no no-reasoning mode.
 * Callers that asked with reasoning off then ask again with it on.
 */
export function rejectsThinkingOff(failure: string | undefined): boolean {
  return failure !== undefined && /\b400\b/.test(failure) && /thinking/i.test(failure)
}

/**
 * A {@link SelfEvalModel} over kernel providers: `providerFor` returns the
 * provider whose ledger stamps `{ learningPhase, taskId }`.
 */
export function providerSelfEvalModel(options: {
  readonly providerFor: (attribution: { readonly learningPhase: 'self-eval' | 'calibrate'; readonly taskId: string; readonly model: string }) => LLMProvider
  readonly estimateUsd: (model: string, usage: LLMUsage) => number | 'unknown'
  readonly timeoutMs?: number
}): SelfEvalModel {
  return {
    async complete(request) {
      const provider = options.providerFor({ learningPhase: request.phase, taskId: request.taskId, model: request.model })
      const send = async (thinking: 'off' | 'on', effort: SelfEvalRequest['effort']) => {
        let text = ''
        let usage: LLMUsage | undefined
        let failure: string | undefined
        try {
          for await (const event of provider.complete({
            requestId: randomUUID(),
            model: request.model,
            thinking,
            ...(effort === undefined ? {} : { effort }),
            maxTokens: request.maxTokens,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }, { purpose: 'auxiliary', ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })) {
            if (event.type === 'text.delta') text += event.text
            else if (event.type === 'usage') usage = event.usage
            else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        return { text, usage, failure }
      }
      let reply = await send(request.thinking, request.effort)
      // A model without a no-reasoning mode refuses `thinking: off` before any work (nothing billed): ask again with reasoning at low effort.
      if (request.thinking === 'off' && rejectsThinkingOff(reply.failure)) reply = await send('on', 'low')
      const used = reply.usage ?? { ...ZERO_USAGE, inputTokens: 'unknown', outputTokens: 'unknown' }
      return { text: reply.text, usage: used, estimatedUsd: options.estimateUsd(request.model, used), ...(reply.failure === undefined ? {} : { failure: reply.failure.slice(0, 500) }) }
    },
  }
}

const RUBRIC_SYSTEM = [
  'You write the grading rubric for one task an AI agent was given. You see the task (the user\'s messages) and the files the project had when the task started; you never see the result.',
  'Write 3 to 8 items. Each item is one property a good result of this task must have, stated so that someone looking at the result and the project files can check it.',
  'Cover what the user asked for, explicitly or by clear implication: the requested outputs, the facts and numbers they must agree with, constraints the user set. Do not add requirements the user did not state or clearly imply, and do not grade wording or style unless the user asked about it.',
  'Make every item one that a plausible but flawed attempt could fail. Leave out what nearly any attempt meets (keeping names, valid syntax, no unrelated edits) unless the user asked for it. Where the task and its files determine an expected value, count or case, name it in the item so it can be checked directly.',
  'Write each item as one sentence of at most 300 characters, in the language the user wrote in. Weight 3: the task fails without it; 2: important; 1: minor.',
  'Answer with only this JSON object: {"items":[{"text":"...","weight":2}]}',
].join('\n')

const SCORE_SYSTEM = [
  'You grade the result of a task an AI agent did against a fixed rubric. You see the task, the files the project had at the start, the result files, the agent\'s final answer and the outcome of deterministic checks.',
  'For every rubric item give 1 when the result meets it, 0.5 when it meets it partly or what is shown does not let you verify it, 0 when it does not meet it. Judge only from what is shown; a claim in the final answer that the files do not support does not meet an item.',
  'Give each score a note of at most one sentence on why, in the language the user wrote in.',
  'Answer with only this JSON object: {"scores":[{"id":"r1","score":1,"note":"..."}]}',
].join('\n')

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}\n…(truncated)` : text
}

function jsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}

/** The rubric items of a model answer (`r1`, `r2`, …), or `undefined`. */
export function parseRubric(text: string): RubricItem[] | undefined {
  const value = jsonObject(text) as { items?: unknown } | undefined
  if (value === undefined || !Array.isArray(value.items)) return undefined
  const items: RubricItem[] = []
  for (const raw of value.items as unknown[]) {
    if (items.length >= SELF_EVAL_LIMITS.maxRubricItems) break
    const item = raw as { text?: unknown; weight?: unknown }
    if (typeof item?.text !== 'string') continue
    const itemText = item.text.trim().slice(0, SELF_EVAL_LIMITS.maxRubricItemChars)
    if (itemText === '') continue
    const weight = item.weight === 2 || item.weight === 3 ? item.weight : 1
    items.push({ id: `r${items.length + 1}`, text: itemText, ...(weight === 1 ? {} : { weight }) })
  }
  return items.length === 0 ? undefined : items
}

/** The scores of a model answer for `rubric` (one per item, unknown ids dropped), or `undefined` when an item is missing. */
export function parseScores(text: string, rubric: Pick<Rubric, 'items'>): RubricScore[] | undefined {
  const value = jsonObject(text) as { scores?: unknown } | undefined
  if (value === undefined || !Array.isArray(value.scores)) return undefined
  const byId = new Map<string, RubricScore>()
  for (const raw of value.scores as unknown[]) {
    const item = raw as { id?: unknown; score?: unknown; note?: unknown }
    if (typeof item?.id !== 'string' || !rubric.items.some(entry => entry.id === item.id) || byId.has(item.id)) continue
    const score = item.score === 1 || item.score === 0.5 || item.score === 0 ? item.score : undefined
    if (score === undefined) continue
    const note = typeof item.note === 'string' ? item.note.trim().slice(0, SELF_EVAL_LIMITS.maxNoteChars) : ''
    byId.set(item.id, { itemId: item.id, score, ...(note === '' ? {} : { note }) })
  }
  if (byId.size !== rubric.items.length) return undefined
  return rubric.items.map(item => byId.get(item.id)!)
}

/** What the evaluator reads of a finished task. */
interface TaskView {
  readonly messages: readonly string[]
  readonly answer: string
  readonly feedbackIds: readonly string[]
  readonly rating?: 1 | 2 | 3 | 4 | 5
  readonly inputs: RunOutput
  readonly before: ReadonlyMap<string, string>
  readonly tree?: string
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** The task's start snapshot (turn 1, else the step-4 file). */
async function startSnapshot(snapshots: string, taskId: string): Promise<TaskSnapshotRecord | undefined> {
  for (const name of [perTurnFileName(taskId, 1), `${taskId}.json`]) {
    const value = await readJson(join(snapshots, 'tasks', name))
    if (value !== undefined && validateCapabilityFile('taskSnapshot', value).length === 0 && (value as TaskSnapshotRecord).taskId === taskId) return value as TaskSnapshotRecord
  }
  return undefined
}

/** The checks recorded at the end of `turn` (else the step-4 file). */
async function recordedChecks(snapshots: string, taskId: string, turn: number): Promise<TaskCheck[]> {
  for (const name of [perTurnFileName(taskId, turn), `${taskId}.json`]) {
    const value = await readJson(join(snapshots, 'checks', name))
    if (value !== undefined && validateCapabilityFile('taskChecks', value).length === 0 && (value as TaskChecksRecord).taskId === taskId) return [...(value as TaskChecksRecord).results]
  }
  return []
}

async function snapshotInputs(snapshots: string, tree: string, messages: readonly string[], documentText: DocumentText): Promise<{ inputs: RunOutput; before: Map<string, string> }> {
  const value = await readJson(join(snapshots, 'trees', `${tree}.json`))
  const before = new Map<string, string>()
  if (value === undefined || validateCapabilityFile('snapshotTree', value).length > 0) return { inputs: { files: [] }, before }
  for (const file of (value as SnapshotTree).files) before.set(file.path, file.sha256)
  const said = messages.join('\n')
  const named = (path: string) => said.includes(path) || said.includes(path.slice(path.lastIndexOf('/') + 1))
  const paths = [...before.keys()].filter(path => !path.startsWith('.nexgent/')).sort((left, right) => Number(named(right)) - Number(named(left)) || (left < right ? -1 : left > right ? 1 : 0))
  const files: { path: string; text: string }[] = []
  for (const path of paths.slice(0, SELF_EVAL_PROMPT_LIMITS.inputFiles)) {
    const bytes = await readFile(join(snapshots, 'objects', before.get(path)!)).catch(() => undefined)
    if (bytes !== undefined) files.push({ path, text: await fileText(path, bytes, documentText, SELF_EVAL_PROMPT_LIMITS.inputFileChars) })
  }
  const rest = paths.slice(SELF_EVAL_PROMPT_LIMITS.inputFiles)
  return { inputs: { files, ...(rest.length === 0 ? {} : { unshown: rest.slice(0, 100) }) }, before }
}

function taskView(records: readonly SessionRecord[], turn: number): Omit<TaskView, 'inputs' | 'before' | 'tree'> | undefined {
  const start = records[0]
  if (start?.type !== 'session.start' || start.parentSessionId !== undefined || start.purpose === 'improvement') return undefined
  const messages: string[] = []
  let answer = ''
  const feedbackIds: string[] = []
  let rating: 1 | 2 | 3 | 4 | 5 | undefined
  for (const record of records) {
    if (record.type === 'user.message' && record.turn <= turn && (record.source === 'user' || record.source === 'feedback')) messages.push(record.content)
    else if (record.type === 'assistant.message' && record.turn <= turn && record.content.trim() !== '') answer = record.content
    else if (record.type === 'feedback') {
      feedbackIds.push(record.feedback.id)
      if (record.feedback.rating !== undefined) rating = record.feedback.rating as 1 | 2 | 3 | 4 | 5
    }
  }
  return { messages, answer, feedbackIds, ...(rating === undefined ? {} : { rating }) }
}

function renderFiles(title: string, output: RunOutput, chars: number): string {
  const parts = [`# ${title}`]
  if (output.files.length === 0 && (output.unshown ?? []).length === 0) parts.push('(none)')
  for (const file of output.files) parts.push(`## ${file.path}\n${clip(file.text, chars)}`)
  if ((output.unshown ?? []).length > 0) parts.push(`Other files (not shown): ${output.unshown!.join(', ')}${output.unlisted === undefined ? '' : ` and ${output.unlisted} more`}`)
  if ((output.removed ?? []).length > 0) parts.push(`Removed files: ${output.removed!.join(', ')}`)
  return parts.join('\n\n')
}

function renderTask(messages: readonly string[]): string {
  return `# Task\n${clip(messages.map((message, index) => `Message ${index + 1}:\n${message}`).join('\n\n'), SELF_EVAL_PROMPT_LIMITS.taskChars)}`
}

/** The rubric request (task and inputs only). */
export function rubricPrompt(messages: readonly string[], inputs: RunOutput): { readonly system: string; readonly user: string } {
  return { system: RUBRIC_SYSTEM, user: `${renderTask(messages)}\n\n${renderFiles('Project files at the start', inputs, SELF_EVAL_PROMPT_LIMITS.inputFileChars)}` }
}

/** The scoring request (the same for the self-scorer and the external reviewer). */
export function scorePrompt(rubric: Pick<Rubric, 'items'>, messages: readonly string[], inputs: RunOutput, outputs: RunOutput, answer: string, checks: readonly TaskCheck[]): { readonly system: string; readonly user: string } {
  const checkLines = checks.length === 0 ? '(none)' : checks.map(check => `- ${check.name}: ${check.passed ? 'passed' : 'failed'}${check.detail === undefined ? '' : ` (${check.detail})`}`).join('\n')
  const items = rubric.items.map(item => `- ${item.id} (weight ${item.weight ?? 1}): ${item.text}`).join('\n')
  return {
    system: SCORE_SYSTEM,
    user: [
      renderTask(messages),
      renderFiles('Project files at the start', inputs, SELF_EVAL_PROMPT_LIMITS.inputFileChars),
      renderFiles('Result files (created or changed)', outputs, SELF_EVAL_PROMPT_LIMITS.outputFileChars),
      `# Final answer\n${answer.trim() === '' ? '(none)' : clip(answer, SELF_EVAL_PROMPT_LIMITS.answerChars)}`,
      `# Deterministic checks\n${checkLines}`,
      `# Rubric\n${items}`,
    ].join('\n\n'),
  }
}

/** A running total of spend. */
class Spend {
  usage: LLMUsage = ZERO_USAGE
  requestCount = 0
  usd: number | 'unknown' = 0
  add(reply: SelfEvalReply): void {
    this.usage = addUsage(this.usage, reply.usage)
    this.requestCount += 1
    this.usd = this.usd === 'unknown' || reply.estimatedUsd === 'unknown' ? 'unknown' : this.usd + reply.estimatedUsd
  }
  /** Dollars counted against ceilings: an unknown estimate counts as the whole ceiling. */
  charged(ceiling: number): number {
    return this.usd === 'unknown' ? ceiling : this.usd
  }
  cost(): LearningCost {
    return { usage: this.usage, requestCount: this.requestCount, estimatedUsd: this.usd }
  }
}

/** Options of {@link selfEvaluate}. */
export interface SelfEvaluateOptions {
  readonly layout: WorkspaceLayout
  readonly sessionId: string
  /** Last root turn to evaluate. */
  readonly turn: number
  /** The kernel's task id of the root session; default: found from the task snapshots. */
  readonly taskId?: string
  readonly model: SelfEvalModel
  /** The execution model: writes the rubric and scores. */
  readonly executionModel: string
  readonly learning: Pick<LearningConfig, 'selfEvalMaxUsd' | 'contribute'>
  /** `mayLearn(project, user)`; off: only the deterministic checks are recorded. */
  readonly mayLearn: boolean
  /** Learning budget left in the window (the host's ledger sum). */
  readonly budgetLeftUsd: number
  /** Nexgent home: with `learning.contribute`, a scored task becomes a practice case. */
  readonly home?: string
  readonly projectId?: string
  /** Draws in `[0, 1)` for the random sample and the calibration sample; default `Math.random`. */
  readonly draw?: () => number
  /** Share of scored tasks also calibrated; default {@link CALIBRATION_SAMPLE_RATE}. */
  readonly calibrationRate?: number
  /** Default {@link CALIBRATION_MODEL}. */
  readonly calibrationModel?: string
  /** Worst-case cost of a request before it is sent (prices); without it, ceilings are checked against spend so far. */
  readonly estimateUsd?: (model: string, usage: LLMUsage) => number | 'unknown'
  readonly documentText?: DocumentText
  readonly signal?: AbortSignal
  readonly now?: () => Date
}

async function findTaskId(snapshots: string, sessionId: string): Promise<string | undefined> {
  const names = await readdir(join(snapshots, 'tasks')).catch(() => [] as string[])
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const value = (await readJson(join(snapshots, 'tasks', name))) as Partial<TaskSnapshotRecord> | undefined
    if (value?.sessionId === sessionId && typeof value.taskId === 'string') return value.taskId
  }
  return undefined
}

/** Worst-case dollars of a request: every prompt character as half a token, every output token used. */
function worstCase(estimate: SelfEvaluateOptions['estimateUsd'], model: string, prompt: { system: string; user: string }, maxTokens: number): number | undefined {
  if (estimate === undefined) return undefined
  const usd = estimate(model, { ...ZERO_USAGE, inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 2), outputTokens: maxTokens })
  return usd === 'unknown' ? undefined : usd
}

/**
 * Evaluate a finished root task once (see the module comment).
 * @returns the evaluation (an existing one with the user's latest feedback
 * merged), or `undefined` for a project that is a gate trial copy, a child
 * or improvement session, or a task without a readable session.
 */
export async function selfEvaluate(options: SelfEvaluateOptions): Promise<SelfEvaluation | undefined> {
  const { layout } = options
  const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
  const directory = evaluationsDirectory(layout)
  const taskId = options.taskId ?? (await findTaskId(snapshots, options.sessionId))
  if (taskId === undefined) return undefined
  if (await isTrialCopy(new CapabilityStore(layout.capabilities))) return undefined

  let records: readonly SessionRecord[]
  try {
    records = (await new JsonlSessionStore({ sessionsDir: layout.sessions }).readAll(options.sessionId)).records
  } catch {
    return undefined
  }
  const view = taskView(records, options.turn)
  if (view === undefined) return undefined
  const feedback = { feedbackIds: view.feedbackIds, ...(view.rating === undefined ? {} : { rating: view.rating }) }

  const existing = await readEvaluation(directory, taskId)
  if (existing !== undefined) {
    if (view.feedbackIds.length === 0) return existing
    const merged = withFeedback(existing, feedback)
    if (JSON.stringify(merged) === JSON.stringify(existing)) return existing
    return (await recordEvaluationFeedback(directory, taskId, feedback)) ?? merged
  }

  const now = options.now ?? (() => new Date())
  const draw = options.draw ?? Math.random
  const documentText = options.documentText
  const start = await startSnapshot(snapshots, taskId)
  const { inputs, before } = start?.tree === null || start === undefined ? { inputs: { files: [] } as RunOutput, before: new Map<string, string>() } : await snapshotInputs(snapshots, start.tree, view.messages, documentText)
  const shown = await runOutput(layout.root, before, documentText)
  const outputs: RunOutput = { ...shown, files: shown.files.slice(0, SELF_EVAL_PROMPT_LIMITS.outputFiles), unshown: [...shown.files.slice(SELF_EVAL_PROMPT_LIMITS.outputFiles).map(file => file.path), ...(shown.unshown ?? [])] }
  if (outputs.unshown!.length === 0) delete (outputs as { unshown?: unknown }).unshown
  const changed = [...shown.files.map(file => file.path), ...(shown.unshown ?? [])]

  const checks = [...(await recordedChecks(snapshots, taskId, options.turn)), ...(await genericChecks(layout.root, changed, view.answer))]
  const ceiling = options.learning.selfEvalMaxUsd
  const sample = selfEvalSample({
    learning: options.mayLearn,
    hasFeedback: view.feedbackIds.length > 0,
    checkFailed: checks.some(check => !check.passed),
    budgetLeftUsd: options.budgetLeftUsd,
    perTaskMaxUsd: ceiling,
    draw: draw(),
  })

  const spend = new Spend()
  let rubric: Rubric | undefined
  let scores: RubricScore[] | undefined
  if (sample === 'user-feedback' || sample === 'check-failed' || sample === 'random') {
    const prompt = rubricPrompt(view.messages, inputs)
    const worst = worstCase(options.estimateUsd, options.executionModel, prompt, SELF_EVAL_PROMPT_LIMITS.rubricTokens)
    if (worst === undefined || worst <= ceiling) {
      const reply = await options.model.complete({ phase: 'self-eval', model: options.executionModel, ...prompt, maxTokens: SELF_EVAL_PROMPT_LIMITS.rubricTokens, thinking: 'off', taskId, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      spend.add(reply)
      const items = reply.failure === undefined ? parseRubric(reply.text) : undefined
      if (items !== undefined) rubric = { items, model: options.executionModel, createdAt: now().toISOString(), generator: RUBRIC_GENERATOR }
    }
    if (rubric !== undefined) {
      const scoring = scorePrompt(rubric, view.messages, inputs, outputs, view.answer, checks)
      const worstScore = worstCase(options.estimateUsd, options.executionModel, scoring, SELF_EVAL_PROMPT_LIMITS.scoreTokens)
      if (spend.charged(ceiling) + (worstScore ?? 0) <= ceiling && spend.charged(ceiling) < ceiling) {
        const reply = await options.model.complete({ phase: 'self-eval', model: options.executionModel, ...scoring, maxTokens: SELF_EVAL_PROMPT_LIMITS.scoreTokens, thinking: 'off', taskId, ...(options.signal === undefined ? {} : { signal: options.signal }) })
        spend.add(reply)
        scores = reply.failure === undefined ? parseScores(reply.text, rubric) : undefined
      }
    }
  }

  const score = combineScore(checks, rubric, scores)
  const outcome = selfEvalOutcome({ checks, ...scoredBy(rubric, scores, score), ...(view.rating === undefined ? {} : { rating: view.rating }) })
  const projectId = options.projectId ?? (await handbookProjectId(layout.root))
  let evaluation: SelfEvaluation = await writeEvaluation(directory, {
    formatVersion: 1,
    rules: LEARNING_RULES,
    projectId,
    taskId,
    sessionId: options.sessionId,
    turn: options.turn,
    createdAt: now().toISOString(),
    checks,
    sample,
    ...(rubric === undefined ? {} : { rubric }),
    ...(scores === undefined ? {} : { scores, scorer: options.executionModel }),
    ...(view.feedbackIds.length === 0 ? {} : { feedback }),
    ...(score === undefined ? {} : { score }),
    outcome,
    cost: spend.cost(),
  })

  // Calibration (ADR 0019 decision 6): the external reviewer scores the same result with the same rubric and checks.
  if (rubric !== undefined && scores !== undefined && score !== undefined && evaluation.calibration === undefined
    && draw() < (options.calibrationRate ?? CALIBRATION_SAMPLE_RATE)
    && options.budgetLeftUsd - spend.charged(ceiling) >= ceiling) {
    // Calibration is learning spend outside the per-task ceiling (a tenth of scored tasks); it needs the budget to cover its worst case and one more ceiling.
    const model = options.calibrationModel ?? CALIBRATION_MODEL
    const scoring = scorePrompt(rubric, view.messages, inputs, outputs, view.answer, checks)
    const worst = worstCase(options.estimateUsd, model, scoring, SELF_EVAL_PROMPT_LIMITS.calibrationTokens)
    if (worst === undefined || options.budgetLeftUsd - spend.charged(ceiling) - worst >= ceiling) {
      const calibration = await calibrate(options.model, { model, scoring, taskId, checks, rubric, selfScore: score, selfScores: scores, now, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      if (calibration !== undefined) evaluation = await recordCalibration(directory, evaluation, calibration)
    }
  }

  if (options.home !== undefined && options.learning.contribute && evaluation.rubric !== undefined && start?.tree !== undefined && start.tree !== null) {
    await addPracticeCase(options.home, { evaluation, messages: view.messages, tree: start.tree, ...(options.now === undefined ? {} : { now: options.now }) }).catch(() => undefined)
  }
  return evaluation
}

/** The {@link selfEvalOutcome} inputs of a (possibly unscored) rubric. */
export function scoredBy(rubric: Pick<Rubric, 'items'> | undefined, scores: readonly RubricScore[] | undefined, score: number | undefined): { rubricScored: boolean; score?: number; rubricScore?: number } {
  const graded = rubric === undefined || scores === undefined ? undefined : rubricScore(rubric, scores)
  return { rubricScored: graded !== undefined, ...(score === undefined ? {} : { score }), ...(graded === undefined ? {} : { rubricScore: graded }) }
}

/** One calibration request; `undefined` when the reviewer gave no usable scores. */
async function calibrate(model: SelfEvalModel, input: {
  readonly model: string
  readonly scoring: { readonly system: string; readonly user: string }
  readonly taskId: string
  readonly checks: readonly TaskCheck[]
  readonly rubric: Rubric
  readonly selfScore: number
  readonly selfScores: readonly RubricScore[]
  readonly now: () => Date
  readonly signal?: AbortSignal
}): Promise<SelfEvalCalibration | undefined> {
  const spend = new Spend()
  const reply = await model.complete({ phase: 'calibrate', model: input.model, ...input.scoring, maxTokens: SELF_EVAL_PROMPT_LIMITS.calibrationTokens, thinking: 'on', effort: 'low', taskId: input.taskId, ...(input.signal === undefined ? {} : { signal: input.signal }) })
  spend.add(reply)
  const scores = reply.failure === undefined ? parseScores(reply.text, input.rubric) : undefined
  const external = scores === undefined ? undefined : combineScore(input.checks, input.rubric, scores)
  if (external === undefined || scores === undefined) return undefined
  const agree = selfEvalOutcome({ checks: input.checks, ...scoredBy(input.rubric, scores, external) }) === selfEvalOutcome({ checks: input.checks, ...scoredBy(input.rubric, input.selfScores, input.selfScore) })
  return { model: input.model, score: external, agree, at: input.now().toISOString(), cost: spend.cost() }
}
