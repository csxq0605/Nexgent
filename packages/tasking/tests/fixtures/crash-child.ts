/**
 * Child process for the crash test: runs two complete turns through the
 * tasking service (material, goal, present v1, feedback, present v2), opens a
 * third turn, starts presenting a large file and kills itself (SIGKILL; on
 * Windows TerminateProcess) while the snapshot is being copied.
 *
 * argv: <projectRoot> <sessionId> <materialSource> <bigFile (project-relative)>
 */
import { readdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { renderFeedbackPrompt, resolveWorkspaceLayout, toDeliverableVersionRef, type SessionRecordInput } from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { createFeedbackEntry, createTaskingService, materialAddedRecord } from '../../src/index.js'

const [root, sessionId, materialSource, bigFile] = process.argv.slice(2) as [string, string, string, string]
const layout = resolveWorkspaceLayout(root)
const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
const tasking = createTaskingService(layout, store)
const append = (record: SessionRecordInput) => store.append(sessionId, record)

await store.create({ sessionId, projectRoot: root, model: 'scripted-model', sandboxMode: 'workspace-write' })
const material = await tasking.materials.add({ sourcePath: materialSource, sessionId })
await append(materialAddedRecord(material))
await tasking.goals.set(append, 'Summarize sales by region')

// turn 1: write + present v1
await append({ type: 'turn.start', turn: 1 })
await append({ type: 'user.message', turn: 1, content: 'Summarize the orders.', source: 'user', materials: [material.id] })
await tasking.files.beginTurn(sessionId, 1)
await writeFile(nodePath.join(root, 'summary.csv'), 'region,total\nnorth,100\n')
const v1 = await tasking.deliverables.present({ sessionId, turn: 1, toolCallId: 'call_1', paths: ['summary.csv'], summary: 'First summary.' })
await append({ type: 'deliverable.presented', turn: 1, step: 1, toolCallId: 'call_1', deliverable: toDeliverableVersionRef(v1) })
await append({ type: 'turn.files', turn: 1, changes: [...(await tasking.files.endTurn(sessionId, 1))] })
await append({ type: 'turn.end', turn: 1, reason: { kind: 'completed' } })

// turn 2: feedback + present v2
const feedback = await createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, rating: 3, comment: 'Use Chinese region names.' }, tasking.deliverables)
await append({ type: 'turn.start', turn: 2 })
await append({ type: 'feedback', turn: 2, feedback })
await append({ type: 'user.message', turn: 2, content: renderFeedbackPrompt(feedback), source: 'feedback' })
await tasking.files.beginTurn(sessionId, 2)
await writeFile(nodePath.join(root, 'summary.csv'), 'region,total\n华北,100\n')
const v2 = await tasking.deliverables.present({ sessionId, turn: 2, toolCallId: 'call_2', paths: ['summary.csv'], summary: 'Chinese names.', deliverableId: v1.deliverableId })
await append({ type: 'deliverable.presented', turn: 2, step: 1, toolCallId: 'call_2', deliverable: toDeliverableVersionRef(v2) })
await append({ type: 'turn.files', turn: 2, changes: [...(await tasking.files.endTurn(sessionId, 2))] })
await append({ type: 'turn.end', turn: 2, reason: { kind: 'completed' } })

// turn 3: killed while a large snapshot is being copied
await append({ type: 'turn.start', turn: 3 })
await append({ type: 'user.message', turn: 3, content: 'Add the raw data too.', source: 'user' })
const versionDir = nodePath.join(layout.outputs, v1.deliverableId)
void tasking.deliverables.present({ sessionId, turn: 3, toolCallId: 'call_3', paths: ['summary.csv', bigFile], summary: 'With raw data.', deliverableId: v1.deliverableId })
for (;;) {
  const entries = await readdir(versionDir)
  if (entries.some(entry => entry.startsWith('.tmp-'))) {
    process.stdout.write(`killing mid-copy ${entries.includes('v3') ? 'late' : 'in-time'}\n`)
    break
  }
  if (entries.includes('v3')) {
    process.stdout.write('killing late\n')
    break
  }
  await new Promise(resolve => setImmediate(resolve))
}
process.kill(process.pid, 'SIGKILL')
