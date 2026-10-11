/**
 * `@nexgent/session` — session JSONL v1 persistence (append, checkpoint,
 * recovery, single-writer lock) and the request ledger, provided to Cordis as
 * `ctx.session` and `ctx.ledger`.
 */
export const packageName = '@nexgent/session'

export { JsonlSessionStore, SESSION_FILE_NAME } from './store.js'
export type { JsonlSessionStoreOptions, ResumeResult, SessionFsyncPolicy } from './store.js'
export { JsonlLedger } from './ledger.js'
export type { JsonlLedgerOptions } from './ledger.js'
export {
  DEFAULT_CHECKPOINT_EVERY,
  foldRecord,
  initialState,
  projectSession,
  replay,
  SessionProjector,
  shouldCheckpoint,
} from './projection.js'
export type { ReplayResult } from './projection.js'
export { checkSequence, encodeLine, scanSessionLog } from './jsonl.js'
export type { ScanResult } from './jsonl.js'
export {
  ABANDONED_LOCK_MS,
  acquireLockFile,
  isProcessAlive,
  LOCK_FILE_NAME,
  parseLockFile,
  releaseLockFile,
} from './lock.js'
export type { LockIdentity } from './lock.js'
export { evaluateSchema, jsonEqual } from './schema/evaluator.js'
export type { EvaluateOptions, SchemaIssue, SchemaNode } from './schema/evaluator.js'
export {
  assertSessionRecord,
  formatIssues,
  isSessionRecord,
  isSessionState,
  SESSION_RECORD_DEFS,
  sessionRecordSchema,
  sessionRecordValidators,
  validateSessionRecord,
  validateSessionState,
} from './schema/session-schema.js'
export type { RecordValidator } from './schema/session-schema.js'
export {
  isLedgerRecordType,
  LEDGER_RECORD_DEFS,
  ledgerRecordSchema,
  ledgerRecordValidators,
  validateLedgerRecord,
} from './schema/ledger-schema.js'
export {
  checkSessionPluginConfig,
  createSessionServices,
  SessionPlugin,
  SessionPluginConfigSchema,
} from './plugin.js'
export type { SessionPluginConfig, SessionServices } from './plugin.js'
