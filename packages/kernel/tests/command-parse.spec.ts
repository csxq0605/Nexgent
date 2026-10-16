import { describe, expect, it } from 'vitest'
import { decideToolPolicy, grantMatches, isConcurrentTool, lexWords, parseScript, quoteWords, type ToolDefinition } from '../src/index.js'

const words = (script: string, options?: Parameters<typeof parseScript>[1]) =>
  parseScript(script, options).commands.filter(command => command.words.length > 0).map(command => [...command.words])

describe('parseScript', () => {
  it('splits on separators and keeps quoted text together', () => {
    expect(words('a; b && c || d | e & f\ng')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
    expect(words('git commit -m "fix; sudo bug"')).toEqual([['git', 'commit', '-m', 'fix; sudo bug']])
    expect(words("echo 'a && b' \"c | d\" e\\ f")).toEqual([['echo', 'a && b', 'c | d', 'e f']])
  })

  it('reads substitutions, subshells, groups and backticks', () => {
    expect(words('echo $(sudo id)')).toEqual([['id'], ['echo', '\uFFFC']])
    expect(parseScript('echo $(sudo id)').commands[0]!.privilegeWords).toEqual(['sudo', 'id'])
    expect(words('(cd x && ls) ; { pwd; }')).toEqual([['cd', 'x'], ['ls'], ['pwd']])
    expect(words('echo `whoami` "$(date)"')).toEqual([['whoami'], ['date'], ['echo', '\uFFFC', '\uFFFC']])
  })

  it('handles redirections, assignments and here-documents', () => {
    const [cmd] = parseScript('FOO=1 BAR=2 cat < in > out 2>&1 >> log &> all').commands
    expect(cmd!.words).toEqual(['cat'])
    expect(cmd!.assignments).toEqual(['FOO=1', 'BAR=2'])
    expect(cmd!.redirects.map(r => `${r.fd ?? ''}${r.op}${r.target}`)).toEqual(['<in', '>out', '2>&1', '>>log', '&>all'])
    expect(words("cat <<'EOF'\n$(rm -rf /)\nEOF\nls")).toEqual([['cat'], ['ls']])
    expect(words('cat <<EOF\nhello $(date)\nEOF\nls')).toEqual([['cat'], ['date'], ['ls']])
    expect(words('cat <<-EOF\n\tbody\n\tEOF\nls')).toEqual([['cat'], ['ls']])
  })

  it('unwraps shells, env, time, nice, xargs, timeout, sudo and find -exec', () => {
    expect(words("sh -c 'git push'")).toEqual([['git', 'push']])
    expect(words('bash -lc "rm -rf /"')).toEqual([['rm', '-rf', '/']])
    expect(words("sh -c 'a; b' && c")).toEqual([['a'], ['b'], ['c']])
    expect(words('env -i FOO=1 nice -n 5 nohup time ls -l')).toEqual([['ls', '-l']])
    expect(words('timeout 5 rm x')).toEqual([['rm', 'x']])
    expect(words('command -v ls')).toEqual([])
    expect(words('eval "rm -rf x"')).toEqual([['rm', '-rf', 'x'], ['eval', 'rm -rf x']])
    const [xargs] = parseScript('xargs -a l rm -rf').commands
    expect(xargs).toMatchObject({ words: ['rm', '-rf'], dynamicArgs: true })
    const sudo = parseScript('sudo -u bob env X=1 rm -rf x').commands[0]!
    expect(sudo).toMatchObject({ words: ['rm', '-rf', 'x'], privilegeWords: ['sudo', '-u', 'bob', 'env', 'X=1', 'rm', '-rf', 'x'] })
    const found = parseScript('find / -name x -exec rm -rf {} +').commands
    expect(found.map(c => c.words[0])).toEqual(['rm', 'find'])
    expect(found[0]).toMatchObject({ extraTargets: ['/'], dynamicArgs: true })
  })

  it('strips git / npm / pnpm / yarn global options from core', () => {
    expect(parseScript('git -C . -c a=b --no-pager push origin main').commands[0]!.core).toEqual(['git', 'push', 'origin', 'main'])
    expect(parseScript('/usr/bin/git --git-dir=x --work-tree y status').commands[0]!.core).toEqual(['git', 'status'])
    expect(parseScript('npm --prefix x install left-pad').commands[0]!.core).toEqual(['npm', 'install', 'left-pad'])
    expect(parseScript('pnpm -w add x').commands[0]!.core).toEqual(['pnpm', 'add', 'x'])
    expect(parseScript('pnpm --filter a -r add x').commands[0]!.core).toEqual(['pnpm', 'add', 'x'])
    expect(parseScript('pnpm -C pkg install').commands[0]!.core).toEqual(['pnpm', 'install'])
    expect(parseScript('yarn --cwd x add y').commands[0]!.core).toEqual(['yarn', 'add', 'y'])
    expect(parseScript('git -C . push').commands[0]!.words).toEqual(['git', '-C', '.', 'push'])
  })

  it('expands ~, HOME and known variables only', () => {
    const options = { home: '/home/u', env: { TMPDIR: '/tmp/nx-1' } }
    expect(words('rm -rf ~/x $HOME/y ${HOME}/z $TMPDIR/w "$TMPDIR/v" \'$TMPDIR/u\' $NOPE/t', options)).toEqual([
      ['rm', '-rf', '/home/u/x', '/home/u/y', '/home/u/z', '/tmp/nx-1/w', '/tmp/nx-1/v', '$TMPDIR/u', '$NOPE/t'],
    ])
    const [cmd] = parseScript('rm $NOPE/t $HOME', options).commands
    expect(cmd!.unresolved).toEqual([false, true, false])
  })

  it('reports incomplete scripts and survives garbage', () => {
    expect(parseScript("echo 'oops").incomplete).toBe(true)
    expect(parseScript('echo $(ls').incomplete).toBe(true)
    expect(parseScript('((((((((((((((((((((a))))))))))))))))))))').incomplete).toBe(true)
    expect(() => parseScript('<<<>>>&&||;;)(}{`$')).not.toThrow()
  })

  it('reads PowerShell quoting, escapes and separators', () => {
    const ps = { dialect: 'powershell' as const, home: 'C:\\Users\\u' }
    expect(words("Remove-Item -Recurse 'C:\\a b' ; Get-Item \"x`\"y\"", ps)).toEqual([['Remove-Item', '-Recurse', 'C:\\a b'], ['Get-Item', 'x"y']])
    expect(words('Get-ChildItem | Where-Object { $_.Name -eq "a" } | Select-Object -First 1', ps).map(w => w[0])).toEqual(['Get-ChildItem', '$_.Name', 'Where-Object', 'Select-Object'])
    expect(words('pwsh -NoProfile -Command "Remove-Item -Recurse C:\\x"', ps)).toEqual([['Remove-Item', '-Recurse', 'C:\\x']])
    expect(words('Remove-Item $env:USERPROFILE\\x', { ...ps, env: { USERPROFILE: 'C:\\Users\\u' } })).toEqual([['Remove-Item', 'C:\\Users\\u\\x']])
    expect(words('a 2>&1 > $null', ps)).toEqual([['a']])
  })

  it('lexes a grant pattern', () => {
    expect(lexWords("git push origin 'my branch'")).toEqual(['git', 'push', 'origin', 'my branch'])
    expect(lexWords(quoteWords(['rm', '-rf', "it's $x", '']))).toEqual(['rm', '-rf', "it's $x", ''])
  })
})

describe('grantMatches (commands)', () => {
  const grant = (pattern?: string) => ({ tool: 'bash', ...(pattern === undefined ? {} : { pattern }), grantedAt: '' })
  const cmd = (value: string) => ({ kind: 'command' as const, value })
  it('compares the whole word sequence', () => {
    expect(grantMatches(grant('git push origin main'), 'bash', cmd('git push origin main'))).toBe(true)
    expect(grantMatches(grant('git push'), 'bash', cmd('git push origin main'))).toBe(false)
    expect(grantMatches(grant('git push'), 'bash', cmd('git push --force'))).toBe(false)
    expect(grantMatches(grant('git push'), 'bash', cmd('git pushfoo'))).toBe(false)
    expect(grantMatches(grant('rm'), 'bash', cmd('rmdir x'))).toBe(false)
    expect(grantMatches(grant('rm -rf /tmp/x'), 'bash', cmd('rm -rf ~/Documents'))).toBe(false)
    expect(grantMatches(grant("git commit -m 'a b'"), 'bash', cmd('git commit -m "a b"'))).toBe(true)
  })
  it('requires every command of the subject to match, and unwraps wrappers', () => {
    expect(grantMatches(grant('git push'), 'bash', cmd('git push && git push'))).toBe(true)
    expect(grantMatches(grant('git push'), 'bash', cmd("sh -c 'git push'"))).toBe(true)
    expect(grantMatches(grant('git push'), 'bash', cmd('git push && rm -rf /'))).toBe(false)
    expect(grantMatches(grant('git push'), 'bash', cmd(''))).toBe(false)
    expect(grantMatches(grant(), 'bash', cmd('anything'))).toBe(true)
    expect(grantMatches(grant('git push'), 'pwsh', cmd('git push'))).toBe(false)
  })
  it('keeps glob semantics for paths', () => {
    expect(grantMatches({ tool: 'fs', pattern: 'src/**/*.ts', grantedAt: '' }, 'fs', { kind: 'path', value: 'src/a/b.ts' })).toBe(true)
    expect(grantMatches({ tool: 'fs', pattern: 'src/*.ts', grantedAt: '' }, 'fs', { kind: 'path', value: 'src/a/b.ts' })).toBe(false)
  })
})

describe('readOnlyCall', () => {
  const def = (extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name: 'bash', description: '', inputSchema: { type: 'object' }, effects: ['execute', 'write', 'network'], approval: 'never', ...extra,
  })
  it('lifts the read-only refusal for a read-only call only', () => {
    const readOnlyCall = (input: unknown) => (input as { command: string }).command === 'ls'
    expect(decideToolPolicy(def(), 'read-only', { command: 'ls' }).kind).toBe('deny')
    expect(decideToolPolicy(def({ readOnlyCall }), 'read-only').kind).toBe('deny')
    expect(decideToolPolicy(def({ readOnlyCall }), 'read-only', { command: 'ls' }).kind).toBe('run')
    expect(decideToolPolicy(def({ readOnlyCall }), 'read-only', { command: 'rm x' }).kind).toBe('deny')
    expect(decideToolPolicy(def({ readOnlyCall: () => { throw new Error('x') } }), 'read-only', {}).kind).toBe('deny')
    expect(decideToolPolicy(def({ readOnlyCall, approval: 'ask' }), 'read-only', { command: 'ls' })).toMatchObject({ kind: 'ask', risk: 'low' })
    expect(decideToolPolicy(def({ readOnlyCall, approval: 'always' }), 'read-only', { command: 'ls' }).kind).toBe('ask')
  })
  it('lets a read-only call run concurrently', () => {
    expect(isConcurrentTool(def())).toBe(false)
    expect(isConcurrentTool(def(), false, true)).toBe(true)
    expect(isConcurrentTool(def({ approval: 'ask' }), false, true)).toBe(false)
    expect(isConcurrentTool(def(), true, true)).toBe(false)
  })
})
