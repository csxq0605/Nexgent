/**
 * The D19–D23 judges of accept-step5: each decides one desktop item from the
 * observations step5-desktop.mjs collected. Pure, like the other judges, so
 * each is tested against broken copies of a good run
 * (packages/test-support/tests/accept-step5-desktop-judges.spec.ts).
 *
 * `ctx` is `{ improvements, improvementsError }`: the scenario's observations,
 * or the error that kept it from running at all. An unknown result is never a pass.
 */
import { verdict } from './step2-judges.mjs'

/** Status words of the 改进 tab (apps/desktop strings.ts `improvementStatusText`). */
export const STATUS_WORDS = {
  queued: '排队中',
  diagnosing: '诊断中',
  proposing: '提出候选中',
  trialing: '门控试验中',
  'waiting-history': '等待更多历史任务',
  'awaiting-approval': '等待审批',
  adopted: '已采用',
  rejected: '未采用',
  'no-proposal': '不是能力问题',
  'budget-exhausted': '预算用尽',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
}
/** Decision reasons of the gate in words (apps/desktop strings.ts `decisionReasonText`). */
export const REASON_WORDS = {
  'quality-up': '检查通过率高于基线',
  'cost-down': '质量持平且更省',
  'review-preferred': '质量持平，审核模型更倾向候选',
  'quality-down': '检查通过率低于基线',
  'guard-regressed': '守护任务退步',
  'cost-over-cap': '成本超过上限',
  'no-improvement': '没有改进',
  'unknown-runs': '有运行结果未知',
  'budget-exhausted': '试验额度用尽',
  interrupted: '试验中断',
}
/** What the tab shows for what started a job. */
export const TRIGGER_WORDS = { 'feedback-count': '反馈累计', explicit: '手动', 'check-failure': '检查失败' }
export const LABELS = { firstUse: '已被后续任务使用', feedbackRate: '反馈检查（单独记）', passRate: '检查通过率', review: '审核模型的意见', noCandidate: '还没有产生候选', noProposal: '无' }
const COST_SHOWN = /^≈ \$\d+\.\d\d/
const PHASE_WORDS = { diagnose: '诊断', propose: '提出候选', trial: '门控试验' }
const FINAL = ['adopted', 'rejected', 'no-proposal', 'failed', 'budget-exhausted', 'interrupted', 'cancelled', 'awaiting-approval', 'waiting-history']

const KINDS = ['noProposal', 'failed', 'rejected', 'adopted']
const first = (text, n = 120) => String(text ?? '').slice(0, n)
const has = (text, part) => typeof text === 'string' && typeof part === 'string' && part !== '' && text.includes(part)

/** The scenario's observations, or a failed result saying why there are none / which step they stop at. */
function observed(ctx, needs) {
  if (ctx?.improvementsError !== undefined && ctx.improvementsError !== null) return { fail: `the improvements desktop scenario did not run: ${first(ctx.improvementsError instanceof Error ? ctx.improvementsError.message : ctx.improvementsError, 300)}` }
  const obs = ctx?.improvements
  if (obs === undefined || obs === null) return { fail: 'no observations of the improvements desktop scenario' }
  const missing = needs.filter(([ok]) => !ok(obs)).map(([, name]) => name)
  if (missing.length > 0 && obs.error !== undefined) return { fail: `the scenario stopped at "${obs.error.step}" (${first(String(obs.error.message).split('\n')[0], 200)}); missing observations: ${missing.join(', ')}` }
  return { obs }
}

const prepared = (obs, kind) => obs.prepared?.[kind]
const cardOf = (obs, kind) => (obs.list?.cards ?? []).find(c => c?.id === prepared(obs, kind)?.id)
const detailOf = (obs, kind) => obs.details?.[prepared(obs, kind)?.id]
const fileOf = (obs, kind) => obs.files?.jobs?.[prepared(obs, kind)?.id]
const allPrepared = obs => KINDS.every(kind => prepared(obs, kind)?.id !== undefined)

