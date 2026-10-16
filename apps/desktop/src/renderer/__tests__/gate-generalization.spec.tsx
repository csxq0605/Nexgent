// @vitest-environment jsdom
/**
 * ADR 0013 in the renderer: the three new gate reasons in words, the
 * pre-replay refusal with the hit values, the similar-case pass rate, and the
 * approval dialog for a candidate verified only on the feedback task.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CapabilityDecision, TrialVerdict } from '@nexgent/kernel'
import { FakeBridge, candidate, candidateDetail, improvementDetail, improvementJob } from '../testing/fake-bridge.js'
import { renderApp } from './helpers.js'

const ts = '2026-10-14T08:00:00.000Z'
const decision = (extra: Record<string, unknown>): CapabilityDecision =>
  ({ formatVersion: 1, id: 'd-1', outcome: 'rejected', reason: 'similar-regression', trigger: 'gate', decidedAt: ts, candidateId: 'c-1', fromVersion: 'baseline', toVersion: 'baseline', detail: '详情', ...extra }) as CapabilityDecision

function bridgeWith(status: 'rejected' | 'awaiting-approval', decisions: CapabilityDecision[]): FakeBridge {
  const bridge = new FakeBridge()
  const view = improvementJob({ id: 'j-1', status, candidateId: 'c-1' })
  const cand = candidate({ id: 'c-1', status })
  bridge.improvements = { ...bridge.improvements, jobs: [view] }
  bridge.improvementDetails['j-1'] = improvementDetail(view, { candidate: { ...candidateDetail(cand), decisions } })
  return bridge
}

async function openJob(bridge: FakeBridge) {
  await renderApp(bridge)
  fireEvent.click(screen.getByTestId('tab-improvements'))
  await waitFor(() => expect(screen.getByTestId('improvement-panel')).toBeTruthy())
  fireEvent.click(screen.getByTestId('improvement-status'))
  await screen.findByTestId('improvement-gate')
}

describe('gate conclusions of ADR 0013', () => {
  it('explains similar-regression and shows the similar-case pass rate', async () => {
    const verdict: TrialVerdict = { outcome: 'reject', reason: 'similar-regression', passRate: { candidate: 1, baseline: 0.5 }, similarPassRate: { candidate: 0.25, baseline: 0.75 }, decidedByReview: false } as TrialVerdict
    await openJob(bridgeWith('rejected', [decision({ reason: 'similar-regression', verdict, trialId: 't-1' })]))
    expect(screen.getByTestId('improvement-gate-verdict').textContent).toContain('同类题变差：候选在相似任务上通过的检查比现在少，已拒绝')
    expect(screen.getByTestId('improvement-similar-rate').textContent).toBe('同类题通过率：候选 25%，现在 75%')
  })

  it('explains no-similar-cases for an awaiting job', async () => {
    await openJob(bridgeWith('awaiting-approval', [decision({ outcome: 'awaiting-approval', reason: 'no-similar-cases' })]))
    expect(screen.getByTestId('improvement-gate-verdict').textContent).toContain('只在原题上验证过：项目里没有相似任务可验证，需要你批准')
    expect(screen.getByTestId('improvement-original-only').textContent).toContain('只在原题上验证过')
    expect(screen.queryByTestId('improvement-similar-rate')).toBeNull()
  })

  it('shows instance-literal as refused before replay with the hit values', async () => {
    const hits = [
      { value: '48213.55', kind: 'number', path: 'skills/region/SKILL.md', source: '反馈原文' },
      { value: 'ORD-20260917', kind: 'identifier', path: 'functions/tool.ts', source: '任务描述' },
    ]
    await openJob(bridgeWith('rejected', [decision({ reason: 'instance-literal', instanceLiterals: hits })]))
    expect(screen.getByTestId('improvement-gate-verdict').textContent).toContain('回放前已拒绝：候选含有原题的具体数值')
    expect(screen.getByTestId('improvement-refused').textContent).toBe('回放前已拒绝')
    const items = within(screen.getByTestId('improvement-literals')).getAllByTestId('improvement-literal')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('48213.55')
    expect(items[0]!.textContent).toContain('skills/region/SKILL.md')
    expect(items[0]!.textContent).toContain('反馈原文')
    expect(screen.queryByTestId('improvement-gate-rate')).toBeNull()
  })

  it('the capabilities page shows the reasons too', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate({ id: 'c-2', status: 'rejected', decision: { id: 'd-2', outcome: 'rejected', reason: 'instance-literal', detail: '含 48213.55' } })] }
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('tab-capabilities'))
    fireEvent.click(await screen.findByTestId('candidate-status'))
    await waitFor(() => expect(screen.getByTestId('candidate-reason').textContent).toContain('回放前已拒绝：候选含有原题的具体数值'))
  })

  it('the capabilities page gives a gate verdict\'s numbers in words and folds the English detail line away', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate({ id: 'c-3', status: 'rejected', decision: { id: 'd-3', outcome: 'rejected', reason: 'no-improvement', detail: 'reject (no-improvement). Quality passed: candidate 67%, baseline 67%.' } })] }
    const verdict = { outcome: 'reject', reason: 'no-improvement', passRate: { candidate: 2 / 3, baseline: 2 / 3 }, similarPassRate: { candidate: 1, baseline: 1 }, feedbackPassRate: { candidate: 0, baseline: 0 }, costRatio: 1.358, decidedByReview: false } as TrialVerdict
    bridge.evidence['c-3'] = { receipts: [], decisions: [decision({ id: 'd-3', candidateId: 'c-3', reason: 'no-improvement', verdict })] }
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('tab-capabilities'))
    fireEvent.click(await screen.findByTestId('candidate-status'))
    await waitFor(() => expect(screen.getByTestId('candidate-reason').textContent).toContain(
      '原因：没有改进。检查通过率 候选 67% / 基线 67%；同类题通过率：候选 100%，现在 100%；反馈检查（单独记）候选 0% / 基线 0%；费用是基线的 1.36 倍。',
    ))
    // The English line is still there, folded under a summary.
    const record = screen.getByTestId('candidate-reason').querySelector('details')!
    expect(record.open).toBe(false)
    expect(record.textContent).toContain('reject (no-improvement)')
  })
})

describe('approval for a candidate verified only on the original task', () => {
  it('opens the dialog with the 只在原题上验证过 section, even without plugins or a cost reason', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [candidate({ id: 'c-5', status: 'awaiting-approval', requiresApproval: false, components: [{ kind: 'skill', name: 'region-table' }], decision: { id: 'd-5', outcome: 'awaiting-approval', reason: 'no-similar-cases', detail: 'only original' } })],
    }
    bridge.evidence['c-5'] = { receipts: [], decisions: [decision({ id: 'd-5', candidateId: 'c-5', outcome: 'awaiting-approval', reason: 'no-similar-cases' })] }
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(dialog.textContent).toContain('候选需要你的批准')
    expect(within(dialog).getByTestId('approval-original-only').textContent).toContain('只在原题上验证过')
    expect(within(dialog).getByTestId('approval-original-only').textContent).toContain('没有相似任务')
    expect(within(dialog).queryByTestId('approval-plugins')).toBeNull()
    expect(within(dialog).queryByTestId('approval-cost')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('plugin-allow'))
    await waitFor(() => expect(bridge.callsOf('capabilities.approve')).toEqual([{ projectId: 'p1', candidateId: 'c-5', decision: 'allow' }]))
  })
})
