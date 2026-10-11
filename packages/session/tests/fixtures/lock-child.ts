// Child process for the cross-process lock tests: take (or create) a session
// lock, report the outcome on stdout, then hold it until stdin closes or the
// process is killed.
import { isNexgentError } from '@nexgent/kernel'
import { JsonlSessionStore } from '../../src/index.js'

const [sessionsDir, sessionId, mode] = process.argv.slice(2)
if (sessionsDir === undefined || sessionId === undefined) throw new Error('usage: lock-child <sessionsDir> <sessionId> [create]')
const store = new JsonlSessionStore({ sessionsDir, checkpointOnRelease: false })
try {
  if (mode === 'create') {
    await store.create({ sessionId, projectRoot: sessionsDir, model: 'm', sandboxMode: 'read-only' })
  } else {
    await store.lock(sessionId)
  }
  process.stdout.write(`ok ${process.pid}\n`)
} catch (error) {
  process.stdout.write(`${isNexgentError(error) ? error.code : String(error)}\n`)
  process.exit(0)
}
process.stdin.resume()
process.stdin.on('end', () => {
  void store.close().then(() => process.exit(0))
})
