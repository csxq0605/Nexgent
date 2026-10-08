import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive, killAllSpawned, spawnNode, TimeoutError, waitFor, waitForFile } from '../src/index.js'

const child = fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url))
const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexgent-ts-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await killAllSpawned()
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('spawnNode', () => {
  it('captures stdout, passes env and stdin, resolves exit', async () => {
    const handle = spawnNode([child, 'echo', 'A1'], { env: { TS_FIXTURE: 'yes' }, stdin: 'piped' })
    const { match } = await handle.waitForOutput(/stdin=(\w+)/, 10_000, 'stdout')
    expect(match?.[1]).toBe('piped')
    const exit = await handle.exit
    expect(exit.code).toBe(0)
    expect(exit.stdout).toBe('argv=A1 env=yes stdin=piped\n')
    expect(handle.exited).toBe(true)
  })

  it('reports non-zero exit and stderr; waitForOutput rejects when the child exits first', async () => {
    const handle = spawnNode([child, 'exit', '3'])
    await expect(handle.waitForOutput(/never/)).rejects.toThrow(/exited before output matched/)
    const exit = await handle.exit
    expect(exit.code).toBe(3)
    expect(exit.stderr).toContain('bye')
  })

  it('waitForOutput accepts a predicate and times out with TimeoutError', async () => {
    const dir = await tempDir()
    const handle = spawnNode([child, 'hang', dir])
    await handle.waitForOutput((text) => text.includes('ready'))
    await expect(handle.waitForOutput(/nope/, 50)).rejects.toBeInstanceOf(TimeoutError)
  })

  it('waitForFile resolves with the file content', async () => {
    const dir = await tempDir()
    const target = join(dir, 'out.txt')
    const handle = spawnNode([child, 'file', target])
    expect(await handle.waitForFile(target, 10_000, (c) => c.includes('done'))).toBe('done\n')
    await expect(waitForFile(join(dir, 'missing'), { timeoutMs: 50 })).rejects.toBeInstanceOf(TimeoutError)
  })

  it('kill() terminates the whole process tree', async () => {
    const dir = await tempDir()
    const handle = spawnNode([child, 'hang', dir])
    await handle.waitForOutput(/ready/)
    const pids = JSON.parse(await readFile(join(dir, 'pids.json'), 'utf8')) as { child: number; grandchild: number }
    expect(isProcessAlive(pids.grandchild)).toBe(true)
    const exit = await handle.kill()
    expect(exit.code === null || exit.code !== 0).toBe(true)
    await waitFor(() => !isProcessAlive(pids.grandchild), { timeoutMs: 5000, label: 'grandchild gone' })
    expect(isProcessAlive(pids.child)).toBe(false)
  })
})
