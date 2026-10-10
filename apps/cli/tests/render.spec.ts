import { describe, expect, it } from 'vitest'
import { boundJsonLine, createRenderer, formatUsage, preview } from '../src/index.js'
import { Capture, sessionEvent, SID, USAGE, UNKNOWN_USAGE, writeFileTurn } from './helpers.js'


function renderAll(mode: 'text' | 'json', events = [sessionEvent(), ...writeFileTurn()]) {
  const stdout = new Capture()
  const stderr = new Capture()
  const renderer = createRenderer(mode, stdout, stderr)
  for (const event of events) renderer.render(event)
  renderer.finish({ sessionId: SID, status: 'completed', exitCode: 0, totalUsage: USAGE, requestCount: 2, toolCallCount: 1, finalText: 'Created hello.txt.' })
  return { stdout: stdout.text, stderr: stderr.text }
}

describe('text renderer', () => {
  it('streams assistant text to stdout and progress to stderr', () => {
    const { stdout, stderr } = renderAll('text')
    expect(stdout).toBe('Created hello.txt.\n')
    expect(stderr).toBe([
      `nexgent: new session ${SID} (model mimo-v2.6-pro, sandbox workspace-write)`,
      '> write_file {"path":"hello.txt","content":"Hello"}',
      '  ok 4 ms: wrote 5 bytes to hello.txt',
      `nexgent: completed; session ${SID}; requests 2; tool calls 1; tokens in 812 / out 37`,
      '',
    ].join('\n'))
  })

  it('reports cancellation, failure, approvals, reasoning and a resume hint', () => {
    const stdout = new Capture()
    const stderr = new Capture()
    const r = createRenderer('text', stdout, stderr)
    r.render(sessionEvent({ resumed: true, sandboxMode: 'full-access' }))
    r.render({ type: 'reasoning.delta', text: 'hmm' })
    r.render({ type: 'text.delta', text: 'Partial' })
    r.render({ type: 'approval.decision', decision: { id: 'a1', decision: 'deny', scope: 'once', decidedBy: 'timeout' } })
    r.render({ type: 'approval.decision', decision: { id: 'a2', decision: 'allow', scope: 'session', decidedBy: 'user' } })
    r.render({ type: 'turn.end', turn: 2, reason: { kind: 'cancelled', cause: 'user' } })
    r.render({ type: 'turn.end', turn: 3, reason: { kind: 'error', error: { name: 'NexgentError', code: 'llm/timeout', message: 'idle' } } })
    r.render({ type: 'run.error', error: { name: 'NexgentError', code: 'ledger/write-failed', message: 'disk full' }, fatal: false })
    r.finish({ sessionId: SID, status: 'cancelled', exitCode: 130, totalUsage: UNKNOWN_USAGE, requestCount: 1, toolCallCount: 0, finalText: 'Partial' })
    expect(stdout.text).toBe('Partial\n')
    expect(stderr.text).toBe([
      `nexgent: resumed session ${SID} (model mimo-v2.6-pro, sandbox full-access)`,
      'nexgent: warning: full-access sandbox: tools may read, write and run anything you can',
      'thinking: hmm',
      '  approval: denied (timeout)',
      '  approval: allowed (session)',
      'nexgent: turn 2 cancelled (user)',
      'nexgent: turn 3 failed: llm/timeout: idle',
      'nexgent: error: ledger/write-failed: disk full',
      `nexgent: cancelled; session ${SID}; requests 1; tool calls 0; tokens in ? / out ?`,
      `nexgent: continue with: nexgent resume ${SID} --project "/proj"`,
      '',
    ].join('\n'))
  })

  it('previews long or multi-line text on one line', () => {
    expect(preview('a\n  b\tc')).toBe('a b c')
    expect(preview('x'.repeat(200), 10)).toBe('xxxxxxx...')
    expect(formatUsage(UNKNOWN_USAGE)).toBe('tokens in ? / out ?')
  })
})

describe('json renderer', () => {
  it('writes one JSON object per event and a final line', () => {
    const { stdout, stderr } = renderAll('json')
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(lines.map(line => line.type)).toEqual([
      'session', 'turn.start', 'step.start', 'tool-call.start', 'tool-call.delta', 'tool-call.end', 'usage',
      'tool.start', 'tool.end', 'step.start', 'text.delta', 'text.delta', 'turn.end', 'final',
    ])
    expect(lines.at(-1)).toEqual({
      type: 'final', sessionId: SID, status: 'completed', exitCode: 0, text: 'Created hello.txt.',
      totalUsage: USAGE, requestCount: 2, toolCallCount: 1,
    })
    expect(stderr).toBe('')
  })

  it('bounds long strings and lines', () => {
    const line = JSON.parse(boundJsonLine({ type: 'tool.end', content: 'é'.repeat(10_000) }, 16)) as { content: string; truncated: boolean }
    expect(line.content).toBe('é'.repeat(8))
    expect(line.truncated).toBe(true)
    const big = { type: 'x', name: 'keep', nested: Array.from({ length: 100 }, () => 'y'.repeat(100)) }
    expect(JSON.parse(boundJsonLine(big, 8192, 512))).toEqual({ type: 'x', name: 'keep', truncated: true })
  })

  it('writes an error line for failures outside the stream', () => {
    const stdout = new Capture()
    createRenderer('json', stdout, new Capture()).fail({ code: 'cli/runtime-not-wired', message: 'later' })
    expect(JSON.parse(stdout.text)).toEqual({ type: 'error', error: { code: 'cli/runtime-not-wired', message: 'later' } })
  })
})
