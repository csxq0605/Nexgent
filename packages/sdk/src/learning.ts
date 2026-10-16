/**
 * API 8 over `@nexgent/evolve`'s layer-1 learner (rework E1): the handbook a
 * project sees (`handbook.list`, `handbook.show`, over `@nexgent/capabilities`'
 * `Handbook`) and the learning view (`learning.status`: settings,
 * notice, dollar spend in the window by phase, self-evaluations and scorer
 * reliability).
 */
import {
  isRetrievable,
  LEARNING_RULES,
  mayLearn,
  NexgentError,
  readProjectConfig,
  scorerReliability,
  type HandbookEntry,
  type HandbookScope,
  type Ledger,
} from '@nexgent/kernel'
import { learningBudgetStatus, readUserConfig, type ImprovementHost, type LearningHost } from '@nexgent/evolve'
import type { HandbookEntryDetail, HandbookListing, LearningStatus } from './api.js'

function learnerOf(host: ImprovementHost): LearningHost {
  if (host.learning === undefined) throw new NexgentError('internal', 'this project runs without background learning')
  return host.learning
}

const view = (entry: HandbookEntry) => ({ ...entry, retrievable: isRetrievable(entry) })

/** `handbook.list`: the project's own entries and, with `useShared`, the user's (retired ones only when asked), newest change first. */
export async function handbookList(host: ImprovementHost, input: { readonly scope?: HandbookScope; readonly includeRetired?: boolean }): Promise<HandbookListing> {
  const handbook = await learnerOf(host).handbook()
  const entries = await handbook.entries({ ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.includeRetired === undefined ? {} : { includeRetired: input.includeRetired }) })
  return { entries: entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(view), sharedIncluded: handbook.learning.useShared && input.scope !== 'project' }
}

/**
 * `handbook.show`: one entry the project can see, with every operation on it.
 * @throws `handbook/not-found`.
 */
export async function handbookShow(host: ImprovementHost, entryId: unknown): Promise<HandbookEntryDetail> {
  if (typeof entryId !== 'string' || entryId === '') throw new NexgentError('tool/invalid-input', 'handbook.show needs an entryId')
  const { entry, ops } = await (await learnerOf(host).handbook()).ops(entryId)
  return { entry: view(entry), ops: [...ops] }
}

/**
 * `handbook.setStatus` (rework D2): the user stops an entry (`retired`) or
 * takes it back (`active`) from the 能力 page; written as a `status`
 * operation with actor `user`.
 * @throws `handbook/not-found`, `tool/invalid-input`.
 */
export async function handbookSetStatus(host: ImprovementHost, input: { readonly entryId?: unknown; readonly status?: unknown; readonly reason?: unknown }): Promise<HandbookEntryDetail> {
  if (typeof input.entryId !== 'string' || input.entryId === '') throw new NexgentError('tool/invalid-input', 'handbook.setStatus needs an entryId')
  if (input.status !== 'active' && input.status !== 'retired') throw new NexgentError('tool/invalid-input', 'handbook.setStatus: status must be active or retired')
  if (input.reason !== undefined && typeof input.reason !== 'string') throw new NexgentError('tool/invalid-input', 'handbook.setStatus: reason must be a string')
  const handbook = await learnerOf(host).handbook()
  const [result] = await handbook.apply([{ op: 'status', entryId: input.entryId, status: input.status, ...(input.reason === undefined || input.reason.trim() === '' ? {} : { reason: input.reason.trim() }) }], { actor: 'user' })
  if (result?.outcome === 'rejected' && result.reason === 'not-found') throw new NexgentError('handbook/not-found', result.detail)
  if (result?.outcome !== 'applied') throw new NexgentError('tool/invalid-input', result?.outcome === 'rejected' ? result.detail : 'the status was not changed')
  return handbookShow(host, input.entryId)
}

/** `learning.status`. */
export async function learningStatus(host: ImprovementHost, home: string, ledger: Pick<Ledger, 'read'> | undefined, now: Date): Promise<LearningStatus> {
  const learner = learnerOf(host)
  const { config } = await readProjectConfig(host.layout.configFile)
  const user = await readUserConfig(home)
  const budget = ledger === undefined
    ? { usedUsd: 0, remainingUsd: config.learning.budget.maxUsd, estimated: 0, phases: [], windowStart: new Date(now.getTime() - config.learning.budget.windowDays * 86_400_000).toISOString() }
    : await learningBudgetStatus(ledger, config.learning.budget, now)
  const evaluations = await learner.evaluations()
  const windowStart = Date.parse(budget.windowStart)
  return {
    config: config.learning,
    noticeAcknowledged: user.learning.noticeAcknowledgedAt !== undefined,
    active: mayLearn(config.learning, user.learning),
    rules: LEARNING_RULES,
    budget: {
      ...config.learning.budget,
      spentUsd: budget.usedUsd,
      remainingUsd: budget.remainingUsd,
      windowStart: budget.windowStart,
      estimated: budget.estimated > 0,
      phases: budget.phases.map(phase => ({ phase: phase.phase, usd: phase.usd, requestCount: phase.requestCount })),
    },
    selfEvaluations: evaluations.filter(evaluation => Date.parse(evaluation.createdAt) >= windowStart).length,
    reliability: scorerReliability(evaluations.flatMap(evaluation => (evaluation.calibration === undefined ? [] : [evaluation.calibration]))),
  }
}
