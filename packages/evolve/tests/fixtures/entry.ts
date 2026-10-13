/**
 * A host entry for tests: `improve <projectRoot> <jobId>` runs the job with
 * stages picked by NEXGENT_TEST_STAGES (`pending` | `adopted` | `hang`).
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorkspaceLayout, ZERO_USAGE } from '@nexgent/kernel'
import { PENDING_STAGES, runImprovementJob, type ImprovementStages } from '../../src/index.js'

const [mode, root, jobId] = process.argv.slice(2)
if (mode !== 'improve' || root === undefined || jobId === undefined) process.exit(64)
const layout = resolveWorkspaceLayout(root)
const kind = process.env.NEXGENT_TEST_STAGES ?? 'pending'
const usage = { ...ZERO_USAGE, inputTokens: 10, totalTokens: 10 }
const stages: ImprovementStages = kind === 'pending' ? PENDING_STAGES : {
  async diagnose() {
    if (kind === 'hang') {
      await writeFile(join(root, `diagnosing-${process.pid}`), '')
      // Keep the process alive until it is killed.
      setInterval(() => undefined, 1_000)
      await new Promise(() => undefined)
    }
    return { usage, requestCount: 1, outcome: 'propose', proposalKind: 'skill' }
  },
  async propose() {
    return { usage, requestCount: 1, outcome: 'candidate', candidateId: '11111111-1111-4111-8111-111111111111' }
  },
  async trial() {
    return { usage, requestCount: 1, outcome: 'adopted' }
  },
}
const result = await runImprovementJob(layout, jobId, { stages })
process.stdout.write(`${JSON.stringify({ ran: result.jobs.map(job => [job.id, job.status]), skipped: result.skipped })}\n`)
