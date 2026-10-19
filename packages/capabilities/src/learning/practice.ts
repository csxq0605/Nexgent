/**
 * The practice set (ADR 0018 decision 3, `data-formats.md` §练习题集):
 * `<NEXGENT_HOME>/practice/cases/<caseId>.json`. A scored root task of a
 * contributing project becomes one task case; similar tasks share a cluster
 * and so a split (60% train, 20% selection, 20% holdout by the cluster id).
 * Learners (reflection, induction, proposals) only ever list `train` and
 * `selection`; `holdout` and the generic `guard` cases are for measurement.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HANDBOOK_LIMITS,
  isVisibleToLearners,
  PRACTICE_LIMITS,
  practiceSplit,
  resolveUserDataLayout,
  type PracticeCase,
  type PracticeSplit,
  type SelfEvaluation,
} from '@nexgent/kernel'
import { validateLearningFile } from '@nexgent/session'
import { publishExclusive } from '../activation.js'
import { jaccard, terms } from '../handbook/tokens.js'

/** Key overlap (Jaccard) at or above which a new task joins an existing case's cluster. */
export const PRACTICE_CLUSTER_MIN = 0.25

/** `<home>/practice/cases/`. */
export function practiceCasesDirectory(home: string): string {
  return join(resolveUserDataLayout(home).practice, 'cases')
}

/** The similarity key of a task text: its most frequent terms (≤16), first-seen order breaking ties. */
export function similarityKey(text: string): string[] {
  const counts = new Map<string, number>()
  for (const term of terms(text)) {
    const key = term.slice(0, HANDBOOK_LIMITS.maxKeywordChars)
    if (key === '' || /[A-Z\n]/.test(key)) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order = [...counts.keys()]
  return order
    .sort((left, right) => counts.get(right)! - counts.get(left)! || order.indexOf(left) - order.indexOf(right))
    .slice(0, PRACTICE_LIMITS.maxSimilarityKeys)
}

async function readCase(path: string): Promise<PracticeCase | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return validateLearningFile('practiceCase', value).length === 0 ? (value as PracticeCase) : undefined
  } catch {
    return undefined
  }
}

async function allCases(home: string): Promise<PracticeCase[]> {
  const directory = practiceCasesDirectory(home)
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
  const cases: PracticeCase[] = []
  for (const name of names) {
    const found = await readCase(join(directory, name))
    if (found !== undefined && `${found.id}.json` === name) cases.push(found)
  }
  return cases.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1))
}

/**
 * The practice cases a reader may see. `learner` (default): reflection,
 * induction and proposals see `train` and `selection` only. `measure`: the
 * measurement and the gate's guard see every split.
 */
export async function listPracticeCases(home: string, options: { readonly audience?: 'learner' | 'measure' } = {}): Promise<PracticeCase[]> {
  const cases = await allCases(home)
  return (options.audience ?? 'learner') === 'measure' ? cases : cases.filter(isVisibleToLearners)
}

/** How many cases each split holds. */
export function practiceCounts(cases: readonly Pick<PracticeCase, 'split'>[]): Record<PracticeSplit, number> {
  const counts: Record<PracticeSplit, number> = { train: 0, selection: 0, holdout: 0, guard: 0 }
  for (const item of cases) counts[item.split] += 1
  return counts
}

/** The cluster a task with `key` joins: the most similar task case's at or above {@link PRACTICE_CLUSTER_MIN}, else a new one. */
export function clusterFor(key: readonly string[], cases: readonly Pick<PracticeCase, 'source' | 'similarityKey' | 'clusterId'>[]): string {
  const mine = new Set(key)
  let best: { clusterId: string; overlap: number } | undefined
  for (const other of cases) {
    if (other.source !== 'task') continue
    const overlap = jaccard(mine, new Set(other.similarityKey))
    if (overlap >= PRACTICE_CLUSTER_MIN && (best === undefined || overlap > best.overlap)) best = { clusterId: other.clusterId, overlap }
  }
  return best?.clusterId ?? randomUUID()
}

/**
 * Add a scored task to the practice set, once per project task.
 * @returns the case, the existing one for the task, or `undefined` when the
 * evaluation has no rubric.
 */
export async function addPracticeCase(home: string, input: { readonly evaluation: SelfEvaluation; readonly messages: readonly string[]; readonly tree: string; readonly now?: () => Date }): Promise<PracticeCase | undefined> {
  const { evaluation } = input
  if (evaluation.rubric === undefined) return undefined
  const cases = await allCases(home)
  const existing = cases.find(item => item.projectId === evaluation.projectId && item.taskId === evaluation.taskId)
  if (existing !== undefined) return existing
  const prompt = input.messages.join('\n\n').slice(0, PRACTICE_LIMITS.maxPromptChars)
  if (prompt.trim() === '') return undefined
  const key = similarityKey(prompt)
  const clusterId = clusterFor(key, cases)
  const practiceCase: PracticeCase = {
    formatVersion: 1,
    id: randomUUID(),
    source: 'task',
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    prompt,
    input: { projectId: evaluation.projectId, tree: input.tree },
    projectId: evaluation.projectId,
    taskId: evaluation.taskId,
    sessionId: evaluation.sessionId,
    similarityKey: key,
    clusterId,
    split: practiceSplit(clusterId, 'task'),
    rubric: evaluation.rubric,
    outcome: evaluation.outcome,
    ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
  }
  const issues = validateLearningFile('practiceCase', practiceCase)
  if (issues.length > 0) throw new TypeError(`invalid practice case: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  await publishExclusive(practiceCasesDirectory(home), `${practiceCase.id}.json`, `${JSON.stringify(practiceCase, null, 2)}\n`)
  return practiceCase
}

/**
 * Load the generic guard cases (M1's `guardPracticeCases()`): each must be
 * `source: generic`, `split: guard`; present ids are left as they are.
 * @returns how many were added.
 * @throws `TypeError` when a case is invalid or not a generic guard case.
 */
export async function loadGenericPracticeCases(home: string, cases: readonly unknown[]): Promise<number> {
  for (const value of cases) {
    const issues = validateLearningFile('practiceCase', value)
    if (issues.length > 0) throw new TypeError(`invalid practice case: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
    const item = value as PracticeCase
    if (item.source !== 'generic' || item.split !== 'guard') throw new TypeError(`practice case ${item.id} is not a generic guard case`)
  }
  let added = 0
  for (const value of cases) {
    const item = value as PracticeCase
    if (await publishExclusive(practiceCasesDirectory(home), `${item.id}.json`, `${JSON.stringify(item, null, 2)}\n`)) added += 1
  }
  return added
}
