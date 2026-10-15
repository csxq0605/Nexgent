// @vitest-environment jsdom
/**
 * Out-of-order list reads (step 6 closing, Windows D-layer flake): a refresh
 * started before a user action can answer after the refresh started by that
 * action. The store keeps only the answer of the latest read it started, so
 * an older answer never paints a list back to its earlier state.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, candidate, improvementJob } from '../testing/fake-bridge.js'
import { emit, emitApp, renderApp } from './helpers.js'

/** Make the next call of `method` answer with what it would answer now, but only when `release` is called. */
function holdNext(bridge: FakeBridge, method: string): { release: () => void; called: Promise<void> } {
  const original = bridge.handlers[method]!
  let release!: () => void
  let called!: () => void
  const calledPromise = new Promise<void>(resolve => (called = resolve))
  const gate = new Promise<void>(resolve => (release = resolve))
  let held = false
  bridge.handlers[method] = (input: unknown) => {
    if (held) return original(input)
    held = true
    const answer = original(input)
    called()
    return gate.then(() => answer)
  }
  return { release, called: calledPromise }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

describe('a list read that answers after a later one is dropped', () => {
  it('capabilities: a refresh from before deny does not put the candidate back to awaiting approval', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = {
      ...bridge.capabilities,
      candidates: [candidate({ id: 'c-9', status: 'awaiting-approval', requiresApproval: true, components: [{ kind: 'plugin', name: 'greeter' }], summary: '问候插件', decision: { id: 'd9', outcome: 'awaiting-approval', reason: 'quality-up', detail: 'passed' } })],
    }
    await renderApp(bridge)
    const dialog = await screen.findByTestId('plugin-approval-dialog')
    // An event starts a refresh that reads the candidate still waiting and answers late.
    const slow = holdNext(bridge, 'capabilities.list')
    emit(bridge, { type: 'capability.candidate', sessionId: undefined, candidate: bridge.capabilities.candidates[0] })
    await slow.called
    // The user denies; the refresh that follows reads it rejected and answers first.
    fireEvent.click(within(dialog).getByTestId('plugin-deny'))
    await waitFor(() => expect(screen.queryByTestId('plugin-approval-dialog')).toBeNull())
    fireEvent.click(screen.getByTestId('tab-capabilities'))
    await waitFor(() => expect(screen.getByTestId('capability-candidate').dataset['status']).toBe('rejected'))
    slow.release()
    await tick()
    expect(screen.getByTestId('capability-candidate').dataset['status']).toBe('rejected')
    expect(within(screen.getByTestId('capability-candidate')).getByTestId('candidate-status').textContent).toBe('未采用')
  })

  it('improvement jobs: a refresh from before cancel does not put the job back to running', async () => {
    const bridge = new FakeBridge()
    bridge.improvements = { ...bridge.improvements, jobs: [improvementJob({ id: 'j-1', status: 'diagnosing' })], activeJobId: 'j-1' }
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('tab-improvements'))
    const job = await screen.findByTestId('improvement-job')
    expect(job.dataset['status']).toBe('diagnosing')
    const slow = holdNext(bridge, 'improvements.list')
    emit(bridge, { type: 'improvement.job', sessionId: undefined, job: bridge.improvements.jobs[0] })
    await slow.called
    fireEvent.click(within(job).getByTestId('improvement-cancel'))
    await waitFor(() => expect(screen.getByTestId('improvement-job').dataset['status']).toBe('cancelled'))
    slow.release()
    await tick()
    expect(screen.getByTestId('improvement-job').dataset['status']).toBe('cancelled')
  })

  it('improver: a read from before a rollback does not put the rolled-back version back', async () => {
    const bridge = new FakeBridge()
    const child = 'c'.repeat(64)
    bridge.improver = {
      current: { version: child, revision: 1, since: '2026-10-12T10:00:00.000Z', trigger: 'meta-job', jobId: 'm-1' },
      history: [{ format: 1, revision: 1, previous: null, from: 'v0', version: child, type: 'adopt', trigger: 'meta-job', jobId: 'm-1', committedAt: '2026-10-12T10:00:00.000Z' }],
      usedBy: [],
    } as never
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('tab-improvements'))
    await waitFor(() => expect(screen.getByTestId('improver-current').dataset['version']).toBe(child))
    const slow = holdNext(bridge, 'improvers.list')
    emitApp(bridge, { type: 'improver.version', current: bridge.improver.current })
    await slow.called
    fireEvent.click(screen.getByTestId('improver-rollback'))
    fireEvent.click(await screen.findByTestId('improver-rollback-confirm'))
    await waitFor(() => expect(screen.getByTestId('improver-current').dataset['version']).toBe('v0'))
    slow.release()
    await tick()
    expect(screen.getByTestId('improver-current').dataset['version']).toBe('v0')
  })
})
