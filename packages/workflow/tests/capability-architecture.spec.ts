import { describe, expect, it } from 'vitest'
import { validateCapabilityArchitecture } from '../src/index.js'

const input = (value: unknown) => ({
  component: { kind: 'architecture', name: 'review-pipeline' },
  files: new Map([['architecture.json', new Uint8Array(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))]]),
  directory: '/d',
})

describe('architecture component check (step 4)', () => {
  it('accepts a format-1 graph the compiler takes and refuses anything else', () => {
    const graph = { nodes: [{ id: 'draft', prompt: 'Write it.', dependencies: [] }, { id: 'check', prompt: 'Check it.', dependencies: ['draft'] }] }
    expect(() => validateCapabilityArchitecture(input({ format: 1, architecture: graph }))).not.toThrow()
    expect(() => validateCapabilityArchitecture(input('{'))).toThrow(/not valid JSON/)
    expect(() => validateCapabilityArchitecture(input({ format: 2, architecture: graph }))).toThrow(/format/)
    expect(() => validateCapabilityArchitecture(input({ format: 1, architecture: { nodes: [{ id: 'a', prompt: 'x', dependencies: ['missing'] }] } }))).toThrow()
    expect(() => validateCapabilityArchitecture({ ...input({}), files: new Map() })).toThrow(/missing architecture.json/)
  })
})
