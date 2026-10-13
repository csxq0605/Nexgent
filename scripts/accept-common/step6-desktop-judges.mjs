/**
 * The D24–D27 judges of accept-step6: each decides one desktop item from the
 * observations step6-desktop.mjs collected. Pure, like the other judges, so
 * each is tested against broken copies of a good run
 * (packages/test-support/tests/accept-step6-desktop-judges.spec.ts). Each takes
 * the scenario's observations and returns `{ status: 'passed' | 'failed', evidence }`.
 *
 * Nothing is judged from the screen alone: every number, version and word the
 * DOM shows is compared with the job file, `comparison.json`, `change.json`,
 * `meta-diagnosis.json`, the improver revisions (`activation/<n>.json`), the
 * queue or `.nexgent/config.json` read at the same time. Missing observations
 * fail; the evidence says what was seeded (`obs.seeded.what`).
 */
import { verdict } from './step2-judges.mjs'

/** Why a comparison concluded as it did, in the desktop's words (apps/desktop strings.ts `improverReasonText`). */
export const IMPROVER_REASON_WORDS = {
  'gate-passed': '子的后代通过门控而父的没有',
  'quality-up': '质量更高',
  'cost-down': '质量相同且费用低 10% 以上',
  'no-improvement': '没有改进',
  'no-offspring': '子没有产出后代',
  'unknown-arm': '有一臂结果未知',
  'origin-mismatch': '两臂起点不一致',
  'epoch-mismatch': '评价纪元不同',
}
/** An arm's gate reasons in the desktop's words (`decisionReasonText`). */
export const GATE_REASON_WORDS = {
  'quality-up': '检查通过率高于基线',
  'cost-down': '质量持平且更省',
  'quality-down': '检查通过率低于基线',
  'no-improvement': '没有改进',
  'unknown-runs': '有运行结果未知',
  'budget-exhausted': '试验额度用尽',
}
const FINAL = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled'])
const COST_SHOWN = /^≈ \$\d+\.\d\d/

const first = (text, n = 160) => String(text ?? '').slice(0, n)
const has = (text, part) => typeof text === 'string' && typeof part === 'string' && part !== '' && text.includes(part)
/** The version as the desktop shows it: `v0` stays, a hash shows 12 characters. */
const shortVersion = version => (version === undefined || version === null ? 'v0' : String(version).slice(0, 12))
const tokensShown = n => (typeof n === 'number' ? n.toLocaleString('en-US') : '未知')
const usdShown = usd => (typeof usd === 'number' ? `≈ $${usd.toFixed(2)}` : '费用未知')
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const seededNote = obs => (obs?.seeded?.what === undefined ? 'nothing was seeded' : `seeded: ${obs.seeded.what}`)

/** The failed result when the scenario did not produce what `item` needs; otherwise `{ obs }`. */
function observed(obs, item, needs) {
  if (obs === undefined || obs === null) return { fail: 'no observations of the step-6 desktop scenario' }
  if (obs.errors?.[item] !== undefined) return { fail: `the scenario stopped in ${item}: ${first(String(obs.errors[item]).split('\n')[0], 300)}` }
  const missing = needs.filter(([ok]) => !ok(obs)).map(([, name]) => name)
  if (missing.length > 0) {
    const why = obs.error === undefined ? '' : ` (the scenario stopped: ${first(String(obs.error.message).split('\n')[0], 200)})`
    return { fail: `missing observations: ${missing.join(', ')}${why}` }
  }
  return { obs }
}

const cardOf = (cards, id) => (cards ?? []).find(card => card?.id === id)
const fileJobOf = (files, id) => (files?.jobs ?? []).find(job => job?.id === id)
const tailOf = revisions => (revisions ?? []).filter(r => r?.error === undefined).at(-1)
/** The improver in force by the chain: the tail's version, `v0` for an empty chain. */
const inForce = revisions => tailOf(revisions)?.version ?? 'v0'

// ---- D24 ------------------------------------------------------------------------------

