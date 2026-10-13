/**
 * Step 6: the judge's own reading of the parent / child improver comparison rule
 * (docs/plan/step-6-work-partition.md, user decision 4, 2026-10-13), and the
 * scripted playbooks the meta-improvement scenario will run (partition W7).
 *
 * H10 checks that the product's `decideImprover` agrees with the rule recomputed
 * from the two arms' records. This file is that recomputation: written from the
 * plan's wording, not imported from the product, so a drift in either shows up
 * as a disagreement instead of agreeing with itself.
 *
 * The rule, in order:
 *   1. any `unknown` in either arm → not adopted;
 *   2. the child produced no descendant → not adopted;
 *   3. the child's descendant passed its gate and the parent's did not → adopted;
 *   4. both passed and the child's gate quality is higher → adopted;
 *   5. both passed, equal quality, and the child's job cost at least 10% less → adopted;
 *   6. otherwise → not adopted.
 * Reading of the plan where it is silent (to be confirmed against W0's contract):
 * rules 4 and 5 apply only when both descendants passed their gates; a parent
 * that produced no descendant counts as "did not pass" for rule 3.
 *
 * Arm record (what the judge reads from the comparison record, field names to be
 * bound to W0's `comparison.json` once the contract lands):
 *   { descendant: boolean | 'unknown', gatePassed: boolean | 'unknown',
 *     quality: number | 'unknown', costUsd: number | 'unknown' }
 */

/** The child must cost at least this fraction less to win a quality tie. */
export const COST_WIN_FRACTION = 0.1

const isUnknown = value => value === 'unknown' || value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))

/**
 * Recompute the parent / child decision from the two arms.
 * @returns `{ adopt, reason }` — reason one of unknown, no-descendant, gate-win,
 *   quality-win, cost-win, no-gain.
 */
export function referenceImproverDecision(parent, child) {
  const fields = ['descendant', 'gatePassed', 'quality', 'costUsd']
  for (const [arm, record] of [['parent', parent], ['child', child]]) {
    if (record === undefined || record === null) return { adopt: false, reason: 'unknown', detail: `${arm} arm missing` }
    // A missing descendant makes the gate fields moot: only the descendant flag and the cost must be known.
    const needed = record.descendant === false ? ['descendant', 'costUsd'] : fields
    const unknown = needed.filter(field => isUnknown(record[field]))
    if (unknown.length > 0) return { adopt: false, reason: 'unknown', detail: `${arm} arm: ${unknown.join(', ')} unknown` }
  }
  if (child.descendant !== true) return { adopt: false, reason: 'no-descendant', detail: 'the child improver produced no descendant' }
  const parentPassed = parent.descendant === true && parent.gatePassed === true
  if (child.gatePassed === true && !parentPassed) return { adopt: true, reason: 'gate-win', detail: "the child's descendant passed its gate, the parent's did not" }
  if (child.gatePassed === true && parentPassed) {
    if (child.quality > parent.quality) return { adopt: true, reason: 'quality-win', detail: `gate quality ${child.quality} > ${parent.quality}` }
    if (child.quality === parent.quality && child.costUsd <= parent.costUsd * (1 - COST_WIN_FRACTION)) {
      return { adopt: true, reason: 'cost-win', detail: `equal quality, cost ${child.costUsd} ≤ 90% of ${parent.costUsd}` }
    }
  }
  return { adopt: false, reason: 'no-gain', detail: 'the child is not better by the rule' }
}

/**
 * Scripted playbooks for the meta-improvement scenario (partition W7). Each says
 * what the scripted model answers in the meta-diagnosis and meta-proposal, what
 * the two arms should end with, and what the scenario must observe. `arms` feed
 * {@link referenceImproverDecision}; `expect` is what the product must record.
 */
export const PLAYBOOKS = [
  {
    id: 'improve-the-improver',
    title: '该改进改进器：元诊断指出诊断常漏读失败检查，子改进器补一段诊断策略，后代通过门控而父的不通过，子被采用',
    metaDiagnosis: { proposalKind: 'change', finding: 'diagnoses keep skipping the failed check records' },
    change: { kind: 'diagnosis-policy', summary: 'read every failed check record before naming a failure type' },
    arms: {
      parent: { descendant: true, gatePassed: false, quality: 0.67, costUsd: 0.4 },
      child: { descendant: true, gatePassed: true, quality: 1, costUsd: 0.42 },
    },
    expect: { status: 'adopted', reason: 'gate-win', nextJobUsesChild: true },
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
    change: { kind: 'proposal-operator', summary: 'only propose context policies' },
    arms: {
      parent: { descendant: true, gatePassed: true, quality: 1, costUsd: 0.45 },
      child: { descendant: false, gatePassed: 'unknown', quality: 'unknown', costUsd: 0.3 },
    },
    expect: { status: 'rejected', reason: 'no-descendant', nextJobUsesChild: false },
  },
  {
    id: 'out-of-bounds-change',
    title: '越界改动：元提案改评价器字段（采用规则 / 费用倍数），被拒，不进比较',
    metaDiagnosis: { proposalKind: 'change', finding: 'the gate rejects too often' },
    change: { kind: 'comparison-parameter', field: 'costApprovalRatio', value: 10, summary: 'raise the cost approval ratio' },
    arms: null,
    expect: { status: 'failed', reason: 'out-of-bounds', nextJobUsesChild: false },
  },
]
