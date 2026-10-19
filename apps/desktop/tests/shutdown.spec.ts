import { describe, expect, it, vi } from 'vitest'
import type { SdkEvent } from '@nexgent/sdk'
import type { Logger } from '../src/main/logger.js'
import { ShutdownCoordinator, type RunningTurn } from '../src/main/shutdown.js'

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const usage = { inputTokens: 0, outputTokens: 0 } as never

function start(sessionId: string, turn = 1): SdkEvent {
  return { type: 'turn.start', projectId: 'p', sessionId, eventSeq: 1, turn, source: 'user' }
}
function end(sessionId: string, turn = 1): SdkEvent {
  return { type: 'turn.end', projectId: 'p', sessionId, eventSeq: 2, turn, reason: { kind: 'completed' }, usage }
}

function fakeSdk() {
  const order: string[] = []
  const sdk = {
    call: vi.fn(async (method: string, input: { sessionId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${method}:${input.sessionId}`)
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    }),
  }
  return { sdk, order }
}

describe('ShutdownCoordinator', () => {
  it('tracks running turns from turn.start / turn.end', () => {
    const { sdk } = fakeSdk()
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm: async () => true, log: quiet })
    coordinator.observe(start('a'))
    coordinator.observe(start('b'))
    coordinator.observe(end('a'))
    expect(coordinator.running).toEqual([{ projectId: 'p', sessionId: 'b', turn: 1 }])
  })

  it('quits without asking when nothing runs, after disposing the SDK', async () => {
    const { sdk, order } = fakeSdk()
    const confirm = vi.fn(async () => true)
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm, log: quiet })
    expect(await coordinator.requestQuit()).toBe('quit')
    expect(confirm).not.toHaveBeenCalled()
    expect(order).toEqual(['dispose'])
    expect(coordinator.done).toBe(true)
  })

  it('stays open and touches nothing when the user declines', async () => {
    const { sdk, order } = fakeSdk()
    const confirm = vi.fn(async (_running: readonly RunningTurn[]) => false)
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm, log: quiet })
    coordinator.observe(start('a'))
    expect(await coordinator.requestQuit()).toBe('stay')
    expect(confirm).toHaveBeenCalledWith([{ projectId: 'p', sessionId: 'a', turn: 1 }])
    expect(order).toEqual([])
    expect(coordinator.done).toBe(false)
  })

  it('cancels every running turn and waits for them before disposing', async () => {
    const { sdk, order } = fakeSdk()
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm: async () => true, log: quiet })
    coordinator.observe(start('a'))
    coordinator.observe(start('b', 3))
    expect(await coordinator.requestQuit()).toBe('quit')
    expect(sdk.call).toHaveBeenCalledWith('turns.cancel', { projectId: 'p', sessionId: 'a' })
    expect(sdk.call).toHaveBeenCalledWith('turns.cancel', { projectId: 'p', sessionId: 'b' })
    expect(order.at(-1)).toBe('dispose')
    expect(order.slice(0, 2).sort()).toEqual(['turns.cancel:a', 'turns.cancel:b'])
  })

  it('asks once when quit is requested repeatedly', async () => {
    const { sdk } = fakeSdk()
    const confirm = vi.fn(async () => true)
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm, log: quiet })
    coordinator.observe(start('a'))
    const decisions = await Promise.all([coordinator.requestQuit(), coordinator.requestQuit()])
    expect(decisions).toEqual(['quit', 'quit'])
    expect(confirm).toHaveBeenCalledOnce()
    expect(sdk.dispose).toHaveBeenCalledOnce()
    expect(await coordinator.requestQuit()).toBe('quit')
  })

  it('asks again after a declined quit', async () => {
    const { sdk } = fakeSdk()
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm, log: quiet })
    coordinator.observe(start('a'))
    expect(await coordinator.requestQuit()).toBe('stay')
    expect(await coordinator.requestQuit()).toBe('quit')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('a forced quit does not wait for an open confirmation, and the confirmation then changes nothing', async () => {
    const { sdk, order } = fakeSdk()
    let answer: (value: boolean) => void = () => {}
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm, log: quiet })
    coordinator.observe(start('a'))
    const asked = coordinator.requestQuit()
    await Promise.resolve()
    expect(coordinator.asking).toBe(true)
    expect(await coordinator.forceQuit()).toBe('quit')
    expect(order).toEqual(['turns.cancel:a', 'dispose'])
    expect(coordinator.done).toBe(true)
    answer(false)
    expect(await asked).toBe('quit')
    expect(coordinator.asking).toBe(false)
    expect(sdk.dispose).toHaveBeenCalledOnce()
  })

  it('still disposes when a cancel fails, and exits after the timeout when disposal hangs', async () => {
    const warn = vi.fn()
    const sdk = {
      call: vi.fn(async () => {
        throw new Error('gone')
      }),
      dispose: vi.fn(() => new Promise<void>(() => {})),
    }
    const coordinator = new ShutdownCoordinator({ sdk: sdk as never, confirm: async () => true, log: { ...quiet, warn }, timeoutMs: 20 })
    coordinator.observe(start('a'))
    expect(await coordinator.requestQuit()).toBe('quit')
    expect(sdk.dispose).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not finish within 20 ms'))
  })
})