/** One snapshot of cards and files: every job file has a card with its own version, the marker iff meta. */
function cardConditions(label, snap) {
  const conditions = []
  const jobs = (snap?.files?.jobs ?? []).filter(job => job.arm !== true)
  conditions.push([jobs.length > 0 && (snap?.cards ?? []).length > 0, `${label}: job files and job cards were observed`])
  for (const job of jobs) {
    const card = cardOf(snap.cards, job.id)
    const version = job.improverVersion ?? 'v0'
    const tag = `${label}: ${job.kind} job ${first(job.id, 8)}`
    conditions.push(
      [card !== undefined, `${tag} has a card`],
      [card?.kind === job.kind, `${tag}: the card says ${card?.kind}, job.json says ${job.kind}`],
      [card?.improverVersion === version, `${tag}: the card shows improver ${shortVersion(card?.improverVersion)}, job.json says ${shortVersion(version)}`],
      [has(card?.improverText, shortVersion(version)), `${tag}: the card's text names ${shortVersion(version)} (got ${JSON.stringify(card?.improverText)})`],
      [card?.badge === (job.kind === 'meta'), `${tag}: the 元改进 marker is ${job.kind === 'meta' ? 'present' : 'absent'} (got ${card?.badge})`],
      [job.kind !== 'meta' || card?.badgeText === '元改进', `${tag}: the marker reads 元改进 (got ${JSON.stringify(card?.badgeText)})`],
    )
  }
  const imp = snap?.improver
  const want = inForce(snap?.files?.revisions)
  conditions.push(
    [imp?.present === true && imp?.version === want, `${label}: the improver section shows ${shortVersion(imp?.version)}, the activation chain's tail is ${shortVersion(want)}`],
    [has(imp?.versionText, shortVersion(want)), `${label}: and its text names it (got ${JSON.stringify(imp?.versionText)})`],
  )
  return conditions
}

export function judgeD24(obs) {
  const seen = observed(obs, 'd24', [[o => o.d24?.initial !== undefined, 'the first look at the 改进 tab'], [o => o.d24?.later !== undefined, 'the look after the rollback and the jobs that followed'], [o => o.seeded?.jobId !== undefined, 'the seeded meta job']])
  if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
  const { d24 } = seen.obs
  const { initial, later } = d24
  const conditions = [...cardConditions('first look', initial), ...cardConditions('after the jobs', later)]
  const seededCard = cardOf(initial.cards, obs.seeded.jobId)
  const seededFile = fileJobOf(initial.files, obs.seeded.jobId)
  const j1 = fileJobOf(initial.files, obs.prepared?.j1?.id)
  const j2 = fileJobOf(initial.files, obs.prepared?.j2?.id)
  const forced = inForce(initial.files?.revisions)
  conditions.push(
    [seededFile?.kind === 'meta' && seededCard?.kind === 'meta' && seededCard?.badge === true, 'the seeded meta job is listed with the marker'],
    [seededFile?.improverVersion === 'v0' && forced !== 'v0' && seededCard?.improverVersion === 'v0', `a job shows the improver it was pinned to (the meta job ${shortVersion(seededCard?.improverVersion)}) and not the one now in force (${shortVersion(forced)})`],
    [j1?.improverVersion === 'v0' && cardOf(initial.cards, j1?.id)?.improverVersion === 'v0', 'the job run before the child was adopted shows v0'],
    [j2?.improverVersion === obs.seeded.child && cardOf(initial.cards, j2?.id)?.improverVersion === obs.seeded.child, `the job run after the adoption shows the child ${shortVersion(obs.seeded.child)}`],
    [new Set((initial.cards ?? []).map(c => c.improverVersion)).size >= 2, 'cards of at least two different improver versions were shown'],
  )
  const laterMeta = (later.files?.jobs ?? []).filter(job => job.kind === 'meta' && job.id !== obs.seeded.jobId)
  conditions.push(
    [laterMeta.length >= 1 && laterMeta.every(job => cardOf(later.cards, job.id)?.badge === true), `a meta job the product started (${laterMeta.length}) carries the marker`],
    [(obs.consoleErrors?.first ?? []).length === 0, `no console errors in the first launch (got ${JSON.stringify(obs.consoleErrors?.first)})`],
  )
  const shown = (initial.cards ?? []).length + (later.cards ?? []).length
  return verdict(conditions, `${shown} card observations against job.json and the activation chain: each shows its own pinned improver version (v0 and ${shortVersion(obs.seeded.child)}, not the one in force) and the 元改进 marker exactly on meta jobs; the improver in force equals the chain's tail; ${seededNote(obs)}`)
}