export const DESKTOP_JUDGES = {
  D19(ctx) {
    const seen = observed(ctx, [[o => allPrepared(o), 'prepared jobs'], [o => (o.list?.cards ?? []).length > 0, 'job cards'], [o => o.details !== undefined, 'job details'], [o => o.files !== undefined, 'job files']])
    if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
    const obs = seen.obs
    const conditions = [
      [allPrepared(obs) && new Set(KINDS.map(k => prepared(obs, k).id)).size === 4, 'four distinct jobs were prepared'],
      [KINDS.map(k => prepared(obs, k)?.status).join() === 'no-proposal,failed,rejected,adopted', `the prepared jobs end no-proposal, failed, rejected, adopted (got ${KINDS.map(k => prepared(obs, k)?.status).join(',')})`],
      [typeof obs.list?.pending === 'string' && /\d+ \/ \d+/.test(obs.list.pending), `the tab shows the counted feedback (got ${JSON.stringify(obs.list?.pending)})`],
      [typeof obs.list?.budget === 'string' && /tokens/.test(obs.list.budget), `the tab shows the improvement budget (got ${JSON.stringify(obs.list?.budget)})`],
      [(obs.consoleErrors?.first ?? []).length === 0, `no console errors in the first launch (got ${JSON.stringify(obs.consoleErrors?.first)})`],
    ]
    for (const kind of KINDS) {
      const card = cardOf(obs, kind)
      const file = fileOf(obs, kind)
      const detail = detailOf(obs, kind)
      const status = prepared(obs, kind)?.status
      conditions.push(
        [card !== undefined && file !== undefined, `${kind}: a card and a job file with the same id`],
        [card?.status === file?.status && card?.status === status, `${kind}: the card's status ${card?.status} is the job file's ${file?.status}`],
        [card?.statusText === STATUS_WORDS[status], `${kind}: the card says ${STATUS_WORDS[status]} (got ${JSON.stringify(card?.statusText)}), whether it was adopted`],
        [has(card?.trigger, TRIGGER_WORDS[file?.trigger] ?? '\0') && has(card?.trigger, `${file?.items} 条`), `${kind}: the trigger reason ${TRIGGER_WORDS[file?.trigger]} and ${file?.items} signals (got ${JSON.stringify(card?.trigger)})`],
        [typeof card?.cost === 'string' && COST_SHOWN.test(card.cost) && /tokens/.test(card.cost), `${kind}: the card shows a known cost (got ${JSON.stringify(card?.cost)})`],
        [detail !== undefined && detail !== null && detail.error === undefined, `${kind}: the card opens (got ${JSON.stringify(detail?.error ?? detail)?.slice(0, 80)})`],
        [Array.isArray(detail?.phases) && detail.phases.length === (file?.phases ?? []).length && (file?.phases ?? []).every(p => detail.phases.some(x => x.phase === p && has(x.text, PHASE_WORDS[p]))), `${kind}: the cost by phase lists ${JSON.stringify(file?.phases)} (got ${JSON.stringify(detail?.phases?.map(p => p.phase))})`],
      )
    }
    // What the candidate changed and the gate result: the jobs that got that far.
    for (const kind of ['rejected', 'adopted']) {
      const file = fileOf(obs, kind)
      const detail = detailOf(obs, kind)
      const components = file?.candidate?.components ?? []
      conditions.push(
        [components.length === 1 && components.every(c => has(detail?.candidate, c.name)), `${kind}: the candidate names what it changed ${JSON.stringify(components.map(c => c.name))} (got ${JSON.stringify(first(detail?.candidate))})`],
        [!has(detail?.candidate, LABELS.noCandidate) && has(detail?.candidate, file?.candidate?.summary ?? '\0'), `${kind}: and its summary (got ${JSON.stringify(first(detail?.candidate, 200))})`],
        [file?.decision !== undefined && has(detail?.gateVerdict, STATUS_WORDS[file.decision.outcome] ?? '\0') && has(detail?.gateVerdict, REASON_WORDS[file.decision.reason] ?? '\0'), `${kind}: the gate result shows ${file?.decision?.outcome} / ${file?.decision?.reason} (got ${JSON.stringify(first(detail?.gateVerdict))})`],
        [has(detail?.gateRate, LABELS.passRate), `${kind}: the check pass rates (got ${JSON.stringify(detail?.gateRate)})`],
      )
    }
    const adopted = detailOf(obs, 'adopted')
    conditions.push([adopted?.firstUse === null || adopted?.firstUse === undefined, `before any later task the adopted job does not claim a use (got ${JSON.stringify(adopted?.firstUse)})`])
    const evidence = `${KINDS.length} jobs listed with status, trigger, cost and detail matching the job files (${KINDS.map(k => `${k}: ${cardOf(obs, k)?.statusText} ${cardOf(obs, k)?.cost}`).join('; ')}); candidate ${JSON.stringify(fileOf(obs, 'adopted')?.candidate?.components?.map(c => c.name))} and gate result shown for the rejected and adopted jobs; ${obs.list?.pending}; no console errors`
    return verdict(conditions, evidence)
  },

  D20(ctx) {
    const seen = observed(ctx, [[o => allPrepared(o), 'prepared jobs'], [o => o.details !== undefined, 'job details'], [o => o.files !== undefined, 'job files']])
    if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
    const obs = seen.obs
    const none = { card: cardOf(obs, 'noProposal'), file: fileOf(obs, 'noProposal'), detail: detailOf(obs, 'noProposal') }
    const failed = { card: cardOf(obs, 'failed'), file: fileOf(obs, 'failed'), detail: detailOf(obs, 'failed') }
    const rejected = { card: cardOf(obs, 'rejected'), file: fileOf(obs, 'rejected'), detail: detailOf(obs, 'rejected') }
    const adopted = { card: cardOf(obs, 'adopted'), file: fileOf(obs, 'adopted'), detail: detailOf(obs, 'adopted') }
    const hypothesis = job => job.file?.diagnosis?.hypothesis
    const conditions = [
      // no-proposal
      [none.file?.status === 'no-proposal' && has(none.card?.detailText, none.file?.detail ?? '\0'), `no-proposal: the card gives the reason recorded in the job (got ${JSON.stringify(first(none.card?.detailText))})`],
      [has(none.detail?.diagnosis, hypothesis(none) ?? '\0') && (none.detail?.failures ?? []).length > 0, `no-proposal: the opened job shows the diagnosis and its failure types (got ${JSON.stringify(first(none.detail?.diagnosis))})`],
      [has(none.detail?.diagnosis, LABELS.noProposal) && has(none.detail?.candidate, LABELS.noCandidate), `no-proposal: it says no component is proposed and no candidate exists (got ${JSON.stringify(first(none.detail?.candidate))})`],
      // failed
      [failed.file?.status === 'failed' && typeof failed.file?.detail === 'string' && failed.file.detail !== '' && failed.card?.detailText === failed.file.detail, `failed: the card gives the reason recorded in the job (${JSON.stringify(first(failed.file?.detail))}; got ${JSON.stringify(first(failed.card?.detailText))})`],
      [failed.card?.statusText === STATUS_WORDS.failed && failed.detail !== null && failed.detail?.error === undefined && has(failed.detail?.diagnosis, hypothesis(failed) ?? '\0'), `failed: the opened job shows what was diagnosed before it failed (got ${JSON.stringify(first(failed.detail?.diagnosis))})`],
      // rejected
      [rejected.file?.status === 'rejected' && rejected.file?.decision?.outcome === 'rejected', `rejected: the job file records a rejection decision (got ${JSON.stringify(rejected.file?.decision?.outcome)})`],
      [has(rejected.detail?.gateVerdict, STATUS_WORDS.rejected) && has(rejected.detail?.gateVerdict, REASON_WORDS[rejected.file?.decision?.reason] ?? '\0'), `rejected: the opened job gives the reason ${rejected.file?.decision?.reason} in words (got ${JSON.stringify(first(rejected.detail?.gateVerdict))})`],
      [has(rejected.card?.detailText, rejected.file?.detail?.slice(0, 40) ?? '\0'), `rejected: the card gives the job's own explanation (got ${JSON.stringify(first(rejected.card?.detailText))})`],
      [has(rejected.detail?.gate, rejected.detail?.gateVerdict ?? '\0') && rejected.detail?.gateVerdict !== rejected.detail?.gateRate, 'rejected: the reason and the pass rates are separate lines'],
      // feedback checks and the reviewer's opinion are marked on their own
      [has(adopted.detail?.gateFeedback, LABELS.feedbackRate) && adopted.file?.decision?.feedbackPassRate !== undefined, `adopted: the feedback checks have a line of their own marked 单独记 (got ${JSON.stringify(adopted.detail?.gateFeedback)})`],
      [has(adopted.detail?.gateRate, LABELS.passRate) && !has(adopted.detail?.gateRate, '反馈检查') && adopted.detail?.gateFeedback !== adopted.detail?.gateRate, `adopted: the pass rates line does not mix them in (got ${JSON.stringify(adopted.detail?.gateRate)})`],
      [(adopted.detail?.gateReview !== null && adopted.detail?.gateReview !== undefined) === (adopted.file?.decision?.decidedByReview === true), `adopted: the reviewer's opinion is marked exactly when it decided (decided by review ${adopted.file?.decision?.decidedByReview}; got ${JSON.stringify(adopted.detail?.gateReview)})`],
      [(rejected.detail?.gateReview !== null && rejected.detail?.gateReview !== undefined) === (rejected.file?.decision?.decidedByReview === true), `rejected: the reviewer's opinion is marked exactly when it decided (decided by review ${rejected.file?.decision?.decidedByReview}; got ${JSON.stringify(rejected.detail?.gateReview)})`],
      [(rejected.detail?.gateFeedback !== null && rejected.detail?.gateFeedback !== undefined) === (rejected.file?.decision?.feedbackPassRate !== undefined), `rejected: the feedback check line shows exactly when the verdict has one (got ${JSON.stringify(rejected.detail?.gateFeedback)})`],
      [!(obs.consoleErrors?.first ?? []).length, `no console errors (got ${JSON.stringify(obs.consoleErrors?.first)})`],
    ]
    const evidence = `no-proposal reason "${first(none.file?.detail, 60)}", failure reason "${first(failed.file?.detail, 60)}" and rejection ${rejected.file?.decision?.reason} open on click; the adopted job's feedback check line (${first(adopted.detail?.gateFeedback, 60)}) is separate from the pass rate line${adopted.file?.decision?.decidedByReview === true ? ' and the reviewer note' : ' (review did not decide: no reviewer note)'}`
    return verdict(conditions, evidence)
  },

  D21(ctx) {
    const seen = observed(ctx, [[o => o.deliverableJob !== undefined, 'the job started from the deliverable card']])
    if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
    const obs = seen.obs
    const job = obs.deliverableJob ?? {}
    const file = job.file ?? {}
    const known = new Set(KINDS.map(k => prepared(obs, k)?.id))
    const conditions = [
      [obs.deliverable?.cardCount >= 1, `the deliverable card was on screen (got ${obs.deliverable?.cardCount})`],
      [typeof job.id === 'string' && !known.has(job.id), 'a new job appeared in the 改进 tab after the click'],
      [Array.isArray(job.newJobs) && job.newJobs.length === 1 && job.newJobs[0] === job.id, `exactly one job file was added (got ${JSON.stringify(job.newJobs)})`],
      [file.trigger === 'explicit', `the job file's trigger is explicit (got ${JSON.stringify(file.trigger)})`],
      [typeof job.deliverableId === 'string' && file.request?.deliverableId === job.deliverableId, `it points at the deliverable ${job.deliverableId} (got ${JSON.stringify(file.request)})`],
      [file.request?.sessionId === job.feedbackSession, `and at the card's conversation (got ${JSON.stringify(file.request?.sessionId)})`],
      [typeof job.firstSeen === 'string' && job.firstSeen in STATUS_WORDS, `the tab showed it with a status (got ${JSON.stringify(job.firstSeen)})`],
      [Array.isArray(job.seen) && job.seen.length >= 2 && job.seen.every(s => s in STATUS_WORDS), `the tab followed its progress (statuses seen ${JSON.stringify(job.seen)})`],
      [FINAL.includes(job.final?.status) && job.final?.status === file.status, `it ended in the tab as ${job.final?.status}, the job file's ${file.status}`],
      [job.final?.statusText === STATUS_WORDS[file.status], `with the words ${STATUS_WORDS[file.status]} (got ${JSON.stringify(job.final?.statusText)})`],
    ]
    return verdict(conditions, `改进 on the deliverable card started job ${first(job.id, 8)} (explicit, request.deliverableId ${first(file.request?.deliverableId, 8)}); the 改进 tab followed ${job.seen?.join(' → ')}, ending as ${job.final?.statusText}`)
  },

  D22(ctx) {
    const seen = observed(ctx, [[o => o.settings?.restartOff !== undefined, 'settings after the second restart'], [o => o.autoOff !== undefined, 'feedback with automatic improvement off']])
    if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
    const obs = seen.obs
    const s = obs.settings ?? {}
    const on = s.configOn ?? {}
    const off = s.configOff ?? {}
    const a = obs.autoOff ?? {}
    const sameAs = (shown, config) => shown !== undefined && config !== undefined && shown.autoImprove === config.autoImprove && String(shown.budget) === String(config.budget) && String(shown.window) === String(config.window)
    const conditions = [
      [s.initial?.autoImprove === false, `the settings page opens with the project's value, off (got ${JSON.stringify(s.initial)})`],
      [s.saveOn?.approvalDialogs === 0 && s.saveOff?.approvalDialogs === 0, 'saving asks for no approval'],
      [on.autoImprove === true && typeof on.budget === 'number' && typeof on.window === 'number' && (on.budget !== 3_000_000 || on.window !== 30), `config.json holds what was set: on, a changed budget and window (got ${JSON.stringify(on)})`],
      [sameAs(s.restartOn, on), `after a restart the page shows automatic improvement on with the budget and window set (got ${JSON.stringify(s.restartOn)}, file ${JSON.stringify(on)})`],
      [off.autoImprove === false && typeof off.budget === 'number' && typeof off.window === 'number' && (off.budget !== on.budget || off.window !== on.window), `config.json holds the second change: off, another budget and window (got ${JSON.stringify(off)})`],
      [sameAs(s.restartOff, off), `after another restart the page shows it off with the new budget and window (got ${JSON.stringify(s.restartOff)}, file ${JSON.stringify(off)})`],
      [(obs.consoleErrors?.second ?? []).length === 0 && (obs.consoleErrors?.third ?? []).length === 0, `no console errors after the restarts (got ${JSON.stringify([...(obs.consoleErrors?.second ?? []), ...(obs.consoleErrors?.third ?? [])])})`],
      [Array.isArray(a.submitted) && a.submitted.length === 3, `three counted feedback entries were submitted with it off (got ${JSON.stringify(a.submitted)})`],
      [a.config?.autoImprove === false, `automatic improvement was off while they were submitted (got ${JSON.stringify(a.config)})`],
      [a.queueAfter?.counted - a.queueBefore?.counted === 3, `the queue counted them (counted ${a.queueBefore?.counted} → ${a.queueAfter?.counted})`],
      [typeof a.jobsBefore === 'number' && a.jobsAfter === a.jobsBefore, `no job started (jobs ${a.jobsBefore} → ${a.jobsAfter})`],
    ]
    return verdict(conditions, `automatic improvement and the budget (${on.budget} tokens / ${on.window} days, then ${off.budget} / ${off.window}) changed on the settings page, written to config.json without approval and shown again after each restart; with it off, ${a.submitted?.length} counted feedback entries were queued (counted ${a.queueBefore?.counted} → ${a.queueAfter?.counted}) and the job count stayed ${a.jobsAfter}`)
  },

  D23(ctx) {
    const seen = observed(ctx, [[o => o.firstUse !== undefined, 'the next task and the first use'], [o => allPrepared(o), 'prepared jobs']])
    if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
    const obs = seen.obs
    const use = obs.firstUse ?? {}
    const adoptedId = prepared(obs, 'adopted')?.id
    const before = obs.files?.jobs?.[adoptedId]
    const detailBefore = obs.details?.[adoptedId]
    const file = use.file
    const rejected = obs.details?.[prepared(obs, 'rejected')?.id]
    const conditions = [
      [prepared(obs, 'adopted')?.status === 'adopted' && before?.status === 'adopted', 'the job under test was adopted'],
      [before !== undefined && before.firstUse === undefined && (detailBefore?.firstUse === null || detailBefore?.firstUse === undefined), `before the next task the job does not claim a use (file ${JSON.stringify(before?.firstUse)}, screen ${JSON.stringify(detailBefore?.firstUse)})`],
      [typeof use.nextSession === 'string' && use.nextSession !== '', 'the next task ran in a new conversation'],
      [typeof use.ui === 'string' && use.ui.startsWith(LABELS.firstUse) && /\d/.test(use.ui.slice(LABELS.firstUse.length)), `the 改进 tab shows 已被后续任务使用 with a time (got ${JSON.stringify(use.ui)})`],
      [file !== null && file !== undefined && typeof file.at === 'string' && !Number.isNaN(Date.parse(file.at)), `the job file records the first use with a time (got ${JSON.stringify(file)})`],
      [file?.sessionId === use.nextSession, `the recorded use is the next task's conversation (got ${JSON.stringify(file?.sessionId)}, expected ${use.nextSession})`],
      [typeof use.adoptedDecidedAt === 'string' && typeof file?.at === 'string' && file.at >= use.adoptedDecidedAt, `and it is after the adoption (${use.adoptedDecidedAt} → ${file?.at})`],
      [rejected?.firstUse === null || rejected?.firstUse === undefined, 'the rejected job shows no use'],
    ]
    return verdict(conditions, `after the adoption the next task (conversation ${first(use.nextSession, 8)}) loaded the skill; the adopted job's detail shows "${use.ui}" and the job file records first use at ${file?.at}${use.nudged ? ' (after a second turn started)' : ''}`)
  },
}

/** Judge one desktop item; a throw is a failure. */
export function judgeDesktop(id, ctx) {
  const judge = DESKTOP_JUDGES[id]
  if (judge === undefined) return { status: 'failed', evidence: `no desktop judge for ${id}` }
  try {
    return judge(ctx)
  } catch (error) {
    return { status: 'failed', evidence: `judge ${id} threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}
