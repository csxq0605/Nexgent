import { describe, expect, it } from 'vitest'
import { buildScript, parseJsonLines, WRITE_TOOL } from '../../../scripts/accept-common/scenario.mjs'

describe('ps1-smoke scenario helpers', () => {
  it('scripts five model requests: tool call, answer, stall, tool call, answer', () => {
    const entries = buildScript()
    expect(entries).toHaveLength(5)
    expect((entries[0]?.toolCalls as Array<{ name: string }>)[0]?.name).toBe(WRITE_TOOL)
    expect(entries[2]?.fault).toEqual({ kind: 'timeout', afterChunks: 3 })
  })

  it('parses JSON lines leniently', () => {
    const events = parseJsonLines('noise\r\n{"type":"session","sessionId":"s1"}\n\n{"type":"final"}\n')
    expect(events.map(e => e.type)).toEqual(['session', 'final'])
  })
})
