/**
 * One layer-2 induction (ADR 0025): read a group of similar successful
 * tasks, send one request (`purpose: 'auxiliary'`, `learningPhase:
 * 'induce'`, counted in the learning budget), curate the candidates and add
 * what passes to the user's skill library as trial versions; refused
 * candidates go to the library's failure archive, which the next induction
 * reads. Nothing is spent when a learned skill in force already matches the
 * task.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Handbook } from '@nexgent/capabilities'
import { SkillLibrary } from '@nexgent/capabilities'
import { ZERO_USAGE, type InstanceLiteralSource, type LedgerAttribution, type LLMCompleteOptions, type LLMProvider, type LLMUsage, type ProjectConfig, type SessionStore } from '@nexgent/kernel'
import { estimateUsd } from '@nexgent/llm'
import { writeJsonAtomic } from '../lock.js'
import type { LearnedTask } from '../learning/queue.js'
import { readTaskRun, renderTaskRun } from '../learning/run-record.js'
import type { LearningLanguage } from '../learning/text.js'
import { curateInduction } from './induce-curate.js'
import { inductionSystemPrompt, inductionUserMessage, parseInduction, type InductionTask } from './induce-prompt.js'
import { EMPTY_INDUCTION_STATE, INDUCTION, type InductionGroup, type InductionRun, type InductionState } from './trigger.js'

/** `<project data>/learning/skills.json`. */
export const INDUCTION_STATE_FILE = 'skills.json'

/** Read the induction state (missing or unreadable: empty). */
export async function readInductionState(path: string): Promise<InductionState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as InductionState
    if (value?.formatVersion !== 1 || value.used === null || typeof value.used !== 'object' || !Array.isArray(value.runs)) return EMPTY_INDUCTION_STATE
    return value
  } catch {
    return EMPTY_INDUCTION_STATE
  }
}

/** Write it atomically. */
export async function writeInductionState(path: string, state: InductionState): Promise<void> {
  await writeJsonAtomic(path, state)
}

/** The state file of a project's learning directory. */
export function inductionStatePath(learningDirectory: string): string {
  return join(learningDirectory, INDUCTION_STATE_FILE)
}

