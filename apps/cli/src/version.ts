/** The CLI package version (read from `dist/../package.json`). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Read the package version from `dist/../package.json`. */
export function packageVersion(): string {
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as { version: string }
  return pkg.version
}
