import { spawnSync } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  isSecretEnvName,
  LocalProcessRunner,
  Redactor,
  scrubEnv,
  TailBuffer,
  truncationMarker,
} from '../src/index.js'
import { pidAlive, tempDir } from './helpers.js'

const posix = process.platform !== 'win32'
const bash = (script: string, cwd: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  ({ command: 'bash', args: ['-c', script], cwd, timeoutMs: extra.timeoutMs ?? 10_000, ...(extra.signal === undefined ? {} : { signal: extra.signal }) })

function firstPid(stdout: string): number {
  const pid = Number(stdout.trim().split(/\s+/)[0])
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  return pid
}

describe.runIf(posix)('process tree termination (POSIX)', () => {
  it('kills the whole tree on timeout, grandchild included', async () => {
    const cwd = await tempDir()
    const runner = new LocalProcessRunner({ graceMs: 500 })
    const result = await runner.run(bash('sleep 600 & echo $!; wait', cwd, { timeoutMs: 300 }))
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
  })

  it('escalates to SIGKILL for members that ignore SIGTERM', async () => {
    const cwd = await tempDir()
    const runner = new LocalProcessRunner({ graceMs: 200 })
    const result = await runner.run(bash(`bash -c 'trap "" TERM; sleep 600' & echo $!; trap "" TERM; wait`, cwd, { timeoutMs: 300 }))
    expect(result.timedOut).toBe(true)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
  })

  it('kills the tree on abort', async () => {
    const cwd = await tempDir()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const result = await new LocalProcessRunner({ graceMs: 500 }).run(bash('sleep 600 & echo $!; wait', cwd, { signal: controller.signal }))
    expect(result.aborted).toBe(true)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
  })

  it('reaps background members left after a normal exit', async () => {
    const cwd = await tempDir()
    const result = await new LocalProcessRunner({ graceMs: 500 }).run(bash('sleep 600 > /dev/null 2>&1 & echo $!', cwd))
    expect(result.exitCode).toBe(0)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
  })

  it('returns immediately when already aborted', async () => {
    const cwd = await tempDir()
    const controller = new AbortController()
    controller.abort()
    const result = await new LocalProcessRunner().run(bash('echo hi', cwd, { signal: controller.signal }))
    expect(result).toMatchObject({ aborted: true, exitCode: null, stdout: '' })
  })

  it('reports exit codes, stdin and stderr', async () => {
    const cwd = await tempDir()
    const result = await new LocalProcessRunner().run({ ...bash('cat; echo err >&2; exit 3', cwd), stdin: 'in' })
    expect(result).toMatchObject({ exitCode: 3, stdout: 'in', stderr: 'err\n', timedOut: false })
  })

  it('caps output at 64 KiB per stream, keeps the tail and marks the drop', async () => {
    const cwd = await tempDir()
    const result = await new LocalProcessRunner().run(bash(`head -c 1048576 /dev/zero | tr '\\0' 'a'; printf END`, cwd))
    const dropped = 1048576 + 3 - DEFAULT_MAX_OUTPUT_BYTES
    expect(result.stdout.startsWith(`${truncationMarker(dropped)}\n`)).toBe(true)
    expect(result.stdout.endsWith('aaaEND')).toBe(true)
    expect(Buffer.byteLength(result.stdout) - truncationMarker(dropped).length - 1).toBe(DEFAULT_MAX_OUTPUT_BYTES)
    expect(truncationMarker(5)).toBe('[nexgent: output truncated, dropped 5 bytes]')
  })

  it('scrubs secrets from the environment and redacts leaked values', async () => {
    const cwd = await tempDir()
    const hostEnv = { ...process.env, NEXGENT_API_KEY: 'nexgent-secret-value-1', FOO_TOKEN: 'foo-token-value-2', KEEP_ME: 'yes' }
    const runner = new LocalProcessRunner({ hostEnv })
    const result = await runner.run({
      ...bash('echo "k=${NEXGENT_API_KEY:-unset} t=${FOO_TOKEN:-unset} keep=$KEEP_ME extra=$EXTRA"; echo nexgent-secret-value-1 sk-ABCDEFGHIJKLMNOPQRST', cwd),
      env: { EXTRA: 'x' },
    })
    expect(result.stdout).toContain('k=unset t=unset keep=yes extra=x')
    expect(result.stdout).toContain('[redacted] [redacted]')
    expect(result.stdout).not.toContain('nexgent-secret-value-1')
  })
})

describe.runIf(process.platform === 'win32')('process tree termination (Windows)', () => {
  // The first launcher on a machine compiles the Job Object helper, so deadlines leave room for it.
  const pwsh = (script: string, cwd: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    ({ command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', script], cwd, timeoutMs: extra.timeoutMs ?? 30_000, ...(extra.signal === undefined ? {} : { signal: extra.signal }) })
  /** A sleeper whose command line carries `marker`. */
  const sleeper = (marker: string) => `Start-Process -PassThru -NoNewWindow pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 600 # ${marker}'`
  /** PIDs of live processes whose command line contains `marker` (the query itself excluded by splitting the marker). */
  function marked(marker: string): number[] {
    const half = Math.floor(marker.length / 2)
    const query = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + '${marker.slice(0, half)}' + '${marker.slice(half)}' + '*') } | ForEach-Object { $_.ProcessId }`
    const out = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true })
    return out.stdout.split(/\s+/).filter(Boolean).map(Number)
  }
  const newMarker = () => `nxleak${Math.random().toString(36).slice(2, 10)}`

  beforeAll(async () => {
    // Warm the helper so the deadlines below measure the commands, not the one-time compile.
    await new LocalProcessRunner().run(pwsh('exit 0', await tempDir(), { timeoutMs: 120_000 }))
  }, 180_000)

  it('kills a nested Start-Process tree on timeout', async () => {
    const cwd = await tempDir()
    const marker = newMarker()
    const runner = new LocalProcessRunner({ graceMs: 500 })
    const result = await runner.run(pwsh(`$p = ${sleeper(marker)}; Write-Output $p.Id; Start-Sleep 600`, cwd, { timeoutMs: 8_000 }))
    expect(result.timedOut).toBe(true)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
    expect(marked(marker)).toEqual([])
  }, 60_000)

  it('kills a grandchild whose parent already exited, on timeout and on cancel', async () => {
    const cwd = await tempDir()
    for (const mode of ['timeout', 'abort'] as const) {
      const marker = newMarker()
      // The middle pwsh starts the sleeper and exits, so the sleeper has no live parent in the tree.
      const middle = `$p = ${sleeper(marker)}; Write-Output $p.Id`
      const script = `pwsh -NoProfile -EncodedCommand ${Buffer.from(middle, 'utf16le').toString('base64')}; Start-Sleep 600`
      const controller = new AbortController()
      if (mode === 'abort') setTimeout(() => controller.abort(), 8_000)
      const result = await new LocalProcessRunner({ graceMs: 500 }).run(pwsh(script, cwd, mode === 'abort' ? { signal: controller.signal } : { timeoutMs: 8_000 }))
      expect(mode === 'abort' ? result.aborted : result.timedOut).toBe(true)
      expect(pidAlive(firstPid(result.stdout))).toBe(false)
      expect(marked(marker)).toEqual([])
    }
  }, 120_000)

  it('reaps background processes left after a normal exit', async () => {
    const cwd = await tempDir()
    const marker = newMarker()
    const result = await new LocalProcessRunner({ graceMs: 500 }).run(pwsh(`$p = ${sleeper(marker)}; Write-Output $p.Id`, cwd))
    expect(result.exitCode).toBe(0)
    expect(pidAlive(firstPid(result.stdout))).toBe(false)
    expect(marked(marker)).toEqual([])
  }, 60_000)

  it('passes arguments, stdin, exit code and stderr through the launcher', async () => {
    const cwd = await tempDir()
    const script = '$in = [Console]::In.ReadToEnd(); Write-Output ("arg=" + $args[0] + " in=" + $in); [Console]::Error.WriteLine("err"); exit 3'
    const result = await new LocalProcessRunner().run({
      command: 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } 'a "quoted" arg'`],
      cwd,
      timeoutMs: 30_000,
      stdin: 'in',
    })
    expect(result).toMatchObject({ exitCode: 3, timedOut: false })
    expect(result.stdout.trim()).toBe('arg=a "quoted" arg in=in')
    expect(result.stderr.trim()).toBe('err')
  }, 60_000)

  it('reports a command that cannot be started as process/failed', async () => {
    const cwd = await tempDir()
    await expect(new LocalProcessRunner().run({ command: 'nexgent-no-such-program', args: [], cwd, timeoutMs: 30_000 }))
      .rejects.toMatchObject({ code: 'process/failed' })
  }, 60_000)
})

