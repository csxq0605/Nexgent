/**
 * `@nexgent/sdk` — the in-process API the CLI and the desktop app share:
 * the frozen interface (`api.ts`) and its implementation (`createSdk`).
 */
export * from './api.js'
export { createSdk, LocalNexgentSdk, READ_TEXT_MAX_BYTES, writeDefaultConfig } from './sdk.js'
export type { LocalSdkOptions, ProjectAgentEvent, StartedTurn, StartTurnInput } from './sdk.js'
export { bootProjectApp, COMPACTION_THRESHOLD_ENV, step2ProfileRows } from './boot.js'
export type { BootOptions } from './boot.js'
export { EXPORT_FILES, EXPORT_FORMAT_VERSION, REDACTED, redactSecrets, writeExportBundle } from './export.js'
export type { ExportInput } from './export.js'
export { historyItems, sessionSummary, turnUsage } from './history.js'
export { RECENT_PROJECTS_FILE, RECENT_PROJECTS_LIMIT, RecentProjects } from './recent.js'
export type { RecentProjectEntry } from './recent.js'
export { describeApiKey, readSettings, secretValues, setApiKey, updateSettings } from './settings.js'
export type { CredentialEnv } from './settings.js'
