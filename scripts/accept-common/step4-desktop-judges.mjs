/**
 * The D15–D18 judges of accept-step4: each decides one desktop item from the
 * observations step4-desktop.mjs collected. Pure, like the H judges, so each
 * is tested against a broken copy of a real run
 * (packages/test-support/tests/accept-step4-desktop.spec.ts).
 */
import { verdict } from './step2-judges.mjs'
import { CAPABILITY_TEXTS, OLD_CAPABILITY_ENTRIES, PLUGIN_NAME } from './step4-desktop.mjs'

// Updated 2026-10-19: the 能力 page no longer shows the version panel, the
// candidate list, the revision list or the rollback button. The judges read
// the capability data the renderer gets from `capabilities.list` and require
// that the 能力 page shows none of the removed entries.

const consoleErrors = obs => [...(obs.consoleErrors?.first ?? []), ...(obs.consoleErrors?.second ?? [])]
const candidateOf = (panel, id) => (panel?.candidates ?? []).find(c => c?.id === id)
const sessionsAdded = (before, after) => Object.keys(after ?? {}).filter(id => !(id in (before ?? {})))
const historyTypes = history => (history ?? []).map(r => r.type)
/** Removed 能力-page entries still shown; a missing count is not proof of absence. */
const oldShown = entries => OLD_CAPABILITY_ENTRIES.filter(id => entries?.[id] !== 0)

function withScenario(obs, result) {
  if (result.status !== 'failed' || obs.error === undefined) return result
  return { ...result, evidence: `${result.evidence} (capabilities scenario stopped at ${obs.error.step}: ${String(obs.error.message).split('\n')[0]})` }
}

