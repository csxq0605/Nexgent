// @vitest-environment jsdom
/**
 * ADR 0026/0027 in the renderer: 能力 → 离线改进 shows what new tasks use,
 * the practice set, a plan that waits for the user's approval of its cap,
 * and a finished run's recommendation side by side with what is in force;
 * approving, applying and stopping the applied version each call the SDK
 * only on a click.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OfflineListing, OfflineRunView } from '@nexgent/sdk'
import { FakeBridge } from '../testing/fake-bridge.js'
import { renderApp } from './helpers.js'

const DEFAULTS = { executionGuidance: '', retrieval: { handbookTopK: 5, handbookMinCoverage: 0.2, handbookMinSharedTerms: 2, skillMaxActive: 2 } }

function run(extra: Partial<OfflineRunView> = {}): OfflineRunView {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-19T03:00:00.000Z',
    status: 'awaiting-approval',
    live: false,
    capUsd: 12.3,
    estimateUsd: 8.2,
    spentUsd: 0,
    iteration: 0,
    maxIterations: 10,
    versions: 1,
    cases: { minibatch: 6, selection: 4, holdout: 4, guard: 0 },
    start: DEFAULTS,
    resumable: false,
    ...extra,
  }
}

function bridgeWith(listing: OfflineListing): FakeBridge {
  const bridge = new FakeBridge()
  let current = listing
  bridge.handlers['offline.list'] = () => current
  bridge.handlers['offline.plan'] = () => {
    current = { ...current, runs: [run()] }
    return current.runs[0]
  }
  bridge.handlers['offline.approve'] = (input: { runId: string; capUsd: number }) => {
    current = { ...current, runs: [run({ status: 'running', live: true, approvedAt: '2026-10-19T03:01:00.000Z', spentUsd: 0.4 })] }
    return { ...current.runs[0], input }
  }
  bridge.handlers['offline.decide'] = (input: { answer: 'apply' | 'decline' }) => {
    const done = current.runs[0]!
    current = { ...current, runs: [{ ...done, decision: { outcome: input.answer === 'apply' ? 'applied' : 'declined', at: '2026-10-19T05:00:00.000Z' } }], ...(input.answer === 'apply' ? { applied: { formatVersion: 1, runId: done.runId, versionId: 2, candidate: done.best!, appliedAt: '2026-10-19T05:00:00.000Z' } } : {}) }
    return current.runs[0]
  }
  bridge.handlers['offline.revert'] = () => {
    const { applied: _applied, ...rest } = current
    current = rest
    return current
  }
  return bridge
}

async function openOffline(bridge: FakeBridge): Promise<void> {
  await renderApp(bridge)
  fireEvent.click(screen.getByTestId('nav-capabilities'))
  fireEvent.click(screen.getByTestId('tab-offline'))
  await waitFor(() => expect(screen.getByTestId('offline-panel')).toBeTruthy())
}

describe('能力 → 离线改进', () => {
  it('plans for free, then starts only when the user approves the planned cap', async () => {
    const bridge = bridgeWith({ runs: [], defaults: DEFAULTS, practice: { train: 6, selection: 4, holdout: 4, guard: 0 } })
    await openOffline(bridge)
    expect(screen.getByTestId('offline-current').dataset.applied).toBe('no')
    expect(screen.getByTestId('offline-retrieval').textContent).toContain('每个任务最多查 5 条经验')
    fireEvent.click(screen.getByTestId('offline-plan'))
    await waitFor(() => expect(screen.getByTestId('offline-approve')).toBeTruthy())
    expect(screen.getByTestId('offline-cost').textContent).toContain('上限 12.3 美元')
    expect(bridge.callsOf('offline.approve')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('offline-approve'))
    await waitFor(() => expect(screen.getByTestId('offline-run').dataset.live).toBe('yes'))
    expect(bridge.callsOf('offline.approve')[0]).toEqual({ runId: run().runId, capUsd: 12.3 })
    expect(screen.getByTestId('offline-stop')).toBeTruthy()
  })

  it('cannot plan without enough practice cases', async () => {
    await openOffline(bridgeWith({ runs: [], defaults: DEFAULTS, practice: { train: 2, selection: 0, holdout: 1, guard: 0 } }))
    expect((screen.getByTestId('offline-plan') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a recommendation next to what is in force, applies it on the user\'s word, and stops it again', async () => {
    const best = { executionGuidance: 'Check the result against the request before finishing.', retrieval: { ...DEFAULTS.retrieval, handbookTopK: 3 } }
    const finished = run({
      status: 'awaiting-user',
      approvedAt: '2026-10-19T03:01:00.000Z',
      spentUsd: 9.1,
      versions: 3,
      best,
      result: { verdict: 'recommended', bestId: 2, detail: 'x', holdout: { seed: {}, best: {}, meanDiff: 0.12, ciLow: 0.04, ciHigh: 0.2 } },
    })
    const bridge = bridgeWith({ runs: [finished], defaults: DEFAULTS, practice: { train: 6, selection: 4, holdout: 4, guard: 0 } })
    await openOffline(bridge)
    expect(screen.getByTestId('offline-verdict').textContent).toContain('平均每题高 12 分')
    expect(screen.getAllByTestId('offline-guidance').map(node => node.textContent)).toEqual(['（没有）', '（没有）', best.executionGuidance])
    fireEvent.click(screen.getByTestId('offline-apply'))
    await waitFor(() => expect(screen.getByTestId('offline-decision').textContent).toContain('已在'))
    expect(screen.getByTestId('offline-current').dataset.applied).toBe('yes')
    fireEvent.click(screen.getByTestId('offline-revert'))
    expect(bridge.callsOf('offline.revert')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('offline-revert-confirm'))
    await waitFor(() => expect(screen.getByTestId('offline-current').dataset.applied).toBe('no'))
  })
})
