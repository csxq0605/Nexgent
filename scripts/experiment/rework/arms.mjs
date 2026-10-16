// @ts-check
/**
 * The six arms of ADR 0019 §8 and how each one's holdout state is made.
 *
 *   base       nothing learned: a fresh project, an empty NEXGENT_HOME
 *   format     the injection slot without content: a fresh project with one context policy
 *              whose text is a fixed, empty handbook frame (controls for "a block was added
 *              to the prompt")
 *   notes      the user's feedback recorded verbatim: a fresh project with one context
 *              policy holding the training stream's counted feedback, oldest first
 *   L1         the handbook only: the training stream's NEXGENT_HOME with skills removed
 *   L1+L2      the handbook and the skill library: the training stream's NEXGENT_HOME
 *   L1+L2+L3   plus the framework from one offline evolution run (M4)
 *
 * One training stream feeds every arm (learning on when a learning arm is available), so
 * notes, L1 and L1+L2 retain the same experience in different ways; base and format do
 * not depend on it. Holdout runs are in a fresh project per run, so whatever transfers to
 * an unseen task type goes through the user level (ADR 0018 decision 8), and learning is
 * frozen while they run.
 *
 * base, format and notes work on the product as it is. The learning arms need product
 * parts that later packages build (V1/E1 handbook and reflection, V2/E2 skills, V3/E3
 * framework, and a "use without learning" switch for holdout runs); until their adapter
 * is written and frozen at M2, `unavailable` names what is missing and the orchestration
 * skips the arm. For rehearsals only, `standIn` gives each learning arm a fixed context
 * policy so the whole six-arm flow, records and report can be exercised; stand-in arms are
 * marked in every record and never count as a result.
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
  L1: ['V1 用户级经验手册存储与检索注入', 'E1 每个任务后的反思与整理', '留出运行时“只用不学”的开关'],
  'L1+L2': ['L1 的全部', 'V2 技能库', 'E2 第 2 层归纳', '能从 NEXGENT_HOME 里只去掉技能（给 L1 臂）'],
  'L1+L2+L3': ['L1+L2 的全部', 'V3 框架版本存储', 'E3 第 3 层离线运行'],
})

/** The format arm's policy: the frame a handbook would be shown in, with no entry. */
export const FORMAT_POLICY = Object.freeze({
  name: 'experience-frame',
  description: '经验手册（格式对照，无内容）',
  instructions: '经验手册\n\n（本项目目前没有记录的经验条目。）\n',
})

/** Stand-in policies of the learning arms (rehearsal only; fixed text, not learned). */
export const STAND_IN_POLICY = Object.freeze({
  name: 'rehearsal-stand-in',
  description: '演练替身（不是学到的内容）',
  title: '演练替身',
})

/**
 * Which learning arms can run on the loaded packages. Nothing here can: the adapters are
 * written when V1/E1 (and later V2/E2, V3/E3) land, and frozen with the orchestration at
 * M2. Kept as a function so that change is one place.
 * @param {any} _pkgs
 * @returns {Record<Arm, { available: boolean, reason: string | null }>}
 */
export function armSupport(_pkgs) {
  /** @type {Record<string, { available: boolean, reason: string | null }>} */
  const out = {}
  for (const arm of ARMS) {
    out[arm] = ARM_NEEDS[arm].length === 0
      ? { available: true, reason: null }
      : { available: false, reason: `需要：${ARM_NEEDS[arm].join('；')}（M2 冻结编排时接上）` }
  }
  return /** @type {Record<Arm, { available: boolean, reason: string | null }>} */ (out)
}

/** Whether an arm learns in the training stream (as opposed to being built from it afterwards). @param {Arm} arm */
export const isLearningArm = arm => arm === 'L1' || arm === 'L1+L2' || arm === 'L1+L2+L3'
