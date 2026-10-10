/**
 * JSON Schema of the session JSONL v1 records (and the checkpoint state),
 * plus the validators built on it. `schema/session.v1.schema.json` is this
 * object serialized; a test keeps the two identical.
 *
 * Normative text: `docs/spec/data-formats.md` §会话 JSONL v1. Type mirror:
 * `packages/kernel/src/contracts/session.ts`.
 */
import {
  isJsonValue,
  NexgentError,
  SESSION_RECORD_TYPES,
  type JsonObject,
  type SessionRecord,
  type SessionRecordType,
  type SessionState,
} from '@nexgent/kernel'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

/** `$defs` key of each record type's schema. */
export const SESSION_RECORD_DEFS: Readonly<Record<SessionRecordType, string>> = {
  'session.start': 'sessionStartRecord',
  'user.message': 'userMessageRecord',
  'assistant.message': 'assistantMessageRecord',
  'tool.result': 'toolResultRecord',
  'turn.start': 'turnStartRecord',
  'turn.end': 'turnEndRecord',
  checkpoint: 'checkpointRecord',
  error: 'errorRecord',
  'approval.request': 'approvalRequestRecord',
  'approval.decision': 'approvalDecisionRecord',
  'approval.grant': 'approvalGrantRecord',
}

const BASE_REQUIRED = ['type', 'seq', 'ts', 'sessionId'] as const

function record(type: SessionRecordType, properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return closedObject(
    {
      type: { const: type },
      seq: ref('positiveInteger'),
      ts: ref('timestamp'),
      sessionId: ref('nonEmptyString'),
      ...properties,
    },
    [...BASE_REQUIRED, ...required],
  )
}

const turn = ref('positiveInteger')
const step = ref('positiveInteger')

/** The session record schema (draft 2020-12), dispatching on `type` via `oneOf`. */
export const sessionRecordSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/session.v1.schema.json',
  title: 'Nexgent session JSONL v1 record',
  description: 'One line of .nexgent/sessions/<sessionId>/session.jsonl. See docs/spec/data-formats.md.',
  oneOf: SESSION_RECORD_TYPES.map(type => ref(SESSION_RECORD_DEFS[type])),
  $defs: {
    ...COMMON_DEFS,
    sandboxMode: { enum: ['read-only', 'workspace-write', 'full-access'] },
    toolCall: closedObject({ id: { type: 'string' }, name: { type: 'string' }, arguments: { type: 'string' } }, [
      'id',
      'name',
      'arguments',
    ]),
    userMessage: closedObject({ role: { const: 'user' }, content: { type: 'string' } }, ['role', 'content']),
    assistantMessage: closedObject(
      {
        role: { const: 'assistant' },
        content: { type: 'string' },
        toolCalls: { type: 'array', items: ref('toolCall') },
        providerContent: ref('jsonValue'),
      },
      ['role', 'content'],
    ),
    toolMessage: closedObject(
      {
        role: { const: 'tool' },
        toolCallId: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        isError: { type: 'boolean' },
      },
      ['role', 'toolCallId', 'name', 'content', 'isError'],
    ),
    approvalRequest: closedObject(
      {
        id: ref('nonEmptyString'),
        sessionId: ref('nonEmptyString'),
        callId: { type: 'string' },
        tool: ref('nonEmptyString'),
        summary: { type: 'string' },
        detail: { type: 'string' },
        risk: { enum: ['low', 'medium', 'high'] },
        options: { type: 'array', items: ref('approvalScope') },
        pattern: { type: 'string' },
        expiresAt: { type: 'string' },
      },
      ['id', 'sessionId', 'callId', 'tool', 'summary', 'risk', 'options'],
    ),
    approvalDecision: closedObject(
      {
        id: ref('nonEmptyString'),
        decision: { enum: ['allow', 'deny'] },
        scope: ref('approvalScope'),
        decidedBy: { enum: ['user', 'timeout', 'cancel', 'headless'] },
        reason: { type: 'string' },
      },
      ['id', 'decision', 'scope', 'decidedBy'],
    ),
    approvalGrant: closedObject(
      { tool: ref('nonEmptyString'), pattern: { type: 'string' }, grantedAt: ref('timestamp') },
      ['tool', 'grantedAt'],
    ),
    turnEndReason: {
      oneOf: [
        closedObject({ kind: { const: 'completed' } }, ['kind']),
        closedObject({ kind: { const: 'cancelled' }, cause: { enum: ['user', 'timeout', 'shutdown', 'cost-cap'] } }, [
          'kind',
          'cause',
        ]),
        closedObject({ kind: { const: 'error' }, error: ref('errorInfo') }, ['kind', 'error']),
        closedObject({ kind: { const: 'max-tokens' } }, ['kind']),
        closedObject({ kind: { const: 'interrupted' } }, ['kind']),
      ],
    },
    sessionMetadata: closedObject(
      {
        createdAt: ref('timestamp'),
        projectRoot: { type: 'string' },
        model: { type: 'string' },
        sandboxMode: ref('sandboxMode'),
        grants: { type: 'array', items: ref('approvalGrant') },
        title: { type: 'string' },
        lastTurn: { type: 'integer', minimum: 0 },
        openTurn: ref('positiveInteger'),
        totalUsage: ref('usage'),
        lastSeq: ref('positiveInteger'),
      },
      ['createdAt', 'projectRoot', 'model', 'sandboxMode', 'grants', 'lastTurn', 'totalUsage', 'lastSeq'],
    ),
    sessionState: closedObject(
      {
        sessionId: ref('nonEmptyString'),
        version: { const: 1 },
        messages: {
          type: 'array',
          items: { oneOf: [ref('userMessage'), ref('assistantMessage'), ref('toolMessage')] },
        },
        metadata: ref('sessionMetadata'),
      },
      ['sessionId', 'version', 'messages', 'metadata'],
    ),
    sessionStartRecord: record(
      'session.start',
      {
        version: { const: 1 },
        projectRoot: ref('nonEmptyString'),
        model: ref('nonEmptyString'),
        sandboxMode: ref('sandboxMode'),
        parentSessionId: ref('nonEmptyString'),
        title: { type: 'string' },
      },
      ['version', 'projectRoot', 'model', 'sandboxMode'],
    ),
    userMessageRecord: record(
      'user.message',
      { turn, content: { type: 'string' }, source: { enum: ['user', 'inject'] } },
      ['turn', 'content', 'source'],
    ),
    assistantMessageRecord: record(
      'assistant.message',
      {
        turn,
        step,
        requestId: ref('nonEmptyString'),
        content: { type: 'string' },
        toolCalls: { type: 'array', items: ref('toolCall') },
        usage: ref('usage'),
        finishReason: ref('finishReason'),
        interrupted: { const: true },
        providerContent: ref('jsonValue'),
        refusal: ref('refusalInfo'),
      },
      ['turn', 'step', 'requestId', 'content', 'usage', 'finishReason'],
    ),
    toolResultRecord: record(
      'tool.result',
      {
        turn,
        step,
        toolCallId: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        isError: { type: 'boolean' },
        error: ref('errorInfo'),
        meta: {},
        durationMs: ref('nonNegativeNumber'),
      },
      ['turn', 'step', 'toolCallId', 'name', 'content', 'isError', 'durationMs'],
    ),
    turnStartRecord: record('turn.start', { turn }, ['turn']),
    turnEndRecord: record('turn.end', { turn, reason: ref('turnEndReason') }, ['turn', 'reason']),
    checkpointRecord: record(
      'checkpoint',
      { coversSeq: ref('positiveInteger'), state: ref('sessionState') },
      ['coversSeq', 'state'],
    ),
    errorRecord: record('error', { turn, error: ref('errorInfo'), fatal: { type: 'boolean' } }, ['error', 'fatal']),
    approvalRequestRecord: record('approval.request', { turn, request: ref('approvalRequest') }, ['turn', 'request']),
    approvalDecisionRecord: record('approval.decision', { turn, decision: ref('approvalDecision') }, [
      'turn',
      'decision',
    ]),
    approvalGrantRecord: record('approval.grant', { grant: ref('approvalGrant') }, ['grant']),
  },
}

