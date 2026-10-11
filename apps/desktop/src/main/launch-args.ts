/**
 * The command line the desktop app accepts (the `nexgent app` launch
 * contract, `apps/cli/src/app-launch.ts`): `electron <appDir> [--project <abs>]`,
 * or `Nexgent [--project <abs>]` when packaged. Chromium switches and the
 * app directory are ignored; `--project=<abs>` is accepted too.
 */
import { isAbsolute } from 'node:path'

/** What the main process acts on. */
export interface LaunchArgs {
  /** Absolute project root to open at start-up (or in the running instance, for a second launch). */
  readonly project?: string
  /** A `--project` value that was given but is not usable (relative or empty); logged, not opened. */
  readonly invalidProject?: string
}

/** Parse an argv (`process.argv`, or the `argv` of a `second-instance` event). */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgs {
  let value: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--project') {
      value = argv[index + 1] ?? ''
      index += 1
    } else if (arg.startsWith('--project=')) {
      value = arg.slice('--project='.length)
    }
  }
  if (value === undefined) return {}
  return value !== '' && isAbsolute(value) && !value.includes('\0') ? { project: value } : { invalidProject: value }
}
