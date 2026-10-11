import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { EXIT, InterruptController, installSignalHandlers, nextInterruptAction, signalExitCode } from '../src/index.js'

describe('nextInterruptAction', () => {
  it('cancels a running turn on the first Ctrl+C and exits on the second', () => {
    const first = nextInterruptAction('turn', 'SIGINT')
    expect(first).toEqual({ action: { kind: 'cancel-turn', cause: 'user' }, phase: 'cancelling' })
    expect(nextInterruptAction(first.phase, 'SIGINT')).toEqual({ action: { kind: 'exit', code: EXIT.CANCELLED }, phase: 'cancelling' })
  })

  it('exits at once when no turn is running', () => {
    expect(nextInterruptAction('idle', 'SIGINT').action).toEqual({ kind: 'exit', code: 130 })
  })

  it('treats SIGTERM as a shutdown cancel, then a forced 143', () => {
    expect(nextInterruptAction('turn', 'SIGTERM').action).toEqual({ kind: 'cancel-turn', cause: 'shutdown' })
    expect(nextInterruptAction('cancelling', 'SIGTERM').action).toEqual({ kind: 'exit', code: 143 })
    expect(signalExitCode('SIGBREAK')).toBe(EXIT.TERMINATED)
  })
})

describe('InterruptController', () => {
  it('aborts the turn signal with the cause as reason, then exits on repeat', () => {
    const exits: number[] = []
    const notes: string[] = []
    const controller = new InterruptController({ exit: code => exits.push(code), notify: m => notes.push(m) })
    const signal = controller.beginTurn()
    expect(controller.state).toBe('turn')
    controller.handle('SIGINT')
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('user')
    expect(controller.cancelledBy).toBe('user')
    expect(notes[0]).toContain('press Ctrl+C again')
    expect(exits).toEqual([])
    controller.handle('SIGINT')
    expect(exits).toEqual([130])
  })

  it('returns to idle after the turn ends', () => {
    const exits: number[] = []
    const controller = new InterruptController({ exit: code => exits.push(code), notify: () => {} })
    controller.beginTurn()
    controller.endTurn()
    expect(controller.state).toBe('idle')
    controller.handle('SIGINT')
    expect(exits).toEqual([130])
  })
})

describe('installSignalHandlers', () => {
  it.each(['linux', 'win32'] as const)('binds and unbinds on %s', (platform) => {
    const emitter = new EventEmitter()
    const source = Object.assign(emitter, { platform }) as unknown as Parameters<typeof installSignalHandlers>[0]
    const exits: number[] = []
    const controller = new InterruptController({ exit: code => exits.push(code), notify: () => {} })
    const uninstall = installSignalHandlers(source, controller)
    const extra = platform === 'win32' ? 'SIGBREAK' : 'SIGHUP'
    expect(emitter.listenerCount('SIGINT')).toBe(1)
    expect(emitter.listenerCount(extra)).toBe(1)
    emitter.emit(extra)
    expect(exits).toEqual([143])
    uninstall()
    expect(emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM') + emitter.listenerCount(extra)).toBe(0)
  })
})
