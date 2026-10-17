/**
 * Layer 1 inside the running app (ADR 0018 decisions 4, 8, 10, 11; rework
 * plan E1): after every root task turn the kernel calls `noteTurnEnd`; the
 * task is queued and a background loop in the app process reflects on it
 * (one model request, `learningPhase: 'reflect'`), curates the proposed
 * operations and appends them to the handbook logs, then derives the status
 * changes the counts call for.
 *
 * - One task at a time per project, by the process holding the worker lock;
 *   another app process only queues.
 * - Spends only when `mayLearn` (learning on and the notice acknowledged)
 *   and the learning budget has at least {@link REFLECTION_RESERVE_USD}
 *   left; otherwise items wait in the queue (`waiting-budget`) and run on a
 *   later turn or start once the window has room.
 * - {@link LearningHost.stop} (app exit) aborts the running request and
 *   leaves its item pending; {@link LearningHost.start} picks it up again.
 * - Before reflecting it runs `@nexgent/capabilities`' `selfEvaluate` for
 *   the task (once per task; later turns only merge the user's feedback),
 *   whose requests carry `learningPhase: 'self-eval' | 'calibrate'` and
 *   count against the same budget. The reflection reads that evaluation;
 *   only when there is none (it failed, or a trial copy) the outcome is
 *   derived from the turn's checks and the user's rating
 *   (`selfEvalOutcome`). That evaluation only informs the reflection.
 * - ADR 0023: the task's outcome for the randomized exposure comparison is
 *   recorded (`Handbook.recordOutcome`) from the user's signals (rating,
 *   comment, revert), the checks and the external review only
 *   ({@link taskOutcome}, {@link revertedTasks}), never from the
 *   self-evaluation; then `Handbook.applyEvidence` updates the statuses.
 *   Reflection votes record use only.
 * - The handbook is `@nexgent/capabilities`' {@link Handbook}: retrieval,
 *   and every write through `Handbook.apply` (actor `reflection`). Votes of
 *   the executing model come through its `handbook_mark` tool.
 * - A trial copy of a project (gate replay, comparison arm) learns nothing.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import {
  CapabilityStore,
  evaluationsDirectory,
  Handbook,
  isTrialCopy,
  listEvaluations,
  providerSelfEvalModel,
  readEvaluation,
  selfEvaluate,
  type HandbookChangeResult,
  type ScoredEntry,
} from '@nexgent/capabilities'
import {
  foldHandbook,
  HANDBOOK_TOP_K,
  mayLearn,
  readProjectConfig,
  selfEvalOutcome,
  ZERO_USAGE,
  isRetrievable,
  type HandbookEntry,
  type InstanceLiteralSource,
  type Ledger,
  type LedgerAttribution,
  type LLMCompleteOptions,
  type LLMProvider,
  type LLMUsage,
  type ProjectTaskMessage,
  type SelfEvaluation,
  type SessionStore,
  type TaskCheck,
  type TurnEndReason,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { estimateUsd } from '@nexgent/llm'
import { breakStaleLock, tryCreateLock } from '../lock.js'
import { readUserConfig } from '../user.js'
import { learningBudgetStatus, type LearningBudgetStatus } from './budget.js'
import { REVERTED_OUTCOME, revertedTasks, taskOutcome } from './outcome.js'
import { curateReflection, reflectionEdits, statusReason, votesFromTask, type CurationRejection } from './curate.js'
import {
  enqueueItem,
  learningPaths,
  MAX_ATTEMPTS,
  readLearningQueue,
  updateLearningQueue,
  type LearnedTask,
  type LearningItem,
  type LearningQueueFile,
} from './queue.js'
import { parseReflection, REFLECTION_MAX_TOKENS, reflectionSystemPrompt, reflectionUserMessage, type ContrastTask, type ReflectionEvaluation } from './reflect.js'
import { readTaskRun, renderTaskRun, type TaskRun } from './run-record.js'
import { detectLanguage, keywordsOf, similarity, type LearningLanguage } from './text.js'

/** Budget a reflection needs left before it is sent (its request is bounded well below this). */
export const REFLECTION_RESERVE_USD = 0.1
/** Related entries shown besides the votable ones. */
export const RELATED_ENTRIES = 8
/** Similarity a contrasting task needs. */
export const CONTRAST_MIN_SIMILARITY = 0.2

