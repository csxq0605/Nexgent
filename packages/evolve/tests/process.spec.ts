/** Real OS processes: the detached job process, a killed job, and two processes counting at once. */
import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensureQueue, ImprovementHost, improvementsDir, jobPaths, readJob, readQueue } from '../src/index.js'
import { feedback, project, tempDir } from './helpers.js'

const ENTRY = fileURLToPath(new URL('./fixtures/entry.ts', import.meta.url))
const ADMIT = fileURLToPath(new URL('./fixtures/admit-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const TSX_ENV = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx`.trim() }

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('job processes', () => {
  it('the third feedback starts a detached job process that runs the job', async () => {
    const layout = await project()
    const host = new ImprovementHost(layout, { legacyCounting: true, entry: ENTRY, env: { ...TSX_ENV, NEXGENT_TEST_STAGES: 'adopted' } })
    await host.start()
    const result = await host.noteFeedback([feedback(), feedback({ rating: 1 }), feedback()])
    const started = host.started.get(result.started!.id)!
    expect(started.pid).toBeTypeOf('number')
    expect(await started.exited).toBe(0)
    expect(await host.show(result.started!.id)).toMatchObject({ status: 'adopted' })
  }, 60_000)

  it('a killed job process is marked interrupted on the next start and not re-run', async () => {
    const layout = await project()
    const host = new ImprovementHost(layout, { legacyCounting: true, entry: ENTRY, env: { ...TSX_ENV, NEXGENT_TEST_STAGES: 'hang' } })
    await host.start()
    const job = await host.run()
    const started = host.started.get(job.id)!
    await until(async () => ((await readdir(layout.root)).some(name => name.startsWith('diagnosing-')) ? true : undefined))
    expect((await readJob(host.directory, job.id)).status).toBe('diagnosing')
    process.kill(started.pid!, 'SIGKILL')
    await started.exited
    // A new app start in another "process": a fresh host.
    const restarted = new ImprovementHost(layout, { legacyCounting: true, entry: ENTRY, env: { ...TSX_ENV, NEXGENT_TEST_STAGES: 'adopted' } })
    await restarted.start()
    const after = await restarted.show(job.id)
    expect(after.status).toBe('interrupted')
    expect(after.history.map(entry => entry.status)).toEqual(['queued', 'diagnosing', 'interrupted'])
    expect(restarted.started.size).toBe(0)
    expect((await readQueue(restarted.directory))!.activeJobId).toBeUndefined()
    await expect(readdir(jobPaths(restarted.directory, job.id).directory)).resolves.not.toContain('job.lock')
    // The slot is free again: an explicit run starts a new job.
    const next = await restarted.run()
    expect(next.id).not.toBe(job.id)
    await restarted.settled()
    expect(await restarted.show(next.id)).toMatchObject({ status: 'adopted' })
  }, 60_000)
})

describe('two processes counting at once', () => {
  it('count every item once and start exactly one job', async () => {
    const layout = await project()
    await ensureQueue(improvementsDir(layout), new Date(Date.now() - 1_000))
    const barrier = join(await tempDir(), 'barrier')
    await mkdir(barrier)
    const ids = ['a', 'b', 'c', 'd'].map(letter => `${letter}0000000-0000-4000-8000-000000000000`)
    const children = [[ids[0]!, ids[1]!], [ids[2]!, ids[3]!], [ids[1]!, ids[2]!]].map((batch, index) => {
      const child = spawn(process.execPath, ['--import', 'tsx', ADMIT, layout.root, barrier, String(index), ...batch], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.stderr.on('data', chunk => { err += String(chunk) })
      return new Promise<{ added: number; started: string | null }>((resolve, reject) => {
        child.on('close', code => (code === 0 ? resolve(JSON.parse(out.trim()) as { added: number; started: string | null }) : reject(new Error(`child exited ${code}: ${err}`))))
      })
    })
    await until(async () => ((await readdir(barrier)).filter(name => name.startsWith('ready-')).length === 3 ? true : undefined))
    await writeFile(join(barrier, 'go'), '')
    const results = await Promise.all(children)
    expect(results.reduce((sum, result) => sum + result.added, 0)).toBe(4)
    expect(results.filter(result => result.started !== null)).toHaveLength(1)
    const queue = (await readQueue(improvementsDir(layout)))!
    expect([...queue.counted].sort()).toEqual(ids.map(id => `feedback:${id}`).sort())
    const jobs = (await readdir(improvementsDir(layout))).filter(name => /^[0-9a-f-]{36}$/.test(name))
    expect(jobs).toHaveLength(1)
    // Three items went into the job, the fourth waits in the next batch.
    expect((await readJob(improvementsDir(layout), jobs[0]!)).items.length + queue.pending.length).toBe(4)
  }, 60_000)
})
