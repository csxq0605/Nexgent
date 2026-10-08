import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import {
  ZERO_USAGE,
  type LLMUsage,
  type SessionInit,
  type SessionRecordInput,
} from '@nexgent/kernel'

const dirs: string[] = []

/** A fresh temporary directory, removed after the test. */
export async function tempDir(prefix = 'nexgent-session-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

export const SESSION_ID = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

export function sessionInit(projectRoot: string, overrides: Partial<SessionInit> = {}): SessionInit {
  return { sessionId: SESSION_ID, projectRoot, model: 'mimo-v2.6-pro', sandboxMode: 'workspace-write', ...overrides }
}

export const KNOWN_USAGE: LLMUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cacheReadTokens: 0,
  reasoningTokens: 0,
}

/** The records of one complete turn with one tool call (6 records). */
export function turnRecords(turn: number, text = `prompt ${turn} — 你好`): SessionRecordInput[] {
  return [
    { type: 'turn.start', turn },
    { type: 'user.message', turn, content: text, source: 'user' },
    {
      type: 'assistant.message',
      turn,
      step: 1,
      requestId: `req-${turn}-1`,
      content: '',
      toolCalls: [{ id: `call_${turn}`, name: 'read_file', arguments: '{"path":"README.md"}' }],
      usage: KNOWN_USAGE,
      finishReason: 'tool-calls',
    },
    {
      type: 'tool.result',
      turn,
      step: 1,
      toolCallId: `call_${turn}`,
      name: 'read_file',
      content: '# Hi',
      isError: false,
      durationMs: 3,
    },
    {
      type: 'assistant.message',
      turn,
      step: 2,
      requestId: `req-${turn}-2`,
      content: `done ${turn} ✓`,
      usage: ZERO_USAGE,
      finishReason: 'stop',
    },
    { type: 'turn.end', turn, reason: { kind: 'completed' } },
  ]
}
