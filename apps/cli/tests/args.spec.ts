import { describe, expect, it } from 'vitest'
import { CliError, EXIT, commandUsage, isSessionId, parseCliArgs, usage } from '../src/index.js'

const SID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'

function usageError(argv: string[]): CliError {
  try {
    parseCliArgs(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(EXIT.USAGE)
    return error as CliError
  }
  throw new Error(`expected a usage error for ${argv.join(' ')}`)
}

describe('parseCliArgs', () => {
  it('parses run with every option', () => {
    expect(parseCliArgs(['run', '--project', 'p', '--task', 'do it', '--sandbox', 'read-only', '--model', 'm1', '--json'])).toEqual({
      command: 'run', project: 'p', task: 'do it', sandbox: 'read-only', model: 'm1', json: true,
    })
  })

  it('parses run with the minimum and --opt=value forms', () => {
    expect(parseCliArgs(['run', '--project=p', '--task=-starts with a dash'])).toEqual({
      command: 'run', project: 'p', task: '-starts with a dash', json: false,
    })
  })

  it('parses resume with and without a task', () => {
    expect(parseCliArgs(['resume', SID, '--project', 'p'])).toEqual({ command: 'resume', sessionId: SID, project: 'p', json: false })
    expect(parseCliArgs(['resume', '--project', 'p', SID, '--task', 'more', '--sandbox', 'full-access', '--json'])).toEqual({
      command: 'resume', sessionId: SID, project: 'p', task: 'more', sandbox: 'full-access', json: true,
    })
  })

  it('parses app, help and version', () => {
    expect(parseCliArgs(['app', '--project', 'p'])).toEqual({ command: 'app', project: 'p' })
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' })
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' })
    expect(parseCliArgs(['run', '--help'])).toEqual({ command: 'help', topic: 'run' })
    expect(parseCliArgs(['resume', '-h'])).toEqual({ command: 'help', topic: 'resume' })
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' })
    expect(parseCliArgs(['-v'])).toEqual({ command: 'version' })
  })

  it.each([
    [['frobnicate'], 'unknown command "frobnicate"'],
    [['--frob'], 'unknown option "--frob"'],
    [[], 'missing command'],
    [['run', '--task', 't'], '--project is required'],
    [['run', '--project', 'p'], '--task is required'],
    [['run', '--project', 'p', '--task', '   '], '--task must not be empty'],
    [['run', '--project', 'p', '--task', 't', 'extra'], 'takes no positional arguments'],
    [['run', '--project', 'p', '--task', 't', '--sandbox', 'yolo'], '--sandbox must be one of read-only, workspace-write, full-access'],
    [['run', '--project', 'p', '--task', 't', '--bogus'], "Unknown option '--bogus'"],
    [['run', '--project', 'p', '--task'], "argument missing"],
    [['resume', '--project', 'p'], 'needs a <sessionId>'],
    [['resume', 'abc', '--project', 'p'], 'is not a session id'],
    [['resume', SID, SID, '--project', 'p'], 'got extra'],
    [['resume', SID, '--project', 'p', '--model', 'm'], 'does not accept --model'],
    [['app', '--project', 'p', '--task', 't'], 'does not accept --task'],
    [['app'], '--project is required'],
  ])('rejects %j', (argv, message) => {
    expect(usageError(argv).message).toContain(message)
  })

  it('validates session ids as lowercase uuid v4', () => {
    expect(isSessionId(SID)).toBe(true)
    expect(isSessionId(SID.toUpperCase())).toBe(false)
    expect(isSessionId('6f1c2a3b-4d5e-1f60-8a7b-9c0d1e2f3a4b')).toBe(false)
  })

  it('documents every command and the exit codes in help', () => {
    expect(usage()).toMatch(/run[\s\S]*resume[\s\S]*app/)
    expect(usage()).toContain('130 cancelled')
    expect(commandUsage('run')).toContain('--sandbox <mode>')
    expect(commandUsage('resume')).toContain('<sessionId>')
    expect(commandUsage('app')).toContain('step 2')
  })
})
