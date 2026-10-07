import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { commitActivation, finishSelection, readActivation, reserveSelection } from '../src/architecture-activation.ts'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), linkSync: vi.fn(actual.linkSync) }
})
afterEach(() => vi.restoreAllMocks())
const baseline = 'a'.repeat(64)
const candidate = 'b'.repeat(64)
const compiledDigest = 'e'.repeat(64)
function directory() {
  const root = fs.mkdtempSync(join(tmpdir(), 'nexgent-activation-test-'))
  onTestFinished(() => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('nexgent-activation-test-')) throw new Error('unexpected test cleanup target')
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

describe('immutable native architecture activation', () => {
  it('publishes complete linked revisions, keeps prior revisions, and refuses a stale operation', () => {
    const root = directory()
    const initial = readActivation(root, baseline)
    const adopted = commitActivation(root, baseline, initial, candidate, 'adopt', { selectionTrial: 'selection', guardTrial: 'guard' }, compiledDigest)
    expect(adopted).toMatchObject({ revision: 1, version: candidate })
    expect(readActivation(root, baseline)).toEqual(adopted)
    expect(commitActivation(root, baseline, initial, 'c'.repeat(64), 'adopt', {}, compiledDigest)).toBeNull()
    if (adopted === null) throw new Error('activation missing')
    const rolledBack = commitActivation(root, baseline, adopted, baseline, 'rollback', { runId: 'failed-run' }, compiledDigest)
    expect(readActivation(root, baseline)).toEqual(rolledBack)
    expect(fs.readdirSync(root).sort()).toEqual(['1.json', '2.json'])
  })

  it('refuses malformed or divergent durable revisions instead of silently selecting baseline', () => {
    const valid = { format: 1, revision: 1, previous: null, from: baseline, version: candidate, type: 'adopt', compiledDigest }
    const invalid: unknown[] = [null, [], {}, { ...valid, format: 2 }, { ...valid, revision: 3 }, { ...valid, previous: 'wrong' },
      { ...valid, from: candidate }, { ...valid, version: null }, { ...valid, version: 'bad' }, { ...valid, type: 'guess' }]
    for (const value of invalid) {
      const root = directory()
      fs.writeFileSync(join(root, '1.json'), JSON.stringify(value))
      expect(() => readActivation(root, baseline)).toThrow('invalid architecture activation chain')
    }
    const root = directory()
    fs.writeFileSync(join(root, '01.json'), JSON.stringify(valid))
    expect(() => readActivation(root, baseline)).toThrow('invalid')
    for (const compilation of [{ ...valid, compiledDigest: undefined }, { ...valid, compiledDigest: null }, { ...valid, compiledDigest: 'bad' }]) {
      const target = directory()
      fs.writeFileSync(join(target, '1.json'), JSON.stringify(compilation))
      expect(() => readActivation(target, baseline)).toThrow('compilation')
    }
  })

  it('contains a publication race without replacing the winner', () => {
    const root = directory()
    const initial = readActivation(root, baseline)
    vi.mocked(fs.linkSync).mockImplementationOnce((source, destination) => {
      fs.copyFileSync(source, destination)
      throw Object.assign(new Error('concurrent writer won'), { code: 'EEXIST' })
    })
    expect(commitActivation(root, baseline, initial, candidate, 'adopt', {}, compiledDigest)).toBeNull()
    expect(readActivation(root, baseline)).toMatchObject({ revision: 1, version: candidate })
    expect(fs.readdirSync(root)).toEqual(['1.json'])
  })

  it('fails before publication on sync errors and cleans unpublished temporary files', () => {
    const root = directory()
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('sync unavailable') })
    expect(() => commitActivation(root, baseline, readActivation(root, baseline), candidate, 'adopt', {}, compiledDigest)).toThrow('sync unavailable')
    expect(readActivation(root, baseline)).toMatchObject({ revision: 0 })
    expect(fs.readdirSync(root)).toEqual([])
    vi.mocked(fs.linkSync).mockImplementationOnce(() => { throw 'non-error publication failure' })
    expect(() => commitActivation(root, baseline, readActivation(root, baseline), candidate, 'adopt', {}, compiledDigest)).toThrow()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('consumes slots once, counts interrupted reservations, and rejects replay and exhausted budgets', () => {
    const root = directory()
    const attempts = reserveSelection(root, candidate, 2)
    expect(() => reserveSelection(root, candidate, 2)).toThrow('already attempted')
    reserveSelection(root, 'c'.repeat(64), 2)
    expect(() => reserveSelection(root, 'd'.repeat(64), 2)).toThrow('budget exhausted')
    finishSelection(attempts, candidate, { adopted: false, status: 'unknown' })
    expect(() =>{  finishSelection(attempts, candidate, { adopted: true }) }).toThrow('already settled')
    expect(JSON.parse(fs.readFileSync(join(attempts, `${candidate}.result.json`), 'utf8'))).toEqual({ adopted: false, status: 'unknown' })
    expect(fs.readdirSync(join(attempts, 'slots')).sort()).toEqual(['1.json', '2.json'])
  })
})