const DEFS = sessionRecordSchema.$defs as Record<string, JsonObject>
const KNOWN_TYPES = new Set<string>(SESSION_RECORD_TYPES)

/** Validates one value; returns the issues (empty = valid). */
export type RecordValidator = (value: unknown, options?: EvaluateOptions) => SchemaIssue[]

function defValidator(def: string): RecordValidator {
  const schema = DEFS[def]
  if (schema === undefined) throw new Error(`missing schema def ${def}`)
  return (value, options) => {
    if (!isJsonValue(value)) return [{ path: '/', message: 'not a JSON-safe value' }]
    return evaluateSchema(sessionRecordSchema, schema, value, options)
  }
}

/** One validator per record type, each checking the full record (common fields included). */
export const sessionRecordValidators: Readonly<Record<SessionRecordType, RecordValidator>> = Object.fromEntries(
  SESSION_RECORD_TYPES.map(type => [type, defValidator(SESSION_RECORD_DEFS[type])]),
) as Record<SessionRecordType, RecordValidator>

/** Validates a {@link SessionState} (the `checkpoint.state` payload). */
export const validateSessionState: RecordValidator = defValidator('sessionState')

/**
 * Validate any session record: JSON-safe, a known `type`, and that type's schema.
 * @param options - `allowAdditionalProperties` for lenient reading.
 */
export function validateSessionRecord(value: unknown, options?: EvaluateOptions): SchemaIssue[] {
  const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
    return [{ path: '/type', message: `unknown record type ${JSON.stringify(type)}` }]
  }
  return sessionRecordValidators[type as SessionRecordType](value, options)
}

/** Whether `value` is a valid {@link SessionRecord} (strict: no unknown fields). */
export function isSessionRecord(value: unknown): value is SessionRecord {
  return validateSessionRecord(value).length === 0
}

/** Whether `value` is a valid {@link SessionState}. */
export function isSessionState(value: unknown): value is SessionState {
  return validateSessionState(value).length === 0
}

/** Render issues as one line. */
export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')
}

/**
 * Throw `session/invalid-record` unless `value` is a valid session record.
 * @throws {NexgentError} `session/invalid-record` with the issues in `details`.
 */
export function assertSessionRecord(value: unknown): asserts value is SessionRecord {
  const issues = validateSessionRecord(value)
  if (issues.length > 0) {
    throw new NexgentError('session/invalid-record', `invalid session record: ${formatIssues(issues)}`, {
      details: { issues: issues.map(issue => ({ ...issue })) },
    })
  }
}
