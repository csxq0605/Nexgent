import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLayout, type WorkspaceLayout } from '@nexgent/kernel'
import { bothOrders, runGate, type ReviewInput, type ReviewResult, type TrialReviewer } from '../src/index.js'
import { tempDir } from './helpers.js'
import { pastTask, proposeCandidate, scriptedRunner, usage, type ArmScript } from './trial-fixture.js'

/** A project with the checker, a CSV the tasks name, an unrelated binary file, and three past tasks. */
async function inputProject(): Promise<{ layout: WorkspaceLayout; tasks: { taskId: string; sessionId: string }[] }> {
  const root = await tempDir()
  const layout = resolveWorkspaceLayout(root)
  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(join(root, 'check.mjs'), "import { readFileSync } from 'node:fs'\nprocess.exit(readFileSync('out/result.txt', 'utf8') === 'good' ? 0 : 1)\n")
  await writeFile(join(root, 'a-notes.txt'), 'unrelated notes\n')
  await writeFile(join(root, 'orders.csv'), 'region,amount\nnorth,1\nsouth,2\n')
  await writeFile(join(root, 'logo.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
  const tasks = []
  for (const text of ['summarize orders.csv by region', 'summarize orders.csv by month', 'build the region lookup table']) tasks.push(await pastTask(layout, text))
  return { layout, tasks }
}

function arms(candidate: ArmScript, baseline: ArmScript) {
  return scriptedRunner(request => (request.arm === 'candidate' ? candidate : baseline))
}

async function writeConfig(layout: WorkspaceLayout, capabilities: Record<string, unknown>): Promise<void> {
  await writeFile(layout.configFile, JSON.stringify({ version: 1, capabilities }))
}

const answer = (preference: ReviewResult['preference'], estimatedUsd?: number | 'unknown'): ReviewResult => ({
  preference,
  reason: preference,
  usage: usage(10),
  requestCount: 1,
  ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
})

/**
 * A reviewer that always prefers whatever is shown as attempt A. Where the
 * gate does not say the order (before ADR 0016), the reviewer route put the
 * candidate first on odd repeats, as `llmReviewer` did.
 */
function prefersA(failOn?: (input: ReviewInput) => boolean): TrialReviewer & { readonly asked: ReviewInput[] } {
  const asked: ReviewInput[] = []
  return {
    asked,
    async review(input) {
      asked.push(input)
      if (failOn?.(input) === true) throw new Error('overloaded')
      const candidateFirst = (input as { candidateFirst?: boolean }).candidateFirst ?? input.repeat % 2 === 1
      return answer(candidateFirst ? 'candidate' : 'baseline')
    },
  }
}

describe('ADR 0016: a pair\'s vote from both orders', () => {
  it('counts a preference only when both orders agree', () => {
    const cases: [ReviewResult['preference'], ReviewResult['preference'], ReviewResult['preference']][] = [
      ['candidate', 'candidate', 'candidate'],
      ['baseline', 'baseline', 'baseline'],
      ['tie', 'tie', 'tie'],
      // A flip with the order is the position, not the attempts.
      ['candidate', 'baseline', 'tie'],
      ['baseline', 'candidate', 'tie'],
      ['candidate', 'tie', 'tie'],
      ['tie', 'baseline', 'tie'],
      ['candidate', 'unknown', 'unknown'],
      ['unknown', 'baseline', 'unknown'],
      ['unknown', 'unknown', 'unknown'],
    ]
    for (const [first, second, vote] of cases) expect(bothOrders(answer(first), answer(second)).preference, `${first} / ${second}`).toBe(vote)
  })

  it('adds up both requests and keeps both reasons', () => {
    const result = bothOrders(answer('candidate', 0.01), answer('tie', 0.02))
    expect(result).toMatchObject({ requestCount: 2, usage: { totalTokens: 20 } })
    expect(result.estimatedUsd).toBeCloseTo(0.03)
    expect(result.reason).toBe('Candidate as A: candidate (candidate) Candidate as B: tie (tie)')
    expect(bothOrders(answer('tie', 0.01), answer('tie', 'unknown')).estimatedUsd).toBe('unknown')
    expect(bothOrders(answer('tie', 0.01), answer('tie')).estimatedUsd).toBe('unknown')
  })
})

describe('ADR 0016: a position-biased reviewer cannot adopt a candidate', { timeout: 60_000 }, () => {
  it('rejects a check tie that one review per pair (one order) adopted with an odd number of repeats', async () => {
    const { layout, tasks } = await inputProject()
    await writeConfig(layout, { repeats: 1 })
    const candidate = await proposeCandidate(layout, tasks[2]!)
    const reviewer = prefersA()
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(result.status)
    // One order per pair put the candidate first on every repeat 1: two votes for it, none against, adopted.
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(result.verdict.decidedByReview).not.toBe(true)
    // Each pair was asked twice, once with each attempt first.
    expect(reviewer.asked.map(input => input.candidateFirst)).toEqual([true, false, true, false])
  })

  it('rejects when one order of every other pair fails (the alternating orders no longer cancel out)', async () => {
    const { layout, tasks } = await inputProject()
    const candidate = await proposeCandidate(layout, tasks[2]!)
    const reviewer = prefersA(input => input.repeat === 2)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(result.status)
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })

  it('still adopts on a preference that holds in both orders', async () => {
    const { layout, tasks } = await inputProject()
    await writeConfig(layout, { repeats: 1 })
    const candidate = await proposeCandidate(layout, tasks[2]!)
    // Both arms pass the checks; only the candidate also writes the per-region table the task asks for.
    const table = async (request: { projectRoot: string }) => {
      await mkdir(join(request.projectRoot, 'out'), { recursive: true })
      await writeFile(join(request.projectRoot, 'out', 'regions.csv'), 'region,total\nnorth,1\nsouth,2\n')
    }
    const reviewer: TrialReviewer = {
      async review(input) {
        const [a, b] = input.candidateFirst ? [input.candidate, input.baseline] : [input.baseline, input.candidate]
        const hasTable = (output: typeof a) => output.files.some(file => file.path === 'out/regions.csv')
        const better = hasTable(a) && !hasTable(b) ? 'A' : hasTable(b) && !hasTable(a) ? 'B' : 'tie'
        if (better === 'tie') return answer('tie')
        return answer((better === 'A') === input.candidateFirst ? 'candidate' : 'baseline')
      },
    }
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', inspect: table }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(result.status)
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'review-preferred', decidedByReview: true })
  })
})

