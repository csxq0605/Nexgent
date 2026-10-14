// @ts-check
/**
 * Simulated user feedback for the pilot (ADR 0011 decision 4): filled from fixed templates
 * by the rubric points the deterministic checks found unmet, never written by a model, so
 * a rerun sends the same words.
 *
 * - Only checked points (`by: 'check'`) feed feedback. Review points are the external
 *   reviewer's, and the external reviewer stays out of the improvement loop.
 * - Failed case: three counted entries (rating 2, no rating, rating 3) about the most
 *   important unmet point, each worded differently; every other unmet point gets one
 *   short sentence in the first entry.
 * - The taste point is said in the first entry whenever the deliverable does not match
 *   it, failed case or not. It is never scored, so a diagnosis that turns it into a
 *   standing rule is learning a one-off preference.
 * - Passed case: one entry that does not count (rating 5, or 4 with the taste remark).
 * - Unknown check result: no feedback.
 *
 * Counting follows `../feedback.mjs` (a rating of 3 or less, or a comment without a rating).
 *
 * Linux, macOS and Windows; no dependencies.
 */

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').PilotJudge} PilotJudge
 * @typedef {import('../feedback.mjs').FeedbackEntry} FeedbackEntry
 */

/** Which unmet point leads, by type. */
export const PRIORITY = ['missing', 'wrong-result', 'unverified', 'format', 'convention']

/** Three wordings per point type; `{detail}` is the point's `feedback` text. */
export const TEMPLATES = {
  missing: ['{detail}。', '{detail}，这是任务里要的。', '请对照任务要求检查一遍，这次{detail}。'],
  'wrong-result': ['结果不对：{detail}。', '{detail}，请重新做一遍。', '这次的结果还是有错（{detail}），交之前请核对。'],
  unverified: ['{detail}。', '交之前请自己核对一遍，这次{detail}。', '又出现了没核对的问题：{detail}。以后交之前都要核对。'],
  format: ['格式不对：{detail}。', '{detail}，请按要求的格式来。', '格式还是有问题（{detail}）。'],
  convention: ['{detail}。', '我们这边一直有这个习惯，这次{detail}。', '又是这样：{detail}。以后都要注意。'],
}

export const SECONDARY = '另外，{detail}。'
export const TASTE = '还有，{detail}。'
export const PRAISE = '这次的结果没问题，谢谢。'
export const RATINGS = /** @type {const} */ ([2, undefined, 3])

const fill = (/** @type {string} */ template, /** @type {string} */ detail) => template.replaceAll('{detail}', detail)

/**
 * Feedback for one finished pilot case.
 * @param {PilotCase} task
 * @param {PilotJudge} judged deterministic points filled; review points may be unknown
 * @param {boolean | null} tasteMet whether the deliverable matches the taste point (`null`: unknown, not said)
 * @returns {{ primary: string | null, entries: FeedbackEntry[] }}
 */
export function pilotFeedback(task, judged, tasteMet) {
  const checked = judged.points.filter(point => point.by === 'check')
  if (checked.some(point => point.pass === null)) return { primary: null, entries: [] }
  const taste = task.rubric.find(point => point.type === 'taste')
  const tasteLine = taste !== undefined && tasteMet === false ? fill(TASTE, taste.feedback) : ''
  const failed = checked.filter(point => point.pass === false)
    .map(point => /** @type {import('./common.mjs').Point} */ (task.rubric.find(p => p.id === point.id)))
    .sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type) || task.rubric.indexOf(a) - task.rubric.indexOf(b))
  if (failed.length === 0) {
    return { primary: null, entries: [tasteLine === '' ? { key: 'praise', rating: 5, comment: PRAISE } : { key: 'praise', rating: 4, comment: `${PRAISE}${tasteLine}` }] }
  }
  const [primary, ...rest] = failed
  const templates = /** @type {Record<string, string[]>} */ (TEMPLATES)[primary.type]
  const entries = templates.map((template, index) => {
    let comment = fill(template, primary.feedback)
    if (index === 0) {
      for (const point of rest) comment += fill(SECONDARY, point.feedback)
      comment += tasteLine
    }
    const rating = RATINGS[index]
    return rating === undefined ? { key: `fb${index + 1}`, comment } : { key: `fb${index + 1}`, rating, comment }
  })
  return { primary: primary.id, entries }
}
