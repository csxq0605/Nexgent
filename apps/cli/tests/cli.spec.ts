import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../bin/nexgent.mjs', import.meta.url))
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  version: string
}

describe('nexgent bin (requires `pnpm build`)', () => {
  it('prints the package version for --version', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    expect(out.trim()).toBe(pkg.version)
  })

  it('reports app as a step-2 placeholder with exit 2', () => {
    const result = spawnSync(process.execPath, [bin, 'app', '--project', '.'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('step 2')
  })

  it('reports usage errors with exit 2 and no stack', () => {
    const result = spawnSync(process.execPath, [bin, 'frobnicate'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr.trim()).toBe('nexgent: unknown command "frobnicate" (see `nexgent --help`)')
  })
})

describe('no Python execution path', () => {
  it('apps/cli and the acceptance scripts never name a Python interpreter or .py file', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const roots = ['../src', '../bin', '../../../scripts'].map(p => fileURLToPath(new URL(p, import.meta.url)))
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (/['"`](python[0-9.]*|py)(\.exe)?['"`]|\.py['"`\s]/i.test(await readFile(full, 'utf8'))) offenders.push(full)
      }
    }
    for (const root of roots) await walk(root)
    expect(offenders).toEqual([])
  })
})
