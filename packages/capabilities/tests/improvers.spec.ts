import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyImproverChange, canonicalImproverText, IMPROVER_V0, resolveWorkspaceLayout, type ImproverBundle } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { improversDir, improverVersionOf, ImproverStore } from '../src/index.js'
import { tempDir } from './helpers.js'

const JOB_A = '8b1f2a6e-3c4d-4e5f-9a0b-1c2d3e4f5a61'
const JOB_B = '8b1f2a6e-3c4d-4e5f-9a0b-1c2d3e4f5a62'

const repeats3 = applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'repeats', value: 3 })
const recency = applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'selection', value: 'recency' })

async function store(): Promise<ImproverStore> {
  const root = await tempDir()
  return new ImproverStore(improversDir(resolveWorkspaceLayout(root)), { now: () => new Date('2026-10-13T16:00:00.000Z') })
}

describe('ImproverStore', () => {
  it('a project without improvers runs on v0, and nothing is written for it', async () => {
    const improvers = await store()
    expect(improvers.directory.endsWith(join('.nexgent', 'improvers'))).toBe(true)
    const resolved = await improvers.resolve()
    expect(resolved).toMatchObject({ version: 'v0', rollbacks: [], activation: { revision: 0, digest: null, version: 'v0' } })
    expect(resolved.bundle).toBe(IMPROVER_V0)
    expect(await improvers.write(IMPROVER_V0)).toEqual({ version: 'v0', created: false })
    expect(await improvers.versions()).toEqual([])
    await expect(readdir(improvers.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('the same content is the same version, stored once; an invalid improver is refused', async () => {
    const improvers = await store()
    const first = await improvers.write(repeats3)
    expect(first.created).toBe(true)
    expect(first.version).toMatch(/^[a-f0-9]{64}$/)
    expect(await improvers.write(JSON.parse(JSON.stringify(repeats3)) as ImproverBundle)).toEqual({ version: first.version, created: false })
    expect(improverVersionOf(repeats3)).toBe(first.version)
    expect(await improvers.versions()).toEqual([first.version])
    expect(await readFile(join(improvers.bundlesDirectory, `${first.version}.json`), 'utf8')).toBe(canonicalImproverText(repeats3))
    expect(await improvers.load(first.version)).toEqual(repeats3)
    const outOfBounds = { ...repeats3, comparison: { ...repeats3.comparison, repeats: 9 } }
    await expect(improvers.write(outOfBounds)).rejects.toMatchObject({ code: 'improver/invalid' })
    await expect(improvers.load('f'.repeat(64))).rejects.toMatchObject({ code: 'improver/not-found' })
  })

  it('adopts a stored improver, rolls back as a new revision and keeps every file', async () => {
    const improvers = await store()
    const a = (await improvers.write(repeats3)).version
    const b = (await improvers.write(recency)).version
    await expect(improvers.adopt('f'.repeat(64), { jobId: JOB_A })).rejects.toMatchObject({ code: 'improver/not-found' })
    await expect(improvers.rollback({ trigger: 'manual' })).rejects.toMatchObject({ code: 'improver/activation' })

    const adopted = await improvers.adopt(a, { jobId: JOB_A })
    expect(adopted?.revision).toEqual({ format: 1, revision: 1, previous: null, from: 'v0', version: a, type: 'adopt', trigger: 'meta-job', jobId: JOB_A, committedAt: '2026-10-13T16:00:00.000Z' })
    await expect(improvers.adopt(a, { jobId: JOB_A })).rejects.toMatchObject({ code: 'improver/activation' })
    await improvers.adopt(b, { jobId: JOB_B })
    expect((await improvers.resolve()).bundle).toEqual(recency)

    // Without a target: back to the one before.
    const back = await improvers.rollback({ trigger: 'manual', reason: 'worse summaries' })
    expect(back?.revision).toMatchObject({ revision: 3, from: b, version: a, type: 'rollback', trigger: 'manual', reason: 'worse summaries' })
    expect((await improvers.resolve()).version).toBe(a)
    // A version never in force cannot be a target; v0 always can.
    const never = (await improvers.write(applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'selectionCases', value: 3 }))).version
    await expect(improvers.rollback({ trigger: 'manual', toVersion: never })).rejects.toMatchObject({ code: 'improver/activation' })
    const toV0 = await improvers.rollback({ trigger: 'manual', toVersion: 'v0' })
    expect(toV0?.activation).toMatchObject({ revision: 4, version: 'v0', stack: ['v0'] })
    // An improver rolled away from earlier can be returned to by name.
    expect((await improvers.rollback({ trigger: 'manual', toVersion: b }))?.activation).toMatchObject({ version: b, stack: ['v0', b] })

    const chain = await improvers.chain()
    expect(chain.problem).toBeUndefined()
    expect(chain.revisions.map(revision => `${revision.type}:${revision.version === 'v0' ? 'v0' : revision.version === a ? 'a' : 'b'}`)).toEqual(['adopt:a', 'adopt:b', 'rollback:a', 'rollback:v0', 'rollback:b'])
    expect((await readdir(improvers.activationDirectory)).sort()).toEqual(['1.json', '2.json', '3.json', '4.json', '5.json'])
    expect((await improvers.versions()).sort()).toEqual([a, b, never].sort())
  })

  it('two adoptions at once: exactly one wins, the other sees the conflict', async () => {
    const root = await tempDir()
    const directory = improversDir(resolveWorkspaceLayout(root))
    const one = new ImproverStore(directory)
    const two = new ImproverStore(directory)
    const a = (await one.write(repeats3)).version
    const b = (await one.write(recency)).version
    const observed = await one.activation()
    const results = await Promise.all([one.adopt(a, { jobId: JOB_A }, observed), two.adopt(b, { jobId: JOB_B }, observed)])
    expect(results.filter(result => result === null)).toHaveLength(1)
    const winner = results.find(result => result !== null)!
    const chain = await one.chain()
    expect(chain.revisions).toEqual([winner.revision])
    expect(chain.activation.version).toBe(winner.revision.version)

    // Without an observed tail the race is decided by the exclusive publish alone.
    const c = (await one.write(applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'selectionCases', value: 4 }))).version
    const d = (await one.write(applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'selectionCases', value: 3 }))).version
    const again = await Promise.all([one.adopt(c, { jobId: JOB_A }), two.adopt(d, { jobId: JOB_B })])
    expect(again.filter(result => result === null).length).toBeLessThanOrEqual(1)
    const revisions = (await one.chain()).revisions
    expect(revisions).toHaveLength(1 + again.filter(result => result !== null).length)
    expect((await one.chain()).problem).toBeUndefined()
  })

  it('an improver in force that no longer loads is rolled back on read (load-failure), down to v0', async () => {
    const improvers = await store()
    const a = (await improvers.write(repeats3)).version
    const b = (await improvers.write(recency)).version
    await improvers.adopt(a, { jobId: JOB_A })
    await improvers.adopt(b, { jobId: JOB_B })
    // b is edited by hand so its content no longer matches its version; a breaks the bounds.
    await writeFile(join(improvers.bundlesDirectory, `${b}.json`), canonicalImproverText(repeats3))
    await writeFile(join(improvers.bundlesDirectory, `${a}.json`), JSON.stringify({ ...repeats3, comparison: { ...repeats3.comparison, repeats: 9 } }))
    await expect(improvers.load(b)).rejects.toMatchObject({ code: 'improver/invalid' })
    await expect(improvers.load(a)).rejects.toMatchObject({ code: 'improver/invalid' })

    const resolved = await improvers.resolve()
    expect(resolved.version).toBe('v0')
    expect(resolved.bundle).toBe(IMPROVER_V0)
    expect(resolved.rollbacks.map(rollback => [rollback.version, rollback.revision.trigger, rollback.revision.version])).toEqual([[b, 'load-failure', a], [a, 'load-failure', 'v0']])
    expect(resolved.rollbacks[0]!.revision.reason).toContain('does not match its version')
    // Nothing is deleted.
    expect((await improvers.versions()).sort()).toEqual([a, b].sort())
    expect((await improvers.resolve()).rollbacks).toEqual([])
  })

  it('a damaged chain is reported, runs on its last valid revision and accepts no new revision', async () => {
    const improvers = await store()
    const a = (await improvers.write(repeats3)).version
    const b = (await improvers.write(recency)).version
    await improvers.adopt(a, { jobId: JOB_A })
    await writeFile(join(improvers.activationDirectory, '2.json'), JSON.stringify({ format: 1, revision: 2, previous: 'f'.repeat(64), from: a, version: b, type: 'adopt', trigger: 'meta-job', jobId: JOB_B, committedAt: '2026-10-13T16:00:00.000Z' }))
    const chain = await improvers.chain()
    expect(chain.problem).toMatchObject({ file: '2.json' })
    expect(chain.activation.version).toBe(a)
    const resolved = await improvers.resolve()
    expect(resolved).toMatchObject({ version: a, problem: { file: '2.json' } })
    await expect(improvers.adopt(b, { jobId: JOB_B })).rejects.toMatchObject({ code: 'improver/activation' })
    await expect(improvers.rollback({ trigger: 'manual' })).rejects.toMatchObject({ code: 'improver/activation' })

    // A damaged chain whose tail does not load falls back to v0 without writing.
    await writeFile(join(improvers.bundlesDirectory, `${a}.json`), 'not json')
    const fallback = await improvers.resolve()
    expect(fallback).toMatchObject({ version: 'v0', fallback: { version: a }, rollbacks: [] })
    expect((await readdir(improvers.activationDirectory)).sort()).toEqual(['1.json', '2.json'])
  })

  it('a rollback revision to an improver never in force is rejected on read', async () => {
    const improvers = await store()
    const a = (await improvers.write(repeats3)).version
    const b = (await improvers.write(recency)).version
    await improvers.adopt(a, { jobId: JOB_A })
    const raw = await readFile(join(improvers.activationDirectory, '1.json'), 'utf8')
    const { createHash } = await import('node:crypto')
    await writeFile(join(improvers.activationDirectory, '2.json'), JSON.stringify({ format: 1, revision: 2, previous: createHash('sha256').update(raw).digest('hex'), from: a, version: b, type: 'rollback', trigger: 'manual', committedAt: '2026-10-13T16:00:00.000Z' }))
    expect((await improvers.chain()).problem).toMatchObject({ file: '2.json', message: expect.stringContaining('in force earlier') })
  })
})
