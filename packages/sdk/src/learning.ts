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
