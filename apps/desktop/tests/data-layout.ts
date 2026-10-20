/**
 * Where a project's data lives in these tests (ADR 0017, K1): in the user data directory
 * `<home>/projects/<projectId>/`, not in `<root>/.nexgent/`. A test registers the `home` the
 * app under test runs with (`useHome`) and then finds the project's data through the product's
 * own `resolveProjectLayout`.
 */
import { join } from 'node:path'
import { resolveProjectLayout, type WorkspaceLayout } from '@nexgent/kernel'

const homes = new Map<string, string>()

/** Remember which NEXGENT_HOME `root` is opened under. Returns `root`. */
export function useHome(root: string, home: string): string {
  homes.set(root, home)
  return root
}

/** The registered home of `root`. */
export function homeOf(root: string): string {
  const home = homes.get(root)
  if (home === undefined) throw new Error(`no home registered for ${root}; call useHome(root, home) first`)
  return home
}

/** The resolved layout of `root` under its registered home. */
export function layoutOf(root: string): WorkspaceLayout {
  return resolveProjectLayout(root, { home: homeOf(root) })
}

/** `<data dir>/<name>` of `root`. */
export function dataPath(root: string, ...names: string[]): string {
  return join(layoutOf(root).dataDir, ...names)
}