describe('ADR 0016: the reviewer sees the task\'s input files', { timeout: 60_000 }, () => {
  it('passes the project as the task started, files the task names first, documents as text', async () => {
    const { layout, tasks } = await inputProject()
    await writeConfig(layout, { repeats: 1 })
    const candidate = await proposeCandidate(layout, tasks[2]!)
    const reviewer = prefersA()
    const documentText = (path: string, bytes: Uint8Array) => (path.endsWith('.xlsx') ? `sheet of ${bytes.byteLength} bytes: north 1` : undefined)
    const sheet = async (request: { projectRoot: string }) => {
      await mkdir(join(request.projectRoot, 'out'), { recursive: true })
      await writeFile(join(request.projectRoot, 'out', 'table.xlsx'), Buffer.from([0x50, 0x4b, 0xff, 0x00]))
    }
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', inspect: sheet }, { output: 'good' }), reviewer, documentText, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(result.status)

    const ofCase = reviewer.asked.find(input => input.messages[0]?.text === 'summarize orders.csv by region')
    if (ofCase === undefined) throw new Error('the orders task was not reviewed')
    const paths = ofCase.inputs.files.map(file => file.path)
    // The file the task names comes first; the run's own outputs and the project's data directory are not inputs.
    expect(paths[0]).toBe('orders.csv')
    expect(ofCase.inputs.files[0]!.text).toBe('region,amount\nnorth,1\nsouth,2\n')
    expect(paths).toEqual(expect.arrayContaining(['a-notes.txt', 'check.mjs', 'logo.bin']))
    expect(paths.some(path => path.startsWith('out/') || path.startsWith('.nexgent'))).toBe(false)
    // A binary file the host cannot read stays a marker; a document the host reads is shown as its text.
    expect(ofCase.inputs.files.find(file => file.path === 'logo.bin')!.text).toBe('(binary, 4 bytes)')
    expect(ofCase.candidate.files.find(file => file.path === 'out/table.xlsx')!.text).toBe('sheet of 4 bytes: north 1')
    // Both orders of a pair see the same inputs.
    const other = reviewer.asked.filter(input => input.caseId === ofCase.caseId && input.repeat === ofCase.repeat)
    expect(other.map(input => input.candidateFirst)).toEqual([true, false])
    expect(other[1]!.inputs).toEqual(ofCase.inputs)
  })
})
