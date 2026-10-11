/**
 * The desktop log: one file per local day under `<nexgent home>/logs/`
 * (`desktop-YYYY-MM-DD.log`), one line per entry, level configurable.
 *
 * Writes are synchronous appends so a line survives a crash right after it;
 * the main process logs rarely (lifecycle, denials, errors), never per token
 * of model output. Callers never pass secrets, tokens or call arguments.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Levels, lowest first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** What the rest of the main process logs through. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Options of {@link createFileLogger}. */
export interface FileLoggerOptions {
  /** Directory holding the daily files; created on first write. */
  readonly dir: string
  /** Entries below this level are dropped. Default `info`. */
  readonly level?: LogLevel
  /** Files older than this many days are removed when the logger is created. Default 14. */
  readonly keepDays?: number
  /** Clock, for tests. */
  readonly now?: () => Date
  /** Also echo to stderr (development). */
  readonly echo?: boolean
}

/** Parse a level name (`NEXGENT_LOG_LEVEL`); anything unknown is `undefined`. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const lowered = value?.trim().toLowerCase()
  return LOG_LEVELS.find((level) => level === lowered)
}

/** `YYYY-MM-DD` of the local calendar day. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The file name of a day's log. */
export function logFileName(date: Date): string {
  return `desktop-${localDay(date)}.log`
}

const FILE_PATTERN = /^desktop-(\d{4})-(\d{2})-(\d{2})\.log$/

/** Remove daily files older than `keepDays` relative to `now`; other files are left alone. */
export function pruneLogs(dir: string, keepDays: number, now: Date): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays).getTime()
  const removed: string[] = []
  for (const name of names) {
    const match = FILE_PATTERN.exec(name)
    if (match === null) continue
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    if (day < cutoff) {
      rmSync(join(dir, name), { force: true })
      removed.push(name)
    }
  }
  return removed
}

/** A logger appending to the current day's file; the file switches when the local day changes. */
export function createFileLogger(options: FileLoggerOptions): Logger {
  const now = options.now ?? (() => new Date())
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info')
  pruneLogs(options.dir, options.keepDays ?? 14, now())
  let dirReady = false
  const write = (level: LogLevel, message: string): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return
    const at = now()
    // One entry, one line: embedded newlines would let a message forge entries.
    const line = `${at.toISOString()} ${level.toUpperCase()} ${message.replace(/[\r\n]+/g, ' ')}\n`
    if (options.echo === true) process.stderr.write(line)
    try {
      if (!dirReady) {
        mkdirSync(options.dir, { recursive: true })
        dirReady = true
      }
      appendFileSync(join(options.dir, logFileName(at)), line)
    } catch {
      // Logging never takes the app down.
    }
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}
