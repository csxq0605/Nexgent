import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

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