// ---- D25 ------------------------------------------------------------------------------

function seededDetail(obs) {
  const { dom, files } = obs.d25.seeded
  const conditions = []
  const tag = text => `seeded meta job: ${text}`
  conditions.push([dom !== null && dom !== undefined && files?.job !== undefined && files?.diagnosis !== undefined && files?.change !== undefined && files?.comparison !== undefined, tag('the detail and its job.json, meta-diagnosis.json, change.json and comparison.json were observed')])
  if (dom === null || dom === undefined || files?.comparison === undefined || files?.change === undefined || files?.diagnosis === undefined) return conditions
  const { diagnosis, change, comparison, job } = files
  conditions.push(
    [has(dom.diagnosis, diagnosis.hypothesis), tag(`the meta diagnosis shows the hypothesis of meta-diagnosis.json (got ${JSON.stringify(first(dom.diagnosis))})`)],
    [diagnosis.proposal === 'change' && has(dom.diagnosis, '改进器需要一处修改'), tag(`it says a change is needed, as the file does (${diagnosis.proposal})`)],
    [(dom.findings ?? []).length === diagnosis.findings.length && diagnosis.findings.every((f, i) => dom.findings[i]?.stage === f.stage && has(dom.findings[i]?.text, f.label) && has(dom.findings[i]?.text, `${f.jobs} 个作业`)), tag(`the ${diagnosis.findings.length} findings match the file (stage, label, job count)`)],
    [dom.change?.op === change.op, tag(`the change op ${dom.change?.op} is change.json's ${change.op}`)],
    [typeof obs.d25.seeded.parentParagraph === 'string' && dom.change?.before === obs.d25.seeded.parentParagraph, tag(`the 修改前 text is the parent's paragraph ${change.index + 1} (got ${JSON.stringify(first(dom.change?.before, 60))})`)],
    [dom.change?.after === change.text && change.childParagraph === change.text, tag(`the 修改后 text is change.json's and the child improver file's paragraph (got ${JSON.stringify(first(dom.change?.after, 60))})`)],
    [dom.change?.before !== dom.change?.after, tag('before and after differ')],
    [has(dom.change?.rationale, change.rationale), tag('the rationale is change.json\'s')],
    [change.parentVersion === 'v0' && change.childVersion === obs.d25.seeded.child && comparison.child?.improverVersion === change.childVersion && comparison.parent?.improverVersion === change.parentVersion && job?.meta?.childVersion === change.childVersion, tag('change.json, comparison.json and job.json agree on the parent and the child version')],
  )
  const arms = dom.comparison?.arms ?? []
  conditions.push([arms.length === 2 && arms.some(a => a.arm === 'parent') && arms.some(a => a.arm === 'child'), tag(`both arms are shown (got ${arms.map(a => a.arm).join(',')})`)])
  for (const side of ['parent', 'child']) {
    const arm = arms.find(a => a.arm === side)
    const record = comparison[side]
    const at = tag(`${side} arm`)
    conditions.push(
      [arm !== undefined && record !== undefined, `${at} is shown and in comparison.json`],
      [has(arm?.version, shortVersion(record?.improverVersion)), `${at} shows its improver ${shortVersion(record?.improverVersion)} (got ${JSON.stringify(arm?.version)})`],
      [record?.candidateId === undefined ? has(arm?.offspring, '无后代') : has(arm?.offspring, String(record.candidateId).slice(0, 8)), `${at} shows its offspring (${record?.candidateId === undefined ? 'none' : String(record?.candidateId).slice(0, 8)}; got ${JSON.stringify(arm?.offspring)})`],
      [has(arm?.gate, record?.verdictOutcome === 'adopt' ? '通过' : record?.verdictOutcome === 'reject' ? '未通过' : '\0') && has(arm?.gate, GATE_REASON_WORDS[record?.verdictReason] ?? '\0') && (record?.verdictOutcome !== 'adopt' || !has(arm?.gate, '未通过')), `${at} shows the gate result ${record?.verdictOutcome}/${record?.verdictReason} (got ${JSON.stringify(arm?.gate)})`],
      [typeof record?.quality === 'number' && has(arm?.quality, `${Math.round(record.quality * 100)}%`), `${at} shows the quality ${record?.quality} (got ${JSON.stringify(arm?.quality)})`],
      [typeof record?.usd === 'number' && has(arm?.cost, usdShown(record.usd)) && has(arm?.cost, `${tokensShown(record?.tokens)} tokens`), `${at} shows the cost ${usdShown(record?.usd)} and ${tokensShown(record?.tokens)} tokens of comparison.json (got ${JSON.stringify(arm?.cost)})`],
    )
  }
  const v = dom.comparison?.verdict
  conditions.push(
    [v?.outcome === comparison.outcome && v?.reason === comparison.reason && job?.meta?.outcome === comparison.outcome && job?.meta?.reason === comparison.reason, tag(`the decision ${v?.outcome}/${v?.reason} is comparison.json's ${comparison.outcome}/${comparison.reason} and job.json's ${job?.meta?.outcome}/${job?.meta?.reason}`)],
    [has(v?.text, comparison.outcome === 'adopt' ? '采用子版本' : '不采用') && has(v?.text, IMPROVER_REASON_WORDS[comparison.reason] ?? '\0'), tag(`the decision text gives the outcome and the reason in words (got ${JSON.stringify(v?.text)})`)],
    [job?.status === (comparison.outcome === 'adopt' ? 'adopted' : 'rejected'), tag(`the job file ends ${job?.status}, as the decision says`)],
    [typeof dom.cost === 'string' && (COST_SHOWN.test(String(dom.cost).split('：')[1] ?? '') || has(dom.cost, '费用未知')) && /tokens/.test(dom.cost), tag(`the job's cost line is shown (got ${JSON.stringify(dom.cost)})`)],
    [(dom.phases ?? []).length >= 1, tag('the cost by phase is listed')],
  )
  // The decision took effect: the adopting revision names this job and the child.
  const adopting = (obs.d24?.initial?.files?.revisions ?? []).find(r => r.jobId === obs.seeded.jobId)
  conditions.push([adopting?.type === 'adopt' && adopting?.version === change.childVersion && adopting?.trigger === 'meta-job', tag(`the activation chain has the adopt revision of this job for the child (got ${JSON.stringify(adopting)})`)])
  return conditions
}

