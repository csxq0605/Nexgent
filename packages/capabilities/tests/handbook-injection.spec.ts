/** K1: the capability provider takes handbook entries from a retriever (V1) once one is given. */
import type { HandbookEntry, HandbookRetriever, SessionState, TurnContextInput } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import { capabilitiesProvider } from '../src/provider.js'
import type { CapabilityService } from '../src/service.js'

const policy = { kind: 'context-policy', name: 'p', entryPath: '/none', spec: { kind: 'context-policy', spec: { instructions: 'Run the tests before finishing.' } } }
const service = { attach: async () => undefined, components: async () => [policy] } as unknown as CapabilityService

function input(turn: number): TurnContextInput {
  return { sessionId: 's1', turn, projectRoot: '/p', text: 'fix the parser', source: 'user', materialIds: [], state: {} as SessionState, signal: new AbortController().signal }
}

const entry = { id: '0b5c2a52-0f7e-4a51-9a51-4a1f5e1b2c3d', text: 'Read the failing test first.' } as HandbookEntry

describe('handbook injection', () => {
  it('keeps the old learned-practices section without a retriever', async () => {
    const contribution = await capabilitiesProvider(service).beginTurn(input(1))
    expect(contribution.systemSections?.map(section => section.title)).toEqual(['Learned practices'])
    expect(contribution.inject).toBeUndefined()
  })

  it('injects retrieved entries before the first user message, not in the system prompt', async () => {
    const queries: string[] = []
    const retriever: HandbookRetriever = { retrieve: async query => { queries.push(query.text); return [{ entry, score: 1 }] } }
    const provider = capabilitiesProvider(service, undefined, () => retriever)
    const first = await provider.beginTurn(input(1))
    expect(first.systemSections).toBeUndefined()
    expect(first.inject).toHaveLength(1)
    expect(first.inject?.[0]).toContain(`[${entry.id}] ${entry.text}`)
    expect(queries).toEqual(['fix the parser'])
    expect(await provider.beginTurn(input(2))).toEqual({})
  })
})
