import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { project, SESSION_A, sha256Of } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const BIG_BYTES = 48 * 1024 * 1024

function runChild(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal, stdout }))
  })
}

describe('hard kill', () => {
  it('materials, deliverables, feedback and goal survive a kill mid-turn; the half-written snapshot is never listed', async () => {
    const p = await project()
    const source = nodePath.join(p.outside, 'orders.csv')
    await writeFile(source, 'order,region,amount\n1,north,"1,200"\n')
    await writeFile(p.abs('raw.bin'), Buffer.alloc(BIG_BYTES, 7))

    const result = await runChild([p.root, SESSION_A, source, 'raw.bin'])
    expect(result.stdout).toMatch(/^killing /)
    expect(result.code === 0).toBe(false)

    // A restarted process builds fresh services over the same files.
    const tasking = p.reopen()
    const materials = await tasking.materials.list()
    expect(materials).toHaveLength(1)
    expect(materials[0]).toMatchObject({ originalName: 'orders.csv', sessionId: SESSION_A, status: 'active' })
    expect(sha256Of(tasking.materials.absolutePath(materials[0]!))).toBe(sha256Of(source))

    const [deliverable, ...others] = await tasking.deliverables.list()
    expect(others).toEqual([])
    const versions = deliverable!.versions.map(version => version.version)
    expect(versions.slice(0, 2)).toEqual([1, 2])
    // v3 exists only if the copy finished before the kill; then it is complete.
    if (versions.length === 3) expect(deliverable!.versions[2]!.files.map(file => file.size)).toEqual([expect.any(Number), BIG_BYTES])
    else expect(versions).toHaveLength(2)
    const diff = await tasking.deliverables.diff(deliverable!.deliverableId, 1, 2)
    expect(diff.files[0]!.hunks?.[0]?.lines).toContainEqual({ op: 'add', text: '华北,100' })

    const feedback = await tasking.feedback.list({ sessionId: SESSION_A })
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toMatchObject({ deliverableId: deliverable!.deliverableId, version: 1, rating: 3, turn: 2 })

    expect(await tasking.goals.get(SESSION_A)).toMatchObject({ text: 'Summarize sales by region', status: 'active' })

    const { records } = await p.sessions.readAll(SESSION_A)
    expect(records.filter(record => record.type === 'deliverable.presented')).toHaveLength(2)
    expect(records.filter(record => record.type === 'turn.files').map(record => record.type === 'turn.files' && record.changes)).toEqual([
      [{ path: 'summary.csv', change: 'added' }],
      [{ path: 'summary.csv', change: 'modified' }],
    ])
    expect((await p.sessions.resume(SESSION_A)).metadata.openTurn).toBe(3)

    // Leftovers of the interrupted copy go away on startup cleanup.
    const dir = nodePath.join(p.workspace.layout.outputs, deliverable!.deliverableId)
    const leftover = (await readdir(dir)).filter(entry => entry.startsWith('.tmp-'))
    expect(await tasking.cleanup()).toBe(leftover.length)
    expect((await readdir(dir)).filter(entry => entry.startsWith('.tmp-'))).toEqual([])
    expect(existsSync(nodePath.join(dir, 'v1', 'deliverable.json'))).toBe(true)
  }, 120_000)
})