describe('env scrub and redaction units', () => {
  it('classifies secret variable names', () => {
    for (const name of ['NEXGENT_API_KEY', 'nexgent_x', 'OPENAI_API_KEY', 'GH_TOKEN', 'DB_PASSWORD', 'APP_SECRET', 'AWS_REGION', 'AZURE_X', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(isSecretEnvName(name)).toBe(true)
    }
    for (const name of ['PATH', 'HOME', 'TOKENIZER', 'TMPDIR']) expect(isSecretEnvName(name)).toBe(false)
    const { env, removedValues } = scrubEnv({ PATH: '/bin', GH_TOKEN: 'abc' }, { GH_TOKEN: 'explicit' })
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 'explicit' })
    expect(removedValues).toEqual(['abc'])
  })

  it('redacts known values and secret shapes', () => {
    const redactor = new Redactor(['super-secret-1', 'short'])
    expect(redactor.redact('a super-secret-1 b short')).toBe('a [redacted] b short')
    expect(redactor.redact('Authorization: Bearer abcdefghijklmnop1234')).toBe('Authorization: Bearer [redacted]')
    expect(redactor.redact('AKIAABCDEFGHIJKLMNOP and sk-0123456789abcdefXYZ')).toBe('[redacted] and [redacted]')
  })

  it('tail buffer keeps the last bytes', () => {
    const tail = new TailBuffer(4)
    tail.push(Buffer.from('abc'))
    tail.push(Buffer.from('def'))
    expect(tail.text()).toBe(`${truncationMarker(2)}\ncdef`)
    tail.push(Buffer.from('0123456789'))
    expect(tail.dropped).toBe(12)
    expect(tail.text()).toBe(`${truncationMarker(12)}\n6789`)
  })
})
