// @vitest-environment jsdom
/**
 * Step 5 in the renderer: the 改进 tab lists improvement jobs with status and
 * cost, expands the chain diagnosis -> candidate -> gate -> first use, starts
 * and cancels jobs, follows `improvement.job` events; the settings page edits
 * `autoImprove` and the improvement budget.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, ZERO_USAGE, candidate, candidateDetail, improvementDetail, improvementJob, version } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

async function openTab(bridge?: FakeBridge) {
  const rendered = await renderApp(bridge)
  fireEvent.click(screen.getByTestId('tab-improvements'))
  await waitFor(() => expect(screen.getByTestId('improvement-panel')).toBeTruthy())
  return rendered
}

describe('improvement jobs in the right panel', () => {
  it('shows an empty state, pending count and budget', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, pending: 2, budget: { usedTokens: 12_345, maxTokens: 3_000_000, windowDays: 30 } }
    await openTab(bridge)
    expect(screen.getByTestId('improvement-pending').textContent).toBe('已计入 2 / 3 条反馈')
    expect(screen.getByTestId('improvement-budget').textContent).toContain('12,345 / 3,000,000')
    expect(screen.getByTestId('improvement-budget').textContent).toContain('30 天')
    expect(screen.getByTestId('improvement-panel').textContent).toContain('还没有改进作业')
    expect((screen.getByTestId('improvement-run') as HTMLButtonElement).disabled).toBe(false)
  })

  it('lists jobs newest first with status, cost and the reason', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = {
      ...bridge.improvements,
      jobs: [
        improvementJob({ id: 'j-3', status: 'trialing', tokens: { diagnose: 1000, propose: 2000 }, estimatedUsd: 0.42 }),
        improvementJob({ id: 'j-2', status: 'rejected', trigger: 'check-failure', estimatedUsd: 'unknown', tokens: { diagnose: 'unknown' }, detail: '检查通过率低于基线' }),
        improvementJob({ id: 'j-1', status: 'waiting-history', trigger: 'explicit', detail: '历史任务不足 5 个' }),
      ],
      activeJobId: 'j-3',
    }
    await openTab(bridge)
    const jobs = screen.getAllByTestId('improvement-job')
    expect(jobs.map(j => [j.dataset['job'], j.dataset['status'], within(j).getByTestId('improvement-status').textContent])).toEqual([
      ['j-3', 'trialing', '门控试验中'],
      ['j-2', 'rejected', '未采用'],
      ['j-1', 'waiting-history', '等待更多历史任务'],
    ])
    expect(within(jobs[0]!).getByTestId('improvement-cost').textContent).toContain('≈ $0.42')
    expect(within(jobs[0]!).getByTestId('improvement-cost').textContent).toContain('3,000 tokens')
    expect(within(jobs[1]!).getByTestId('improvement-cost').textContent).toContain('费用未知')
    expect(within(jobs[1]!).getByTestId('improvement-detail-text').textContent).toBe('检查通过率低于基线')
    expect(within(jobs[1]!).getByTestId('improvement-trigger').textContent).toContain('检查失败')
    expect(within(jobs[2]!).getByTestId('improvement-trigger').textContent).toContain('手动')
    expect(within(jobs[2]!).getByTestId('improvement-detail-text').textContent).toBe('历史任务不足 5 个')
  })

  it('expands a job to its diagnosis, candidate, gate, phases and first use', async () => {
    const bridge = new FakeBridge()
    const view = improvementJob({ id: 'j-1', status: 'adopted', candidateId: 'c-1', tokens: { diagnose: 1000, propose: 2000, trial: 5000 }, estimatedUsd: 0.1 })
    const cand = candidate({ id: 'c-1', status: 'adopted' })
    const detail = candidateDetail(cand)
    bridge.improvements = { ...bridge.improvements, jobs: [view] }
    bridge.improvementDetails['j-1'] = improvementDetail(view, {
      job: { firstUse: { taskId: 't9', sessionId: 's1', at: '2026-10-12T10:00:00.000Z', version: 'b'.repeat(64) } },
      diagnosis: {
        formatVersion: 1, jobId: 'j-1', createdAt: 'x', sessionId: 'i1', attempts: 1, memberCosts: [],
        hypothesis: '缺少按地区汇总的技能',
        proposalKind: 'skill',
        failureTypes: [{ category: 'system-design', label: '漏了地区列', evidence: [{ kind: 'feedback', feedbackId: 'f1' } as never, { kind: 'feedback', feedbackId: 'f2' } as never] }],
        involved: { members: ['main'], tools: [], skills: [], components: [] },
      },
      candidate: {
        ...detail,
        view: cand,
        decisions: [{ formatVersion: 1, id: 'd1', outcome: 'adopted', reason: 'quality-up', trigger: 'gate', decidedAt: 'x', fromVersion: 'baseline', toVersion: 'b'.repeat(64), detail: '候选多通过了 2 项。', verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: 1, decidedByReview: true } }],
      },
    })
    await openTab(bridge)
    expect(screen.queryByTestId('improvement-detail')).toBeNull()
    fireEvent.click(within(screen.getByTestId('improvement-job')).getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getByTestId('improvement-detail')).toBeTruthy())
    expect(bridge.callsOf('improvements.show')).toEqual([{ projectId: 'p1', jobId: 'j-1' }])
    expect(screen.getByTestId('improvement-diagnosis').textContent).toContain('缺少按地区汇总的技能')
    expect(screen.getByTestId('improvement-diagnosis').textContent).toContain('技能')
    expect(screen.getByTestId('improvement-diagnosis').textContent).toContain('漏了地区列（2 条证据）')
    expect(screen.getByTestId('improvement-candidate').textContent).toContain('order-summary')
    expect(screen.getByTestId('improvement-candidate').textContent).toContain('已采用')
    expect(screen.getByTestId('improvement-gate-verdict').textContent).toContain('检查通过率高于基线')
    expect(screen.getByTestId('improvement-gate-verdict').textContent).toContain('候选多通过了 2 项。')
    expect(screen.getByTestId('improvement-gate-feedback').textContent).toContain('反馈检查')
    expect(screen.getByTestId('improvement-gate-review')).toBeTruthy()
    expect(screen.getByTestId('improvement-phases').textContent).toContain('诊断：1,000 tokens')
    expect(screen.getByTestId('improvement-phases').textContent).toContain('门控试验：5,000 tokens')
    expect(screen.getByTestId('improvement-first-use').textContent).toContain('已被后续任务使用：')
    // Second click closes it.
    fireEvent.click(within(screen.getByTestId('improvement-job')).getByTestId('improvement-status'))
    await waitFor(() => expect(screen.queryByTestId('improvement-detail')).toBeNull())
  })

  it('shows why a job ended without a candidate', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, jobs: [improvementJob({ id: 'j-1', status: 'no-proposal', detail: '需求变了，不是能力问题' })] }
    await openTab(bridge)
    expect(screen.getByTestId('improvement-status').textContent).toBe('不是能力问题')
    fireEvent.click(screen.getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getByTestId('improvement-detail')).toBeTruthy())
    expect(screen.getByTestId('improvement-candidate').textContent).toContain('还没有产生候选')
    expect(screen.getByTestId('improvement-detail-text').textContent).toBe('需求变了，不是能力问题')
  })

  it('runs a job, disables the button while it is active, then cancels it', async () => {
    const bridge = new FakeBridge()
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('improvement-run'))
    await waitFor(() => expect(screen.getAllByTestId('improvement-job')).toHaveLength(1))
    expect(bridge.callsOf('improvements.run')).toEqual([{ projectId: 'p1' }])
    expect(screen.getByTestId('improvement-status').textContent).toBe('排队中')
    expect((screen.getByTestId('improvement-run') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(screen.getByTestId('improvement-job')).getByTestId('improvement-cancel'))
    await waitFor(() => expect(screen.getByTestId('improvement-status').textContent).toBe('已取消'))
    expect(bridge.callsOf('improvements.cancel')).toEqual([{ projectId: 'p1', jobId: 'j-1' }])
    expect((screen.getByTestId('improvement-run') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows busy and budget errors as readable notices', async () => {
    const bridge = new FakeBridge()
    await openTab(bridge)
    bridge.handlers['improvements.run'] = () => {
      throw { name: 'NexgentError', code: 'improvement/busy', message: 'busy' }
    }
    fireEvent.click(screen.getByTestId('improvement-run'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('已有一个改进作业在运行'))
    bridge.handlers['improvements.run'] = () => {
      throw { name: 'NexgentError', code: 'improvement/budget-exhausted', message: 'spent' }
    }
    fireEvent.click(screen.getByTestId('improvement-run'))
    await waitFor(() => expect(screen.getAllByTestId('notice').map(n => n.textContent).join()).toContain('改进预算已用尽'))
  })

  it('refreshes on an improvement.job event and keeps the open detail fresh', async () => {
    const bridge = new FakeBridge()
    const view = improvementJob({ id: 'j-1', status: 'diagnosing' })
    bridge.improvements = { ...bridge.improvements, jobs: [view], activeJobId: 'j-1' }
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getByTestId('improvement-detail')).toBeTruthy())
    const next = improvementJob({ id: 'j-1', status: 'failed', updatedAt: '2026-10-12T09:00:00.000Z', detail: '诊断三次都没通过' })
    bridge.improvements = { ...bridge.improvements, jobs: [next] }
    const { activeJobId: _gone, ...rest } = bridge.improvements
    bridge.improvements = rest
    const shows = bridge.callsOf('improvements.show').length
    emit(bridge, { type: 'improvement.job', sessionId: undefined, job: next })
    await waitFor(() => expect(screen.getByTestId('improvement-status').textContent).toBe('失败'))
    await waitFor(() => expect(bridge.callsOf('improvements.show').length).toBe(shows + 1))
    expect(screen.getByTestId('improvement-detail-text').textContent).toBe('诊断三次都没通过')
    expect((screen.getByTestId('improvement-run') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('improvement-cancel')).toBeNull()
  })

  it('improves from a deliverable card with its session and deliverable', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    bridge.deliverables = [{ deliverableId: 'd1', title: 'summary.csv', versions: [version(1)] }]
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'deliverable.presented', turn: 1, deliverable: version(1) })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage: ZERO_USAGE })
    await waitFor(() => expect(screen.getByTestId('deliverable-improve')).toBeTruthy())
    // Hold the call: the button answers at once, before the job exists.
    const run = bridge.handlers['improvements.run']!
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    bridge.handlers['improvements.run'] = (input: unknown) => gate.then(() => run(input))
    fireEvent.click(screen.getByTestId('deliverable-improve'))
    await waitFor(() => expect(bridge.callsOf('improvements.run')).toEqual([{ projectId: 'p1', sessionId: 's1', deliverableId: 'd1' }]))
    const button = screen.getByTestId('deliverable-improve') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('正在开始改进…')
    release()
    // Started: the card says so and the 改进 tab opens on the new job.
    await waitFor(() => expect(screen.getByTestId('deliverable-improve-started').textContent).toContain('已开始改进'))
    expect((screen.getByTestId('deliverable-improve') as HTMLButtonElement).disabled).toBe(false)
    await waitFor(() => expect(screen.getByTestId('improvement-panel')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('improvement-job').length).toBe(bridge.improvements.jobs.length))
  })

  it('returns the card button to normal when starting fails', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    bridge.deliverables = [{ deliverableId: 'd1', title: 'summary.csv', versions: [version(1)] }]
    bridge.improvements = { ...bridge.improvements, activeJobId: 'busy' }
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'deliverable.presented', turn: 1, deliverable: version(1) })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage: ZERO_USAGE })
    await waitFor(() => expect(screen.getByTestId('deliverable-improve')).toBeTruthy())
    fireEvent.click(screen.getByTestId('deliverable-improve'))
    await waitFor(() => expect(screen.getAllByTestId('notice').length).toBe(1))
    await waitFor(() => expect((screen.getByTestId('deliverable-improve') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('deliverable-improve').textContent).toBe('改进')
    expect(screen.queryByTestId('deliverable-improve-started')).toBeNull()
  })
})

describe('improvement settings', () => {
  it('saves autoImprove and the improvement budget through settings.update', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect(screen.getByTestId('settings-auto-improve')).toBeTruthy())
    expect((screen.getByTestId('settings-auto-improve') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('settings-improvement-budget') as HTMLInputElement).value).toBe('3000000')
    fireEvent.click(screen.getByTestId('settings-auto-improve'))
    fireEvent.change(screen.getByTestId('settings-improvement-budget'), { target: { value: '500000' } })
    fireEvent.change(screen.getByTestId('settings-improvement-window'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeTruthy())
    const patch = bridge.callsOf('settings.update')[0].patch
    expect(patch.autoImprove).toBe(false)
    expect(patch.improvement).toMatchObject({ feedbackThreshold: 3, budget: { maxTokens: 500000, windowDays: 7 } })
    expect(bridge.settings.autoImprove).toBe(false)
    expect(bridge.settings.improvement.budget).toEqual({ maxTokens: 500000, windowDays: 7 })
  })

  it('rejects a bad budget without saving', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect(screen.getByTestId('settings-improvement-budget')).toBeTruthy())
    fireEvent.change(screen.getByTestId('settings-improvement-budget'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(screen.getByText(/必须是正整数/)).toBeTruthy())
    expect(bridge.callsOf('settings.update')).toEqual([])
  })
})
