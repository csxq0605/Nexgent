import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliError, EXIT, credentialFilePath, describeApiKey, requireApiKey, type CredentialProbe } from '../src/index.js'

const home = path.resolve('/home/u')
const defaultFile = path.join(home, '.nexgent', 'credentials.json')

function probe(env: Record<string, string>, files: Record<string, string> = {}): CredentialProbe {
  return {
    env,
    homedir: home,
    readFile: async (file) => {
      const text = files[file]
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    },
  }
}

describe('credential presence', () => {
  it('prefers the environment variable', async () => {
    expect(await describeApiKey(probe({ NEXGENT_API_KEY: 'sk-x' }))).toEqual({ configured: true, source: 'env' })
  })

  it('falls back to the credential file and treats empty values as unset', async () => {
    const file = JSON.stringify({ version: 1, credentials: { NEXGENT_API_KEY: 'sk-y' } })
    expect(await describeApiKey(probe({ NEXGENT_API_KEY: '' }, { [defaultFile]: file }))).toEqual({ configured: true, source: 'file' })
    const empty = JSON.stringify({ version: 1, credentials: { NEXGENT_API_KEY: '' } })
    expect(await describeApiKey(probe({}, { [defaultFile]: empty }))).toEqual({ configured: false })
  })

  it('honours NEXGENT_HOME for the file location', async () => {
    const custom = path.resolve('/custom')
    expect(credentialFilePath({ NEXGENT_HOME: custom }, home)).toBe(path.join(custom, 'credentials.json'))
    const file = JSON.stringify({ version: 1, credentials: { NEXGENT_API_KEY: 'k' } })
    expect(await describeApiKey(probe({ NEXGENT_HOME: custom }, { [path.join(custom, 'credentials.json')]: file }))).toEqual({ configured: true, source: 'file' })
  })

  it.each(['not json', '{"version":2,"credentials":{"NEXGENT_API_KEY":"k"}}', '{"version":1}'])('treats a malformed file as unconfigured: %s', async (text) => {
    expect(await describeApiKey(probe({}, { [defaultFile]: text }))).toEqual({ configured: false })
  })

  it('never returns the key value', async () => {
    const info = await describeApiKey(probe({ NEXGENT_API_KEY: 'sk-secret-value' }))
    expect(JSON.stringify(info)).not.toContain('sk-secret-value')
  })

  it('requireApiKey fails with instructions and the environment exit code', async () => {
    const error = await requireApiKey(probe({})).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(EXIT.ENVIRONMENT)
    expect((error as CliError).message).toContain('NEXGENT_API_KEY')
    expect((error as CliError).message).toContain(defaultFile)
  })
})
