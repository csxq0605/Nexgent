// @ts-check
/**
 * The six arms of ADR 0019 §8 and how each one's holdout state is made.
 *
 *   base       nothing learned: a fresh project, an empty NEXGENT_HOME
 *   format     the handbook's frame without content, where the handbook goes: the handbook
 *              header and "no entries" before the task message (controls for "a block was
 *              added to the first message")
 *   notes      the user's feedback recorded verbatim, where the handbook goes: every counted
 *              feedback entry of the training stream, oldest first, under a header, before
 *              the task message
 *   L1         the handbook only: a fresh project under a copy of the training stream's
 *              NEXGENT_HOME (its user level: handbook, settings; skills removed once V2
 *              has them), the product's own retrieval and injection (top entries for the
 *              task, before its user message)
 *   L1+L2      the handbook and the skill library: the training stream's NEXGENT_HOME
 *   L1+L2+L3   plus the framework from one offline evolution run (M4)
 *
 * Position (M2 freeze): V1 moved the handbook out of the system prompt into a message
 * before the root task's user message, merged into the same user turn on the wire
 * (`packages/llm/src/wire.ts`). format and notes are put in that same place: their text
 * is prepended to the task message (`firstMessage`), so the only difference between
 * notes and L1 is what the text is (raw feedback, all of it, vs. learned entries,
 * retrieved), not where it stands. The notes arm keeps all of the feedback (the old
 * pilot's "whole policy" behaviour) rather than going through the handbook's top-5
 * retrieval, so it stays the strong baseline ADR 0019 asks L1 to beat.
 *
 * One training stream feeds every arm (learning on when a learning arm can run), so
 * notes, L1 and L1+L2 retain the same experience in different ways; base and format do
 * not depend on it. Holdout runs are in a fresh project per run, so whatever transfers to
 * an unseen task type goes through the user level (ADR 0018 decision 8), and learning is
 * off while they run (retrieval does not depend on it: `Handbook.retrieve` reads the
 * user level whenever `learning.useShared`, default on).
 *
 * L1 runs on the product as built (V1 handbook, E1 learning). L1+L2 and L1+L2+L3 need
 * parts later packages build; until their adapter is written `unavailable` names what is
 * missing and the orchestration skips the arm. For rehearsals only, `standIn` gives such
 * an arm a fixed first-message text so the flow, records and report can be exercised;
 * stand-in arms are marked in every record and never count as a result.
 *
 * Linux, macOS and Windows; no dependencies.
 */

export const ARMS = /** @type {const} */ (['base', 'format', 'notes', 'L1', 'L1+L2', 'L1+L2+L3'])

/** @typedef {typeof ARMS[number]} Arm */

/** What each arm needs from the product, by plan package. */
export const ARM_NEEDS = /** @type {Record<Arm, string[]>} */ ({
  base: [],
  format: [],
  notes: [],
  L1: [],
  'L1+L2': ['L1 的全部', 'V2 技能库', 'E2 第 2 层归纳', '能从 NEXGENT_HOME 里只去掉技能（给 L1 臂）'],
  'L1+L2+L3': ['L1+L2 的全部', 'V3 框架版本存储', 'E3 第 3 层离线运行'],
})

/**
 * The handbook's opening line (`HANDBOOK_INJECT_HEADER` in packages/capabilities/src/handbook/host.ts;
 * a test keeps the copy equal).
 */
export const HANDBOOK_HEADER = 'Experience from earlier tasks (handbook). Use what fits this task and ignore the rest. If an entry clearly helped or misled you, say so with handbook_mark.'

/** The format arm's text: the handbook's frame with no entry. */
export const FORMAT_TEXT = `${HANDBOOK_HEADER}\n(No entries yet.)`

/** The notes arm's header (the handbook's wording, saying what the lines are). */
export const NOTES_HEADER = "Experience from earlier tasks (the user's feedback on earlier results, verbatim). Use what fits this task and ignore the rest."

/** Limit of the notes text (the old context-policy limit, `CAPABILITY_LIMITS.maxInstructionBytes`). */
export const NOTES_MAX_BYTES = 16_384

/**
 * The notes arm's text: every counted feedback entry, oldest first; when too long, the
 * oldest are dropped.
 * @param {ReadonlyArray<{ at: string, comment: string }>} entries
 * @returns {{ text: string, kept: number, dropped: number }}
 */
export function notesText(entries) {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const render = (/** @type {typeof ordered} */ list) => [NOTES_HEADER, ...list.map(entry => `- ${entry.comment.replace(/\s*\n\s*/g, ' ')}`)].join('\n')
  let start = 0
  while (start < ordered.length && Buffer.byteLength(render(ordered.slice(start))) > NOTES_MAX_BYTES) start += 1
  return { text: ordered.length - start === 0 ? '' : render(ordered.slice(start)), kept: ordered.length - start, dropped: start }
}

/**
 * The first message of a holdout run: the arm's text, a blank line, the task message.
 * @param {string} prefix the arm's text ('' for none)
 * @param {string} message
 */
export const firstMessage = (prefix, message) => (prefix === '' ? message : `${prefix}\n\n${message}`)

/** Stand-in text of an arm without an adapter (rehearsal only; fixed text, not learned). */
export const STAND_IN_TITLE = '演练替身'
/** @param {string} arm */
export const standInText = arm => `${STAND_IN_TITLE}：${arm}\n这是演练用的固定文字，不是学到的内容。`

/**
 * Which arms can run on the loaded packages: L1 needs the handbook (`@nexgent/capabilities`
 * `Handbook`) and the learner (`@nexgent/evolve` `LearningHost`); L1+L2 and L1+L2+L3 have
 * no adapter yet.
 * @param {any} pkgs
 * @returns {Record<Arm, { available: boolean, reason: string | null }>}
 */
export function armSupport(pkgs) {
  /** @type {Record<string, { available: boolean, reason: string | null }>} */
  const out = {}
  const l1 = typeof pkgs?.capabilities?.Handbook === 'function' && typeof pkgs?.evolve?.LearningHost === 'function'
  for (const arm of ARMS) {
    if (arm === 'L1' && !l1) out[arm] = { available: false, reason: '需要：已构建的 @nexgent/capabilities Handbook 与 @nexgent/evolve LearningHost' }
    else out[arm] = ARM_NEEDS[arm].length === 0
      ? { available: true, reason: null }
      : { available: false, reason: `需要：${ARM_NEEDS[arm].join('；')}（适配写好后另行冻结）` }
  }
  return /** @type {Record<Arm, { available: boolean, reason: string | null }>} */ (out)
}

/** Whether an arm learns in the training stream (as opposed to being built from it afterwards). @param {Arm} arm */
export const isLearningArm = arm => arm === 'L1' || arm === 'L1+L2' || arm === 'L1+L2+L3'