function realDetail(obs) {
  const real = obs.d25.real
  const conditions = []
  const tag = text => `real meta job: ${text}`
  const { dom, files } = real
  conditions.push([dom !== null && dom !== undefined && files?.job !== undefined && files?.diagnosis !== undefined, tag('the detail and its job.json and meta-diagnosis.json were observed')])
  if (dom === null || dom === undefined || files?.diagnosis === undefined) return conditions
  conditions.push(
    [files.job.kind === 'meta' && FINAL.has(files.job.status), tag(`it is a finished meta job (${files.job.status})`)],
    [has(dom.diagnosis, files.diagnosis.hypothesis), tag('the diagnosis shows the hypothesis of meta-diagnosis.json')],
    [files.diagnosis.proposal === 'none' && has(dom.diagnosis, '结论：无') && files.job.status === 'no-proposal', tag('no change was proposed: the file and the screen say so, and the job ends no-proposal')],
    [dom.change === null && files.change === undefined, tag('no change section on screen and no change.json')],
    [dom.comparison === null && files.comparison === undefined, tag('no comparison on screen and no comparison.json')],
    [(files.ledger?.requests ?? 0) >= 1 && (files.ledger?.phases ?? []).includes('meta-diagnose'), tag(`the ledger holds its meta-diagnose requests (${files.ledger?.requests})`)],
    [typeof dom.cost === 'string' && COST_SHOWN.test(String(dom.cost).split('：')[1] ?? ''), tag(`its cost is a known number from the ledger (got ${JSON.stringify(dom.cost)})`)],
    [typeof files.ledger?.tokens === 'number' && has(dom.cost, `${tokensShown(files.ledger.tokens)} tokens`), tag(`the tokens shown (${first(dom.cost, 80)}) are the ledger's ${files.ledger?.tokens}`)],
  )
  return conditions
}

