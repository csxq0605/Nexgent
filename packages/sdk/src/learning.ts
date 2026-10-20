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
  type OrganizationMemory,
} from '@nexgent/kernel'
import { learningBudgetStatus, readUserConfig, type LearningHost } from '@nexgent/evolve'
import type { Handbook } from '@nexgent/capabilities'
import type { HandbookEntryDetail, HandbookEntryView, HandbookListing, LearningStatus } from './api.js'

type EntryEvidence = HandbookEntryView['evidence']

const view = (entry: HandbookEntry, evidence?: EntryEvidence): HandbookEntryView => ({ ...entry, retrievable: isRetrievable(entry), ...(evidence === undefined ? {} : { evidence }) })

/** Redesign UI 1: each entry's evidence and last use; an unreadable usage file shows none rather than failing the list. */
async function evidenceOf(handbook: Handbook): Promise<Map<string, NonNullable<EntryEvidence>>> {
  const [evidence, usage] = await Promise.all([handbook.evidence().catch(() => new Map()), handbook.usage().catch(() => new Map())])
  const out = new Map<string, NonNullable<EntryEvidence>>()
  for (const id of new Set([...evidence.keys(), ...usage.keys()])) {
    const e = evidence.get(id)
    const lastUsedAt = usage.get(id)?.lastUsedAt
    out.set(id, {
      shown: e?.shown ?? 0,
      heldBack: e?.heldBack ?? 0,
      ...(e?.shownMean === undefined ? {} : { shownMean: e.shownMean }),
      ...(e?.heldBackMean === undefined ? {} : { heldBackMean: e.heldBackMean }),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    })
  }
  return out
}

/** `handbook.list`: the project's own entries and, with `useShared`, the user's (retired ones only when asked), newest change first. */
export async function handbookList(learner: LearningHost, input: { readonly scope?: HandbookScope; readonly includeRetired?: boolean }): Promise<HandbookListing> {
  const handbook = await learner.handbook()
  const entries = await handbook.entries({ ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.includeRetired === undefined ? {} : { includeRetired: input.includeRetired }) })
  const evidence = await evidenceOf(handbook)
  return { entries: entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(entry => view(entry, evidence.get(entry.id))), sharedIncluded: handbook.learning.useShared && input.scope !== 'project' }
}

/**
 * `handbook.show`: one entry the project can see, with every operation on it.
 * @throws `handbook/not-found`.
 */
export async function handbookShow(learner: LearningHost, entryId: unknown): Promise<HandbookEntryDetail> {
  if (typeof entryId !== 'string' || entryId === '') throw new NexgentError('tool/invalid-input', 'handbook.show needs an entryId')
  const handbook = await learner.handbook()
  const { entry, ops } = await handbook.ops(entryId)
  return { entry: view(entry, (await evidenceOf(handbook)).get(entry.id)), ops: [...ops] }
}

/**
 * `handbook.setStatus` (rework D2): the user stops an entry (`retired`) or
 * takes it back (`active`) from the 能力 page; written as a `status`
 * operation with actor `user`. Taking back a retired entry goes through
 * `Handbook.restore`, which returns it to the status it had before.
 * @throws `handbook/not-found`, `tool/invalid-input`.
 */
export async function handbookSetStatus(learner: LearningHost, input: { readonly entryId?: unknown; readonly status?: unknown; readonly reason?: unknown }): Promise<HandbookEntryDetail> {
  if (typeof input.entryId !== 'string' || input.entryId === '') throw new NexgentError('tool/invalid-input', 'handbook.setStatus needs an entryId')
  if (input.status !== 'active' && input.status !== 'retired') throw new NexgentError('tool/invalid-input', 'handbook.setStatus: status must be active or retired')
  if (input.reason !== undefined && typeof input.reason !== 'string') throw new NexgentError('tool/invalid-input', 'handbook.setStatus: reason must be a string')
  const handbook = await learner.handbook()
  const reason = input.reason === undefined || input.reason.trim() === '' ? undefined : input.reason.trim()
  const current = input.status === 'active' ? (await handbook.entries({ includeRetired: true })).find(entry => entry.id === input.entryId) : undefined
  const result = current?.status === 'retired'
    ? await handbook.restore(input.entryId, reason === undefined ? {} : { reason })
    : (await handbook.apply([{ op: 'status', entryId: input.entryId, status: input.status, ...(reason === undefined ? {} : { reason }) }], { actor: 'user' }))[0]
  if (result?.outcome === 'rejected' && result.reason === 'not-found') throw new NexgentError('handbook/not-found', result.detail)
  if (result?.outcome !== 'applied') throw new NexgentError('tool/invalid-input', result?.outcome === 'rejected' ? result.detail : 'the status was not changed')
  return handbookShow(learner, input.entryId)
}

/** `learning.status`. */
export async function learningStatus(learner: LearningHost, home: string, ledger: Pick<Ledger, 'read'> | undefined, now: Date, organizations?: Pick<OrganizationMemory, 'summary'>): Promise<LearningStatus> {
  const { config } = await readProjectConfig(learner.layout.configFile)
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
    ...(organizations === undefined ? {} : { organizations: await organizations.summary().catch(() => []) }),
  }
}
