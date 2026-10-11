/**
 * Best-effort secret redaction for tool output, subprocess output and error
 * messages (`docs/spec/permissions.md` §密钥存放). Redaction is not a
 * guarantee that secrets never leak; it removes known values and common shapes.
 */

/** Replacement text for a redacted secret. */
export const REDACTED = '[redacted]'

/** Common secret shapes from `permissions.md`; the `Bearer ` prefix is kept. */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,
  /(?<=Bearer )[A-Za-z0-9._-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
]

/** Values shorter than this are not treated as secrets (avoids redacting `true`, `1`, ...). */
export const MIN_SECRET_LENGTH = 8

/** Replaces known secret values and secret-shaped tokens with {@link REDACTED}. */
export class Redactor {
  private readonly secrets: readonly string[]

  /**
   * @param secrets - literal values to remove (e.g. currently loaded keys).
   * @param patterns - global regular expressions for secret shapes.
   */
  constructor(secrets: Iterable<string> = [], private readonly patterns: readonly RegExp[] = DEFAULT_SECRET_PATTERNS) {
    const unique = new Set<string>()
    for (const secret of secrets) if (secret.length >= MIN_SECRET_LENGTH) unique.add(secret)
    // Longest first so a secret containing another is removed whole.
    this.secrets = [...unique].sort((a, b) => b.length - a.length)
  }

  /** A redactor that also removes `secrets`. */
  with(secrets: Iterable<string>): Redactor {
    return new Redactor([...this.secrets, ...secrets], this.patterns)
  }

  /** Redact one string. */
  redact(text: string): string {
    let out = text
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED)
    }
    for (const pattern of this.patterns) {
      const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
      out = out.replace(global, REDACTED)
    }
    return out
  }
}
