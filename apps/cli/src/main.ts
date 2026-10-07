/**
 * `nexgent` command-line entry point.
 *
 * Step 0 scope: `--version` works; `run`, `resume` and `app` only announce
 * that step 1 of the plan has not implemented them yet.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const COMMANDS = ['run', 'resume', 'app'] as const
export type Command = (typeof COMMANDS)[number]

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
}

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
}

/** Read the package version from the nearest package.json (dist/../package.json). */
export function packageVersion(): string {
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version: string }
  return pkg.version
}

export function usage(): string {
  return [
    'Usage: nexgent <command> [options]',
    '',
    'Commands:',
    '  run      start a new task (step 1)',
    '  resume   resume a session (step 1)',
    '  app      launch the desktop app (step 2)',
    '',
    'Options:',
    '  -v, --version  print the version',
    '  -h, --help     print this help',
  ].join('\n')
}

/** Run the CLI and return the process exit code. */
export function main(argv: readonly string[], io: CliIo = defaultIo): number {
  const [first] = argv
  if (first === undefined || first === '-h' || first === '--help') {
    io.stdout(usage())
    return first === undefined ? 1 : 0
  }
  if (first === '-v' || first === '--version') {
    io.stdout(packageVersion())
    return 0
  }
  if ((COMMANDS as readonly string[]).includes(first)) {
    io.stderr(`nexgent ${first}: step 1 not implemented`)
    return 2
  }
  io.stderr(`nexgent: unknown command "${first}"`)
  io.stderr(usage())
  return 1
}
