import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { ZERO_USAGE, type SessionState, type TurnContextInput } from '@nexgent/kernel'

const dirs: string[] = []

/** A fresh temporary directory, removed after the test. */
export async function tempDir(prefix = 'nexgent-context-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
})

export const SESSION_ID = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

/** A turn-start input for a provider. */
export function turnInput(projectRoot: string, overrides: Partial<TurnContextInput> = {}): TurnContextInput {
  const state: SessionState = { sessionId: SESSION_ID, version: 1, messages: [], metadata: emptyMetadata() }
  return {
    sessionId: SESSION_ID,
    turn: 1,
    projectRoot,
    text: 'hello',
    source: 'user',
    materialIds: [],
    state,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function emptyMetadata(): SessionState['metadata'] {
  return {
    createdAt: '2026-10-11T00:00:00.000Z',
    projectRoot: '/',
    model: 'claude-sonnet-5-5',
    sandboxMode: 'workspace-write',
    grants: [],
    lastTurn: 0,
    totalUsage: ZERO_USAGE,
    lastSeq: 1,
  }
}
