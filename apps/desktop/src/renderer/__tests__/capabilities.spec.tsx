// @vitest-environment jsdom
/**
 * Step 4 in the renderer (W4): the 能力 tab shows the adopted version, its
 * problem, candidates with their gate results and the history; a plugin
 * candidate awaiting approval asks in a dialog (allow adopts, deny rejects),
 * and so does a quality rise above the cost limit (ADR 0007: the ratio, each
 * arm's cost and the quality comparison, without the plugin wording);
 * manual rollback.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CandidateDetail } from '@nexgent/sdk'
import type { TrialCost, TrialVerdict } from '@nexgent/kernel'
import { BUNDLE, FakeBridge, candidate, pluginInfo } from '../testing/fake-bridge.js'
import { PROPOSED_POLL_WINDOW_MS, TRIAL_POLL_MS } from '../store.js'
import { emit, renderApp } from './helpers.js'

const capabilityEvent = (type: 'capability.version' | 'capability.candidate', extra: Record<string, unknown>) => ({ type, sessionId: undefined, ...extra })

async function openTab(bridge?: FakeBridge) {
  const rendered = await renderApp(bridge)
  fireEvent.click(screen.getByTestId('tab-capabilities'))
  await waitFor(() => expect(screen.getByTestId('capability-panel')).toBeTruthy())
  return rendered
}

describe('capability versions in the right panel', () => {
  it('re-reads the list while a candidate is trialing, so a gate decided in its own process shows without an event', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate({ id: 'c-9', status: 'trialing', trialId: 'abcdef12-0000' })] }
    await openTab(bridge)
    expect(screen.getByTestId('candidate-status').textContent).toBe('门控试验中')
    const reads = bridge.callsOf('capabilities.list').length
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [candidate({ id: 'c-9', status: 'rejected', trialId: 'abcdef12-0000', decision: { id: 'd9', outcome: 'rejected', reason: 'quality-down', detail: 'Fewer checks passed.' } })],
    }
    await waitFor(() => expect(screen.getByTestId('candidate-status').textContent).toBe('未采用'), { timeout: TRIAL_POLL_MS + 3_000 })
    const after = bridge.callsOf('capabilities.list').length
    expect(after).toBeGreaterThan(reads)
    // Nothing is trialing any more: no further reads.
    await new Promise(resolve => setTimeout(resolve, TRIAL_POLL_MS + 500))
    expect(bridge.callsOf('capabilities.list').length).toBe(after)
  }, 3 * TRIAL_POLL_MS)

  it('re-reads the list after a fresh proposal, so a gate that starts on its own when the task ends shows; an old proposal is left alone', async () => {
    const bridge = new FakeBridge()
    const old = new Date(Date.now() - PROPOSED_POLL_WINDOW_MS - 60_000).toISOString()
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate({ id: 'c-8', status: 'proposed', proposedAt: new Date().toISOString() }), candidate({ id: 'c-7', status: 'proposed', proposedAt: old })] }
    await openTab(bridge)
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate({ id: 'c-8', status: 'trialing', trialId: 'abcdef12-0000' }), candidate({ id: 'c-7', status: 'proposed', proposedAt: old })] }
    await waitFor(() => expect(screen.getAllByTestId('candidate-status')[0]!.textContent).toBe('门控试验中'), { timeout: TRIAL_POLL_MS + 3_000 })

    const quiet = new FakeBridge()
    quiet.capabilities = { ...quiet.capabilities, candidates: [candidate({ id: 'c-7', status: 'proposed', proposedAt: old })] }
    cleanup()
    await openTab(quiet)
    const reads = quiet.callsOf('capabilities.list').length
    await new Promise(resolve => setTimeout(resolve, TRIAL_POLL_MS + 500))
    expect(quiet.callsOf('capabilities.list').length).toBe(reads)
  }, 4 * TRIAL_POLL_MS)

  it('shows the baseline of a fresh project and no rollback', async () => {
    await openTab()
    const current = screen.getByTestId('capability-current')
    expect(current.dataset['version']).toBe('baseline')
    expect(screen.getByTestId('capability-version').textContent).toBe('基线（未采用任何能力包）')
    expect(screen.queryByTestId('capability-rollback')).toBeNull()
    expect(screen.getByTestId('capability-panel').textContent).toContain('还没有候选')
  })

  it('shows the adopted version, its components, candidates by status and the reason of a rejection', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      current: { version: BUNDLE, revision: 1, since: '2026-10-12T09:00:00.000Z', trigger: 'gate', components: [{ kind: 'function-module', name: 'order-tools' }] },
      history: [{ format: 1, revision: 1, previous: null, from: 'baseline', version: BUNDLE, type: 'adopt', trigger: 'gate', decisionId: 'd1', committedAt: '2026-10-12T09:00:00.000Z' }],
      candidates: [
        candidate({ id: 'c-3', status: 'trialing', trialId: 'abcdef12-0000' }),
        candidate({ id: 'c-2', status: 'rejected', components: [{ kind: 'skill', name: 'east-summary' }], decision: { id: 'd2', outcome: 'rejected', reason: 'quality-down', detail: 'The candidate passed fewer checks.' } }),
        candidate({ id: 'c-1', status: 'adopted', components: [{ kind: 'function-module', name: 'order-tools' }] }),
      ],
    }
    await openTab(bridge)
    expect(screen.getByTestId('capability-version').textContent).toBe(BUNDLE.slice(0, 12))
    expect(screen.getByTestId('capability-current').textContent).toContain('门控通过')
    expect(screen.getByTestId('capability-components').textContent).toContain('函数模块 · order-tools')
    const statuses = screen.getAllByTestId('capability-candidate').map(item => [item.dataset['candidate'], within(item).getByTestId('candidate-status').textContent])
    expect(statuses).toEqual([['c-3', '门控试验中'], ['c-2', '未采用'], ['c-1', '已采用']])
    expect(screen.getAllByTestId('capability-revision')).toHaveLength(1)

    // The rejection's reason opens with the candidate.
    const rejected = screen.getAllByTestId('capability-candidate')[1]!
    expect(within(rejected).queryByTestId('candidate-reason')).toBeNull()
    fireEvent.click(within(rejected).getByText('east-summary'))
    await waitFor(() => expect(within(rejected).getByTestId('candidate-reason').textContent).toBe('原因：检查通过率低于基线。The candidate passed fewer checks.'))
    expect(bridge.callsOf('capabilities.show')).toEqual([{ projectId: 'p1', candidateId: 'c-2' }])
  })

  it('shows the problem the host reports', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, current: { version: 'baseline', revision: 2, trigger: 'load-failure', components: [], problem: 'The adopted capability version failed verification.' } }
    await openTab(bridge)
    expect(screen.getByTestId('capability-problem').textContent).toContain('The adopted capability version failed verification.')
  })

  it('starts the gate for a proposed candidate', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, candidates: [candidate()] }
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('candidate-trial'))
    await waitFor(() => expect(within(screen.getByTestId('capability-candidate')).getByTestId('candidate-status').textContent).toBe('门控试验中'))
    expect(bridge.callsOf('capabilities.trial')).toEqual([{ projectId: 'p1', candidateId: 'c-1' }])
  })

  it('rolls back by hand after a confirmation, with an optional reason', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      current: { version: BUNDLE, revision: 1, trigger: 'gate', components: [{ kind: 'skill', name: 'order-summary' }] },
      history: [{ format: 1, revision: 1, previous: null, from: 'baseline', version: BUNDLE, type: 'adopt', trigger: 'gate', decisionId: 'd1', committedAt: '2026-10-12T09:00:00.000Z' }],
      candidates: [candidate({ status: 'adopted' })],
    }
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('capability-rollback'))
    fireEvent.change(screen.getByTestId('capability-rollback-reason'), { target: { value: '汇总不对' } })
    fireEvent.click(screen.getByTestId('capability-rollback-confirm'))
    await waitFor(() => expect(screen.getByTestId('capability-current').dataset['version']).toBe('baseline'))
    expect(bridge.callsOf('capabilities.rollback')).toEqual([{ projectId: 'p1', reason: '汇总不对' }])
    expect(within(screen.getByTestId('capability-candidate')).getByTestId('candidate-status').textContent).toBe('已回滚')
    expect(screen.getAllByTestId('capability-revision')[0]!.dataset['type']).toBe('rollback')
    expect(screen.getByTestId('capability-current').textContent).toContain('手动')
  })

  it('follows capability events: a new version and a changed candidate refresh the tab', async () => {
    const { bridge } = await openTab()
    bridge.capabilities = {
      current: { version: BUNDLE, revision: 1, trigger: 'gate', components: [{ kind: 'skill', name: 'order-summary' }] },
      history: [{ format: 1, revision: 1, previous: null, from: 'baseline', version: BUNDLE, type: 'adopt', trigger: 'gate', decisionId: 'd1', committedAt: '2026-10-12T09:00:00.000Z' }],
      candidates: [candidate({ status: 'adopted' })],
    }
    emit(bridge, capabilityEvent('capability.version', { current: bridge.capabilities.current }))
    await waitFor(() => expect(screen.getByTestId('capability-current').dataset['version']).toBe(BUNDLE))
    expect(screen.getByTestId('capability-candidate').dataset['status']).toBe('adopted')
  })
})

describe('plugin package approval', () => {
  const awaiting = () => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [candidate({ id: 'c-9', status: 'awaiting-approval', requiresApproval: true, components: [{ kind: 'plugin', name: 'greeter' }], summary: '问候插件', decision: { id: 'd9', outcome: 'awaiting-approval', reason: 'quality-up', detail: 'passed' } })],
    }
    return bridge
  }

  it('asks when a plugin candidate passed its gate: package name and hash; deny leaves it not adopted', async () => {
    const { bridge } = await renderApp(awaiting())
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(within(dialog).getByTestId('plugin-approval-names').textContent).toBe('greeter')
    expect(within(dialog).getByTestId('plugin-approval-hash').textContent).toBe(BUNDLE)
    expect(within(dialog).getByTestId('plugin-approval-files').textContent).toContain('greeter/plugin.json')
    expect(within(dialog).getByTestId('plugin-approval-description').textContent).toBe('说明：greeter 插件')
    expect(within(dialog).getByTestId('plugin-approval-permissions').textContent).toBe('插件自述的权限：读取项目文件；联网查询天气')
    expect(within(dialog).getByTestId('plugin-approval-tools').textContent).toBe('注册的工具：greeter_hello')
    expect(within(dialog).queryByTestId('plugin-approval-unreadable')).toBeNull()
    expect((within(dialog).getByTestId('plugin-allow') as HTMLButtonElement).disabled).toBe(false)
    expect(dialog.textContent).toContain('拥有应用的全部权限')
    expect(within(dialog).queryByTestId('approval-cost')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('plugin-deny'))
    await waitFor(() => expect(screen.queryByTestId('plugin-approval-dialog')).toBeNull())
    expect(bridge.callsOf('capabilities.approve')).toEqual([{ projectId: 'p1', candidateId: 'c-9', decision: 'deny' }])
    fireEvent.click(screen.getByTestId('tab-capabilities'))
    await waitFor(() => expect(within(screen.getByTestId('capability-candidate')).getByTestId('candidate-status').textContent).toBe('未采用'))
    expect(screen.getByTestId('capability-current').dataset['version']).toBe('baseline')
  })

  it('a plugin whose plugin.json could not be read has no entry: the dialog says so and allow is disabled', async () => {
    const bridge = awaiting()
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [{ ...bridge.capabilities.candidates[0]!, components: [{ kind: 'plugin', name: 'greeter' }, { kind: 'plugin', name: 'notes' }] }],
    }
    bridge.pluginInfo['c-9'] = [pluginInfo('greeter')]
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    const plugins = within(dialog).getAllByTestId('plugin-approval-plugin')
    expect(plugins.map(item => [item.dataset['plugin'], within(item).queryByTestId('plugin-approval-permissions')?.textContent ?? null])).toEqual([
      ['greeter', '插件自述的权限：读取项目文件；联网查询天气'],
      ['notes', null],
    ])
    expect(within(dialog).getByTestId('plugin-approval-unreadable').textContent).toContain('notes')
    const allow = within(dialog).getByTestId('plugin-allow') as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    fireEvent.click(allow)
    expect(bridge.callsOf('capabilities.approve')).toEqual([])
    expect((within(dialog).getByTestId('plugin-deny') as HTMLButtonElement).disabled).toBe(false)
  })

  it('allow adopts the plugin package; closing the dialog asks again only from the candidate', async () => {
    const { bridge } = await renderApp(awaiting())
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    fireEvent.click(within(dialog).getByLabelText('关闭'))
    expect(screen.queryByTestId('plugin-approval-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('tab-capabilities'))
    await waitFor(() => expect(screen.getByTestId('capability-panel')).toBeTruthy())
    // A later refresh does not reopen it by itself.
    emit(bridge, capabilityEvent('capability.candidate', { candidate: bridge.capabilities.candidates[0] }))
    await waitFor(() => expect(bridge.callsOf('capabilities.list').length).toBeGreaterThan(1))
    expect(screen.queryByTestId('plugin-approval-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('candidate-approve'))
    fireEvent.click(within(await screen.findByTestId('plugin-approval-dialog')).getByTestId('plugin-allow'))
    await waitFor(() => expect(screen.getByTestId('capability-current').dataset['version']).toBe(BUNDLE))
    expect(bridge.callsOf('capabilities.approve')).toEqual([{ projectId: 'p1', candidateId: 'c-9', decision: 'allow' }])
    expect(within(screen.getByTestId('capability-candidate')).getByTestId('candidate-status').textContent).toBe('已采用')
    expect(screen.getByTestId('capability-current').textContent).toContain('审批通过')
  })

  /** A gate that found the candidate better but `ratio`× the baseline's cost, waiting for the user (ADR 0007). */
  const costEvidence = (candidateId: string, options: { readonly ratio: number; readonly basis: 'usd' | 'tokens'; readonly plugin?: boolean; readonly limit?: number }): Pick<CandidateDetail, 'receipts' | 'decisions'> => {
    const trialId = `trial-${candidateId}`
    const arm = (usd: number | 'unknown', tokens: number): TrialCost => ({ usage: { inputTokens: tokens - 1000, outputTokens: 1000, totalTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestCount: 4, estimatedUsd: usd })
    const cost = options.basis === 'usd'
      ? { candidate: arm(0.25, 30_000), baseline: arm(0.1, 20_000), review: arm(0.01, 2_000) }
      : { candidate: arm('unknown', 60_000), baseline: arm('unknown', 20_000), review: arm('unknown', 2_000) }
    const verdict: TrialVerdict = { outcome: 'await-approval', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: options.ratio, costBasis: options.basis, decidedByReview: false }
    const ts = '2026-10-13T12:00:00.000Z'
    return {
      receipts: [
        { type: 'trial.start', format: 1, trialId, ts, candidateId, candidateVersion: BUNDLE, baselineVersion: 'baseline', plan: { selection: [], guard: [], repeats: 2, costRatioCap: 1.2, ...(options.limit === undefined ? {} : { costApprovalRatio: options.limit }), reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100_000 } } },
        { type: 'trial.end', format: 1, trialId, ts, status: 'pass', verdict, cost },
      ],
      decisions: [{ formatVersion: 1, id: `d-${candidateId}`, outcome: 'awaiting-approval', reason: 'quality-up', trigger: 'gate', decidedAt: ts, candidateId, trialId, fromVersion: 'baseline', toVersion: 'baseline', verdict, cost, detail: 'Cost candidate/baseline (estimated USD, cache included): 2.5×' }],
    } as Pick<CandidateDetail, 'receipts' | 'decisions'>
  }

  const costAwaiting = (options: { readonly plugin: boolean }) => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [candidate({
        id: 'c-7',
        status: 'awaiting-approval',
        requiresApproval: options.plugin,
        components: options.plugin ? [{ kind: 'plugin', name: 'greeter' }] : [{ kind: 'skill', name: 'region-table' }],
        summary: '地区表带均价',
        decision: { id: 'd-c-7', outcome: 'awaiting-approval', reason: 'quality-up', detail: 'costly' },
      })],
    }
    return bridge
  }

  it('a quality rise above the cost limit asks with the ratio, both arms in dollars and the quality, without plugin wording', async () => {
    const bridge = costAwaiting({ plugin: false })
    bridge.evidence['c-7'] = costEvidence('c-7', { ratio: 2.5, basis: 'usd', limit: 2 })
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(dialog.textContent).toContain('候选需要你的批准')
    expect(within(dialog).getByTestId('approval-cost-ratio').textContent).toBe('费用约为基线的 2.5 倍（超过 2 倍不自动采用）')
    expect(within(dialog).getByTestId('approval-cost-amounts').textContent).toBe('估算费用（含缓存）：候选约 $0.25，基线约 $0.10')
    expect(within(dialog).getByTestId('approval-quality').textContent).toBe('检查通过率：候选 100%，基线 50%')
    expect(within(dialog).getByTestId('approval-feedback').textContent).toBe('其中反馈检查（单独记）：候选 100%，基线 0%')
    expect(within(dialog).queryByTestId('approval-plugins')).toBeNull()
    expect(within(dialog).queryByTestId('plugin-approval-names')).toBeNull()
    expect(dialog.textContent).not.toContain('插件')
    expect(within(dialog).getByTestId('plugin-approval-hash').textContent).toBe(BUNDLE)
    fireEvent.click(within(dialog).getByTestId('plugin-allow'))
    await waitFor(() => expect(screen.queryByTestId('plugin-approval-dialog')).toBeNull())
    expect(bridge.callsOf('capabilities.approve')).toEqual([{ projectId: 'p1', candidateId: 'c-7', decision: 'allow' }])
  })

  it('without dollar estimates the cost part compares tokens; a plan before ADR 0007 uses the default limit of 2', async () => {
    const bridge = costAwaiting({ plugin: false })
    bridge.evidence['c-7'] = costEvidence('c-7', { ratio: 3, basis: 'tokens' })
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(within(dialog).getByTestId('approval-cost-ratio').textContent).toBe('费用约为基线的 3 倍（超过 2 倍不自动采用）')
    expect(within(dialog).getByTestId('approval-cost-amounts').textContent).toBe('没有美元估算，按 token（输入 + 输出）比较：候选 60,000，基线 20,000')
  })

  it('a plugin candidate above the cost limit shows both parts', async () => {
    const bridge = costAwaiting({ plugin: true })
    bridge.evidence['c-7'] = costEvidence('c-7', { ratio: 2.5, basis: 'usd', limit: 2 })
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(dialog.textContent).toContain('候选需要你的批准')
    expect(within(dialog).getByTestId('approval-cost-ratio').textContent).toContain('2.5 倍')
    expect(within(dialog).getByTestId('approval-plugins').textContent).toContain('拥有应用的全部权限')
    expect(within(dialog).getByTestId('plugin-approval-names').textContent).toBe('greeter')
    expect(within(dialog).getByTestId('plugin-approval-permissions').textContent).toBe('插件自述的权限：读取项目文件；联网查询天气')
    expect(within(dialog).getAllByTestId('plugin-approval-hash')).toHaveLength(1)
  })

  it('a plugin candidate within the cost limit shows only the plugin part', async () => {
    const bridge = costAwaiting({ plugin: true })
    bridge.evidence['c-7'] = costEvidence('c-7', { ratio: 1.5, basis: 'usd', limit: 2 })
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    expect(dialog.textContent).toContain('插件包需要你的批准')
    expect(within(dialog).queryByTestId('approval-cost')).toBeNull()
    expect(within(dialog).getByTestId('plugin-approval-names').textContent).toBe('greeter')
  })
})
