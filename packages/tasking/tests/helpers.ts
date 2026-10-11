import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { SandboxMode, SessionRecordInput, ToolContext } from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { openWorkspace, type LocalWorkspace } from '@nexgent/workspace'
import { afterEach } from 'vitest'
import { createTaskingService, type LocalTaskingService } from '../src/index.js'

const cleanups: string[] = []
const stores: JsonlSessionStore[] = []

afterEach(async () => {
  while (stores.length > 0) await stores.pop()!.close()
  while (cleanups.length > 0) await rm(cleanups.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

/** A fresh temp directory removed after the test (realpath, so Windows short names are expanded). */
export async function tempDir(prefix = 'nxtask-'): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

/** A project with `.nexgent/` laid out, an outside sibling directory, a session store and the tasking service. */
export interface TestProject {
  readonly base: string
  readonly workspace: LocalWorkspace
  readonly root: string
  readonly outside: string
  readonly sessions: JsonlSessionStore
  readonly tasking: LocalTaskingService
  /** Write a project file (portable path), creating parent directories. */
  write(path: string, content: string | Uint8Array): Promise<string>
  /** Absolute path of a project file. */
  abs(path: string): string
  /** A fresh service over the same project, as a restarted process would build it. */
  reopen(): LocalTaskingService
}

export async function project(): Promise<TestProject> {
  const base = await tempDir()
  const workspace = await openWorkspace(nodePath.join(base, 'proj'), { create: true, ensureLayout: true })
  const outside = nodePath.join(base, 'outside')
  await mkdir(outside, { recursive: true })
  const sessions = newStore(workspace.layout.sessions)
  const abs = (path: string) => nodePath.join(workspace.root, ...path.split('/'))
  return {
    base,
    workspace,
    root: workspace.root,
    outside,
    sessions,
    tasking: createTaskingService(workspace.layout, sessions),
    abs,
    async write(path, content) {
      const target = abs(path)
      await mkdir(nodePath.dirname(target), { recursive: true })
      await writeFile(target, content)
      return target
    },
    reopen: () => createTaskingService(workspace.layout, newStore(workspace.layout.sessions)),
  }
}

/** A session store closed after the test. */
export function newStore(sessionsDir: string): JsonlSessionStore {
  const store = new JsonlSessionStore({ sessionsDir, fsync: 'boundaries' })
  stores.push(store)
  return store
}

/** Lowercase hex SHA-256 of a file. */
export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A tool context for direct handler calls. */
export function toolContext(root: LocalWorkspace, extra: Partial<ToolContext> & { step?: number } = {}, sandboxMode: SandboxMode = 'workspace-write'): ToolContext & { step?: number } {
  return {
    sessionId: 'test-session',
    callId: 'call_1',
    turn: 1,
    workspace: root,
    sandboxMode,
    signal: new AbortController().signal,
    approved: false,
    requestApproval: async () => false,
    ...extra,
  }
}

/** Create a session and return an appender bound to it (the host sink of the tests). */
export async function openSession(sessions: JsonlSessionStore, root: string, sessionId: string): Promise<(record: SessionRecordInput) => ReturnType<JsonlSessionStore['append']>> {
  await sessions.create({ sessionId, projectRoot: root, model: 'scripted-model', sandboxMode: 'workspace-write' })
  return record => sessions.append(sessionId, record)
}

export const SESSION_A = '11111111-1111-4111-8111-111111111111'
export const SESSION_B = '22222222-2222-4222-8222-222222222222'
