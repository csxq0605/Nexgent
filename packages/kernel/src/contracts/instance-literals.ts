/**
 * ADR 0013 decision 2: the instance-literal check. A component (or an
 * improver change, ADR 0012 decision 5) must not carry the concrete values
 * of the task it was learned from: a number with a decimal point, an
 * integer of three or more digits, a date or a year-month that appears in
 * the job's feedback text or the feedback task's deliverables, unless the
 * same value appears in the user messages of at least two different tasks
 * of the project history (then it is a project constant, e.g. a fixed
 * threshold).
 *
 * Pure: the host gathers the texts (`@nexgent/capabilities` at
 * `capability_propose` and before a gate replays, `@nexgent/evolve` at
 * the deleted `improve_propose_change`). Names, column names and file-naming rules are
 * never literals here: conventions are what project rules are for.
 *
 * Normative text: `docs/spec/data-formats.md` §候选与门控 (具体数值检查).
 */

/** What kind of value a literal token is. */
export type InstanceLiteralKind = 'decimal' | 'integer' | 'date'

/** Every {@link InstanceLiteralKind}. */
export const INSTANCE_LITERAL_KINDS: readonly InstanceLiteralKind[] = ['decimal', 'integer', 'date']

/** One literal token found in a text. */
export interface InstanceLiteralToken {
  readonly value: string
  readonly kind: InstanceLiteralKind
}

/**
 * Literal tokens: `yyyy-mm-dd`, `yyyy-mm`, a decimal `d+.d+`, or an integer
 * of three or more digits. A token never starts right after a letter, digit,
 * `_` or `.` and never ends right before a digit, `_`, `.digit` or `-digit`,
 * so `sha256`, `v1.2.3`, `x86_64` and `utf-8` give none, while `2384.13USD`
 * and the date of `2026-10-05T08:00` count. Thousands separators are removed
 * first (`2,384.13` reads as `2384.13`).
 */
const TOKEN = /(?<![\p{L}\p{N}_.])(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d+\.\d+|\d{3,})(?![\p{N}_]|\.\d|-\d)/gu
const THOUSANDS = /(?<=\d),(?=\d{3}(?!\d))/g

/** The literal tokens of a text, in order, without duplicates. Pure. */
export function literalTokens(text: string): InstanceLiteralToken[] {
  const seen = new Set<string>()
  const tokens: InstanceLiteralToken[] = []
  for (const match of text.replace(THOUSANDS, '').matchAll(TOKEN)) {
    const value = match[1]!
    if (seen.has(value)) continue
    seen.add(value)
    tokens.push({ value, kind: value.includes('-') ? 'date' : value.includes('.') ? 'decimal' : 'integer' })
  }
  return tokens
}

/** One text the checked component (or change) consists of. */
export interface InstanceLiteralText {
  /** The component file (component-relative path) or the change field, e.g. `SKILL.md`, `diagnosis.paragraphs[3]`. */
  readonly path: string
  readonly text: string
}

/** Where the task's concrete values come from. */
export interface InstanceLiteralSource {
  /** `feedback`: a feedback entry's text; `deliverable`: a file of a deliverable version of the feedback task. */
  readonly kind: 'feedback' | 'deliverable'
  /** A label for the hit, e.g. `feedback:<feedbackId>` or `deliverable:<deliverableId>/v2/report.md`. */
  readonly ref: string
  readonly text: string
  /** ADR 0012: the project it comes from (meta jobs read several); absent for one project. */
  readonly projectId?: string
}

/** One user message of the project history, with its root task. */
export interface ProjectTaskMessage {
  readonly taskId: string
  readonly text: string
  readonly projectId?: string
}

/** One hit: a value of the component that is the task's, not the project's. */
export interface InstanceLiteralHit {
  readonly value: string
  readonly kind: InstanceLiteralKind
  /** The component file or change field it appears in. */
  readonly path: string
  /** The first source (in input order) it appears in. */
  readonly source: string
}

/** Distinct tasks whose user messages must carry a value for it to count as a project constant. */
export const PROJECT_CONSTANT_MIN_TASKS = 2

/**
 * ADR 0013 decision 2 (pure): every literal token of the component texts
 * that also appears in a source and in the user messages of fewer than
 * {@link PROJECT_CONSTANT_MIN_TASKS} distinct tasks. Values are compared as
 * written (`2384.1` and `2384.10` differ). One hit per value and path, in
 * component-text order. Empty means the component passes. With
 * `projectId` set on sources and messages, a constant counts only within its
 * own project.
 */
export function findInstanceLiterals(
  componentTexts: readonly InstanceLiteralText[],
  sources: readonly InstanceLiteralSource[],
  projectMessages: readonly ProjectTaskMessage[],
): InstanceLiteralHit[] {
  const sourceOf = new Map<string, InstanceLiteralSource[]>()
  for (const source of sources) {
    for (const token of literalTokens(source.text)) {
      const list = sourceOf.get(token.value)
      if (list === undefined) sourceOf.set(token.value, [source])
      else list.push(source)
    }
  }
  const tasksOf = new Map<string, Set<string>>()
  for (const message of projectMessages) {
    for (const token of literalTokens(message.text)) {
      const key = `${message.projectId ?? ''}\u0000${token.value}`
      const set = tasksOf.get(key) ?? new Set<string>()
      set.add(message.taskId)
      tasksOf.set(key, set)
    }
  }
  const hits: InstanceLiteralHit[] = []
  for (const component of componentTexts) {
    for (const token of literalTokens(component.text)) {
      const from = (sourceOf.get(token.value) ?? []).find(source => (tasksOf.get(`${source.projectId ?? ''}\u0000${token.value}`)?.size ?? 0) < PROJECT_CONSTANT_MIN_TASKS)
      if (from !== undefined) hits.push({ value: token.value, kind: token.kind, path: component.path, source: from.ref })
    }
  }
  return hits
}
