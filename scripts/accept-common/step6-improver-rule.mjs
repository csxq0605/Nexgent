/**
 * Step 6: the judge's own reading of the parent / child improver comparison rule
 * (ADR 0008 decision 4; user decision 4, 2026-10-13), and the scripted playbooks
 * the meta-improvement scenario runs (partition W7).
 *
 * H10 checks that the product's `decideImprover` agrees with the rule recomputed
 * from the two arms' records in `comparison.json`. This file is that
 * recomputation: written from the ADR's wording over the contract's record
 * shapes (`ComparisonOrigin`, `ComparisonArmResult`), not imported from the
 * product, so a drift in either shows up as a disagreement instead of agreeing
 * with itself. Reasons are the contract's names.
 *
 * The rule, in order:
 *   1. the arms' epochs differ from each other or from the origin → reject `epoch-mismatch`;
 *      any other origin difference (source job, snapshot tree, feedback set, capability
 *      version) → reject `origin-mismatch`;
 *   2. either arm unknown → reject `unknown-arm`. Unknown: the job did not finish, or ended
 *      interrupted / cancelled / budget-exhausted, or failed on an error other than its own
 *      invalid diagnosis, or its trial ended unknown-runs / budget-exhausted, or its cost is
 *      not a known number;
 *   3. the child produced no offspring (no candidate) → reject `no-offspring`;
 *   4. the child's offspring passed its gate (job adopted in the copy) and the parent's did
 *      not → adopt `gate-passed`;
 *   5. only when both passed: higher child quality (the gate's candidate pass rate) → adopt
 *      `quality-up`; equal quality and child cost ≤ 90% of a parent cost above 0 (exactly
 *      10% less counts) → adopt `cost-down`;
 *   6. otherwise → reject `no-improvement`.
 * 「契约」 confirmed both readings of 5 (2026-10-13).
 */

/** A child at most this fraction of the parent's cost wins a quality tie. */
export const COST_DOWN_RATIO = 0.9

const FINISHED = new Set(['adopted', 'rejected', 'no-proposal', 'failed'])
const OWN_FAILURES = new Set(['improvement/invalid-diagnosis'])
const UNKNOWN_TRIALS = new Set(['unknown-runs', 'budget-exhausted'])

const knownNumber = value => typeof value === 'number' && Number.isFinite(value)

function sameOrigin(a, b) {
  const key = o => JSON.stringify([o?.sourceJobId, o?.tree, o?.capabilityVersion, [...(o?.feedbackIds ?? [])].sort()])
  return key(a) === key(b)
}

/** What one arm's record says, by the rule's own reading. */
export function armFacts(arm) {
  const status = arm?.status
  const errored = status === 'failed' && arm.error !== undefined && !OWN_FAILURES.has(arm.error?.code)
  const unknown = !FINISHED.has(status) || errored || UNKNOWN_TRIALS.has(arm?.verdict?.reason) || !knownNumber(arm?.cost?.estimatedUsd)
  const gatePassed = status === 'adopted'
  const quality = gatePassed && knownNumber(arm?.verdict?.passRate?.candidate) ? arm.verdict.passRate.candidate : undefined
  return { unknown, offspring: typeof arm?.candidateId === 'string', gatePassed, quality, costUsd: arm?.cost?.estimatedUsd }
}

/**
 * Recompute the parent / child decision from `comparison.json`'s origin and arms.
 * @returns `{ outcome: 'adopt' | 'reject', reason }` with the contract's reason names.
 */
export function referenceImproverDecision(origin, parent, child) {
  const reject = reason => ({ outcome: 'reject', reason })
  if (origin === undefined || parent === undefined || child === undefined) return reject('unknown-arm')
  if (parent.origin?.epoch !== origin.epoch || child.origin?.epoch !== origin.epoch) return reject('epoch-mismatch')
  if (!sameOrigin(parent.origin, origin) || !sameOrigin(child.origin, origin)) return reject('origin-mismatch')
  const p = armFacts(parent)
  const c = armFacts(child)
  if (p.unknown || c.unknown) return reject('unknown-arm')
  if (!c.offspring) return reject('no-offspring')
  if (c.gatePassed && !p.gatePassed) return { outcome: 'adopt', reason: 'gate-passed' }
  if (!(c.gatePassed && p.gatePassed) || c.quality === undefined || p.quality === undefined) return reject('no-improvement')
  if (c.quality > p.quality) return { outcome: 'adopt', reason: 'quality-up' }
  if (c.quality === p.quality && p.costUsd > 0 && c.costUsd <= p.costUsd * COST_DOWN_RATIO) return { outcome: 'adopt', reason: 'cost-down' }
  return reject('no-improvement')
}

