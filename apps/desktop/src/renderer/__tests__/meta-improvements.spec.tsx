// @vitest-environment jsdom
/**
 * Step 6 in the renderer: the 改进 tab marks meta jobs and shows the improver
 * version of every job, expands a meta job to its diagnosis, change and
 * parent / child comparison, shows the improver in force with history and
 * rollback, and starts a meta job; the settings page edits `improvement.meta`.
 */
import type { ComparisonArmResult } from '@nexgent/kernel'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CHILD_VERSION, FakeBridge, armResult, changeRecord, comparison, improvementDetail, improvementJob, metaDiagnosis, metaJob } from '../testing/fake-bridge.js'
import { emit, emitApp, renderApp, showTab } from './helpers.js'

async function openTab(bridge?: FakeBridge) {
  const rendered = await renderApp(bridge)
  showTab('improvements')
  await waitFor(() => expect(screen.getByTestId('improvement-panel')).toBeTruthy())
  return rendered
}

function finishedMeta(): FakeBridge {
  const bridge = new FakeBridge()
  const view = metaJob({ id: 'm-1', status: 'adopted', improverVersion: 'v0', meta: { childVersion: CHILD_VERSION, outcome: 'adopt', reason: 'quality-up' }, tokens: { 'meta-diagnose': 1000, 'meta-propose': 2000, compare: 4000 }, estimatedUsd: 0.6 })
  bridge.improvements = { ...bridge.improvements, jobs: [view] }
  bridge.improvementDetails['m-1'] = improvementDetail(view, { metaDiagnosis: metaDiagnosis(), change: changeRecord(), comparison: comparison() })
  return bridge
}

describe('meta jobs in the job list', () => {
  it('marks meta jobs and shows the improver version of each job', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = {
      ...bridge.improvements,
      jobs: [
        metaJob({ id: 'm-1', status: 'meta-proposing', improverVersion: CHILD_VERSION }),
        improvementJob({ id: 'j-2', status: 'adopted' }),
        improvementJob({ id: 'j-1', status: 'rejected', improverVersion: CHILD_VERSION }),
      ],
    }
    await openTab(bridge)
    const jobs = screen.getAllByTestId('improvement-job')
    expect(jobs.map(j => j.dataset['kind'])).toEqual(['meta', 'capability', 'capability'])
    expect(within(jobs[0]!).getByTestId('improvement-meta-badge').textContent).toBe('元改进')
    expect(within(jobs[1]!).queryByTestId('improvement-meta-badge')).toBeNull()
    expect(within(jobs[0]!).getByTestId('improvement-status').textContent).toBe('提出改进器修改中')
    expect(jobs.map(j => within(j).getByTestId('improvement-improver').textContent)).toEqual([`改进器 ${'c'.repeat(12)}`, '改进器 v0', `改进器 ${'c'.repeat(12)}`])
    expect(within(jobs[1]!).getByTestId('improvement-improver').dataset['version']).toBe('v0')
  })

  it('has Chinese texts for the meta statuses', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, jobs: [metaJob({ id: 'm-2', status: 'comparing' }), metaJob({ id: 'm-1', status: 'meta-diagnosing' })] }
    await openTab(bridge)
    expect(screen.getAllByTestId('improvement-status').map(n => n.textContent)).toEqual(['父子对比中', '元诊断中'])
  })
})

