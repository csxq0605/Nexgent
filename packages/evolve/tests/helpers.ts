import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { resolveWorkspaceLayout, type WorkspaceLayout } from '@nexgent/kernel'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

// ADR 0012: the user's improvers, meta queue and config live in the Nexgent home; every test gets its own.
beforeEach(async () => {
  process.env.NEXGENT_HOME = await tempDir()
})

/** The test's Nexgent home. */
export function home(): string {
  return process.env.NEXGENT_HOME!
}

/** A fresh directory removed after the test. */
export async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexgent-evolve-'))
  created.push(path)
  return path
}

/** A project with `.nexgent/config.json` (autoImprove and `improvement` as given). */
export async function project(autoImprove: boolean | undefined = true, improvement?: Record<string, unknown>): Promise<WorkspaceLayout> {
  const layout = resolveWorkspaceLayout(await tempDir())
  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(layout.configFile, `${JSON.stringify({ version: 1, ...(autoImprove === undefined ? {} : { autoImprove }), ...(improvement === undefined ? {} : { improvement }) })}\n`)
  return layout
}
