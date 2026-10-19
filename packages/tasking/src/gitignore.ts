/**
 * The `.gitignore` matcher moved to `@nexgent/workspace` (the search tools use
 * it too); re-exported here under the same names for tasking callers.
 */
export { ALWAYS_SKIPPED_DIRS, GitignoreMatcher, IgnoreScope, childScope, isAlwaysSkipped, parseGitignore, rootScope } from '@nexgent/workspace'
export type { IgnoreRule } from '@nexgent/workspace'