export function judgeD25(obs) {
  const seen = observed(obs, 'd25', [[o => o.d25?.seeded !== undefined, 'the seeded meta job\'s detail'], [o => o.d25?.real !== undefined, 'the real meta job\'s detail'], [o => o.seeded?.jobId !== undefined, 'the seeded ids']])
  if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
  const conditions = [...seededDetail(obs), ...realDetail(obs), [obs.d25.seeded.jobId === obs.seeded.jobId, 'the detail observed is the seeded job\'s']]
  return verdict(conditions, `meta job detail checked against meta-diagnosis.json, change.json, comparison.json, job.json, the child improver file, the activation chain and the ledger: diagnosis, change before/after, both arms (version, offspring, gate result, quality, cost), decision ${obs.d25.seeded.files?.comparison?.outcome}/${obs.d25.seeded.files?.comparison?.reason}, cost; a real meta job (${obs.d25.real.files?.job?.status}) shows its diagnosis and a ledger-priced cost with no change or comparison; ${seededNote(obs)}`)
}

// ---- D26 ------------------------------------------------------------------------------

/** What the settings page, the config file and the 改进 tab should say for one saved setting. */
function settingConditions(label, typed, { dom, config, screen, pending }) {
  const text = n => String(n)
  const conditions = []
  if (dom !== undefined) conditions.push([dom?.enabled === typed.enabled && dom?.every === text(typed.every) && dom?.budget === text(typed.budget) && dom?.window === text(typed.window), `${label}: the settings page shows ${JSON.stringify(dom)} (typed ${JSON.stringify(typed)})`])
  conditions.push(
    [config?.enabled === typed.enabled && config?.every === typed.every && config?.budget === typed.budget && config?.window === typed.window, `${label}: .nexgent/config.json says ${JSON.stringify(config)}`],
  )
  if (screen !== undefined) {
    conditions.push(
      [has(screen.metaStatus, typed.enabled ? '元改进 开' : '元改进 关') && has(screen.metaStatus, ` / ${typed.every} `) && (pending === undefined || has(screen.metaStatus, `已计入 ${pending} /`)), `${label}: the 改进 tab says ${JSON.stringify(screen.metaStatus)}${pending === undefined ? '' : ` (the queue holds ${pending} counted jobs)`}`],
      [has(screen.metaBudget, tokensShown(typed.budget)) && has(screen.metaBudget, `${typed.window} 天`), `${label}: and the meta budget ${JSON.stringify(screen.metaBudget)}`],
    )
  }
  return conditions
}

