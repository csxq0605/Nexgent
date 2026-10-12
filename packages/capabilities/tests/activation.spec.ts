import { randomUUID } from 'node:crypto'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isNexgentError, type ActivationTrigger } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { BASELINE_ACTIVATION, commitActivation, readActivation, readActivationChain, sha256, type ActivationChange } from '../src/index.js'
import { tempDir } from './helpers.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const clock = () => new Date('2026-10-12T03:00:00.000Z')

function adopt(version: string, trigger: ActivationTrigger = 'gate'): ActivationChange {
  return { type: 'adopt', version, trigger, decisionId: randomUUID() }
}

function rollback(trigger: ActivationTrigger = 'manual'): ActivationChange {
  return { type: 'rollback', trigger, decisionId: randomUUID() }
}

async function rejects(promise: Promise<unknown>, code: 'config/invalid' | 'session/corrupt', pattern: RegExp): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(isNexgentError(error, code)).toBe(true)
  expect((error as Error).message).toMatch(pattern)
}

describe('activation chain', () => {
  it('starts at the baseline when nothing is committed', async () => {
    const dir = join(await tempDir(), 'activation')
    expect(await readActivationChain(dir)).toEqual({ revisions: [], activation: BASELINE_ACTIVATION })
  })

  it('appends adopt and rollback revisions linked by digest, in the contract format', async () => {
    const dir = await tempDir()
    const first = adopt(A)
    const one = await commitActivation(dir, BASELINE_ACTIVATION, first, clock)
    expect(one).toMatchObject({ revision: 1, version: A, stack: ['baseline', A] })
    const two = await commitActivation(dir, one!, adopt(B), clock)
    const three = await commitActivation(dir, two!, rollback('usage-regression'), clock)
    expect(three).toMatchObject({ revision: 3, version: A, stack: ['baseline', A] })
    const four = await commitActivation(dir, three!, rollback(), clock)
    expect(four).toMatchObject({ revision: 4, version: 'baseline', stack: ['baseline'] })

    const { revisions, activation, problem } = await readActivationChain(dir)
    expect(problem).toBeUndefined()
    expect(activation).toEqual(four)
    expect(revisions.map(revision => [revision.type, revision.from, revision.version, revision.trigger])).toEqual([
      ['adopt', 'baseline', A, 'gate'],
      ['adopt', A, B, 'gate'],
      ['rollback', B, A, 'usage-regression'],
      ['rollback', A, 'baseline', 'manual'],
    ])
    expect(revisions[0]).toEqual({
      format: 1, revision: 1, previous: null, from: 'baseline', version: A, type: 'adopt',
      trigger: 'gate', decisionId: first.decisionId, committedAt: '2026-10-12T03:00:00.000Z',
    })
    expect(revisions[1]!.previous).toBe(sha256(await readFile(join(dir, '1.json'), 'utf8')))
    expect((await readdir(dir)).sort()).toEqual(['1.json', '2.json', '3.json', '4.json'])
  })

  it('rejects a stale observation instead of overwriting (compare-and-publish)', async () => {
    const dir = await tempDir()
    const one = await commitActivation(dir, BASELINE_ACTIVATION, adopt(A))
    expect(await commitActivation(dir, BASELINE_ACTIVATION, adopt(B))).toBeNull()
    expect(await readActivation(dir)).toEqual(one)
  })

  it('lets exactly one of many concurrent writers publish the same revision', async () => {
    const dir = await tempDir()
    const versions = [A, B, C, 'd'.repeat(64), 'e'.repeat(64)]
    const results = await Promise.all(versions.map(version => commitActivation(dir, BASELINE_ACTIVATION, adopt(version))))
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(await readActivation(dir)).toEqual(winners[0])
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses invalid changes', async () => {
    const dir = await tempDir()
    await rejects(commitActivation(dir, BASELINE_ACTIVATION, rollback()), 'config/invalid', /nothing to roll back/)
    await rejects(commitActivation(dir, BASELINE_ACTIVATION, adopt('baseline')), 'config/invalid', /not a bundle version/)
    const one = await commitActivation(dir, BASELINE_ACTIVATION, adopt(A))
    await rejects(commitActivation(dir, one!, adopt(A)), 'config/invalid', /already the adopted/)
    await rejects(commitActivation(dir, one!, { ...adopt(B), decisionId: 'not-a-uuid' }), 'config/invalid', /invalid revision/)
  })

  describe('stops at the last valid revision and reports the problem', () => {
    async function chain(): Promise<string> {
      const dir = await tempDir()
      const one = await commitActivation(dir, BASELINE_ACTIVATION, adopt(A))
      await commitActivation(dir, one!, adopt(B))
      return dir
    }

    it('a gap', async () => {
      const dir = await chain()
      await writeFile(join(dir, '3.json'), await readFile(join(dir, '2.json')))
      await unlink(join(dir, '2.json'))
      const read = await readActivationChain(dir)
      expect(read.activation.version).toBe(A)
      expect(read.problem).toEqual({ file: '3.json', message: 'revisions are not consecutive' })
    })

    it('an edited earlier revision breaks the digest link', async () => {
      const dir = await chain()
      const raw = JSON.parse(await readFile(join(dir, '1.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(dir, '1.json'), `${JSON.stringify({ ...raw, trigger: 'manual' })}\n`)
      const read = await readActivationChain(dir)
      expect(read.activation.version).toBe(A)
      expect(read.problem?.file).toBe('2.json')
    })

    it('a rollback to a version that was not in force', async () => {
      const dir = await tempDir()
      const one = await commitActivation(dir, BASELINE_ACTIVATION, adopt(A))
      const two = await commitActivation(dir, one!, adopt(B))
      const forged = { format: 1, revision: 3, previous: two!.digest, from: B, version: C, type: 'rollback', trigger: 'manual', decisionId: randomUUID(), committedAt: new Date().toISOString() }
      await writeFile(join(dir, '3.json'), `${JSON.stringify(forged)}\n`)
      const read = await readActivationChain(dir)
      expect(read.activation.version).toBe(B)
      expect(read.problem?.message).toMatch(/previous version/)
    })

    it('garbage, and no revision can be added afterwards', async () => {
      const dir = await chain()
      await writeFile(join(dir, '3.json'), 'nope')
      const read = await readActivationChain(dir)
      expect(read.activation.revision).toBe(2)
      expect(read.problem).toEqual({ file: '3.json', message: 'not JSON' })
      await rejects(commitActivation(dir, read.activation, rollback()), 'session/corrupt', /damaged at 3\.json/)
    })
  })

  it('ignores temporary files and non-revision names', async () => {
    const dir = await tempDir()
    await commitActivation(dir, BASELINE_ACTIVATION, adopt(A))
    await writeFile(join(dir, '.leftover.tmp'), 'x')
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, '01.json'), 'x')
    expect(await readActivationChain(dir)).toMatchObject({ activation: { version: A } })
    expect((await readActivationChain(dir)).problem).toBeUndefined()
  })
})
