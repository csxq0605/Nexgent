/**
 * Environment scrubbing for child processes (`docs/spec/permissions.md`
 * §命令策略 环境清洗): copy the host environment, drop credentials, then merge
 * the caller's explicit overlay.
 */

/**
 * Whether a variable name is removed from child environments: `NEXGENT_*`,
 * names ending in `_API_KEY` / `_TOKEN` / `_SECRET` / `_PASSWORD`, `AWS_*`,
 * `AZURE_*` and `GOOGLE_APPLICATION_CREDENTIALS`. Case-insensitive (Windows
 * variable names are).
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.startsWith('NEXGENT_')
    || /_(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(upper)
    || upper.startsWith('AWS_')
    || upper.startsWith('AZURE_')
    || upper === 'GOOGLE_APPLICATION_CREDENTIALS'
}

/** The result of {@link scrubEnv}. */
export interface ScrubbedEnv {
  /** Environment to hand to `spawn`. */
  readonly env: Record<string, string>
  /** Values of removed variables, for output redaction. */
  readonly removedValues: readonly string[]
}

/**
 * Build a child environment: host variables minus secrets, then `overlay`
 * (applied after scrubbing, so an explicit overlay is kept verbatim).
 * `PATH` is preserved.
 */
export function scrubEnv(
  host: Readonly<Record<string, string | undefined>>,
  overlay: Readonly<Record<string, string>> = {},
): ScrubbedEnv {
  const env: Record<string, string> = {}
  const removedValues: string[] = []
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue
    if (isSecretEnvName(name)) {
      removedValues.push(value)
      continue
    }
    env[name] = value
  }
  for (const [name, value] of Object.entries(overlay)) env[name] = value
  return { env, removedValues }
}
