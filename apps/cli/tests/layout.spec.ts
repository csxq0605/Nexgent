import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG, NEXGENT_SUBDIRS } from '@nexgent/kernel'
import { CliError, EXIT, initProjectLayout } from '../src/index.js'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-layout-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('initProjectLayout', () => {
  it('creates .nexgent, every subdir and a default config', async () => {
    const result = await initProjectLayout(tmp)
    expect(result.createdConfig).toBe(true)
    expect(result.layout.root).toBe(path.resolve(tmp))
    for (const name of NEXGENT_SUBDIRS) {
      expect((await fs.stat(path.join(tmp, '.nexgent', name))).isDirectory()).toBe(true)
    }
    const config = JSON.parse(await fs.readFile(path.join(tmp, '.nexgent', 'config.json'), 'utf8')) as unknown
    expect(config).toEqual(JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG)))
  })

  it('resolves a relative project against the cwd', async () => {
    await fs.mkdir(path.join(tmp, 'proj'))
    const { layout } = await initProjectLayout('proj', tmp)
    expect(layout.dataDir).toBe(path.join(tmp, 'proj', '.nexgent'))
  })

  it('is idempotent and never overwrites an existing config', async () => {
    await fs.mkdir(path.join(tmp, '.nexgent'))
    await fs.writeFile(path.join(tmp, '.nexgent', 'config.json'), '{"model":"mine"}\n')
    const first = await initProjectLayout(tmp)
    const second = await initProjectLayout(tmp)
    expect(first.createdConfig).toBe(false)
    expect(second.createdConfig).toBe(false)
    expect(await fs.readFile(path.join(tmp, '.nexgent', 'config.json'), 'utf8')).toBe('{"model":"mine"}\n')
  })

  it('fails with the environment exit code for a missing or non-directory project', async () => {
    await expect(initProjectLayout(path.join(tmp, 'nope'))).rejects.toMatchObject({ exitCode: EXIT.ENVIRONMENT })
    await fs.writeFile(path.join(tmp, 'file'), '')
    const error = await initProjectLayout(path.join(tmp, 'file')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain('not a directory')
  })
})
