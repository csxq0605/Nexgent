/**
 * `@nexgent/test-support/acceptance` — the cross-process acceptance
 * harness and fault helpers, without the model fakes. Importable from plain
 * `.mjs` scripts such as `scripts/accept-step1.mjs`.
 */
export {
  type Deadline,
  type TruncateAt,
  type TruncateResult,
  TimeoutError,
  appendPartialLine,
  closedPortUrl,
  deadline,
  descendantPids,
  isProcessAlive,
  killProcessTree,
  truncateFile,
  waitFor,
  withTimeout,
} from './faults.js'
export {
  type NodeProcessHandle,
  type OutputMatch,
  type OutputMatcher,
  type OutputStream,
  type ProcessExit,
  type SpawnNodeOptions,
  type WaitForFileOptions,
  killAllSpawned,
  spawnNode,
  waitForFile,
} from './process.js'
export {
  type JsonlReadResult,
  type JsonlTruncation,
  type LedgerReadResult,
  type LedgerStats,
  ledgerStats,
  listSessionIds,
  readJsonlFile,
  readLedgerRecords,
  readSessionRecords,
  sessionFilePath,
} from './records.js'
export {
  type AcceptanceCheck,
  type AcceptanceSummary,
  type AcceptanceSummaryBuilder,
  type AcceptanceSummaryInit,
  type CountOrUnknown,
  type ValidationResult,
  ACCEPTANCE_SUMMARY_KIND,
  ACCEPTANCE_SUMMARY_SCHEMA,
  ACCEPTANCE_SUMMARY_VERSION,
  acceptanceSummary,
  detectEnvironment,
  validateAcceptanceSummary,
} from './summary.js'
