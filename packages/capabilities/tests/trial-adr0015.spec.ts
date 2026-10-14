import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OUTPUT_FILES, OUTPUT_PATHS, runGate, runOutput, type ReviewInput, type TrialReviewer } from '../src/index.js'
import { tempDir } from './helpers.js'
import { feedbackTask, historyProject, improvementJob, proposeCandidate, scriptedRunner, usage } from './trial-fixture.js'

const sha = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex')

async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
  await writeFile(join(root, ...path.split('/')), text)
}

describe('ADR 0015: what the reviewer sees of a run', () => {
  it('lists every changed file (contents for the first few) and the snapshot files the run removed', async () => {
    const root = await tempDir()
    const before = new Map<string, string>()
    const names = Array.from({ length: 20 }, (_, index) => `note ${String(index + 1).padStart(2, '0')}.txt`)
    // The snapshot had 20 inbox files and one file the run leaves alone; the run moves every inbox file.
    for (const name of names) before.set(`inbox/${name}`, sha(name))
    before.set('README.md', sha('readme'))
    await write(root, 'README.md', 'readme')
    for (const name of names) await write(root, `archive/${name.replace(' ', '_')}`, name)

    const output = await runOutput(root, before)
    expect(output.files).toHaveLength(OUTPUT_FILES)
    expect(output.files[0]).toEqual({ path: 'archive/note_01.txt', text: 'note 01.txt' })
    expect(output.unshown).toEqual(names.slice(OUTPUT_FILES).map(name => `archive/${name.replace(' ', '_')}`))
    expect(output.unlisted).toBeUndefined()
    expect(output.removed).toEqual(names.map(name => `inbox/${name}`))
    expect(output.files.some(file => file.path === 'README.md')).toBe(false)
  })

  it('counts the paths beyond the listing limit instead of dropping them silently', async () => {
    const root = await tempDir()
    const before = new Map<string, string>()
    const count = OUTPUT_FILES + OUTPUT_PATHS + 3
    for (let index = 0; index < count; index += 1) {
      before.set(`old/${index}.txt`, sha('x'))
      await write(root, `new/${String(index).padStart(4, '0')}.txt`, 'x')
    }
    const output = await runOutput(root, before)
    expect(output.files).toHaveLength(OUTPUT_FILES)
    expect(output.unshown).toHaveLength(OUTPUT_PATHS)
    expect(output.unlisted).toBe(3)
    expect(output.removed).toHaveLength(OUTPUT_PATHS)
    expect(output.removedUnlisted).toBe(count - OUTPUT_PATHS)
  })

  it('shows a run that changed nothing as no files, with no extra lists', async () => {
    const root = await tempDir()
    await write(root, 'a.txt', 'a')
    expect(await runOutput(root, new Map([['a.txt', sha('a')]]))).toEqual({ files: [] })
  })
})

describe('ADR 0015: the preference review of a job\'s feedback task sees the feedback', { timeout: 60_000 }, () => {
  it('passes the feedback with the feedback task\'s review and none with the other cases', async () => {
    const { layout, tasks } = await historyProject()
    const task = await feedbackTask(layout, 'summarize the august orders by region', 'names must not contain spaces; this time also add a list of the old names')
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id)
    const asked: ReviewInput[] = []
    const reviewer: TrialReviewer = {
      async review(input) {
        asked.push(input)
        return { preference: 'tie', reason: 'same', usage: usage(5), requestCount: 1 }
      },
      async checkFeedback() {
        return { status: 'pass', reason: 'solved', usage: usage(5), requestCount: 1 }
      },
    }
    const runner = scriptedRunner(() => ({ output: 'good' }))
    const result = await runGate({ layout, candidateId: candidate.id, runner, reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`)
    // A full tie: checks, feedback checks and cost; the reviewer is asked for every selection run pair.
    expect(asked.length).toBeGreaterThan(0)
    const own = asked.filter(input => input.caseId === task.taskId)
    const others = asked.filter(input => input.caseId !== task.taskId)
    expect(own.length).toBeGreaterThan(0)
    expect(others.length).toBeGreaterThan(0)
    for (const input of own) expect(input.feedback?.map(entry => entry.comment)).toEqual([task.feedback.comment])
    for (const input of others) expect(input.feedback).toBeUndefined()
  })
})