describe('meta job detail', () => {
  it('shows the meta diagnosis, the change against its parent, both arms and the verdict', async () => {
    const bridge = finishedMeta()
    await openTab(bridge)
    expect(screen.getByTestId('improvement-meta-child').textContent).toContain('c'.repeat(12))
    fireEvent.click(screen.getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getByTestId('improvement-change-before').textContent).not.toContain('未取得'))
    expect(bridge.callsOf('improvements.show')).toEqual([{ projectId: 'p1', jobId: 'm-1' }])
    expect(bridge.callsOf('improvers.show')).toEqual([{ version: 'v0' }])

    const diagnosis = screen.getByTestId('improvement-meta-diagnosis')
    expect(diagnosis.textContent).toContain('诊断没有要求引用反馈原文')
    expect(diagnosis.textContent).toContain('改进器需要一处修改')
    const findings = within(diagnosis).getAllByTestId('improvement-meta-finding')
    expect(findings.map(f => f.textContent)).toEqual(['诊断笼统（诊断 · 2 个作业）', '试验次数少（门控试验 · 1 个作业）'])

    expect(screen.getByTestId('improvement-change').textContent).toContain('改写诊断段落 #2')
    expect(screen.getByTestId('improvement-change-before').textContent).toContain('Find out why, using only the read-only tools')
    expect(screen.getByTestId('improvement-change-after').textContent).toBe('先读完反馈原文，再下结论。')

    const arms = screen.getAllByTestId('improvement-arm')
    expect(arms.map(a => a.dataset['arm'])).toEqual(['parent', 'child'])
    expect(within(arms[0]!).getByTestId('improvement-arm-version').textContent).toBe('改进器 v0')
    expect(within(arms[1]!).getByTestId('improvement-arm-version').textContent).toContain('c'.repeat(12))
    expect(within(arms[0]!).getByTestId('improvement-arm-offspring').textContent).toContain('a1234567')
    expect(within(arms[1]!).getByTestId('improvement-arm-gate').textContent).toContain('通过（检查通过率高于基线）')
    expect(within(arms[0]!).getByTestId('improvement-arm-quality').textContent).toContain('50%')
    expect(within(arms[1]!).getByTestId('improvement-arm-quality').textContent).toContain('100%')
    expect(within(arms[1]!).getByTestId('improvement-arm-cost').textContent).toContain('≈ $0.20')
    expect(within(arms[1]!).getByTestId('improvement-arm-cost').textContent).toContain('1,000 tokens')

    expect(screen.getByTestId('improvement-comparison-verdict').textContent).toContain('采用子版本')
    expect(screen.getByTestId('improvement-comparison-verdict').textContent).toContain('质量更高')
    expect(screen.getByTestId('improvement-meta-cost').textContent).toContain('≈ $0.60')
    expect(screen.getByTestId('improvement-meta-cost').textContent).toContain('7,000 tokens')
    expect(screen.getByTestId('improvement-phases').textContent).toContain('父子对比：4,000 tokens')
  })

  it('shows an arm without offspring or a known verdict, and every decision reason in words', async () => {
    const bridge = new FakeBridge()
    const view = metaJob({ id: 'm-1', status: 'rejected' })
    bridge.improvements = { ...bridge.improvements, jobs: [view] }
    const { verdict: _v, candidateId: _c, ...base } = armResult('child')
    const noChild: ComparisonArmResult = { ...base, status: 'failed', cost: { usage: {} as never, requestCount: 0, estimatedUsd: 'unknown' } }
    bridge.improvementDetails['m-1'] = improvementDetail(view, { comparison: comparison({ child: noChild, verdict: { outcome: 'reject', reason: 'no-offspring' } }) })
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getAllByTestId('improvement-arm')).toHaveLength(2))
    const child = screen.getAllByTestId('improvement-arm')[1]!
    expect(within(child).getByTestId('improvement-arm-offspring').textContent).toContain('无后代')
    expect(within(child).getByTestId('improvement-arm-gate').textContent).toContain('失败')
    expect(within(child).getByTestId('improvement-arm-cost').textContent).toContain('费用未知')
    expect(screen.getByTestId('improvement-comparison-verdict').textContent).toContain('不采用（子没有产出后代）')

    const reasons: Record<string, string> = {
      'gate-passed': '子的后代通过门控而父的没有',
      'quality-up': '质量更高',
      'cost-down': '质量相同且费用低 10% 以上',
      'no-improvement': '没有改进',
      'no-offspring': '子没有产出后代',
      'unknown-arm': '有一臂结果未知',
      'origin-mismatch': '两臂起点不一致',
      'epoch-mismatch': '评价纪元不同',
    }
    for (const [reason, text] of Object.entries(reasons)) {
      bridge.improvementDetails['m-1'] = improvementDetail(view, { comparison: comparison({ verdict: { outcome: 'reject', reason } as never }) })
      bridge.improvements = { ...bridge.improvements, jobs: [{ ...view, updatedAt: `2026-10-12T09:0${Object.keys(reasons).indexOf(reason)}:00.000Z` }] }
      emit(bridge, { type: 'improvement.job', sessionId: undefined, job: bridge.improvements.jobs[0] })
      await waitFor(() => expect(screen.getByTestId('improvement-comparison-verdict').textContent).toContain(text))
    }
  })

  it('shows the other change kinds against the parent improver', async () => {
    const bridge = finishedMeta()
    bridge.improvementDetails['m-1'] = { ...bridge.improvementDetails['m-1']!, change: changeRecord({ change: { op: 'set-comparison-param', param: 'repeats', value: 3 } }) }
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('improvement-status'))
    await waitFor(() => expect(screen.getByTestId('improvement-change-before').textContent).toBe('2'))
    expect(screen.getByTestId('improvement-change-after').textContent).toBe('3')
    expect(screen.getByTestId('improvement-change').textContent).toContain('设置对比参数 repeats')
  })
})

