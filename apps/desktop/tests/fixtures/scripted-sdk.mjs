// A scripted SDK for the desktop E2E tests (loaded through
// NEXGENT_DESKTOP_SDK_MODULE). It records every call that reaches it in
// `<home>/sdk-calls.jsonl` (method and input keys only), runs a fake turn on
// `turns.send` that streams one delta and then waits for `turns.cancel`, and
// marks `dispose` in `<home>/disposed.json`.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NexgentError } from '@nexgent/kernel'

export function createSdk(options) {
  const home = options.home
  const listeners = new Set()
  const running = new Map()
  const seq = new Map()
  const emit = (projectId, sessionId, event) => {
    const next = (seq.get(sessionId) ?? 0) + 1
    seq.set(sessionId, next)
    const full = { projectId, sessionId, eventSeq: next, ...event }
    for (const listener of listeners) listener(full)
  }
  const usage = { inputTokens: 0, outputTokens: 0 }
  return {
    apiVersion: 1,
    async call(method, input) {
      appendFileSync(join(home, 'sdk-calls.jsonl'), `${JSON.stringify({ method, keys: Object.keys(input ?? {}).sort() })}\n`)
      switch (method) {
        case 'app.info':
          return { sdkVersion: 1, appVersion: options.appVersion, platform: process.platform }
        case 'projects.recent':
          return []
        case 'turns.send': {
          const turn = (running.get(input.sessionId)?.turn ?? 0) + 1
          running.set(input.sessionId, { projectId: input.projectId, turn })
          setTimeout(() => {
            emit(input.projectId, input.sessionId, { type: 'turn.start', turn, source: 'user' })
            emit(input.projectId, input.sessionId, { type: 'text.delta', turn, step: 1, text: `echo: ${input.text}` })
          }, 10)
          return { sessionId: input.sessionId, turn }
        }
        case 'turns.cancel': {
          const entry = running.get(input.sessionId)
          if (entry === undefined) return undefined
          running.delete(input.sessionId)
          await new Promise((resolve) => setTimeout(resolve, 50))
          emit(entry.projectId, input.sessionId, { type: 'turn.end', turn: entry.turn, reason: { kind: 'cancelled', cause: 'shutdown' }, usage })
          appendFileSync(join(home, 'cancelled.jsonl'), `${JSON.stringify({ sessionId: input.sessionId, turn: entry.turn })}\n`)
          return undefined
        }
        case 'sessions.export':
          return { path: input.outDir, files: [] }
        case 'settings.setApiKey':
          return input.value === '' ? { configured: false } : { configured: true, source: 'file' }
        case 'projects.open':
          throw new NexgentError('workspace/not-found', `no such project: ${input.root}`, { details: { root: input.root } })
        default:
          return null
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      writeFileSync(join(home, 'disposed.json'), JSON.stringify({ at: new Date().toISOString() }))
    },
  }
}
