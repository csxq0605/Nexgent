import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { SandboxMode, ToolContext } from '@nexgent/kernel'
import { afterEach } from 'vitest'
import { createSandbox, openWorkspace, type LocalSandbox, type LocalWorkspace } from '../src/index.js'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length > 0) await rm(cleanups.pop()!, { recursive: true, force: true })
})

/** A fresh temp directory removed after the test. Never named `nexgent-*`. */
export async function tempDir(prefix = 'nxws-'): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/** A project directory with `.nexgent/` created, plus an outside sibling. */
export async function project(mode: SandboxMode = 'workspace-write'): Promise<{
  workspace: LocalWorkspace
  sandbox: LocalSandbox
  outside: string
}> {
  const base = await tempDir()
  const workspace = await openWorkspace(nodePath.join(base, 'proj'), { create: true, ensureLayout: true })
  const outside = nodePath.join(base, 'outside')
  await mkdir(outside, { recursive: true })
  const sandbox = await createSandbox({ root: workspace.root, mode })
  return { workspace, sandbox, outside }
}

/** A minimal tool context. */
export function toolContext(workspace: LocalWorkspace, sandboxMode: SandboxMode = 'workspace-write', extra: Partial<ToolContext> & { approved?: boolean } = {}): ToolContext {
  return {
    sessionId: 'test-session',
    callId: 'call-1',
    turn: 1,
    workspace,
    sandboxMode,
    signal: new AbortController().signal,
    ...extra,
  }
}

/** Whether a pid is alive (zombies count as dead). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      return state !== 'Z' && state !== 'X'
    } catch {
      return false
    }
  }
  return true
}
