/**
 * The D15–D18 judges of accept-step4: each decides one desktop item from the
 * observations step4-desktop.mjs collected. Pure, like the H judges, so each
 * is tested against a broken copy of a real run
 * (packages/test-support/tests/accept-step4-desktop.spec.ts).
 */
import { verdict } from './step2-judges.mjs'
import { CAPABILITY_TEXTS, PLUGIN_NAME } from './step4-desktop.mjs'

/** Candidate status labels of the 能力 tab (apps/desktop strings.ts `candidateStatusText`). */
export const STATUS_LABELS = { adopted: '已采用', rejected: '未采用', trialing: '门控试验中', 'rolled-back': '已回滚' }
/** The 能力 tab's label for the baseline. */
export const BASELINE_LABEL = '基线（未采用任何能力包）'

const consoleErrors = obs => [...(obs.consoleErrors?.first ?? []), ...(obs.consoleErrors?.second ?? [])]
const candidateOf = (panel, id) => (panel?.candidates ?? []).find(c => c?.id === id)
const sessionsAdded = (before, after) => Object.keys(after ?? {}).filter(id => !(id in (before ?? {})))
/** The 能力 tab lists revisions newest first; the store's history is oldest first. */
const historyTypes = history => (history ?? []).map(r => r.type).reverse()

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
      [before.version === 'baseline' && before.label === BASELINE_LABEL, `before any adoption the tab shows the baseline (got ${JSON.stringify([before.version, before.label])})`],
      [first.length === 1 && first[0] === 'baseline', `the first conversation runs on the baseline (got ${JSON.stringify(first)})`],
      [A !== undefined && after.version === A.version && after.label === A.version.slice(0, 12), `after the adoption a new conversation shows version ${A?.version?.slice(0, 12)} (got ${JSON.stringify([after.version, after.label])})`],
      [after.revision === '3', `with its revision number (got ${after.revision})`],
      [typeof after.components === 'string' && after.components.includes('order-summary'), `and its components (got ${JSON.stringify(after.components)})`],
      [after.problem === null, `no problem banner (got ${JSON.stringify(after.problem)})`],
      [added.length === 1 && obs.secondSessions[added[0]] === A?.version, `the new conversation's session.start carries that version (got ${JSON.stringify(added.map(id => obs.secondSessions[id]))})`],
      [obs.secondSessions?.[Object.keys(obs.firstSessions ?? {})[0]] === 'baseline', 'the earlier conversation keeps the baseline'],
    ], `the right panel showed the baseline, then ${A?.version?.slice(0, 12)} once it was adopted; the new conversation ran on it`)
  },

  D16(obs) {
    const s = obs.seed ?? {}
    const after = obs.after ?? {}
    const want = [['A', 'adopted'], ['R', 'rejected'], ['T', 'trialing'], ['B', 'rolled-back']]
    const conditions = want.map(([key, status]) => {
      const c = candidateOf(after, s[key]?.id)
      return [c?.status === status && c?.label === STATUS_LABELS[status], `candidate ${key} reads ${status} / ${STATUS_LABELS[status]} (got ${JSON.stringify(c && [c.status, c.label])})`]
    })
    conditions.push(
      [candidateOf(after, s.R?.id)?.reasonShown === false, 'the reason is folded until the candidate is opened'],
      [typeof obs.reason === 'string' && obs.reason.includes(CAPABILITY_TEXTS.rejectDetail), `opening the rejected candidate shows the gate's reason (got ${JSON.stringify(obs.reason)})`],
    )
    return verdict(conditions, 'trialing, adopted, rejected and rolled-back candidates each show their status; the rejection reason opens on click')
  },

  D17(obs) {
    const P = obs.seed?.P
    const A = obs.seed?.A
    const d = obs.dialog ?? {}
    const status = candidateOf(obs.after, P?.id)
    const decisions = obs.afterDeny?.decisions ?? []
    return verdict([
      [d.names === PLUGIN_NAME, `the approval dialog names the plugin (got ${JSON.stringify(d.names)})`],
      [P !== undefined && d.hash === P.version, `and shows the candidate bundle's hash (got ${JSON.stringify(d.hash)})`],
      [typeof d.files === 'string' && d.files.includes(`${PLUGIN_NAME}/plugin.json`), 'and its files'],
      [d.detached === true, 'denying closes the dialog'],
      [status?.status === 'rejected' && status?.label === STATUS_LABELS.rejected, `after the denial the candidate reads 未采用 (got ${JSON.stringify(status && [status.status, status.label])})`],
      [decisions.some(x => x.outcome === 'rejected' && x.reason === 'approval-denied'), `a rejected / approval-denied decision was recorded (got ${JSON.stringify(decisions)})`],
      [(obs.afterDeny?.history ?? []).length === (obs.seededHistory ?? []).length && obs.after?.version === A?.version, 'the adopted version did not change'],
      [obs.pluginRan === false, 'the plugin code never ran'],
      [obs.restart?.dialogs === 0, `the dialog does not come back after a restart (got ${obs.restart?.dialogs})`],
    ], `the plugin approval dialog showed ${PLUGIN_NAME} and its hash; denying left it not adopted and nothing ran`)
  },

  D18(obs) {
    const rb = obs.rolledBack ?? {}
    const r = obs.restart ?? {}
    const last = (rb.history ?? []).at(-1)
    return verdict([
      [last?.type === 'rollback' && last?.trigger === 'manual', `the manual rollback appended a manual rollback revision (got ${JSON.stringify(last)})`],
      [rb.version === last?.version && rb.revision === String(last?.revision), `the tab shows the history's tail (shown ${rb.version} r${rb.revision}, history ${last?.version} r${last?.revision})`],
      [rb.version === 'baseline' && rb.label === BASELINE_LABEL, `rolling back from the adopted version returns to the previous one, the baseline (got ${JSON.stringify(rb.version)})`],
      [typeof rb.currentText === 'string' && rb.currentText.includes('手动'), 'the tab says the change was manual'],
      [JSON.stringify(rb.revisions) === JSON.stringify(historyTypes(rb.history)), `the tab's revision list matches the adoption history (shown ${JSON.stringify(rb.revisions)}, history ${JSON.stringify(historyTypes(rb.history))})`],
      [r.version === rb.version && r.revision === rb.revision, `after a restart the same version and revision (got ${r.version} r${r.revision})`],
      [JSON.stringify(r.revisions) === JSON.stringify(historyTypes(r.history)) && JSON.stringify(r.history) === JSON.stringify(rb.history), 'after a restart the revision list still matches the unchanged history'],
      [consoleErrors(obs).length === 0, `no renderer console errors (got ${consoleErrors(obs).slice(0, 3).join(' | ')})`],
    ], `a manual rollback showed ${rb.version} r${rb.revision}, matching the adoption history, and the same after a restart`)
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
