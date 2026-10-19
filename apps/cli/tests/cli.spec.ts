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

  it('reports usage errors with exit 2 and no stack', () => {
    const result = spawnSync(process.execPath, [bin, 'frobnicate'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr.trim()).toBe('nexgent: unknown command "frobnicate" (see `nexgent --help`)')
  })
})
