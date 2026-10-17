/**
 * Layer-1 reflection (ADR 0018 decision 4): one model request after a task
 * reads the run record and its evaluation, the handbook entries that bear on
 * the task and, when there is one, a similar earlier task whose outcome was
 * different, and answers with small handbook operations (add, edit, upvote,
 * downvote) as JSON. The host's curation ({@link curateReflection}) decides
 * what of it is written.
 *
 * The instructions are the improver's reflection part (ADR 0018 decision
 * 7): general, with no example drawn from any task type. `v1` keeps entries
 * short and abstract, leaves out preferences stated in one task's feedback,
 * and prefers a new entry to rewriting an old one.
 */
import type { HandbookEntry, SelfEvalOutcome, TaskCheck } from '@nexgent/kernel'
import { languageName, type LearningLanguage } from './text.js'

/** Version of the reflection instructions below. */
export const REFLECTION_PROMPT_VERSION = 'v1'

/** Output bound of the reflection request. */
export const REFLECTION_MAX_TOKENS = 4_000

/** The reflection instructions (system message). */
export function reflectionSystemPrompt(language: LearningLanguage): string {
  return `You maintain the handbook of a general-purpose agent that carries out tasks in its users' projects. The handbook holds short, reusable working practices; the most relevant ones are shown to the agent when a new task starts. After each task you read what happened and propose small operations on the handbook. You never rewrite the handbook as a whole.

What an entry is:
- One reusable practice: what to do or avoid, in which kind of situation, and why. It must still help on future tasks that differ from this one.
- Not a record of this task: no one-time requests the user made for this task (a particular format, file name, wording or extra item they asked for once), no results, and no concrete values of this task (numbers, amounts, dates, identifiers of its data). If a lesson only holds with such values, do not write it.
- Not a preference from feedback: when the user's feedback on a result asks for something about that result (shorter, longer, another language, another tone or layout), it applies to that result only. Write it as an entry only if the user said it should hold for later tasks.
- Abstract: name the kind of situation and the practice, not this task's file names, field or column names, document titles, domain terms or quoted phrases. Do not give lists of examples taken from this task.
- About the work, not about overriding the task: an entry never changes what a task asks for, how its result is delivered, or how the final reply is written.
- One practice per entry, at most 300 characters. Concrete and checkable beats general advice that any agent already follows; a long checklist is several entries or none.

How to decide:
- Start from the evidence: the evaluation, failed checks, failed tool calls, the user's feedback, and what the final answer did. An outcome marked unknown proves nothing either way.
- When a contrasting task is given (similar, but its outcome differed), ask what one run did that the other did not, and whether that difference is a reusable practice.
- Do not add a near-duplicate of an existing entry. Use "edit" only to correct an entry or make it shorter and clearer, never to append this task's details to it; an entry can be edited only a few times. A different lesson is a new entry. When a new entry replaces older ones, list their ids in "supersedes".
- Vote only on entries listed under "Entries given to this task": "upvote" when following it clearly helped this run, "downvote" when following it hurt or it was wrong here. Do not vote on other entries.
- Use scope "project" only for a convention that holds in this project alone (for example its own naming or layout rules); otherwise use "user".
- "keywords": 3 to 8 lowercase words a user would write when asking for such a task (an entry is shown only when its keywords or enough of its words appear in the task), not category names, file names or this task's values.
- Few precise operations are better than many. An empty list is a good answer when nothing reusable was learned.

Write every "text" and "reason" in ${languageName(language)}. Keep code, commands, tool names and file names as they are.

Answer with one JSON object and nothing else:
{"ops": [ ... ]}
where each element is one of
{"op": "add", "text": "...", "keywords": ["..."], "scope": "user" | "project", "supersedes": ["<entry id>"], "reason": "..."}
{"op": "edit", "entryId": "<entry id>", "text": "...", "keywords": ["..."], "reason": "..."}
{"op": "upvote", "entryId": "<entry id>", "reason": "..."}
{"op": "downvote", "entryId": "<entry id>", "reason": "..."}
("supersedes" and the "edit" fields other than "entryId" are optional; "reason" says in one sentence why.)`
}

/** The evaluation reflection is told about. */
export interface ReflectionEvaluation {
  readonly outcome: SelfEvalOutcome
  readonly score?: number
  readonly checks: readonly TaskCheck[]
  readonly rating?: number
  /** Where the evaluation came from: a written self-evaluation, or derived from checks and the user's rating. */
  readonly source: 'self-evaluation' | 'derived'
  /** Rubric items with their scores, when a self-evaluation scored them. */
  readonly rubric?: readonly { readonly text: string; readonly score?: number }[]
}

/** A similar earlier task with a different outcome. */
export interface ContrastTask {
  readonly task: string
  readonly outcome: SelfEvalOutcome
  readonly approach: string
}