export const CAPABILITY_JUDGES = {
  D15(obs) {
    const A = obs.seed?.A
    const before = obs.before ?? {}
    const after = obs.after ?? {}
    const first = Object.values(obs.firstSessions ?? {})
    const added = sessionsAdded(obs.firstSessions, obs.secondSessions)
    return verdict([
      [before.version === 'baseline' && before.revision === 0, `before any adoption the project is on the baseline (got ${JSON.stringify([before.version, before.revision])})`],
      // The project's coordinator conversation is created on open, so the first window has it besides the conversation used.
      [first.length >= 1 && first.every(version => version === 'baseline'), `the first conversations run on the baseline (got ${JSON.stringify(first)})`],
      [A !== undefined && after.version === A.version, `after the adoption the current version is ${A?.version?.slice(0, 12)} (got ${JSON.stringify(after.version)})`],
      [after.revision === 3, `with its revision number (got ${after.revision})`],
      [Array.isArray(after.components) && after.components.includes('order-summary'), `and its components (got ${JSON.stringify(after.components)})`],
      [after.problem === null, `no load problem (got ${JSON.stringify(after.problem)})`],
      [added.length === 1 && obs.secondSessions[added[0]] === A?.version, `the new conversation's session.start carries that version (got ${JSON.stringify(added.map(id => obs.secondSessions[id]))})`],
      [Object.keys(obs.firstSessions ?? {}).length > 0 && Object.keys(obs.firstSessions ?? {}).every(id => obs.secondSessions?.[id] === 'baseline'), 'the earlier conversations keep the baseline'],
      [oldShown(after.oldEntries).length === 0, `the 能力 page no longer shows the version panel (still shown: ${JSON.stringify(oldShown(after.oldEntries))})`],
    ], `the project ran on the baseline, then on ${A?.version?.slice(0, 12)} once it was adopted; the 能力 page shows none of the removed entries`)
  },

  D16(obs) {
    const s = obs.seed ?? {}
    const after = obs.after ?? {}
    const want = [['A', 'adopted'], ['R', 'rejected'], ['T', 'trialing'], ['B', 'rolled-back']]
    const conditions = want.map(([key, status]) => {
      const c = candidateOf(after, s[key]?.id)
      return [c?.status === status, `candidate ${key} is ${status} (got ${JSON.stringify(c?.status)})`]
    })
    const detail = candidateOf(after, s.R?.id)?.detail
    conditions.push(
      [typeof detail === 'string' && detail.includes(CAPABILITY_TEXTS.rejectDetail), `the rejected candidate keeps the gate's reason (got ${JSON.stringify(detail)})`],
      [oldShown(after.oldEntries).length === 0, `the 能力 page no longer shows the candidate list (still shown: ${JSON.stringify(oldShown(after.oldEntries))})`],
    )
    return verdict(conditions, 'trialing, adopted, rejected and rolled-back candidates keep their status and the rejection reason in the project; the 能力 page shows no candidate list')
  },

  D17(obs) {
    const P = obs.seed?.P
    const A = obs.seed?.A
    const status = candidateOf(obs.after, P?.id)
    const decisions = obs.afterOpen?.decisions ?? []
    return verdict([
      [obs.dialogs?.afterNewSession === 0, `a new conversation shows no approval dialog (got ${obs.dialogs?.afterNewSession})`],
      [status?.status === 'awaiting-approval', `the plugin candidate that waited for approval (old data) is left as it was (got ${JSON.stringify(status?.status)})`],
      [decisions.length === 1 && decisions[0].outcome === 'awaiting-approval', `and no decision was added for it (got ${JSON.stringify(decisions)})`],
      [(obs.afterOpen?.history ?? []).length === (obs.seededHistory ?? []).length && obs.after?.version === A?.version, 'the adopted version did not change'],
      [obs.pluginRan === false, 'the plugin code never ran'],
      [obs.restart?.dialogs === 0, `no dialog after a restart either (got ${obs.restart?.dialogs})`],
    ], `no approval dialog appeared for the old awaiting-approval plugin candidate ${PLUGIN_NAME}; it stayed as it was and nothing ran`)
  },

  D18(obs) {
    const rb = obs.rolledBack ?? {}
    const r = obs.restart ?? {}
    const result = obs.rollbackResult ?? {}
    const last = (rb.history ?? []).at(-1)
    return verdict([
      [last?.type === 'rollback' && last?.trigger === 'manual', `the manual rollback appended a manual rollback revision (got ${JSON.stringify(last)})`],
      [result.version === last?.version && result.revision === last?.revision, `the rollback call returned the history's tail (returned ${result.version} r${result.revision}, history ${last?.version} r${last?.revision})`],
      [rb.version === last?.version && rb.revision === last?.revision, `the current version is the history's tail (current ${rb.version} r${rb.revision})`],
      [rb.version === 'baseline', `rolling back from the adopted version returns to the previous one, the baseline (got ${JSON.stringify(rb.version)})`],
      [rb.trigger === 'manual', `the current version says the change was manual (got ${JSON.stringify(rb.trigger)})`],
      [JSON.stringify(rb.revisions) === JSON.stringify(historyTypes(rb.history)), `the listed revisions match the adoption history (listed ${JSON.stringify(rb.revisions)}, history ${JSON.stringify(historyTypes(rb.history))})`],
      [r.version === rb.version && r.revision === rb.revision, `after a restart the same version and revision (got ${r.version} r${r.revision})`],
      [JSON.stringify(r.revisions) === JSON.stringify(historyTypes(r.history)) && JSON.stringify(r.history) === JSON.stringify(rb.history), 'after a restart the revisions still match the unchanged history'],
      [oldShown(r.oldEntries).length === 0, `after a restart the 能力 page shows none of the removed entries (still shown: ${JSON.stringify(oldShown(r.oldEntries))})`],
      [consoleErrors(obs).length === 0, `no renderer console errors (got ${consoleErrors(obs).slice(0, 3).join(' | ')})`],
    ], `a manual rollback returned to ${rb.version} r${rb.revision}, matching the adoption history, and the same after a restart`)
  },
}

/**
 * Judge one of D15–D18 from the capabilities observations; a throw is a failure, never a pass.
 * @returns `{ status, evidence }`.
 */
export function judgeCapabilities(id, obs) {
  const fn = CAPABILITY_JUDGES[id]
  if (fn === undefined) return { status: 'not-implemented', evidence: 'no judge' }
  try {
    return withScenario(obs ?? {}, fn(obs ?? {}))
  } catch (error) {
    return { status: 'failed', evidence: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
