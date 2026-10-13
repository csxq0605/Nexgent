/** Race child: wait for the barrier, then submit the given feedback ids through a host. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorkspaceLayout } from '@nexgent/kernel'
import { ImprovementHost, type StartedJob } from '../../src/index.js'

const [root, barrier, index, ...ids] = process.argv.slice(2)
const layout = resolveWorkspaceLayout(root!)
const launched: string[] = []
const host = new ImprovementHost(layout, { launch: (_layout, jobId): StartedJob => { launched.push(jobId); return { jobId, pid: undefined, exited: new Promise(() => undefined) } } })
await writeFile(join(barrier!, `ready-${index}`), '')
for (;;) {
  try {
    await readFile(join(barrier!, 'go'))
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const at = new Date(Date.now() + 1_000).toISOString()
const result = await host.noteFeedback(ids.map(id => ({ id, deliverableId: id, version: 1, rating: 2 as const, comment: 'wrong totals', sessionId: `s-${index}`, turn: 2, submittedAt: at })))
process.stdout.write(`${JSON.stringify({ added: result.added.length, started: result.started?.id ?? null, launched })}\n`)
