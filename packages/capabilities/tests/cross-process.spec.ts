/**
 * Two (or more) OS processes racing on the same project. Runs on every
 * platform; the Windows manual workflow covers `link` and directory rename
 * semantics there.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CapabilityStore, loadBundle } from '../src/index.js'
import { tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/race-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

interface Child {
  readonly done: Promise<string>
}

function startChild(args: string[]): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { err += String(chunk) })
  return {
    done: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`))))
    }),
  }
}

async function race(mode: 'commit' | 'write', count: number, capabilitiesDir: string, versionOf: (index: number) => string): Promise<Record<string, unknown>[]> {
  const barrier = join(await tempDir(), 'barrier')
  await mkdir(barrier)
  const children = Array.from({ length: count }, (_, index) => startChild([mode, capabilitiesDir, barrier, String(index), versionOf(index)]))
  for (;;) {
    if ((await readdir(barrier)).filter(name => name.startsWith('ready-')).length === count) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await writeFile(join(barrier, 'go'), '')
  return (await Promise.all(children.map(child => child.done))).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('cross-process', () => {
  it('only one of several processes publishes the same activation revision', async () => {
    const capabilities = new CapabilityStore(join(await tempDir(), 'capabilities'))
    const results = await race('commit', 4, capabilities.directory, index => String(index + 1).repeat(64))
    expect(results.filter(result => result.committed === true)).toHaveLength(1)
    const winner = results.find(result => result.committed === true)!
    const revisions = await capabilities.history()
    const activation = await capabilities.activation()
    expect(revisions).toHaveLength(1)
    expect(activation.revision).toBe(1)
    expect(revisions[0]!.evidence).toEqual({ child: winner.id })
    expect((await readdir(capabilities.activationDirectory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  }, 60_000)

  it('processes storing the same bundle at once share one verified directory', async () => {
    const capabilities = new CapabilityStore(join(await tempDir(), 'capabilities'))
    const results = await race('write', 3, capabilities.directory, () => '')
    const versions = new Set(results.map(result => result.version))
    expect(versions.size).toBe(1)
    const [version] = versions as Set<string>
    expect(await readdir(capabilities.directory)).toEqual([version])
    await expect(loadBundle(capabilities.directory, version!)).resolves.toMatchObject({ version })
  }, 60_000)
})