describe('improver section', () => {
  it('shows v0 without a rollback button, the meta status and a run button', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, meta: { enabled: true, pending: 2, everyJobs: 3, budget: { usedTokens: 1234, maxTokens: 6_000_000, windowDays: 30 } } }
    await openTab(bridge)
    expect(screen.getByTestId('improver-current').dataset['version']).toBe('v0')
    expect(screen.queryByTestId('improver-rollback')).toBeNull()
    expect(screen.getByTestId('improvement-meta-status').textContent).toBe('元改进 开 · 已计入 2 / 3 个已结束作业')
    expect(screen.getByTestId('improvement-meta-budget').textContent).toContain('1,234 / 6,000,000')
    expect(screen.getByTestId('improvement-meta-budget').textContent).toContain('30 天')
    fireEvent.click(screen.getByTestId('improvement-run-meta'))
    await waitFor(() => expect(screen.getAllByTestId('improvement-job')).toHaveLength(1))
    expect(bridge.callsOf('improvements.runMeta')).toEqual([{ projectId: 'p1' }])
    expect(screen.getByTestId('improvement-meta-badge')).toBeTruthy()
    expect((screen.getByTestId('improvement-run-meta') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a busy error as a notice', async () => {
    const bridge = new FakeBridge()
    await openTab(bridge)
    bridge.handlers['improvements.runMeta'] = () => {
      throw { name: 'NexgentError', code: 'improvement/busy', message: 'busy' }
    }
    fireEvent.click(screen.getByTestId('improvement-run-meta'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('已有一个改进作业在运行'))
  })

  it('lists the history, rolls back with a reason and follows improver.version', async () => {
    const bridge = new FakeBridge()
    bridge.improver = {
      current: { version: CHILD_VERSION, revision: 1, since: '2026-10-12T09:00:00.000Z', trigger: 'meta-job', jobId: 'm-1' },
      history: [{ format: 1, revision: 1, previous: null, from: 'v0', version: CHILD_VERSION, type: 'adopt', trigger: 'meta-job', jobId: 'm-1', committedAt: '2026-10-12T09:00:00.000Z' }],
    }
    await openTab(bridge)
    expect(screen.getByTestId('improver-current').dataset['version']).toBe(CHILD_VERSION)
    expect(screen.getByTestId('improver-version').textContent).toBe('c'.repeat(12))
    expect(screen.getByTestId('improver-section').textContent).toContain('m-1')
    expect(screen.getAllByTestId('improver-revision').map(r => r.dataset['type'])).toEqual(['adopt'])

    fireEvent.click(screen.getByTestId('improver-rollback'))
    fireEvent.change(screen.getByTestId('improver-rollback-reason'), { target: { value: '改坏了' } })
    fireEvent.click(screen.getByTestId('improver-rollback-confirm'))
    await waitFor(() => expect(screen.getByTestId('improver-current').dataset['version']).toBe('v0'))
    expect(bridge.callsOf('improvers.rollback')).toEqual([{ reason: '改坏了' }])
    expect(screen.getAllByTestId('improver-revision').map(r => r.dataset['type'])).toEqual(['rollback', 'adopt'])
    expect(screen.queryByTestId('improver-rollback')).toBeNull()

    // An adoption elsewhere (a meta job finished) arrives as an event.
    bridge.improver = { ...bridge.improver, current: { version: 'd'.repeat(64), revision: 3, trigger: 'meta-job', jobId: 'm-2' } }
    const lists = bridge.callsOf('improvers.list').length
    emitApp(bridge, { type: 'improver.version', current: bridge.improver.current })
    await waitFor(() => expect(screen.getByTestId('improver-current').dataset['version']).toBe('d'.repeat(64)))
    await waitFor(() => expect(bridge.callsOf('improvers.list').length).toBeGreaterThan(lists))
  })

  it('shows a load-failure problem banner', async () => {
    const bridge = new FakeBridge()
    bridge.improver = { current: { version: 'v0', revision: 2, trigger: 'load-failure', problem: '改进器文件损坏' }, history: [] }
    await openTab(bridge)
    expect(screen.getByTestId('improver-problem').textContent).toContain('改进器文件损坏')
  })
})

describe('meta settings (user level)', () => {
  it('loads and saves the meta switch and budget through userSettings without an approval dialog', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect(screen.getByTestId('settings-meta-enabled')).toBeTruthy())
    expect(screen.getByTestId('settings-user-section').textContent).toContain('所有项目')
    expect((screen.getByTestId('settings-meta-enabled') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('settings-meta-budget') as HTMLInputElement).value).toBe('6000000')
    expect((screen.getByTestId('settings-meta-window') as HTMLInputElement).value).toBe('30')
    expect((screen.getByTestId('settings-meta-every') as HTMLInputElement).value).toBe('3')
    fireEvent.click(screen.getByTestId('settings-meta-enabled'))
    fireEvent.change(screen.getByTestId('settings-meta-budget'), { target: { value: '2000000' } })
    fireEvent.change(screen.getByTestId('settings-meta-window'), { target: { value: '14' } })
    fireEvent.change(screen.getByTestId('settings-meta-every'), { target: { value: '5' } })
    const lists = bridge.callsOf('improvements.list').length
    fireEvent.blur(screen.getByTestId('settings-meta-every'))
    await waitFor(() => expect(screen.getByTestId('settings-user-saved')).toBeTruthy())
    // The switch saved at once, the typed values when the field was left.
    expect(bridge.callsOf('userSettings.update')).toEqual([
      { patch: { improvement: { meta: { enabled: true, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5' } } } },
      { patch: { improvement: { meta: { enabled: true, everyJobs: 5, budget: { maxTokens: 2_000_000, windowDays: 14 }, model: 'claude-sonnet-5-5' } } } },
    ])
    expect(bridge.callsOf('settings.update')).toEqual([])
    expect(bridge.userSettings.improvement.meta).toMatchObject({ enabled: true, everyJobs: 5, budget: { maxTokens: 2_000_000, windowDays: 14 } })
    await waitFor(() => expect(bridge.callsOf('improvements.list').length).toBeGreaterThan(lists))
    expect(screen.queryByTestId('approval-dialog')).toBeNull()
  })

  it('reads saved user settings back when the page opens, and rejects bad values', async () => {
    const bridge = new FakeBridge()
    bridge.userSettings = { ...bridge.userSettings, improvement: { meta: { ...bridge.userSettings.improvement.meta, enabled: true, everyJobs: 7 } } }
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect((screen.getByTestId('settings-meta-every') as HTMLInputElement).value).toBe('7'))
    expect((screen.getByTestId('settings-meta-enabled') as HTMLInputElement).checked).toBe(true)
    fireEvent.change(screen.getByTestId('settings-meta-every'), { target: { value: '25' } })
    fireEvent.blur(screen.getByTestId('settings-meta-every'))
    await waitFor(() => expect(screen.getByText(/请填 1 到 20 的整数/)).toBeTruthy())
    fireEvent.change(screen.getByTestId('settings-meta-every'), { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('settings-meta-budget'), { target: { value: '0' } })
    fireEvent.blur(screen.getByTestId('settings-meta-budget'))
    await waitFor(() => expect(screen.getByText(/请填正整数/)).toBeTruthy())
    expect(bridge.callsOf('userSettings.update')).toEqual([])
  })

  it('saves the project share switch through settings.update and leaves meta out of it', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect(screen.getByTestId('settings-share-improver')).toBeTruthy())
    expect((screen.getByTestId('settings-share-improver') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('settings-share-improver'))
    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeTruthy())
    expect(bridge.callsOf('settings.update')[0].patch.improvement).toMatchObject({ shareImproverEvidence: false })
    expect(bridge.settings.improvement.shareImproverEvidence).toBe(false)
    expect(bridge.callsOf('userSettings.update')).toEqual([])
  })

  it('does not send improvement when nothing about it changed', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('open-settings'))
    await waitFor(() => expect(screen.getByTestId('settings-share-improver')).toBeTruthy())
    fireEvent.blur(screen.getByTestId('settings-improvement-budget'))
    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeTruthy())
    expect(bridge.callsOf('settings.update')).toEqual([])
  })
})

