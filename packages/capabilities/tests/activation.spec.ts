import { readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_ACTIVATION,
  CapabilityActivationError,
  commitActivation,
  readActivation,
  readActivationChain,
  sha256,
} from '../src/index.js'
import { tempDir } from './helpers.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const clock = () => new Date('2026-10-12T03:00:00.000Z')

describe('activation chain', () => {
  it('starts at the baseline when nothing is committed', async () => {
    const dir = join(await tempDir(), 'activation')
    expect(await readActivation(dir)).toEqual(BASELINE_ACTIVATION)
  })

  it('appends adopt and rollback revisions linked by digest', async () => {
    const dir = await tempDir()
    const one = await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, { candidate: 'c1' }, clock)
    expect(one).toMatchObject({ revision: 1, version: A, stack: ['baseline', A] })
    const two = await commitActivation(dir, one!, { type: 'adopt', version: B }, { candidate: 'c2' }, clock)
    const three = await commitActivation(dir, two!, { type: 'rollback' }, { trigger: 'usage-regression' }, clock)
    expect(three).toMatchObject({ revision: 3, version: A, stack: ['baseline', A] })
    const four = await commitActivation(dir, three!, { type: 'rollback' }, { trigger: 'manual' }, clock)
    expect(four).toMatchObject({ revision: 4, version: 'baseline', stack: ['baseline'] })

    const { revisions, activation } = await readActivationChain(dir)
    expect(activation).toEqual(four)
    expect(revisions.map(revision => [revision.type, revision.from, revision.version])).toEqual([
      ['adopt', 'baseline', A],
      ['adopt', A, B],
      ['rollback', B, A],
      ['rollback', A, 'baseline'],
    ])
    expect(revisions[0]).toEqual({
      format: 1, revision: 1, previous: null, from: 'baseline', version: A, type: 'adopt',
      evidence: { candidate: 'c1' }, committedAt: '2026-10-12T03:00:00.000Z',
    })
    expect(revisions[1]!.previous).toBe(sha256(await readFile(join(dir, '1.json'), 'utf8')))
    expect((await readdir(dir)).sort()).toEqual(['1.json', '2.json', '3.json', '4.json'])
  })

  it('rejects a stale observation instead of overwriting (compare-and-publish)', async () => {
    const dir = await tempDir()
    const one = await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, {})
    expect(await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: B }, {})).toBeNull()
    expect(await readActivation(dir)).toEqual(one)
  })

  it('lets exactly one of many concurrent writers publish the same revision', async () => {
    const dir = await tempDir()
    const versions = [A, B, C, 'd'.repeat(64), 'e'.repeat(64)]
    const results = await Promise.all(versions.map(version => commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version }, {})))
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(await readActivation(dir)).toEqual(winners[0])
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses invalid changes', async () => {
    const dir = await tempDir()
    await expect(commitActivation(dir, BASELINE_ACTIVATION, { type: 'rollback' }, {})).rejects.toThrow(/nothing to roll back/)
    await expect(commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: 'baseline' }, {})).rejects.toThrow(CapabilityActivationError)
    const one = await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, {})
    await expect(commitActivation(dir, one!, { type: 'adopt', version: A }, {})).rejects.toThrow(/already the adopted/)
    await expect(commitActivation(dir, one!, { type: 'adopt', version: B }, { bad: undefined } as never)).rejects.toThrow(/evidence/)
  })

  describe('rejects a corrupt chain rather than falling back', () => {
    async function chain(): Promise<string> {
      const dir = await tempDir()
      const one = await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, {})
      await commitActivation(dir, one!, { type: 'adopt', version: B }, {})
      return dir
    }

    it('a gap', async () => {
      const dir = await chain()
      await writeFile(join(dir, '3.json'), await readFile(join(dir, '2.json')))
      await unlink(join(dir, '2.json'))
      await expect(readActivation(dir)).rejects.toThrow(/not consecutive/)
    })

    it('an edited earlier revision breaks the digest link', async () => {
      const dir = await chain()
      const raw = JSON.parse(await readFile(join(dir, '1.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(dir, '1.json'), `${JSON.stringify({ ...raw, evidence: { forged: true } })}\n`)
      await expect(readActivation(dir)).rejects.toThrow(/previous digest/)
    })

    it('a rollback to a version that was not in force', async () => {
      const dir = await tempDir()
      const one = await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, {})
      const two = await commitActivation(dir, one!, { type: 'adopt', version: B }, {})
      const forged = { format: 1, revision: 3, previous: two!.digest, from: B, version: C, type: 'rollback', evidence: {}, committedAt: new Date().toISOString() }
      await writeFile(join(dir, '3.json'), `${JSON.stringify(forged)}\n`)
      await expect(readActivation(dir)).rejects.toThrow(/previous version/)
    })

    it('garbage', async () => {
      const dir = await chain()
      await writeFile(join(dir, '3.json'), 'nope')
      await expect(readActivation(dir)).rejects.toThrow(CapabilityActivationError)
    })
  })

  it('ignores temporary files and non-revision names', async () => {
    const dir = await tempDir()
    await commitActivation(dir, BASELINE_ACTIVATION, { type: 'adopt', version: A }, {})
    await writeFile(join(dir, '.leftover.tmp'), 'x')
    await writeFile(join(dir, 'notes.txt'), 'x')
    await writeFile(join(dir, '01.json'), 'x')
    expect((await readActivation(dir)).version).toBe(A)
  })
})