/** A root task turn that ended (the kernel's `TurnEndSignal`). */
export interface TurnEndInput {
  readonly taskId: string
  readonly sessionId: string
  readonly turn: number
  readonly reason: TurnEndReason
  readonly checks?: readonly TaskCheck[]
  readonly at?: Date
}

/** Turn ends worth learning from: the task ran (cancellations by the user, shutdown or a parent are not). */
export function learnsFrom(reason: TurnEndReason): boolean {
  if (reason.kind === 'completed' || reason.kind === 'max-tokens' || reason.kind === 'error') return true
  return reason.kind === 'cancelled' && (reason.cause === 'step-limit' || reason.cause === 'cost-cap' || reason.cause === 'timeout')
}

/** Services the host reads from the app. */
export interface LearningHostOptions {
  readonly layout: WorkspaceLayout
  /** The Nexgent home (user handbook and user config). */
  readonly home: string
  readonly llm: () => LLMProvider | undefined
  readonly ledger: () => Ledger | undefined
  readonly sessions: () => Pick<SessionStore, 'readAll'> | undefined
  /** The interface language (BCP 47); absent: the user's `language` setting, else the language of each task's first message. */
  readonly language?: LearningLanguage
  readonly now?: () => Date
}

/** What the learning page shows. */
export interface LearningStatus {
  readonly enabled: boolean
  readonly acknowledged: boolean
  readonly mayLearn: boolean
  readonly budget?: LearningBudgetStatus
  readonly pending: number
  readonly waitingBudget: number
  readonly running?: string
  /** Latest tasks learned from, newest first (at most 10). */
  readonly recent: readonly LearnedTask[]
  /** Entries visible to this project, by status. */
  readonly entries: Readonly<Record<'trial' | 'active' | 'retired', number>>
}

function count<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Background layer-1 learning of one project. */
export class LearningHost {
  readonly #options: LearningHostOptions
  readonly #paths: ReturnType<typeof learningPaths>
  #copy: Promise<boolean> | undefined
  #loop: Promise<void> | undefined
  #again = false
  #stopped = false
  #abort: AbortController | undefined
  #running: string | undefined

  constructor(options: LearningHostOptions) {
    this.#options = options
    this.#paths = learningPaths(options.layout.dataDir)
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date()
  }

