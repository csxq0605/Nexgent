/**
 * Child process of the mid-term checkpoint test (`checkpoint.spec.ts`): only
 * the SDK, no CLI. Opens a new project, adds two materials (.csv, .xlsx) to
 * a new session, sets a goal, runs a turn that reads the workbook through
 * the Office skill, writes a file and presents it (v1), submits feedback on
 * v1 (the feedback turn edits the file and presents v2), then starts a third
 * turn and prints `STREAMING` once its text arrives; the parent kills the
 * process there.
 *
 * argv: <projectRoot> <csv> <xlsx>; env: NEXGENT_HOME, NEXGENT_API_KEY,
 * NEXGENT_API_BASE_URL (the parent's scripted model server).
 */
import { createSdk, type SdkEvent } from '../../src/index.js'

const [root, csv, xlsx] = process.argv.slice(2) as [string, string, string]
const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`)

const sdk = createSdk({ appVersion: '0.0.0-child', env: process.env, approvalTimeoutMs: 5_000 })
const events: SdkEvent[] = []
let streaming = false
sdk.subscribe(event => {
  events.push(event)
  if (event.type === 'text.delta' && event.turn === 3 && !streaming) {
    streaming = true
    say({ step: 'streaming', turn: 3 })
  }
})
const turnEnd = (turn: number) => new Promise<SdkEvent>(resolve => {
  const hit = events.find(event => event.type === 'turn.end' && event.turn === turn)
  if (hit !== undefined) return resolve(hit)
  const off = sdk.subscribe(event => {
    if (event.type === 'turn.end' && event.turn === turn) {
      off()
      resolve(event)
    }
  })
})

const project = await sdk.call('projects.open', { root, create: true })
const session = await sdk.call('sessions.create', { projectId: project.projectId, title: 'sales' })
const { projectId } = project
const { sessionId } = session
say({ step: 'session', projectId, sessionId, root: project.root })

const orders = await sdk.call('materials.add', { projectId, sessionId, sourcePath: csv })
const regions = await sdk.call('materials.add', { projectId, sessionId, sourcePath: xlsx })
await sdk.call('goals.set', { projectId, sessionId, text: 'Summarize the orders' })

await sdk.call('turns.send', { projectId, sessionId, text: 'Summarize the orders by region and give me the result.', materialIds: [orders.id, regions.id] })
say({ step: 'turn1', end: await turnEnd(1) })

const [deliverable] = await sdk.call('deliverables.list', { projectId })
await sdk.call('feedback.submit', { projectId, sessionId, deliverableId: deliverable!.deliverableId, version: 1, rating: 3, comment: 'Use the Chinese region names.' })
say({ step: 'turn2', end: await turnEnd(2) })

await sdk.call('turns.send', { projectId, sessionId, text: 'Also explain how duplicates were handled.' })
// The parent kills this process while turn 3 streams; never reached otherwise.
await turnEnd(3)
say({ step: 'turn3-finished-unexpectedly' })
await sdk.dispose()
