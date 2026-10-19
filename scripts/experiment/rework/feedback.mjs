// @ts-check
/**
 * Simulated human feedback of the rework training stream (evolution-gap-analysis.md §6:
 * half the training cases get it, the rest carry only the product's own signals). Filled
 * from the step-6 pilot's fixed templates by the checked points a run failed, never
 * written by a model, so a rerun sends the same words:
 *
 * - failed case: three counted entries (rating 2, no rating, rating 3) about the most
 *   important unmet point, worded differently; every other unmet point gets one sentence in
 *   the first entry;
 * - the one-off preference (`taste`), when the case has one, is said in the first entry
 *   (counted or praise), whatever the deliverable looks like — it is never scored, so a
 *   learner that keeps it as a rule learns noise;
 * - passed case: one entry that does not count (rating 5, or 4 with the preference);
 * - an unknown check: no feedback.
 *
 * The `notes` arm's text is the counted entries, oldest first (arms.mjs `notesText`).
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { counts } from '../step6/feedback.mjs'
import { pilotFeedback, PRAISE, PRIORITY, RATINGS, SECONDARY, TASTE, TEMPLATES } from '../step6/pilot/feedback.mjs'

export { counts, PRAISE, PRIORITY, RATINGS, SECONDARY, TASTE, TEMPLATES }

/**
 * @typedef {import('./common.mjs').ReworkCase} ReworkCase
 * @typedef {import('./common.mjs').Judged} Judged
 * @typedef {import('../step6/feedback.mjs').FeedbackEntry} FeedbackEntry
 */

/**
 * Feedback for one finished training case.
 * @param {ReworkCase} task
 * @param {Judged} judged
 * @returns {{ primary: string | null, entries: FeedbackEntry[] }}
 */
export function caseFeedback(task, judged) {
  // The pilot's function takes "taste met?"; `false` makes it say the preference whenever
  // the case has one, which is what this experiment wants (no taste detector).
  return pilotFeedback(/** @type {any} */ (task), /** @type {any} */ (judged), false)
}
