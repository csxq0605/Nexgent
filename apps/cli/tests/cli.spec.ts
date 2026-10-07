import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { main } from '../src/main.js'

const bin = fileURLToPath(new URL('../bin/nexgent.mjs', import.meta.url))
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  version: string
}

describe('nexgent bin', () => {
  it('prints the package version for --version (requires `pnpm build`)', () => {
    const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    expect(out.trim()).toBe(pkg.version)
  })

  it.each(['run', 'resume', 'app'])('reports %s as not implemented', (command) => {
    const result = spawnSync(process.execPath, [bin, command], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr.trim()).toBe(`nexgent ${command}: step 1 not implemented`)
  })
})

describe('main()', () => {
  it('rejects unknown commands with usage', () => {
    const err: string[] = []
    const code = main(['frobnicate'], { stdout: () => {}, stderr: (l) => err.push(l) })
    expect(code).toBe(1)
    expect(err[0]).toContain('unknown command')
  })
})
