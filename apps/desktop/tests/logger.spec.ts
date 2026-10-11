import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileLogger, logFileName, parseLogLevel, pruneLogs } from '../src/main/logger.js'

const dir = (): string => join(mkdtempSync(join(tmpdir(), 'nexgent-desktop-log-')), 'logs')

describe('file logger', () => {
  it('writes one line per entry into the day file and rolls over at midnight', () => {
    const logs = dir()
    let now = new Date(2026, 9, 11, 23, 59, 30)
    const log = createFileLogger({ dir: logs, now: () => now })
    log.info('first')
    now = new Date(2026, 9, 12, 0, 0, 5)
    log.warn('second\ninjected ERROR line')
    expect(readdirSync(logs).sort()).toEqual(['desktop-2026-10-11.log', 'desktop-2026-10-12.log'])
    expect(readFileSync(join(logs, 'desktop-2026-10-11.log'), 'utf8')).toMatch(/^\S+ INFO first\n$/)
    expect(readFileSync(join(logs, 'desktop-2026-10-12.log'), 'utf8')).toMatch(/^\S+ WARN second injected ERROR line\n$/)
  })

  it('drops entries below the configured level', () => {
    const logs = dir()
    const now = new Date(2026, 9, 11)
    const log = createFileLogger({ dir: logs, level: 'warn', now: () => now })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    const lines = readFileSync(join(logs, logFileName(now)), 'utf8').trim().split('\n')
    expect(lines.map((line) => line.split(' ')[1])).toEqual(['WARN', 'ERROR'])
  })

  it('parses level names', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug')
    expect(parseLogLevel(' warn ')).toBe('warn')
    expect(parseLogLevel('verbose')).toBeUndefined()
    expect(parseLogLevel(undefined)).toBeUndefined()
  })

  it('removes day files past the retention window and nothing else', () => {
    const logs = dir()
    const now = new Date(2026, 9, 20)
    createFileLogger({ dir: logs, now: () => now }).info('create dir')
    for (const name of ['desktop-2026-10-01.log', 'desktop-2026-10-06.log', 'desktop-2026-10-07.log', 'other.log']) writeFileSync(join(logs, name), 'x')
    expect(pruneLogs(logs, 14, now)).toEqual(['desktop-2026-10-01.log'])
    expect(readdirSync(logs).sort()).toEqual(['desktop-2026-10-06.log', 'desktop-2026-10-07.log', 'desktop-2026-10-20.log', 'other.log'])
  })

  it('never throws when the directory cannot be written', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'nexgent-desktop-log-')), 'file')
    writeFileSync(blocker, 'x')
    expect(() => createFileLogger({ dir: join(blocker, 'logs') }).error('lost')).not.toThrow()
  })
})
