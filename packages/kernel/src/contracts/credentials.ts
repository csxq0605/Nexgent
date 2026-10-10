/**
 * The credentials contract: how an API key reaches the LLM provider without
 * passing through config files, session records or the ledger.
 *
 * Resolution order for `get(name)`:
 * 1. the process environment variable `name` (for the MiMo key that is
 *    {@link NEXGENT_API_KEY});
 * 2. the local credential file, `~/.nexgent/credentials.json`
 *    (`%USERPROFILE%\.nexgent\credentials.json` on Windows), a
 *    {@link CredentialFile} whose `credentials[name]` is returned.
 * The first hit wins; an empty string counts as unset. Nothing is cached
 * across calls, so an edited file is picked up on the next request.
 */

/** Environment variable (and credential-file key) that holds the model API key. */
export const NEXGENT_API_KEY = 'NEXGENT_API_KEY'

/** Where a value came from. */
export type CredentialSource = 'env' | 'file'

/** Shape of `~/.nexgent/credentials.json`. Written with mode `0600`. */
export interface CredentialFile {
  readonly version: 1
  /** Credential name to secret value. */
  readonly credentials: Readonly<Record<string, string>>
}

/** Value-free facts about one credential, safe to show in a UI. */
export interface CredentialInfo {
  /** Whether `get` would currently return a value. */
  readonly configured: boolean
  /** Which layer supplies it; absent while unconfigured. */
  readonly source?: CredentialSource
}

/** The `ctx.credentials` service. Values go only to the provider that needs them. */
export interface Credentials {
  /** Resolve a secret by name, in the documented order; `undefined` when unset everywhere. */
  get(name: string): Promise<string | undefined>
  /** Describe a credential without revealing it. */
  describe(name: string): Promise<CredentialInfo>
}