export function judgeD26(obs) {
  const seen = observed(obs, 'd26', [
    [o => o.d26?.typed !== undefined, 'the typed values'],
    [o => o.d26?.initial !== undefined && o.d26?.configOn !== undefined, 'the first save'],
    [o => o.d26?.restartOn !== undefined && o.d26?.configOff !== undefined, 'the settings after the first restart and the second save'],
    [o => o.d26?.restartOff !== undefined && o.d26?.filesAtRestart !== undefined, 'the settings after the second restart'],
    [o => o.d26?.autoOff !== undefined, 'the jobs run with the switch off'],
    [o => o.d26?.control !== undefined, 'the control run with the switch on'],
  ])
  if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
  const { d26, consoleErrors } = seen.obs
  const { typed } = d26
  const conditions = [
    [d26.initial?.enabled === false && d26.configBefore?.enabled !== true, `before anything is saved meta improvement is off (page ${JSON.stringify(d26.initial?.enabled)}, config ${JSON.stringify(d26.configBefore?.enabled)})`],
    [!sameJson(d26.initial, { enabled: typed.on.enabled, every: String(typed.on.every), budget: String(typed.on.budget), window: String(typed.on.window) }), 'the values typed in differ from what the page started with'],
    [d26.saveOn?.approvalDialogs === 0 && d26.saveOff?.approvalDialogs === 0, `saving needs no approval (dialogs ${d26.saveOn?.approvalDialogs}, ${d26.saveOff?.approvalDialogs})`],
    ...settingConditions('saved on', typed.on, { config: d26.configOn, screen: d26.screenOn }),
    ...settingConditions('after restart 1', typed.on, { dom: d26.restartOn, config: d26.configAfterRestartOn }),
    ...settingConditions('saved off', typed.off, { config: d26.configOff }),
    ...settingConditions('after restart 2', typed.off, { dom: d26.restartOff, config: d26.configAfterRestartOff, screen: d26.screenOff, pending: d26.filesAtRestart?.queue?.metaPending?.length }),
  ]

  const off = d26.autoOff
  const metaIds = snap => (snap?.jobs ?? []).filter(job => job.kind === 'meta').map(job => job.id).sort()
  const ranIds = (off?.ran ?? []).map(r => r.id)
  const pending = off?.after?.queue?.metaPending ?? []
  conditions.push(
    [off?.after?.config?.enabled === false && off?.before?.config?.enabled === false, `with the switch off in .nexgent/config.json (before ${off?.before?.config?.enabled}, after ${off?.after?.config?.enabled})`],
    [ranIds.length === typed.off.every && new Set(ranIds).size === ranIds.length && (off?.ran ?? []).every(r => ['adopted', 'rejected', 'no-proposal', 'failed'].includes(r.status)), `${ranIds.length} capability jobs finished (${(off?.ran ?? []).map(r => r.status).join(',')}), as many as the K = ${typed.off.every} that start a meta job`],
    [ranIds.every(id => (off?.after?.queue?.metaCounted ?? []).includes(id) && pending.includes(id)), 'the queue counted each of them toward the next meta job and they are still waiting'],
    [pending.length >= typed.off.every, `${pending.length} counted jobs are waiting, K = ${typed.off.every}`],
    [sameJson(metaIds(off?.before), metaIds(off?.after)) && (off?.after?.jobs ?? []).filter(job => !(off?.before?.jobs ?? []).some(b => b.id === job.id)).every(job => job.kind !== 'meta'), `no meta job started: ${metaIds(off?.after).length} meta job files before and after, and every job that appeared meanwhile is a capability job`],
    [off?.after?.queue?.activeJobId === undefined, 'and no job holds the slot'],
  )
  const control = d26.control
  const started = (control?.after?.jobs ?? []).find(job => job.id === control?.started)
  conditions.push(
    [control?.configEnabled === true, 'control: the switch was turned on in the config'],
    [started?.kind === 'meta' && started?.trigger === 'job-count' && !(control?.before?.jobs ?? []).some(job => job.id === started.id), `control: one more finished job starts a meta job on the job-count rule (got ${started?.kind}/${started?.trigger})`],
    [started?.meta?.basis >= typed.off.every && ranIds.every(id => !(control?.after?.queue?.metaPending ?? []).includes(id)), `control: its basis is ${started?.meta?.basis} jobs (K = ${typed.off.every}) and they left the waiting list`],
    [(consoleErrors?.second ?? []).length === 0 && (consoleErrors?.third ?? []).length === 0, `no console errors after the restarts (got ${JSON.stringify([...(consoleErrors?.second ?? []), ...(consoleErrors?.third ?? [])])})`],
  )
  return verdict(conditions, `meta settings typed into the settings page twice (on ${JSON.stringify(typed.on)}, off ${JSON.stringify(typed.off)}), each read back from .nexgent/config.json, the page after a restart and the 改进 tab, with no approval; with the switch off ${ranIds.length} finished jobs (K = ${typed.off.every}) were counted and no meta job started, while the same count with the switch on started one (job ${first(control?.started, 8)}); ${seededNote(obs)}`)
}

// ---- D27 ------------------------------------------------------------------------------

