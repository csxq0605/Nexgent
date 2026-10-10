import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCredential } from '@nexgent/kernel'
import { CliError, EXIT, credentialFilePath, describeApiKey, requireApiKey } from '../src/index.js'

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-cred-'))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe('credential presence', () => {
  it('prefers the environment variable', async () => {
    expect(await describeApiKey({ env: { NEXGENT_API_KEY: 'sk-x' }, home })).toEqual({ configured: true, source: 'env' })
  })

  it('accepts ANTHROPIC_API_KEY as the fallback and treats blank values as unset', async () => {
    expect(await describeApiKey({ env: { ANTHROPIC_API_KEY: 'sk-a' }, home })).toEqual({ configured: true, source: 'env' })
    expect(await describeApiKey({ env: { NEXGENT_API_KEY: '', ANTHROPIC_API_KEY: ' ' }, home })).toEqual({ configured: false })
  })

  it('falls back to the credential file (written 0600) and treats empty values as unset', async () => {
    await saveCredential('NEXGENT_API_KEY', 'sk-y', { home })
    expect(await describeApiKey({ env: { NEXGENT_API_KEY: '' }, home })).toEqual({ configured: true, source: 'file' })
    await saveCredential('NEXGENT_API_KEY', '', { home })
    expect(await describeApiKey({ env: {}, home })).toEqual({ configured: false })
  })

  it('honours NEXGENT_HOME for the file location', async () => {
    const custom = path.join(home, 'custom')
    expect(credentialFilePath({ env: { NEXGENT_HOME: custom } })).toBe(path.join(custom, 'credentials.json'))
    expect(credentialFilePath({ env: {}, home })).toBe(path.join(home, 'credentials.json'))
    await saveCredential('NEXGENT_API_KEY', 'k', { home: custom })
    expect(await describeApiKey({ env: { NEXGENT_HOME: custom } })).toEqual({ configured: true, source: 'file' })
  })

  it.each(['not json', '{"version":2,"credentials":{"NEXGENT_API_KEY":"k"}}', '{"version":1}'])('treats a malformed file as unconfigured: %s', async (text) => {
    await fs.writeFile(path.join(home, 'credentials.json'), text, { mode: 0o600 })
    expect(await describeApiKey({ env: {}, home })).toEqual({ configured: false })
  })

  it.skipIf(process.platform === 'win32')('treats a file with wide permissions as unconfigured', async () => {
    await fs.writeFile(path.join(home, 'credentials.json'), JSON.stringify({ version: 1, credentials: { NEXGENT_API_KEY: 'k' } }), { mode: 0o644 })
    expect(await describeApiKey({ env: {}, home })).toEqual({ configured: false })
  })

  it('never returns the key value', async () => {
    const info = await describeApiKey({ env: { NEXGENT_API_KEY: 'sk-secret-value' }, home })
    expect(JSON.stringify(info)).not.toContain('sk-secret-value')
  })

  it('requireApiKey fails with instructions and the environment exit code', async () => {
    const error = await requireApiKey({ env: {}, home }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(EXIT.ENVIRONMENT)
    expect((error as CliError).message).toContain('NEXGENT_API_KEY')
    expect((error as CliError).message).toContain(path.join(home, 'credentials.json'))
  })
})
