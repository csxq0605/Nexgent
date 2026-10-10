/**
 * Secret hygiene for everything the provider may surface: error messages,
 * error details and ledger endpoints. The API key only ever goes to the SDK
 * (`x-api-key` header); every string that leaves the provider passes through
 * {@link redactSecrets} first.
 */

/** Replacement text for a removed secret. */
export const REDACTED = '[REDACTED]'

/** Bearer tokens, `x-api-key` values and `sk-…` shaped keys, in case a server echoes a header back. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(Bearer\s+)[^\s"',;]+/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
]

/**
 * Remove known secrets and secret-shaped tokens from a string.
 * @param text - text that may contain a secret (an HTTP body, an error message).
 * @param secrets - exact values to remove; empty and very short values are ignored.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let result = text
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 4) continue
    result = result.split(secret).join(REDACTED)
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix: unknown) => typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED)
  }
  return result
}

/**
 * Strip credentials, query and fragment from a URL so it can be stored in
 * ledger records and shown in messages. An unparsable value is returned
 * redacted whole.
 * @param url - an endpoint or proxy URL.
 */
export function sanitizeUrl(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) return REDACTED
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.href.replace(/\/+$/, '')
}
