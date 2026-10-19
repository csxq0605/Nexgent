/**
 * The D24–D27 judges of accept-step6: each decides one desktop item from the
 * observations step6-desktop.mjs collected. Pure, like the other judges, so
 * each is tested against broken copies of a good run
 * (packages/test-support/tests/accept-step6-desktop-judges.spec.ts). Each takes
 * the scenario's observations and returns `{ status: 'passed' | 'failed', evidence }`.
 *
 * Nothing is judged from the screen alone: every number, version and word the
 * DOM shows is compared with the job file, `comparison.json`, `change.json`,
 * `meta-diagnosis.json`, the gate's decision record, the user-level improver
 * revisions (`<home>/improvers/activation/<n>.json`, ADR 0012), the user queue
 * (`<home>/improvements/queue.json`) or the two configs (`<home>/config.json`
 * for the meta settings, `.nexgent/config.json` for the project's sharing
 * switch) read at the same time. Missing observations fail; the evidence says
 * what was seeded (`obs.seeded.what`).
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
/** The three gate reasons of ADR 0013 in the desktop's words (`decisionReasonText`). */
export const ADR0013_REASON_WORDS = {
  'similar-regression': '同类题变差：候选在相似任务上通过的检查比现在少，已拒绝',
  'no-similar-cases': '只在原题上验证过：项目里没有相似任务可验证，需要你批准',
  'instance-literal': '回放前已拒绝：候选含有原题的具体数值',
}
/** An arm's gate reasons in the desktop's words (`decisionReasonText`). */
export const GATE_REASON_WORDS = {
  'quality-up': '检查通过率高于基线',
  'cost-down': '质量持平且更省',
  'quality-down': '检查通过率低于基线',
  'no-improvement': '没有改进',
  'unknown-runs': '有运行结果未知',
  'budget-exhausted': '试验额度用尽',
  ...ADR0013_REASON_WORDS,
}
/** What the improver section says about who shares the improver (`improverSharedNote`). */
export const SHARED_NOTE = '改进器由所有项目共用：在这里采用或回滚，会影响每个项目之后开始的改进作业。'
const FINAL = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled'])
const percentShown = n => `${Math.round(n * 100)}%`
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
      [job.improverScope === 'user' && card?.improverScope === 'user' && has(card?.improverText, '用户级'), `${tag}: the card shows the improver's scope: job.json says ${JSON.stringify(job.improverScope)}, the card ${JSON.stringify(card?.improverScope)} and its text ${JSON.stringify(first(card?.improverText, 60))} (the user-level 用户级)`],
      [card?.badge === (job.kind === 'meta'), `${tag}: the 元改进 marker is ${job.kind === 'meta' ? 'present' : 'absent'} (got ${card?.badge})`],
      [job.kind !== 'meta' || card?.badgeText === '元改进', `${tag}: the marker reads 元改进 (got ${JSON.stringify(card?.badgeText)})`],
    )
  }
  const imp = snap?.improver
  const want = inForce(snap?.files?.revisions)
  conditions.push(
    [imp?.present === true && imp?.version === want, `${label}: the improver section shows ${shortVersion(imp?.version)}, the activation chain's tail is ${shortVersion(want)}`],
    [has(imp?.versionText, shortVersion(want)), `${label}: and its text names it (got ${JSON.stringify(imp?.versionText)})`],
    [has(imp?.sharedNote, SHARED_NOTE), `${label}: the improver section says every project shares the improver (got ${JSON.stringify(first(imp?.sharedNote, 60))})`],
    [snap?.files?.legacyProjectImprovers === false, `${label}: the chain read is the user's (<home>/improvers); the project has no .nexgent/improvers of its own`],
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
  return verdict(conditions, `${shown} card observations against job.json and the activation chain: each shows its own pinned improver version (v0 and ${shortVersion(obs.seeded.child)}, not the one in force) and its scope (user), the improver section says all projects share it, and the 元改进 marker exactly on meta jobs; the improver in force equals the chain's tail; ${seededNote(obs)}`)
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

/**
 * The ADR 0013 conclusions: three improvement jobs whose decision carries `instance-literal`,
 * `similar-regression` and `no-similar-cases`; each detail says the reason in words and shows
 * what only that reason has (the values found with file and source, both similar-case pass
 * rates, the original-case-only note), the last also in the approval dialog.
 */
function gateDetails(obs) {
  const conditions = []
  const gates = obs.d25.gates ?? []
  const seededGates = obs.seeded?.gates ?? []
  conditions.push(
    [gates.length === 3 && ['instance-literal', 'similar-regression', 'no-similar-cases'].every(reason => gates.some(g => g.reason === reason)), `the three conclusions were opened (${gates.map(g => g.reason).join(',')})`],
    [gates.every(g => seededGates.some(x => x.jobId === g.jobId && x.reason === g.reason)), 'and they are the seeded jobs'],
    [(obs.consoleErrors?.fourth ?? []).length === 0, `no console errors in the launch that showed them (got ${JSON.stringify(obs.consoleErrors?.fourth)})`],
  )
  for (const gate of gates) {
    const { dom, files } = gate
    const seededGate = seededGates.find(x => x.jobId === gate.jobId)
    const tag = text => `gate job ${gate.reason}: ${text}`
    const word = ADR0013_REASON_WORDS[gate.reason]
    conditions.push(
      [dom !== null && dom !== undefined && files?.job !== undefined && files?.decision !== undefined, tag('the detail, job.json and the decision record were observed')],
    )
    if (dom === null || dom === undefined || files?.job === undefined || files?.decision === undefined) continue
    const decision = files.decision
    conditions.push(
      [decision.reason === gate.reason && decision.outcome === gate.outcome && files.job.status === gate.outcome && files.decisionId === gate.decisionId, tag(`the files say ${decision.outcome}/${decision.reason} and the job ends ${files.job.status} (seeded ${gate.outcome})`)],
      [files.job.improverScope === 'user' && dom.scope === 'user' && dom.status === files.job.status, tag(`the card shows the job's status (${dom.status}) and the user-level improver (${dom.scope})`)],
      [typeof word === 'string' && has(dom.verdict, word), tag(`the gate conclusion gives the reason in words: ${word} (got ${JSON.stringify(first(dom.verdict, 120))})`)],
      [has(dom.verdict, decision.detail), tag('and the decision record\'s detail')],
      [!has(dom.verdict, gate.reason), tag('and not the raw reason id')],
    )
    if (gate.reason === 'instance-literal') {
      const found = decision.literals ?? []
      const hits = dom.literals ?? []
      conditions.push(
        [has(dom.refused, '回放前已拒绝'), tag(`it says the candidate was refused before any replay (got ${JSON.stringify(dom.refused)})`)],
        [found.length === (seededGate?.literals ?? []).length && found.length >= 1 && found.every((hit, i) => hit.value === seededGate.literals[i]?.value && hit.path === seededGate.literals[i]?.path && hit.source === seededGate.literals[i]?.source), tag('the decision record holds the values the seed wrote')],
        [hits.length === found.length && found.every((hit, i) => has(hits[i], hit.value) && has(hits[i], `文件 ${hit.path}`) && has(hits[i], `来源 ${hit.source}`)), tag(`each value found is listed with its file and its source (${hits.length} shown, ${found.length} in the record)`)],
        [dom.similarRate === null && dom.originalOnly === null, tag('no similar-case rate and no original-only note (the gate never replayed)')],
      )
    } else if (gate.reason === 'similar-regression') {
      const similar = decision.similar
      conditions.push(
        [similar !== undefined && similar.candidate < similar.baseline, tag(`the record has the similar cases worse (${JSON.stringify(similar)})`)],
        [similar !== undefined && has(dom.similarRate, `候选 ${percentShown(similar.candidate)}，现在 ${percentShown(similar.baseline)}`), tag(`both similar-case pass rates are shown (got ${JSON.stringify(dom.similarRate)})`)],
        [typeof decision.passRate?.candidate === 'number' && has(dom.passRate, percentShown(decision.passRate.candidate)) && has(dom.passRate, percentShown(decision.passRate.baseline)), tag(`next to the overall pass rate (got ${JSON.stringify(dom.passRate)})`)],
        [dom.refused === null && (dom.literals ?? []).length === 0 && dom.originalOnly === null, tag('no literal section and no original-only note')],
      )
    } else {
      const approval = obs.d25.approval
      conditions.push(
        [has(dom.originalOnly, '只在原题上验证过'), tag(`the detail says it was verified on the original case only (got ${JSON.stringify(first(dom.originalOnly, 60))})`)],
        [dom.similarRate === null && decision.similar === undefined && dom.refused === null, tag('there are no similar cases: no similar-case rate, no refusal')],
        [files.job.status === 'awaiting-approval' && dom.status === 'awaiting-approval', tag('the job waits for approval')],
        [approval !== undefined && has(approval.text, '候选需要你的批准') && has(approval.originalOnly, '只在原题上验证过') && has(approval.originalOnly, '项目里没有相似任务'), tag(`the approval dialog says the same (got ${JSON.stringify(first(approval?.originalOnly, 60))})`)],
        [approval?.hash === gate.candidateVersion, tag(`and the dialog is for this candidate (${shortVersion(approval?.hash)} is ${shortVersion(gate.candidateVersion)})`)],
      )
    }
  }
  return conditions
}

export function judgeD25(obs) {
  const seen = observed(obs, 'd25', [
    [o => o.d25?.seeded !== undefined, 'the seeded meta job\'s detail'],
    [o => o.d25?.real !== undefined, 'the real meta job\'s detail'],
    [o => o.seeded?.jobId !== undefined, 'the seeded ids'],
    [o => (o.d25?.gates ?? []).length > 0 && o.d25?.approval !== undefined, 'the ADR 0013 gate conclusions and the approval dialog'],
  ])
  if (seen.fail !== undefined) return { status: 'failed', evidence: seen.fail }
  const conditions = [...seededDetail(obs), ...realDetail(obs), [obs.d25.seeded.jobId === obs.seeded.jobId, 'the detail observed is the seeded job\'s'], ...gateDetails(obs)]
  return verdict(conditions, `meta job detail checked against meta-diagnosis.json, change.json, comparison.json, job.json, the child improver file, the activation chain and the ledger: diagnosis, change before/after, both arms (version, offspring, gate result in words, quality, cost), decision ${obs.d25.seeded.files?.comparison?.outcome}/${obs.d25.seeded.files?.comparison?.reason}, cost; a real meta job (${obs.d25.real.files?.job?.status}) shows its diagnosis and a ledger-priced cost with no change or comparison; the three ADR 0013 conclusions (${(obs.d25.gates ?? []).map(g => g.reason).join(', ')}) in words, with the values found (file, source), both similar-case rates and the original-case-only note in the detail and the approval dialog; ${seededNote(obs)}`)
}

// ---- D26 ------------------------------------------------------------------------------

/**
 * What the settings page, the two config files and the 改进 tab should say for one saved setting:
 * the meta switch and budget are the USER's (the page's user section, `<home>/config.json`), the
 * project keeps only its sharing switch (`.nexgent/config.json`, no `improvement.meta`).
 */
function settingConditions(label, typed, { dom, config, screen, pending }) {
  const text = n => String(n)
  const conditions = []
  if (dom !== undefined) {
    conditions.push([dom?.metaInUserSection === true && dom?.enabled === typed.enabled && dom?.every === text(typed.every) && dom?.budget === text(typed.budget) && dom?.window === text(typed.window), `${label}: the settings page's user section shows ${JSON.stringify(dom)} (typed ${JSON.stringify({ ...typed, share: undefined })})`])
    conditions.push([dom?.share === typed.share, `${label}: and the project section's 参与改进器学习 reads ${JSON.stringify(dom?.share)} (typed ${typed.share})`])
  }
  const user = config?.user
  conditions.push(
    [user?.enabled === typed.enabled && user?.every === typed.every && user?.budget === typed.budget && user?.window === typed.window, `${label}: <home>/config.json says ${JSON.stringify(user)}`],
    [config?.project?.share === typed.share, `${label}: .nexgent/config.json says shareImproverEvidence ${JSON.stringify(config?.project?.share)} (typed ${typed.share})`],
    [config?.project?.meta === undefined, `${label}: and the project config holds no improvement.meta (got ${JSON.stringify(config?.project?.meta)})`],
  )
  if (screen !== undefined) {
    conditions.push(
      [has(screen.metaStatus, typed.enabled ? '元改进 开' : '元改进 关') && has(screen.metaStatus, ` / ${typed.every} `) && (pending === undefined || has(screen.metaStatus, `已计入 ${pending} /`)), `${label}: the 改进 tab says ${JSON.stringify(screen.metaStatus)}${pending === undefined ? '' : ` (the user queue holds ${pending} counted jobs)`}`],
      [has(screen.metaBudget, tokensShown(typed.budget)) && has(screen.metaBudget, `${typed.window} 天`), `${label}: and the meta budget ${JSON.stringify(screen.metaBudget)}`],
    )
  }
  return conditions
}

/** The job ids waiting in a snapshot's user queue. */
const pendingIds = snap => (snap?.queue?.pending ?? []).map(entry => entry.jobId)
/** Whether a snapshot's user queue counted job `id` (`<projectId>:<jobId>`). */
const counted = (snap, id) => typeof snap?.queue?.projectId === 'string' && (snap?.queue?.counted ?? []).includes(`${snap.queue.projectId}:${id}`)

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
  const initialTyped = { enabled: typed.on.enabled, every: String(typed.on.every), budget: String(typed.on.budget), window: String(typed.on.window), share: typed.on.share }
  const conditions = [
    [d26.initial?.enabled === false && d26.configBefore?.user?.enabled !== true, `before anything is saved meta improvement is off (page ${JSON.stringify(d26.initial?.enabled)}, <home>/config.json ${JSON.stringify(d26.configBefore?.user?.enabled)})`],
    [d26.initial?.metaInUserSection === true, 'the meta controls are in the user-level section of the settings page'],
    [d26.initial?.share === true && d26.configBefore?.project?.share !== false, `a project shares its evidence by default (page ${JSON.stringify(d26.initial?.share)}, config ${JSON.stringify(d26.configBefore?.project?.share)})`],
    [!sameJson({ enabled: d26.initial?.enabled, every: d26.initial?.every, budget: d26.initial?.budget, window: d26.initial?.window, share: d26.initial?.share }, initialTyped), 'the values typed in differ from what the page started with'],
    [d26.saveOn?.approvalDialogs === 0 && d26.saveOff?.approvalDialogs === 0 && d26.saveShareOff?.approvalDialogs === 0 && d26.saveShareOn?.approvalDialogs === 0, `saving needs no approval (dialogs ${d26.saveOn?.approvalDialogs}, ${d26.saveShareOff?.approvalDialogs}, ${d26.saveOff?.approvalDialogs}, ${d26.saveShareOn?.approvalDialogs})`],
    ...settingConditions('saved on', typed.on, { config: d26.configOn, screen: d26.screenOn }),
    ...settingConditions('after restart 1', typed.on, { dom: d26.restartOn, config: d26.configAfterRestartOn }),
    ...settingConditions('saved off', typed.off, { config: d26.configOff }),
    ...settingConditions('after restart 2', typed.off, { dom: d26.restartOff, config: d26.configAfterRestartOff, screen: d26.screenOff, pending: d26.filesAtRestart?.queue?.pending?.length }),
  ]

  const off = d26.autoOff
  const metaIds = snap => (snap?.jobs ?? []).filter(job => job.kind === 'meta').map(job => job.id).sort()
  const ranIds = (off?.ran ?? []).map(r => r.id)
  const pending = pendingIds(off?.after)
  conditions.push(
    [off?.after?.userConfig?.enabled === false && off?.before?.userConfig?.enabled === false && off?.after?.projectConfig?.meta === undefined && off?.after?.projectConfig?.share === true, `with the switch off in <home>/config.json (before ${off?.before?.userConfig?.enabled}, after ${off?.after?.userConfig?.enabled}), no meta key in the project config, and the project sharing`],
    [ranIds.length === typed.off.every && new Set(ranIds).size === ranIds.length && (off?.ran ?? []).every(r => ['adopted', 'rejected', 'no-proposal', 'failed'].includes(r.status)), `${ranIds.length} capability jobs finished (${(off?.ran ?? []).map(r => r.status).join(',')}), as many as the K = ${typed.off.every} that start a meta job`],
    [ranIds.every(id => counted(off?.after, id) && pending.includes(id)), 'the user queue (<home>/improvements/queue.json) counted each of them toward the next meta job (projectId:jobId) and they are still waiting'],
    [pending.length >= typed.off.every, `${pending.length} counted jobs are waiting, K = ${typed.off.every}`],
    [sameJson(metaIds(off?.before), metaIds(off?.after)) && (off?.after?.jobs ?? []).filter(job => !(off?.before?.jobs ?? []).some(b => b.id === job.id)).every(job => job.kind !== 'meta'), `no meta job started: ${metaIds(off?.after).length} meta job files before and after, and every job that appeared meanwhile is a capability job`],
    [off?.after?.queue?.activeJobId === undefined, 'and no job holds the slot'],
  )
  const control = d26.control
  const started = (control?.after?.jobs ?? []).find(job => job.id === control?.started)
  conditions.push(
    [control?.configEnabled === true && control?.after?.userConfig?.enabled === true && control?.after?.projectConfig?.meta === undefined, 'control: the switch was turned on in the user config (and not in the project config)'],
    [started?.kind === 'meta' && started?.trigger === 'job-count' && !(control?.before?.jobs ?? []).some(job => job.id === started.id), `control: one more finished job starts a meta job on the job-count rule (got ${started?.kind}/${started?.trigger})`],
    [started?.meta?.basis >= typed.off.every && ranIds.every(id => !pendingIds(control?.after).includes(id)), `control: its basis is ${started?.meta?.basis} jobs (K = ${typed.off.every}) and they left the waiting list`],
    [(consoleErrors?.second ?? []).length === 0 && (consoleErrors?.third ?? []).length === 0, `no console errors after the restarts (got ${JSON.stringify([...(consoleErrors?.second ?? []), ...(consoleErrors?.third ?? [])])})`],
  )
  return verdict(conditions, `meta settings typed into the user section of the settings page twice (on ${JSON.stringify({ ...typed.on, share: undefined })}, off ${JSON.stringify({ ...typed.off, share: undefined })}), each read back from <home>/config.json (never from .nexgent/config.json, which holds no improvement.meta), the page after a restart and the 改进 tab, with no approval; the project's 参与改进器学习 switch saved separately into .nexgent/config.json (off, then on) and kept across restarts; with the switch off ${ranIds.length} finished jobs (K = ${typed.off.every}) were counted by the user queue and no meta job started, while the same count with the switch on started one (job ${first(control?.started, 8)}); ${seededNote(obs)}`)
}