/**
 * Scripted playbooks for the meta-improvement scenario (partition W7). Each says
 * what the scripted model answers in the meta diagnosis and meta proposal, how
 * the two arms end (`arms`: status, offspring, gate pass rate, cost), and what
 * the product must record. `arm()` below turns an `arms` entry into a
 * `ComparisonArmResult`-shaped record for {@link referenceImproverDecision}.
 */
export const PLAYBOOKS = [
  {
    id: 'improve-the-improver',
    title: '该改进改进器：元诊断指出诊断常漏读失败检查，子改进器补一段诊断策略，后代通过门控而父的不通过，子被采用',
    metaDiagnosis: { proposalKind: 'change', finding: 'diagnoses keep skipping the failed check records' },
    change: { op: 'set-diagnosis-paragraph', index: 'append', text: 'Before naming a failure type, read every failed check record of the task and cite it.' },
    arms: {
      parent: { status: 'rejected', offspring: true, passRate: 0.67, costUsd: 0.4 },
      child: { status: 'adopted', offspring: true, passRate: 1, costUsd: 0.42 },
    },
    expect: { status: 'adopted', reason: 'gate-passed', nextJobUsesChild: true },
  },
  {
    id: 'improver-is-fine',
    title: '改进器没问题：元诊断给 none，不提改动',
    metaDiagnosis: { proposalKind: 'none', finding: 'recent jobs failed for reasons the improver cannot change' },
    change: null,
    arms: null,
    expect: { status: 'no-proposal', reason: null, nextJobUsesChild: false },
  },
  {
    id: 'child-is-worse',
    title: '子改进器更差：子在副本里没产出后代，不采用，父照常使用',
    metaDiagnosis: { proposalKind: 'change', finding: 'proposals are too broad' },
    change: { op: 'set-proposal-kinds', kinds: ['context-policy'] },
    arms: {
      parent: { status: 'adopted', offspring: true, passRate: 1, costUsd: 0.45 },
      child: { status: 'no-proposal', offspring: false, passRate: null, costUsd: 0.3 },
    },
    expect: { status: 'rejected', reason: 'no-offspring', nextJobUsesChild: false },
  },
  {
    id: 'out-of-bounds-change',
    title: '越界改动：元提案改评价器字段（费用倍数），被拒，不进比较',
    metaDiagnosis: { proposalKind: 'change', finding: 'the gate rejects too often' },
    change: { op: 'set-comparison-param', param: 'costApprovalRatio', value: 10 },
    arms: null,
    expect: { status: 'failed', reason: 'evaluator-field', nextJobUsesChild: false },
  },
]

/**
 * A playbook's change as the meta proposal submits it against `parent` (an
 * `ImproverBundle`): `index: 'append'` becomes the parent's paragraph count.
 */
export function changeFor(playbook, parent) {
  if (playbook.change === null) return null
  if (playbook.change.index !== 'append') return { ...playbook.change }
  return { ...playbook.change, index: parent.diagnosis.paragraphs.length }
}

/** A playbook arm as a `ComparisonArmResult`-shaped record over `origin`. */
export function arm(origin, name, spec) {
  return {
    arm: name,
    improverVersion: name === 'parent' ? 'v0' : 'a'.repeat(64),
    origin,
    jobId: `${name}-job`,
    status: spec.status,
    ...(spec.offspring ? { candidateId: `${name}-candidate` } : {}),
    ...(spec.passRate === null || spec.passRate === undefined ? {} : { verdict: { outcome: spec.status === 'adopted' ? 'adopt' : 'reject', reason: spec.status === 'adopted' ? 'quality-up' : 'no-improvement', passRate: { candidate: spec.passRate, baseline: 0.67 } } }),
    cost: { estimatedUsd: spec.costUsd },
  }
}
