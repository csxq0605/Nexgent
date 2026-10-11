/**
 * The `files` argument on both path flavors: Windows separators, drive
 * letters (case-insensitive), absolute paths inside the project, and paths
 * that leave it.
 */
import { describe, expect, it } from 'vitest'
import { normalizeMemberFiles, renderDelegatePrompt, renderMemberResult, parseDelegateInput } from '../src/index.js'

describe('normalizeMemberFiles', () => {
  it('Windows: backslashes, forward slashes, drive-letter case and absolute paths become portable project paths', () => {
    const root = 'C:\\Users\\Wang Jie\\proj'
    expect(normalizeMemberFiles(root, [
      'data\\orders.csv',
      'data/orders.csv',
      'C:\\Users\\Wang Jie\\proj\\report\\summary.md',
      'c:/users/wang jie/proj/scripts/build.mjs',
      '.\\notes.txt',
    ], 'win32')).toEqual(['data/orders.csv', 'report/summary.md', 'scripts/build.mjs', 'notes.txt'])
  })

  it.each(['..\\secret.txt', 'C:\\Users\\Wang Jie\\other\\x.txt', 'D:\\proj\\x.txt', '\\\\server\\share\\x.txt', '.', '   '])('Windows: refuses %j', input => {
    expect(() => normalizeMemberFiles('C:\\Users\\Wang Jie\\proj', [input], 'win32')).toThrow(expect.objectContaining({ code: 'tool/invalid-input' }))
  })

  it('POSIX: relative and absolute paths inside the project; backslash is an ordinary character', () => {
    expect(normalizeMemberFiles('/home/u/proj', ['a/b.txt', '/home/u/proj/c.txt', './a/../d.txt'], 'posix')).toEqual(['a/b.txt', 'c.txt', 'd.txt'])
    expect(() => normalizeMemberFiles('/home/u/proj', ['/etc/passwd'], 'posix')).toThrow(/not a path inside the project/)
    expect(() => normalizeMemberFiles('/home/u/proj', ['../x'], 'posix')).toThrow(/not a path inside the project/)
  })
})

describe('delegate text', () => {
  it('parses and checks arguments', () => {
    expect(parseDelegateInput({ name: 'a1', task: ' do ', materialIds: ['m', 'm'], files: ['x'] })).toEqual({ name: 'a1', task: 'do', materialIds: ['m'], files: ['x'] })
    expect(() => parseDelegateInput({ name: 'a', task: 'x', mode: 'clone' })).toThrow(/mode/)
    expect(() => parseDelegateInput({ name: 'a', task: '' })).toThrow(/task/)
    expect(() => parseDelegateInput({ name: 'a', task: 'x', files: 'x' })).toThrow(/files/)
  })

  it('renders the prompt and the result', () => {
    expect(renderDelegatePrompt({ task: 'Do it.' }, [])).toMatch(/^Do it\.\n\nWhen you are done/)
    const text = renderMemberResult({
      name: 'm',
      childSessionId: 'c',
      result: {
        status: 'budget',
        text: '',
        deliverables: [],
        usage: { inputTokens: 5, outputTokens: 'unknown', totalTokens: 'unknown', cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 'unknown' },
        requestCount: 1,
        error: { name: 'NexgentError', code: 'budget/exhausted', message: 'per-task requests cap reached (2 of 2)' },
      },
    })
    expect(text.split('\n')).toEqual([
      'Member m finished: budget (session c).',
      'Use: 1 model request(s), 5 input / ? output tokens (cache read 0, cache write 0).',
      'Error: budget/exhausted: per-task requests cap reached (2 of 2)',
      'Deliverables: none presented.',
      '',
      '(The member gave no final reply.)',
    ])
  })
})
