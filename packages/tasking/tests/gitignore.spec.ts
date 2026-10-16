import { describe, expect, it } from 'vitest'
import { GitignoreMatcher, IgnoreScope, parseGitignore } from '../src/index.js'
import { project } from './helpers.js'

/** [pattern lines, path, isDir, ignored] against a root `.gitignore`. */
type Case = readonly [string, string, boolean, boolean]

const CASES: readonly Case[] = [
  // plain names match at any depth, files and directories
  ['foo', 'foo', false, true],
  ['foo', 'a/b/foo', false, true],
  ['foo', 'foo', true, true],
  ['foo', 'foobar', false, false],
  // comments, blanks, escapes
  ['# foo', 'foo', false, false],
  ['\\#foo', '#foo', false, true],
  ['\n\n', 'x', false, false],
  ['\\!important', '!important', false, true],
  ['foo   ', 'foo', false, true],
  ['foo\\ ', 'foo ', false, true],
  ['foo\\ ', 'foo', false, false],
  // anchoring
  ['/foo', 'foo', false, true],
  ['/foo', 'a/foo', false, false],
  ['a/b', 'a/b', false, true],
  ['a/b', 'x/a/b', false, false],
  ['a/b', 'a/b/c', true, false],
  // directory-only
  ['build/', 'build', true, true],
  ['build/', 'build', false, false],
  ['build/', 'src/build', true, true],
  // wildcards
  ['*.log', 'x.log', false, true],
  ['*.log', 'a/b/x.log', false, true],
  ['*.log', 'x.logs', false, false],
  ['a?c', 'abc', false, true],
  ['a?c', 'a/c', false, false],
  ['a?c', 'ac', false, false],
  ['/src/*.js', 'src/a.js', false, true],
  ['/src/*.js', 'src/sub/a.js', false, false],
  ['*', 'anything', false, true],
  // character classes
  ['file[0-9].txt', 'file7.txt', false, true],
  ['file[0-9].txt', 'filex.txt', false, false],
  ['file[!0-9].txt', 'filex.txt', false, true],
  ['file[^0-9].txt', 'file7.txt', false, false],
  ['[abc]x', 'bx', false, true],
  ['[[:digit:]]x', '5x', false, true],
  ['[[:digit:]]x', 'ax', false, false],
  ['a[', 'a[', false, true],
  // double star
  ['**/foo', 'foo', false, true],
  ['**/foo', 'a/b/foo', false, true],
  ['**/foo/bar', 'x/foo/bar', false, true],
  ['**/foo/bar', 'x/foo/baz', false, false],
  ['abc/**', 'abc/x', false, true],
  ['abc/**', 'abc/x/y', false, true],
  ['abc/**', 'abc', true, false],
  ['a/**/b', 'a/b', false, true],
  ['a/**/b', 'a/x/y/b', false, true],
  ['a/**/b', 'a/x/y/c', false, false],
  ['a**b', 'axxb', false, true],
  ['a**b', 'a/b', false, false],
  // negation: last match wins
  ['*.log\n!keep.log', 'keep.log', false, false],
  ['*.log\n!keep.log', 'other.log', false, true],
  ['!keep.log\n*.log', 'keep.log', false, true],
  ['*.log\n!keep.log\nkeep.log', 'keep.log', false, true],
  ['/*\n!/src', 'src', true, false],
  ['/*\n!/src', 'docs', true, true],
]

describe('gitignore patterns', () => {
  for (const [text, path, isDir, expected] of CASES) {
    it(`${JSON.stringify(text)} ${isDir ? 'dir' : 'file'} ${path} -> ${expected ? 'ignored' : 'kept'}`, () => {
      expect(IgnoreScope.empty.with('', parseGitignore(text)).ignores(path, isDir)).toBe(expected)
    })
  }

  it('tolerates CRLF line endings', () => {
    expect(IgnoreScope.empty.with('', parseGitignore('a.txt\r\nb/\r\n')).ignores('a.txt', false)).toBe(true)
    expect(IgnoreScope.empty.with('', parseGitignore('a.txt\r\nb/\r\n')).ignores('b', true)).toBe(true)
  })

  it('scopes a nested file to its directory and lets the deeper file override', () => {
    const scope = IgnoreScope.empty.with('', parseGitignore('*.tmp\n/top.txt')).with('pkg', parseGitignore('!keep.tmp\n/own.txt\nlocal/'))
    expect(scope.ignores('pkg/a.tmp', false)).toBe(true)
    expect(scope.ignores('pkg/keep.tmp', false)).toBe(false)
    expect(scope.ignores('keep.tmp', false)).toBe(true)
    expect(scope.ignores('pkg/own.txt', false)).toBe(true)
    expect(scope.ignores('other/own.txt', false)).toBe(false)
    expect(scope.ignores('pkg/sub/local', true)).toBe(true)
    expect(scope.ignores('pkg/top.txt', false)).toBe(false)
  })
})

describe('GitignoreMatcher over a project', () => {
  it('reads root, nested and info/exclude files, and never re-includes under an ignored directory', async () => {
    const p = await project()
    await p.write('.gitignore', 'dist/\n*.log\n!important.log\nvendor/*\n!vendor/keep\n')
    await p.write('.git/info/exclude', 'secret.txt\n')
    await p.write('pkg/.gitignore', 'generated.ts\n!/dist/\n')
    const matcher = new GitignoreMatcher(p.root)
    const ignored = (path: string, dir = false) => matcher.isIgnored(path, dir)
    expect(await ignored('dist', true)).toBe(true)
    expect(await ignored('dist/a.js')).toBe(true)
    expect(await ignored('x.log')).toBe(true)
    expect(await ignored('important.log')).toBe(false)
    expect(await ignored('secret.txt')).toBe(true)
    expect(await ignored('pkg/secret.txt')).toBe(true)
    expect(await ignored('pkg/generated.ts')).toBe(true)
    expect(await ignored('generated.ts')).toBe(false)
    // pkg/.gitignore re-includes `pkg/dist` (a deeper source wins) …
    expect(await ignored('pkg/dist', true)).toBe(false)
    // … but a file under an ignored directory stays ignored even when a rule names it.
    expect(await ignored('vendor/keep', true)).toBe(false)
    expect(await ignored('vendor/other', true)).toBe(true)
    expect(await ignored('vendor/other/keep')).toBe(true)
    expect(await ignored('dist/important.log')).toBe(true)
    // always skipped, whatever the rules say
    expect(await ignored('.git/HEAD')).toBe(true)
    expect(await ignored('a/node_modules/b.js')).toBe(true)
    expect(await ignored('.nexgent/config.json')).toBe(true)
    expect(await ignored('src/.nexgent/x.json')).toBe(false)
    expect(await ignored('src/app.ts')).toBe(false)
  })
})