describe('shared improver', () => {
  const adopted = (): FakeBridge => {
    const bridge = new FakeBridge()
    bridge.improver = {
      current: { version: CHILD_VERSION, revision: 1, since: '2026-10-12T09:00:00.000Z', trigger: 'meta-job', jobId: 'm-1' },
      history: [],
      usedBy: [
        { root: '/work/orders', name: 'orders', lastJobAt: '2026-10-13T08:00:00.000Z' },
        { root: '/work/sheets', name: 'sheets', lastJobAt: '2026-10-12T08:00:00.000Z' },
      ],
    }
    return bridge
  }

  it('says the improver is shared and lists the projects that used it in the rollback confirmation', async () => {
    const bridge = adopted()
    await openTab(bridge)
    expect(screen.getByTestId('improver-shared-note').textContent).toContain('所有项目')
    fireEvent.click(screen.getByTestId('improver-rollback'))
    const box = screen.getByTestId('improver-rollback-projects')
    const items = within(box).getAllByTestId('improver-rollback-project')
    expect(items.map(i => i.textContent)).toEqual([expect.stringContaining('orders'), expect.stringContaining('sheets')])
    expect(screen.getByTestId('improver-section').textContent).toContain('影响所有项目')
    expect(bridge.callsOf('improvers.list')[0]).toEqual({})
  })

  it('says so when no project has used the improver yet', async () => {
    const bridge = adopted()
    bridge.improver = { ...bridge.improver, usedBy: [] }
    await openTab(bridge)
    fireEvent.click(screen.getByTestId('improver-rollback'))
    expect(within(screen.getByTestId('improver-rollback-projects')).queryAllByTestId('improver-rollback-project')).toEqual([])
    expect(screen.getByTestId('improver-rollback-projects').textContent).toContain('还没有项目使用过它')
  })

  it('follows an application-level improver.version event without a projectId', async () => {
    const bridge = new FakeBridge()
    await openTab(bridge)
    expect(screen.getByTestId('improver-current').dataset['version']).toBe('v0')
    bridge.improver = { ...bridge.improver, current: { version: 'd'.repeat(64), revision: 1, trigger: 'meta-job', jobId: 'm-2' } }
    emitApp(bridge, { type: 'improver.version', current: bridge.improver.current })
    await waitFor(() => expect(screen.getByTestId('improver-current').dataset['version']).toBe('d'.repeat(64)))
  })

  it('shows the user scope of a job next to the improver version', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, jobs: [improvementJob({ id: 'j-2', improverVersion: 'v0', improverScope: 'user' }), improvementJob({ id: 'j-1' })] }
    await openTab(bridge)
    const [user, old] = screen.getAllByTestId('improvement-improver')
    expect(user!.textContent).toBe('改进器 v0 · 用户级')
    expect(user!.dataset['scope']).toBe('user')
    expect(old!.dataset['scope']).toBe('project')
    expect(old!.textContent).toBe('改进器 v0')
  })
})
