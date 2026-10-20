import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { commitActivation } from '../src/activation.js'
import type { CapabilityStore } from '../src/capability-store.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** A fresh directory removed after the test. */
export async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nexgent-capabilities-'))
  created.push(path)
  return path
}

export { sampleComponents } from './sample.js'

/**
 * Make a stored bundle the adopted version, as an older build did (the app
 * adopts nothing any more; a project may still carry such a version).
 */
export async function adopt(store: CapabilityStore, version: string): Promise<void> {
  const committed = await commitActivation(store.activationDirectory, await store.activation(), { type: 'adopt', version, trigger: 'manual', decisionId: randomUUID() })
  if (committed === null) throw new Error('the activation tail moved')
}