export function judgeD27(obs) {
  const seen = observed(obs, 'd27', [
    [o => o.d27?.before !== undefined && o.d27?.after !== undefined && o.d27?.final !== undefined, 'the improver chain before and after the rollback and after the next jobs'],
    [o => (o.d27?.next ?? []).length >= 2, 'the jobs started after the rollback'],
    [o => o.seeded?.child !== undefined, 'the seeded child improver'],
  ])
  if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
  const { d27, seeded, prepared } = seen.obs
  const before = d27.before.revisions ?? []
  const after = d27.after.revisions ?? []
  const tail = tailOf(after)
  const child = seeded.child
  const finalFiles = d27.final.files
  const newJobs = (finalFiles?.jobs ?? []).filter(job => job.arm !== true && tail?.committedAt !== undefined && job.createdAt > tail.committedAt)
  const conditions = [
    [before.length >= 1 && inForce(before) === child && before.at(-1)?.type === 'adopt', `before: the child ${shortVersion(child)} is in force by the chain (${before.length} revision, tail ${before.at(-1)?.type})`],
    [after.length === before.length + 1 && after.every((r, i) => i >= before.length || sameJson(r, before[i])), `after: exactly one revision was added and the earlier ones are unchanged (${before.length} → ${after.length})`],
    [tail?.type === 'rollback' && tail?.trigger === 'manual' && tail?.revision === before.length + 1 && tail?.from === child, `the new revision #${tail?.revision} is a manual rollback from ${shortVersion(tail?.from)} (got ${tail?.type}/${tail?.trigger})`],
    [tail?.version === 'v0' && inForce(after) === 'v0', `it returns to ${shortVersion(tail?.version)} (the parent the child replaced)`],
    [typeof d27.reason === 'string' && d27.reason !== '' && tail?.reason === d27.reason, `the reason typed in the confirmation is written to the revision (got ${JSON.stringify(tail?.reason)})`],
    [d27.afterImprover?.version === 'v0' && d27.afterImprover?.revision === String(tail?.revision) && (d27.afterImprover?.revisions ?? []).length === after.length, `the screen shows ${shortVersion(d27.afterImprover?.version)} at revision ${d27.afterImprover?.revision} with ${(d27.afterImprover?.revisions ?? []).length} revisions listed`],
    [d27.afterImprover?.revisions?.[0]?.type === 'rollback' && d27.afterImprover?.revisions?.[0]?.version === 'v0' && has(d27.afterImprover?.revisions?.[0]?.text, d27.reason), 'the newest listed revision is the rollback with the reason'],
    [inForce(finalFiles?.revisions) === 'v0' && d27.final.improver?.version === 'v0', 'after the next jobs v0 is still the improver in force on disk and on screen'],
  ]
  const kinds = []
  for (const next of d27.next ?? []) {
    const file = fileJobOf(finalFiles, next.id)
    kinds.push(file?.kind)
    conditions.push(
      [file !== undefined && FINAL.has(file.status), `next job ${first(next.id, 8)} (${next.via}) finished (${file?.status})`],
      [file?.improverVersion === tail?.version && file?.createdAt > tail?.committedAt, `next job ${first(next.id, 8)} was created after the rollback and job.json pins ${shortVersion(file?.improverVersion)}, the rolled-back version ${shortVersion(tail?.version)}`],
      [cardOf(d27.final.cards, next.id)?.improverVersion === file?.improverVersion, `its card shows the same version (${shortVersion(cardOf(d27.final.cards, next.id)?.improverVersion)})`],
    )
  }
  conditions.push(
    [kinds.includes('capability') && kinds.includes('meta'), `the next jobs are one capability job and one meta job (got ${kinds.join(',')})`],
    [newJobs.length >= (d27.next ?? []).length && newJobs.every(job => job.improverVersion === tail?.version), `every job created after the rollback (${newJobs.length}) pins ${shortVersion(tail?.version)}`],
    [fileJobOf(finalFiles, prepared?.j2?.id)?.improverVersion === child, `the job before the rollback (J2) pinned the child ${shortVersion(child)}, so the rolled-back version is a real change`],
    [(seen.obs.consoleErrors?.first ?? []).length === 0, `no console errors in the first launch (got ${JSON.stringify(seen.obs.consoleErrors?.first)})`],
  )
  return verdict(conditions, `rollback clicked in the UI with a reason: revision #${tail?.revision} (manual rollback ${shortVersion(child)} → ${shortVersion(tail?.version)}) appended to .nexgent/improvers/activation, earlier revisions unchanged; the next ${(d27.next ?? []).length} jobs (capability, meta) pin the rolled-back version in job.json and on their cards, while the job before pinned the child; ${seededNote(seen.obs)}`)
}

/** The four judges by item id. */
export const DESKTOP_JUDGES = { D24: judgeD24, D25: judgeD25, D26: judgeD26, D27: judgeD27 }