// ---- D27 ------------------------------------------------------------------------------

export function judgeD27(obs) {
  const seen = observed(obs, 'd27', [
    [o => o.d27?.before !== undefined && o.d27?.after !== undefined && o.d27?.final !== undefined, 'the improver chain before and after the rollback and after the next jobs'],
    [o => (o.d27?.next ?? []).length >= 2, 'the jobs started after the rollback'],
    [o => o.d27?.confirmation !== undefined && o.d27?.mainBefore !== undefined && o.d27?.otherBefore !== undefined && o.d27?.otherFinal !== undefined && o.d27?.otherNext !== undefined, 'the rollback confirmation and the other project\'s next job'],
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
  // The projects whose jobs ran on the child (user scope), by the job files of the two projects: the confirmation lists exactly them.
  const ranOnChild = job => job.arm !== true && job.improverScope === 'user' && (job.improverVersion ?? 'v0') === child
  const mainJobs = d27.before.jobs ?? []
  const otherJobs = d27.otherBefore?.jobs ?? []
  const expected = [
    ...(mainJobs.some(ranOnChild) ? [{ name: d27.mainBefore?.name, root: d27.mainBefore?.root }] : []),
    ...(otherJobs.some(ranOnChild) ? [{ name: d27.otherBefore?.name, root: d27.otherBefore?.root }] : []),
  ]
  const shown = d27.confirmation?.projects ?? []
  const otherNext = d27.otherNext
  const otherFile = fileJobOf(d27.otherFinal, otherNext?.id)
  const conditions = [
    [expected.length === 2 && mainJobs.some(ranOnChild) && otherJobs.some(ranOnChild), `two projects ran jobs on the child by their job files (this project ${mainJobs.filter(ranOnChild).length}, ${d27.otherBefore?.name} ${otherJobs.filter(ranOnChild).length})`],
    [has(d27.confirmation?.text, '最近使用过当前改进器的项目') && shown.length === expected.length && expected.every(project => shown.some(p => p.root === project.root && p.root !== '' && has(p.text, project.name))), `the rollback confirmation lists the projects that used the child: ${JSON.stringify(shown.map(p => first(p.text, 40)))} (job files: ${JSON.stringify(expected.map(p => p.name))})`],
    [before.length >= 1 && inForce(before) === child && before.at(-1)?.type === 'adopt', `before: the child ${shortVersion(child)} is in force by the chain (${before.length} revision, tail ${before.at(-1)?.type})`],
    [after.length === before.length + 1 && after.every((r, i) => i >= before.length || sameJson(r, before[i])), `after: exactly one revision was added and the earlier ones are unchanged (${before.length} → ${after.length})`],
    [tail?.type === 'rollback' && tail?.trigger === 'manual' && tail?.revision === before.length + 1 && tail?.from === child, `the new revision #${tail?.revision} is a manual rollback from ${shortVersion(tail?.from)} (got ${tail?.type}/${tail?.trigger})`],
    [tail?.version === 'v0' && inForce(after) === 'v0', `it returns to ${shortVersion(tail?.version)} (the parent the child replaced)`],
    [typeof d27.reason === 'string' && d27.reason !== '' && tail?.reason === d27.reason, `the reason typed in the confirmation is written to the revision (got ${JSON.stringify(tail?.reason)})`],
    [d27.afterImprover?.version === 'v0' && d27.afterImprover?.revision === String(tail?.revision) && (d27.afterImprover?.revisions ?? []).length === after.length, `the screen shows ${shortVersion(d27.afterImprover?.version)} at revision ${d27.afterImprover?.revision} with ${(d27.afterImprover?.revisions ?? []).length} revisions listed`],
    [d27.afterImprover?.revisions?.[0]?.type === 'rollback' && d27.afterImprover?.revisions?.[0]?.version === 'v0' && has(d27.afterImprover?.revisions?.[0]?.text, d27.reason), 'the newest listed revision is the rollback with the reason'],
    [inForce(finalFiles?.revisions) === 'v0' && d27.final.improver?.version === 'v0', 'after the next jobs v0 is still the improver in force on disk and on screen'],
    [d27.after.legacyProjectImprovers === false && finalFiles?.legacyProjectImprovers === false, 'the rollback went into <home>/improvers/activation: the project has no .nexgent/improvers'],
  ]
  const kinds = []
  for (const next of d27.next ?? []) {
    const file = fileJobOf(finalFiles, next.id)
    kinds.push(file?.kind)
    conditions.push(
      [file !== undefined && FINAL.has(file.status), `next job ${first(next.id, 8)} (${next.via}) finished (${file?.status})`],
      [file?.improverVersion === tail?.version && file?.createdAt > tail?.committedAt, `next job ${first(next.id, 8)} was created after the rollback and job.json pins ${shortVersion(file?.improverVersion)}, the rolled-back version ${shortVersion(tail?.version)}`],
      [file?.improverScope === 'user' && cardOf(d27.final.cards, next.id)?.improverVersion === file?.improverVersion && cardOf(d27.final.cards, next.id)?.improverScope === 'user', `its card shows the same version (${shortVersion(cardOf(d27.final.cards, next.id)?.improverVersion)}) and the user scope`],
    )
  }
  conditions.push(
    [otherFile !== undefined && otherFile.kind === 'meta' && FINAL.has(otherFile.status), `the other project's next job (${first(otherNext?.id, 8)}, ${otherNext?.via}) finished (${otherFile?.status})`],
    [otherFile?.improverVersion === tail?.version && otherFile?.improverScope === 'user' && otherFile?.createdAt > tail?.committedAt, `and it pins the rolled-back version ${shortVersion(tail?.version)} of the user line (job.json says ${shortVersion(otherFile?.improverVersion)}, scope ${otherFile?.improverScope}), created after the rollback`],
    [(d27.otherFinal?.jobs ?? []).filter(job => job.createdAt > tail?.committedAt).every(job => job.improverVersion === tail?.version && job.improverScope === 'user') && otherJobs.every(job => !ranOnChild(job) || (d27.otherFinal?.jobs ?? []).some(final => final.id === job.id && final.improverVersion === child)), 'every job of the other project created after the rollback pins the rolled-back version, and its earlier job still names the child'],
    [kinds.includes('capability') && kinds.includes('meta'), `the next jobs are one capability job and one meta job (got ${kinds.join(',')})`],
    [newJobs.length >= (d27.next ?? []).length && newJobs.every(job => job.improverVersion === tail?.version), `every job created after the rollback (${newJobs.length}) pins ${shortVersion(tail?.version)}`],
    [fileJobOf(finalFiles, prepared?.j2?.id)?.improverVersion === child, `the job before the rollback (J2) pinned the child ${shortVersion(child)}, so the rolled-back version is a real change`],
    [(seen.obs.consoleErrors?.first ?? []).length === 0, `no console errors in the first launch (got ${JSON.stringify(seen.obs.consoleErrors?.first)})`],
  )
  return verdict(conditions, `rollback clicked in the UI with a reason: revision #${tail?.revision} (manual rollback ${shortVersion(child)} → ${shortVersion(tail?.version)}) appended to <home>/improvers/activation (the user line, not the project), earlier revisions unchanged, after the confirmation listed the ${expected.length} projects that ran on the child (${expected.map(p => p.name).join(', ')}); the next ${(d27.next ?? []).length} jobs (capability, meta) and the other project's next job pin the rolled-back version (user scope) in job.json, and the first two on their cards, while the job before pinned the child; ${seededNote(seen.obs)}`)
}

/** The four judges by item id. */
export const DESKTOP_JUDGES = { D24: judgeD24, D25: judgeD25, D26: judgeD26, D27: judgeD27 }