/** What an induction needs. */
export interface InductionServices {
  readonly llm: LLMProvider
  readonly sessions: Pick<SessionStore, 'readAll'>
  readonly signal: AbortSignal
  readonly handbook: Handbook
  readonly home: string
  readonly config: Pick<ProjectConfig, 'improvement'>
  readonly language: LearningLanguage
  /** Names of the agent's other skills (built-in, the user's, the project's). */
  readonly reservedNames: readonly string[]
  /** User messages of the project's tasks. */
  readonly projectTaskTexts: readonly string[]
  readonly now: () => Date
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function count(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

/**
 * Run one induction for a group. Throws when the request fails (the caller
 * records the failure); an abort is rethrown.
 */
export async function induceSkills(group: InductionGroup, services: InductionServices): Promise<InductionRun> {
  const library = SkillLibrary.of(services.home, { now: services.now })
  const at = () => services.now().toISOString()
  const taskIds = group.tasks.map(task => task.taskId)
  const base = { seedTaskId: group.seed.taskId, taskIds }
  if ((await library.retrieve(group.seed.task, { k: 1 })).length > 0) {
    return { ...base, at: at(), added: [], rejected: {}, detail: 'a learned skill in force already matches the task' }
  }
  const runs = await Promise.all(group.tasks.map(async (task: LearnedTask) => ({ task, run: await readTaskRun(services.sessions, task.sessionId, 1, task.throughTurn) })))
  const tasks: InductionTask[] = runs.map(({ task, run }) => ({ taskId: task.taskId, score: task.externalScore ?? 0, run: clip(renderTaskRun(run), INDUCTION.maxRunChars) }))
  const projectId = services.handbook.projectId
  const sources: InstanceLiteralSource[] = runs.flatMap(({ task, run }) => [
    { kind: 'feedback' as const, ref: `task:${task.taskId}`, text: run.task, projectId },
    ...run.messages.map(message => ({ kind: 'feedback' as const, ref: `task:${task.taskId}/turn-${message.turn}`, text: message.text, projectId })),
    ...run.feedback.map(entry => ({ kind: 'feedback' as const, ref: `feedback:${entry.id}`, text: entry.comment, projectId })),
    ...(run.answer === '' ? [] : [{ kind: 'deliverable' as const, ref: `answer:${task.taskId}`, text: run.answer, projectId }]),
  ])
  const requests = runs.flatMap(({ run }) => [run.task, ...run.messages.map(message => message.text), ...run.feedback.map(entry => entry.comment)]).filter(text => text.trim() !== '')
  const skills = await library.skills()
  const practices = (await services.handbook.retrieve(group.seed.task, { k: 5 }).catch(() => [])).map(hit => hit.entry)
  const rejectedBefore = (await library.rejected()).slice(-INDUCTION.rejectedShown)
  const model = services.config.improvement.model
  const thinking = services.config.improvement.thinking
  const attribution: LLMCompleteOptions & LedgerAttribution = { purpose: 'auxiliary', taskId: group.seed.taskId, learningPhase: 'induce' }
  let text = ''
  let usage: LLMUsage = ZERO_USAGE
  let failure: string | undefined
  let finish: string | undefined
  for await (const event of services.llm.complete({
    requestId: randomUUID(),
    model,
    thinking,
    maxTokens: thinking === 'off' ? INDUCTION.maxTokens : INDUCTION.maxTokens * 2,
    messages: [
      { role: 'system', content: inductionSystemPrompt(services.language) },
      { role: 'user', content: inductionUserMessage({ tasks, skills, reservedNames: services.reservedNames, practices, rejected: rejectedBefore }) },
    ],
    signal: services.signal,
  }, attribution)) {
    if (event.type === 'text.delta') text += event.text
    else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
    else if (event.type === 'done') finish = event.finishReason
  }
  if (finish === 'aborted' || services.signal.aborted) throw new Error('induction request was aborted')
  if (failure !== undefined) throw new Error(`induction request failed: ${failure}`)
  const usd = estimateUsd(model, usage)
  const spent = usd === 'unknown' ? {} : { usd }
  const parsed = parseInduction(text)
  if (parsed === undefined) {
    await library.reject([{ projectId, group: group.seed.taskId, reason: 'malformed', detail: `the reply was not the JSON asked for (${finish ?? 'no finish reason'})` }])
    return { ...base, at: at(), added: [], rejected: { malformed: 1 }, ...spent }
  }
  const curated = curateInduction(parsed.skills, { skills, reservedNames: services.reservedNames, sources, requests, taskTexts: [...services.projectTaskTexts, ...requests] })
  const added: string[] = []
  const refused = curated.rejected.map(entry => ({ projectId, group: group.seed.taskId, name: entry.skill.name, description: clip(entry.skill.description, 300), reason: entry.reason, detail: clip(entry.detail, 300) }))
  for (const skill of curated.accepted) {
    try {
      const written = await library.add({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        body: skill.body,
        ...(skill.replaces === undefined ? {} : { replaces: skill.replaces }),
        sources: runs.map(({ task }) => ({ projectId, taskId: task.taskId, sessionId: task.sessionId })),
        reason: `induced from ${runs.length} similar successful tasks`,
      })
      added.push(written.id)
    } catch (error) {
      refused.push({ projectId, group: group.seed.taskId, name: skill.name, description: clip(skill.description, 300), reason: 'malformed', detail: clip(error instanceof Error ? error.message : String(error), 300) })
    }
  }
  await library.reject(refused)
  return {
    ...base,
    at: at(),
    added,
    rejected: { ...count(refused.map(entry => entry.reason)), ...(parsed.malformed > 0 ? { malformed: (count(refused.map(entry => entry.reason))['malformed'] ?? 0) + parsed.malformed } : {}) },
    ...spent,
  }
}