  /** The handbook this project sees, with its current `learning` switches. */
  handbook(): Promise<Handbook> {
    const now = this.#options.now
    return Handbook.open({ projectRoot: this.#options.layout.root, home: this.#options.home, ...(now === undefined ? {} : { now }) })
  }

  /** Whether this project is a gate trial's or comparison arm's throw-away copy (asked once). */
  trialCopy(): Promise<boolean> {
    this.#copy ??= isTrialCopy(new CapabilityStore(this.#options.layout.capabilities)).catch(() => false)
    return this.#copy
  }

  /** Queue a root task turn (when worth learning from) and wake the loop. */
  async noteTurnEnd(input: TurnEndInput): Promise<void> {
    if (!learnsFrom(input.reason)) return
    const { config } = await readProjectConfig(this.#options.layout.configFile)
    if (!config.learning.enabled || await this.trialCopy()) return
    await updateLearningQueue(this.#options.layout.dataDir, queue => ({
      queue: enqueueItem(queue, { taskId: input.taskId, sessionId: input.sessionId, turn: input.turn, checks: input.checks ?? [], enqueuedAt: (input.at ?? this.#now()).toISOString() }),
      result: undefined,
    }))
    this.kick()
  }

  /** Put items a dead process left running back to pending, then work the queue. */
  async start(): Promise<void> {
    this.#stopped = false
    const queue = await readLearningQueue(this.#options.layout.dataDir)
    if (queue.items.some(item => item.status === 'running') && await this.#takeWorker()) {
      try {
        await updateLearningQueue(this.#options.layout.dataDir, current => ({
          queue: { ...current, items: current.items.map(item => (item.status === 'running' ? { ...item, status: 'pending' as const } : item)) },
          result: undefined,
        }))
      } finally {
        await this.#releaseWorker()
      }
    }
    this.kick()
  }

  /** Stop (app exit): abort the running request, wait for the loop; its item stays queued. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#abort?.abort()
    await this.#loop?.catch(() => undefined)
  }

  /** Whether the loop is working. */
  get busy(): boolean {
    return this.#loop !== undefined
  }

  /** Resolve once the loop has nothing it can do now. */
  async idle(): Promise<void> {
    while (this.#loop !== undefined) await this.#loop.catch(() => undefined)
  }

  /** Wake the loop (no-op while stopped; a running loop takes another pass). */
  kick(): void {
    if (this.#stopped) return
    if (this.#loop !== undefined) {
      this.#again = true
      return
    }
    this.#loop = (async () => {
      do {
        this.#again = false
        await this.#work().catch(() => undefined)
      } while (this.#again && !this.#stopped)
    })().finally(() => {
      this.#loop = undefined
    })
  }

  async #takeWorker(): Promise<boolean> {
    if (await tryCreateLock(this.#paths.worker, process.pid).catch(() => false)) return true
    if (await breakStaleLock(this.#paths.worker).catch(() => false)) return tryCreateLock(this.#paths.worker, process.pid).catch(() => false)
    return false
  }

  async #releaseWorker(): Promise<void> {
    await rm(this.#paths.worker, { force: true }).catch(() => undefined)
  }

  async #mayLearn(): Promise<boolean> {
    const { config } = await readProjectConfig(this.#options.layout.configFile)
    const user = await readUserConfig(this.#options.home).catch(() => undefined)
    return user !== undefined && mayLearn(config.learning, user.learning)
  }

  /** Work queued items until none can run now. */
  async #work(): Promise<void> {
    await mkdir(this.#paths.directory, { recursive: true })
    if (!(await this.#takeWorker())) return
    try {
      while (!this.#stopped) {
        const queue = await readLearningQueue(this.#options.layout.dataDir)
        const next = queue.items.find(item => item.status !== 'running')
        if (next === undefined) return
        if (!(await this.#mayLearn())) return
        const ledger = this.#options.ledger()
        const llm = this.#options.llm()
        const sessions = this.#options.sessions()
        if (ledger === undefined || llm === undefined || sessions === undefined) return
        const { config } = await readProjectConfig(this.#options.layout.configFile)
        const budget = await learningBudgetStatus(ledger, config.learning.budget, this.#now())
        if (budget.remainingUsd < REFLECTION_RESERVE_USD) {
          await this.#setStatus(queue, 'waiting-budget', `budget: ${budget.usedUsd.toFixed(4)} of ${budget.maxUsd} USD used since ${budget.windowStart}`)
          return
        }
        const item = await this.#claim(next)
        if (item === undefined) continue
        this.#running = item.taskId
        this.#abort = new AbortController()
        let learned: LearnedTask | undefined
        let failure: unknown
        try {
          learned = await this.learnFrom(item, { llm, sessions, signal: this.#abort.signal, budgetLeftUsd: budget.remainingUsd })
        } catch (error) {
          failure = error
        } finally {
          this.#running = undefined
        }
        const aborted = this.#abort.signal.aborted
        this.#abort = undefined
        await this.#finish(item, learned, failure, aborted)
      }
    } finally {
      await this.#releaseWorker()
    }
  }

  async #setStatus(queue: LearningQueueFile, status: 'waiting-budget', detail: string): Promise<void> {
    if (queue.items.every(item => item.status === 'running' || (item.status === status && item.detail === detail))) return
    await updateLearningQueue(this.#options.layout.dataDir, current => ({
      queue: { ...current, items: current.items.map(item => (item.status === 'running' ? item : { ...item, status, detail })) },
      result: undefined,
    }))
  }

  async #claim(next: LearningItem): Promise<LearningItem | undefined> {
    return updateLearningQueue(this.#options.layout.dataDir, current => {
      const found = current.items.find(item => item.taskId === next.taskId && item.status !== 'running')
      if (found === undefined) return { queue: current, result: undefined }
      const claimed: LearningItem = { ...found, status: 'running', attempts: found.attempts + 1 }
      const { detail: _detail, ...rest } = claimed
      return { queue: { ...current, items: current.items.map(item => (item === found ? rest : item)) }, result: rest }
    })
  }

  async #finish(item: LearningItem, learned: LearnedTask | undefined, failure: unknown, aborted: boolean): Promise<void> {
    await updateLearningQueue(this.#options.layout.dataDir, current => {
      const items = current.items.filter(other => !(other.taskId === item.taskId && other.status === 'running'))
      if (learned !== undefined) return { queue: { ...current, items, history: [...current.history, learned] }, result: undefined }
      const detail = clip(failure instanceof Error ? failure.message : String(failure), 300)
      if (aborted) {
        // App exit: back to the queue, this attempt not counted.
        return { queue: { ...current, items: [{ ...item, status: 'pending', attempts: item.attempts - 1 }, ...items] }, result: undefined }
      }
      if (item.attempts >= MAX_ATTEMPTS) {
        const gaveUp: LearnedTask = {
          taskId: item.taskId, sessionId: item.sessionId, fromTurn: item.fromTurn, throughTurn: item.turn, finishedAt: this.#now().toISOString(),
          status: 'failed', outcome: 'unknown', task: '', keywords: [], approach: '', ops: {}, rejected: {}, added: [], detail,
        }
        return { queue: { ...current, items, history: [...current.history, gaveUp] }, result: undefined }
      }
      return { queue: { ...current, items: [...items, { ...item, status: 'pending', detail }] }, result: undefined }
    })
  }

  /** What the reflection is told about a task's result: its self-evaluation when there is one, else derived from checks and rating. */
  evaluationFrom(evaluation: SelfEvaluation | undefined, checks: readonly TaskCheck[], rating: number | undefined): ReflectionEvaluation {
    if (evaluation !== undefined) {
      const scores = new Map((evaluation.scores ?? []).map(score => [score.itemId, score.score]))
      const latestRating = evaluation.feedback?.rating ?? rating
      return {
        outcome: evaluation.outcome,
        ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
        checks: evaluation.checks,
        ...(latestRating === undefined ? {} : { rating: latestRating }),
        source: 'self-evaluation',
        ...(evaluation.rubric === undefined ? {} : { rubric: evaluation.rubric.items.map(rubricItem => ({ text: rubricItem.text, ...(scores.has(rubricItem.id) ? { score: scores.get(rubricItem.id)! } : {}) })) }),
      }
    }
    return { outcome: selfEvalOutcome({ checks, rubricScored: false, ...(rating === undefined ? {} : { rating }) }), checks, ...(rating === undefined ? {} : { rating }), source: 'derived' }
  }

  /** The task's evaluation as written (`evaluations/<taskId>.json`), else derived. */
  async evaluationOf(taskId: string, checks: readonly TaskCheck[], rating: number | undefined): Promise<ReflectionEvaluation> {
    return this.evaluationFrom(await readEvaluation(evaluationsDirectory(this.#options.layout), taskId).catch(() => undefined), checks, rating)
  }

  /**
   * Self-evaluate a task through `selfEvaluate` (first call scores it, later
   * ones merge the user's feedback); `undefined` when it gives none or
   * fails. An abort is rethrown so the item goes back to the queue.
   */
  async #selfEvaluate(item: LearningItem, llm: LLMProvider, signal: AbortSignal, budgetLeftUsd: number): Promise<SelfEvaluation | undefined> {
    const { config } = await readProjectConfig(this.#options.layout.configFile)
    const model = providerSelfEvalModel({
      providerFor: attribution => ({
        info: llm.info,
        complete: (request, options) => llm.complete(request, { ...options, purpose: 'auxiliary', taskId: attribution.taskId, learningPhase: attribution.learningPhase } as LLMCompleteOptions & LedgerAttribution),
      }),
      estimateUsd,
    })
    try {
      return await selfEvaluate({
        layout: this.#options.layout,
        sessionId: item.sessionId,
        turn: item.turn,
        taskId: item.taskId,
        model,
        executionModel: config.model,
        learning: config.learning,
        mayLearn: true,
        budgetLeftUsd,
        home: this.#options.home,
        estimateUsd,
        signal,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      })
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  /** The entries a task with this text would be given (at most `HANDBOOK_TOP_K`). */
  async retrieve(query: string, limit = HANDBOOK_TOP_K): Promise<ScoredEntry[]> {
    return (await this.handbook()).retrieve(query, { k: limit })
  }

  /** The self-evaluations of this epoch written for the project, oldest first. */
  evaluations(): Promise<SelfEvaluation[]> {
    return listEvaluations(evaluationsDirectory(this.#options.layout))
  }

  /** The learning page's numbers. */
  async status(): Promise<LearningStatus> {
    const { config } = await readProjectConfig(this.#options.layout.configFile)
    const user = await readUserConfig(this.#options.home).catch(() => undefined)
    const acknowledged = user?.learning.noticeAcknowledgedAt !== undefined
    const ledger = this.#options.ledger()
    const queue = await readLearningQueue(this.#options.layout.dataDir)
    const all = await (await this.handbook()).entries({ includeRetired: true })
    return {
      enabled: config.learning.enabled,
      acknowledged,
      mayLearn: config.learning.enabled && acknowledged,
      ...(ledger === undefined ? {} : { budget: await learningBudgetStatus(ledger, config.learning.budget, this.#now()) }),
      pending: queue.items.filter(item => item.status === 'pending').length,
      waitingBudget: queue.items.filter(item => item.status === 'waiting-budget').length,
      ...(this.#running === undefined ? {} : { running: this.#running }),
      recent: [...queue.history].reverse().slice(0, 10),
      entries: {
        trial: all.filter(entry => entry.status === 'trial').length,
        active: all.filter(entry => entry.status === 'active').length,
        retired: all.filter(entry => entry.status === 'retired').length,
      },
    }
  }

  /**
   * ADR 0023: record this task's outcome, and a revert for every earlier
   * task whose presented files the user has since removed, then let the
   * handbook update its statuses from the evidence.
   */
  async #recordOutcomes(handbook: Handbook, item: LearningItem, run: TaskRun, evaluation: ReflectionEvaluation, selfEvaluation: SelfEvaluation | undefined): Promise<void> {
    const calibration = selfEvaluation?.calibration ?? (await readEvaluation(evaluationsDirectory(this.#options.layout), item.taskId).catch(() => undefined))?.calibration
    const last = run.feedback.at(-1)
    const outcome = taskOutcome({
      checks: evaluation.checks,
      ...(evaluation.rating === undefined ? {} : { rating: evaluation.rating }),
      ...(last !== undefined && last.rating === undefined && last.comment.trim() !== '' ? { commentOnly: true } : {}),
      ...(calibration === undefined ? {} : { calibration }),
    })
    if (outcome !== undefined) await handbook.recordOutcome({ sessionId: item.sessionId, taskId: item.taskId, ...outcome })
    // Judge reverts only when no other task waits: a waiting one may have deleted the files itself.
    const queue = await readLearningQueue(this.#options.layout.dataDir)
    if (queue.items.every(other => other.taskId === item.taskId)) {
      const root = this.#options.layout.root
      const exists = (path: string) => isAbsolute(path) || normalize(path).startsWith('..') || existsSync(join(root, path))
      const reverted = revertedTasks([...queue.history.slice(-REVERT_WINDOW), { taskId: item.taskId, sessionId: item.sessionId, ...filesOf(run), outputs: [] }], exists)
      for (const task of reverted) await handbook.recordOutcome({ sessionId: task.sessionId, taskId: task.taskId, ...REVERTED_OUTCOME })
      if (reverted.length > 0) {
        const ids = new Set(reverted.map(task => task.taskId))
        await updateLearningQueue(this.#options.layout.dataDir, current => ({
          queue: { ...current, history: current.history.map(task => (ids.has(task.taskId) ? { ...task, reverted: true } : task)) },
          result: undefined,
        }))
      }
    }
    await handbook.applyEvidence()
  }

  /** The most similar earlier task (of this project) whose known outcome differs. */
  #contrast(history: readonly LearnedTask[], run: TaskRun, taskId: string, outcome: ReflectionEvaluation['outcome']): ContrastTask | undefined {
    let best: { task: LearnedTask; score: number } | undefined
    for (const task of history) {
      if (task.taskId === taskId || task.status !== 'done' || task.outcome === 'unknown' || task.outcome === outcome) continue
      const score = similarity(run.task, `${task.task} ${task.keywords.join(' ')}`)
      if (score >= CONTRAST_MIN_SIMILARITY && (best === undefined || score > best.score)) best = { task, score }
    }
    return best === undefined ? undefined : { task: best.task.task, outcome: best.task.outcome, approach: best.task.approach }
  }

  /**
   * Reflect on one queued task and write what curation keeps. Throws when
   * the model request fails (the item is retried); a reply that is not the
   * JSON asked for ends the item without operations.
   */
  async learnFrom(item: LearningItem, services: { readonly llm: LLMProvider; readonly sessions: Pick<SessionStore, 'readAll'>; readonly signal: AbortSignal; readonly budgetLeftUsd?: number }): Promise<LearnedTask> {
    // The whole task so far, with the turns no reflection saw yet marked.
    const run = await readTaskRun(services.sessions, item.sessionId, 1, item.turn, item.fromTurn)
    const base = {
      taskId: item.taskId,
      sessionId: item.sessionId,
      fromTurn: item.fromTurn,
      throughTurn: item.turn,
      task: clip(run.task, 500),
      keywords: keywordsOf([run.task, ...run.messages.map(message => message.text)].join('\n'), 12),
      ...filesOf(run),
      approach: clip(`${run.toolCalls} tool calls (${run.failedToolCalls} failed); tools: ${[...new Set(run.steps.map(step => step.split(' ')[3]).filter(Boolean))].slice(0, 12).join(', ') || 'none'}; files changed: ${run.filesChanged.length}; answer: ${run.answer.replace(/\s+/g, ' ')}`, 600),
    }
    const finishedAt = () => this.#now().toISOString()
    const selfEvaluation = run.isRootTask && run.task !== '' ? await this.#selfEvaluate(item, services.llm, services.signal, services.budgetLeftUsd ?? REFLECTION_RESERVE_USD) : undefined
    const evaluation = this.evaluationFrom(selfEvaluation, item.checks, run.rating)
    if (!run.isRootTask || run.task === '') {
      return { ...base, finishedAt: finishedAt(), status: 'skipped', outcome: evaluation.outcome, ops: {}, rejected: {}, added: [], detail: 'not a root task session' }
    }
    const { config } = await readProjectConfig(this.#options.layout.configFile)
    // ADR 0020 decision 4: the interface language the user chose in the settings, read per task so a change applies to the next one.
    const userLanguage = this.#options.language === undefined ? (await readUserConfig(this.#options.home).catch(() => undefined))?.language : undefined
    const language = this.#options.language ?? userLanguage ?? detectLanguage(run.task)
    const handbook = await this.handbook()
    const projectId = handbook.projectId
    // Bookkeeping: a failure here never stops the reflection.
    await this.#recordOutcomes(handbook, item, run, evaluation, selfEvaluation).catch(() => undefined)
    const [userOps, projectOps] = await Promise.all([handbook.user.read(), handbook.project.read()])
    const user = foldHandbook(userOps).filter(entry => entry.scope === 'user')
    const project = foldHandbook(projectOps).filter(entry => entry.projectId === projectId)
    const query = [run.task, ...run.messages.filter(message => message.source !== 'inject').map(message => message.text)].join('\n')
    const shownIds = run.shownEntries
    const everything = new Map([...project, ...(handbook.learning.useShared ? user : [])].map(entry => [entry.id, entry]))
    const votable = shownIds.length > 0
      ? shownIds.map(id => everything.get(id)).filter((entry): entry is HandbookEntry => entry !== undefined && isRetrievable(entry))
      : (await handbook.retrieve(query, { k: HANDBOOK_TOP_K })).map(hit => hit.entry)
    const votableIds = new Set(votable.map(entry => entry.id))
    const related = (await handbook.retrieve(query, { k: HANDBOOK_TOP_K + RELATED_ENTRIES, exclude: votableIds })).map(hit => hit.entry).slice(0, RELATED_ENTRIES)
    const queue = await readLearningQueue(this.#options.layout.dataDir)
    const contrast = this.#contrast(queue.history, run, item.taskId, evaluation.outcome)

    const requestId = randomUUID()
    const attribution: LLMCompleteOptions & LedgerAttribution = { purpose: 'auxiliary', taskId: item.taskId, learningPhase: 'reflect' }
    let text = ''
    let usage: LLMUsage = ZERO_USAGE
    let failure: string | undefined
    let finish: string | undefined
    for await (const event of services.llm.complete({
      requestId,
      model: config.improvement.model,
      thinking: config.improvement.thinking,
      maxTokens: config.improvement.thinking === 'off' ? REFLECTION_MAX_TOKENS : REFLECTION_MAX_TOKENS * 2,
      messages: [
        { role: 'system', content: reflectionSystemPrompt(language) },
        { role: 'user', content: reflectionUserMessage({ run: renderTaskRun(run), evaluation, ...(contrast === undefined ? {} : { contrast }), votable, shown: shownIds.length > 0, related }) },
      ],
      signal: services.signal,
    }, attribution)) {
      if (event.type === 'text.delta') text += event.text
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
      else if (event.type === 'done') finish = event.finishReason
    }
    if (failure !== undefined) throw new Error(`reflection request failed: ${failure}`)
    if (finish === 'aborted' || services.signal.aborted) throw new Error('reflection request was aborted')
    const usd = estimateUsd(config.improvement.model, usage)
    const spent = usd === 'unknown' ? {} : { usd }
    const parsed = parseReflection(text)
    if (parsed === undefined) {
      return { ...base, finishedAt: finishedAt(), status: 'done', outcome: evaluation.outcome, ops: {}, rejected: {}, added: [], ...spent, detail: `the reply was not the JSON asked for (${finish ?? 'no finish reason'})` }
    }

    const source = { projectId, taskId: item.taskId, sessionId: item.sessionId }
    const sources: InstanceLiteralSource[] = [
      ...run.messages.map(message => ({ kind: 'feedback' as const, ref: `message:turn-${message.turn}`, text: message.text, projectId })),
      { kind: 'feedback', ref: 'message:task', text: run.task, projectId },
      ...run.feedback.map(entry => ({ kind: 'feedback' as const, ref: `feedback:${entry.id}`, text: entry.comment, projectId })),
      ...(run.answer === '' ? [] : [{ kind: 'deliverable' as const, ref: 'answer', text: run.answer, projectId }]),
    ]
    const projectMessages: ProjectTaskMessage[] = [
      ...queue.history.filter(task => task.task !== '').map(task => ({ taskId: task.taskId, text: task.task, projectId })),
      { taskId: item.taskId, text: run.task, projectId },
    ]
    const curated = curateReflection(parsed.ops, {
      projectId,
      taskId: item.taskId,
      contribute: handbook.learning.contribute,
      votable: votableIds,
      user: handbook.learning.useShared ? user : [],
      project,
      sources,
      projectMessages,
      requests: [run.task, ...run.messages.filter(message => message.source !== 'inject').map(message => message.text), ...run.feedback.map(entry => entry.comment)],
      votedFromTask: new Set([...votesFromTask(userOps, item.taskId), ...votesFromTask(projectOps, item.taskId)]),
      edits: reflectionEdits([...userOps, ...projectOps]),
    })
    // Apply checks again under the log's lock: one vote per entry per task (handbook_mark of a later turn included), none on the task's own entry.
    const results: HandbookChangeResult[] = await handbook.apply(curated.changes, { actor: 'reflection', source, literals: { sources, projectMessages }, statusReason: (status, entry) => statusReason(status, entry, language) })
    const written = results.flatMap(result => (result.outcome === 'applied' ? result.ops : []))
    const refused = results.flatMap(result => (result.outcome === 'duplicate' ? ['duplicate' as const] : result.outcome === 'rejected' ? [result.reason === 'not-found' ? 'unknown-entry' as const : result.reason === 'own-source' ? 'own-entry' as const : result.reason] : []))
    const rejected: string[] = [...curated.rejected.map(entry => entry.reason as CurationRejection), ...refused]
    return {
      ...base,
      finishedAt: finishedAt(),
      status: 'done',
      outcome: evaluation.outcome,
      ops: count(written.map(op => (op.op === 'status' ? `status:${op.status}` : op.op))),
      rejected: { ...count(rejected), ...(parsed.malformed > 0 ? { malformed: parsed.malformed } : {}) },
      added: written.filter(op => op.op === 'add').map(op => op.entryId),
      ...spent,
    }
  }
}

/** Learned tasks a revert is looked for in (the most recent ones). */
const REVERT_WINDOW = 50

/** The files a task presented (minus the ones it deleted itself) and the files it deleted, for the revert signal. */
function filesOf(run: Pick<TaskRun, 'deliverables' | 'filesChanged'>): { readonly outputs?: readonly string[]; readonly deleted?: readonly string[] } {
  const deleted = run.filesChanged.filter(line => line.startsWith('deleted ')).map(line => line.slice('deleted '.length))
  const gone = new Set(deleted)
  const outputs = [...new Set(run.deliverables.flatMap(deliverable => deliverable.files))].filter(path => !gone.has(path)).slice(0, 50)
  return { ...(outputs.length === 0 ? {} : { outputs }), ...(deleted.length === 0 ? {} : { deleted: deleted.slice(0, 200) }) }
}
