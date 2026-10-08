/**
 * Project data directory initialization for the CLI.
 *
 * INTERIM: `@nexgent/workspace` owns `.nexgent/` (`Workspace.ensureLayout()`).
 * Until the runtime is wired, the CLI creates the layout itself from the
 * kernel contract helpers so `run` / `resume` fail early on a bad project
 * path; the integrator replaces {@link initProjectLayout}'s body with the
 * workspace service and keeps its error mapping.
 */
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  NEXGENT_SUBDIRS,
  resolveProjectConfig,
  resolveWorkspaceLayout,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CliError, EXIT } from './exit-codes.js'

/** What {@link initProjectLayout} did. */
export interface ProjectLayoutResult {
  readonly layout: WorkspaceLayout
  /** Whether `.nexgent/config.json` was missing and written with the defaults. */
  readonly createdConfig: boolean
}

/**
 * Resolve `project` against `cwd`, check it is an existing directory, create
 * `.nexgent/` and every subdir in {@link NEXGENT_SUBDIRS}, and write
 * `config.json` with the defaults when it does not exist (`data-formats.md`
 * §目录布局: "`nexgent run` 首次运行写入默认值"). Idempotent; an existing
 * config file is never touched.
 * @throws {@link CliError} with {@link EXIT.ENVIRONMENT} when the project is missing, not a directory, or not writable.
 */
export async function initProjectLayout(project: string, cwd: string = process.cwd()): Promise<ProjectLayoutResult> {
  const root = path.resolve(cwd, project)
  let stat
  try {
    stat = await fs.stat(root)
  } catch {
    throw new CliError(EXIT.ENVIRONMENT, `project directory not found: ${root}`)
  }
  if (!stat.isDirectory()) throw new CliError(EXIT.ENVIRONMENT, `project path is not a directory: ${root}`)

  const layout = resolveWorkspaceLayout(root)
  try {
    for (const name of NEXGENT_SUBDIRS) await fs.mkdir(layout[name], { recursive: true })
  } catch (error) {
    throw new CliError(EXIT.ENVIRONMENT, `cannot create ${layout.dataDir}: ${describe(error)}`, { cause: error })
  }
  return { layout, createdConfig: await writeDefaultConfig(layout.configFile) }
}

/** Write the default config exclusively (`wx`); `false` when a file already exists. */
async function writeDefaultConfig(file: string): Promise<boolean> {
  const body = `${JSON.stringify(resolveProjectConfig(), null, 2)}\n`
  let handle
  try {
    handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw new CliError(EXIT.ENVIRONMENT, `cannot write ${file}: ${describe(error)}`, { cause: error })
  }
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