/** Everything one reflection request shows. */
export interface ReflectionInput {
  readonly run: string
  readonly evaluation: ReflectionEvaluation
  readonly contrast?: ContrastTask
  /** Entries given to (or, before injection exists, retrieved for) this task: the only ones that may be voted on. */
  readonly votable: readonly HandbookEntry[]
  /** Whether `votable` were actually shown to the agent. */
  readonly shown: boolean
  /** Further entries close to the task (for edits and supersedes). */
  readonly related: readonly HandbookEntry[]
}

function entryLine(entry: HandbookEntry): string {
  return `- id ${entry.id} · ${entry.scope} · ${entry.status} · helpful ${entry.helpful} · harmful ${entry.harmful} · keywords: ${entry.keywords.join(', ')}\n  ${entry.text.replace(/\s+/g, ' ')}`
}

/** The user message of the reflection request. Pure. */
export function reflectionUserMessage(input: ReflectionInput): string {
  const e = input.evaluation
  const checks = e.checks.length === 0 ? 'none' : e.checks.map(check => `${check.passed ? 'passed' : 'FAILED'} ${check.name}${check.target === undefined ? '' : ` (${check.target})`}${check.detail === undefined ? '' : `: ${check.detail}`}`).join('; ')
  const rubric = e.rubric === undefined || e.rubric.length === 0 ? '' : `\nRubric: ${e.rubric.map(item => `${item.text} → ${item.score ?? 'not scored'}`).join('; ')}`
  const parts = [
    `# Evaluation\nOutcome: ${e.outcome}${e.score === undefined ? '' : ` (score ${e.score.toFixed(2)})`}${e.rating === undefined ? '' : ` · user rating ${e.rating}/5`}\nDeterministic checks: ${checks}${rubric}\nSource: ${e.source === 'derived' ? 'derived from the checks and the user rating (no rubric scoring yet)' : 'self-evaluation'}`,
    `# Run record\n${input.run}`,
    input.contrast === undefined
      ? '# Contrasting task\nNone found.'
      : `# Contrasting task (similar, outcome ${input.contrast.outcome})\nTask: ${input.contrast.task}\nWhat that run did: ${input.contrast.approach}`,
    `# Entries given to this task${input.shown ? '' : ' (retrieved for it; the agent was not shown them, so vote only when the run clearly confirms or contradicts one)'}\n${input.votable.length === 0 ? 'None.' : input.votable.map(entryLine).join('\n')}`,
    `# Other related entries (edit or supersede them instead of adding duplicates; do not vote on them)\n${input.related.length === 0 ? 'None.' : input.related.map(entryLine).join('\n')}`,
  ]
  return parts.join('\n\n')
}

/** One operation as the model proposed it (validated for shape only). */
export type ProposedOp =
  | { readonly op: 'add'; readonly text: string; readonly keywords: readonly string[]; readonly scope: 'user' | 'project'; readonly supersedes: readonly string[]; readonly reason?: string }
  | { readonly op: 'edit'; readonly entryId: string; readonly text?: string; readonly keywords?: readonly string[]; readonly reason?: string }
  | { readonly op: 'upvote' | 'downvote'; readonly entryId: string; readonly reason?: string }

/** What a reply parsed to. */
export interface ParsedReflection {
  readonly ops: readonly ProposedOp[]
  /** Elements that were not a valid operation. */
  readonly malformed: number
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined
}

/** The first balanced `{…}` of a text (code fences and prose around it ignored). */
function firstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Parse a reflection reply (pure).
 * @returns `undefined` when the reply holds no JSON object with an `ops` array.
 */
export function parseReflection(text: string): ParsedReflection | undefined {
  const json = firstObject(text)
  if (json === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { ops?: unknown }).ops)) return undefined
  const ops: ProposedOp[] = []
  let malformed = 0
  for (const raw of (value as { ops: unknown[] }).ops) {
    if (raw === null || typeof raw !== 'object') {
      malformed += 1
      continue
    }
    const item = raw as Record<string, unknown>
    const reason = typeof item.reason === 'string' ? { reason: item.reason } : {}
    if (item.op === 'add' && typeof item.text === 'string') {
      ops.push({ op: 'add', text: item.text, keywords: strings(item.keywords) ?? [], scope: item.scope === 'project' ? 'project' : 'user', supersedes: strings(item.supersedes) ?? [], ...reason })
    } else if (item.op === 'edit' && typeof item.entryId === 'string' && (typeof item.text === 'string' || strings(item.keywords) !== undefined)) {
      const keywords = strings(item.keywords)
      ops.push({ op: 'edit', entryId: item.entryId, ...(typeof item.text === 'string' ? { text: item.text } : {}), ...(keywords === undefined ? {} : { keywords }), ...reason })
    } else if ((item.op === 'upvote' || item.op === 'downvote') && typeof item.entryId === 'string') {
      ops.push({ op: item.op, entryId: item.entryId, ...reason })
    } else {
      malformed += 1
    }
  }
  return { ops, malformed }
}
