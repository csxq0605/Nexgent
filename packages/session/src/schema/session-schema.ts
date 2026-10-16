/**
 * JSON Schema of the session JSONL v1 records (and the checkpoint state),
 * plus the validators built on it. `schema/session.v1.schema.json` is this
 * object serialized; a test keeps the two identical.
 *
 * Normative text: `docs/spec/data-formats.md` §会话 JSONL v1. Type mirror:
 * `packages/kernel/src/contracts/session.ts`.
 */
import {
  CAPABILITY_COMPONENT_KINDS,
  CAPABILITY_VERSION_SWITCH_REASONS,
  COMPONENT_FILE_PATTERN,
  COMPARISON_ARMS,
  COMPONENT_NAME_PATTERN,
  IMPROVEMENT_PHASES,
  IMPROVER_SCOPES,
  IMPROVER_VERSION_PATTERN,
  isJsonValue,
  NexgentError,
  SESSION_PURPOSES,
  SESSION_RECORD_TYPES,
  type JsonObject,
  type SessionRecord,
  type SessionRecordType,
  type SessionState,
} from '@nexgent/kernel'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'
import { CAPABILITY_VERSION_SCHEMA } from './capabilities-schema.js'

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
  'session.mode': 'sessionModeRecord',
  'material.added': 'materialAddedRecord',
  'deliverable.presented': 'deliverablePresentedRecord',
  'turn.files': 'turnFilesRecord',
  feedback: 'feedbackRecord',
  'goal.set': 'goalSetRecord',
  'goal.update': 'goalUpdateRecord',
  'session.title': 'sessionTitleRecord',
  compaction: 'compactionRecord',
  'fork.seed': 'forkSeedRecord',
  'subagent.start': 'subagentStartRecord',
  'subagent.end': 'subagentEndRecord',
  'team.member': 'teamMemberRecord',
  'team.task': 'teamTaskRecord',
  'team.message': 'teamMessageRecord',
  'workflow.start': 'workflowStartRecord',
  'workflow.phase': 'workflowPhaseRecord',
  'workflow.end': 'workflowEndRecord',
  'capability.version': 'capabilityVersionRecord',
  'capability.draft': 'capabilityDraftRecord',
  'capability.try': 'capabilityTryRecord',
  'capability.propose': 'capabilityProposeRecord',
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
        member: ref('approvalMember'),
      },
      ['id', 'sessionId', 'callId', 'tool', 'summary', 'risk', 'options'],
    ),
    approvalMember: closedObject(
      { name: ref('memberName'), executionForm: ref('memberExecutionForm'), parentSessionId: ref('nonEmptyString') },
      ['name', 'executionForm', 'parentSessionId'],
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
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    memberName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
    memberExecutionForm: { enum: ['delegated', 'team', 'workflow'] },
    memberIdentity: closedObject(
      { name: ref('memberName'), executionForm: ref('memberExecutionForm'), preset: ref('nonEmptyString') },
      ['name', 'executionForm'],
    ),
    conversationMessages: {
      type: 'array',
      items: { oneOf: [ref('userMessage'), ref('assistantMessage'), ref('toolMessage')] },
    },
    memberResult: closedObject(
      {
        status: { enum: ['completed', 'failed', 'cancelled', 'budget', 'interrupted'] },
        text: { type: 'string' },
        deliverables: { type: 'array', items: ref('deliverableVersionRef') },
        usage: ref('usage'),
        requestCount: { type: 'integer', minimum: 0 },
        error: ref('errorInfo'),
      },
      ['status', 'text', 'deliverables', 'usage', 'requestCount'],
    ),
    teamMember: closedObject(
      {
        name: ref('memberName'),
        sessionId: ref('nonEmptyString'),
        status: { enum: ['active', 'idle', 'stopped'] },
        preset: ref('nonEmptyString'),
        persona: ref('nonEmptyString'),
      },
      ['name', 'sessionId', 'status'],
    ),
    teamTask: closedObject(
      {
        id: ref('nonEmptyString'),
        title: ref('nonEmptyString'),
        description: { type: 'string' },
        status: { enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
        owner: ref('nonEmptyString'),
        dependsOn: { type: 'array', items: ref('nonEmptyString') },
        result: { type: 'string' },
      },
      ['id', 'title', 'status', 'dependsOn'],
    ),
    teamMessage: closedObject(
      {
        id: ref('nonEmptyString'),
        from: ref('nonEmptyString'),
        to: ref('nonEmptyString'),
        text: { type: 'string', minLength: 1 },
        state: { enum: ['queued', 'delivered'] },
      },
      ['id', 'from', 'to', 'text', 'state'],
    ),
    portablePath: { type: 'string', minLength: 1, pattern: '^[^\\\\]+$' },
    materialRef: closedObject(
      {
        id: ref('nonEmptyString'),
        originalName: ref('nonEmptyString'),
        path: ref('portablePath'),
        size: { type: 'integer', minimum: 0 },
        sha256: ref('sha256'),
        mediaType: ref('nonEmptyString'),
      },
      ['id', 'originalName', 'path', 'size', 'sha256', 'mediaType'],
    ),
    deliverableFile: closedObject(
      { path: ref('portablePath'), size: { type: 'integer', minimum: 0 }, sha256: ref('sha256'), mediaType: ref('nonEmptyString') },
      ['path', 'size', 'sha256', 'mediaType'],
    ),
    deliverableVersionRef: closedObject(
      {
        deliverableId: ref('nonEmptyString'),
        version: ref('positiveInteger'),
        title: ref('nonEmptyString'),
        summary: { type: 'string' },
        files: { type: 'array', minItems: 1, items: ref('deliverableFile') },
        memberName: ref('memberName'),
      },
      ['deliverableId', 'version', 'title', 'summary', 'files'],
    ),
    fileChange: closedObject(
      { path: ref('portablePath'), change: { enum: ['added', 'modified', 'deleted'] } },
      ['path', 'change'],
    ),
    feedbackEntry: closedObject(
      {
        id: ref('nonEmptyString'),
        deliverableId: ref('nonEmptyString'),
        version: ref('positiveInteger'),
        rating: { enum: [1, 2, 3, 4, 5] },
        comment: { type: 'string' },
      },
      ['id', 'deliverableId', 'version', 'comment'],
    ),
    goalStatus: { enum: ['active', 'completed', 'abandoned'] },
    goal: closedObject(
      {
        id: ref('nonEmptyString'),
        text: { type: 'string' },
        status: ref('goalStatus'),
        setAt: ref('timestamp'),
        updatedAt: ref('timestamp'),
        note: { type: 'string' },
      },
      ['id', 'text', 'status', 'setAt', 'updatedAt'],
    ),
    turnEndReason: {
      oneOf: [
        closedObject({ kind: { const: 'completed' } }, ['kind']),
        closedObject({ kind: { const: 'cancelled' }, cause: { enum: ['user', 'timeout', 'shutdown', 'cost-cap', 'parent', 'step-limit'] } }, [
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
        plan: { type: 'boolean' },
        grants: { type: 'array', items: ref('approvalGrant') },
        title: { type: 'string' },
        lastTurn: { type: 'integer', minimum: 0 },
        openTurn: ref('positiveInteger'),
        totalUsage: ref('usage'),
        lastSeq: ref('positiveInteger'),
        goal: ref('goal'),
        lastCompactionSeq: ref('positiveInteger'),
        lastUsage: ref('usage'),
        parentSessionId: ref('nonEmptyString'),
        member: ref('memberIdentity'),
        capabilityVersion: ref('capabilityVersion'),
        purpose: { enum: [...SESSION_PURPOSES] },
        improvement: ref('sessionImprovement'),
      },
      ['createdAt', 'projectRoot', 'model', 'sandboxMode', 'grants', 'lastTurn', 'totalUsage', 'lastSeq'],
    ),
    sessionState: closedObject(
      {
        sessionId: ref('nonEmptyString'),
        version: { const: 1 },
        messages: ref('conversationMessages'),
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
        member: ref('memberIdentity'),
        capabilityVersion: ref('capabilityVersion'),
        purpose: { enum: [...SESSION_PURPOSES] },
        improvement: ref('sessionImprovement'),
        plan: { type: 'boolean' },
        commandSandbox: {
          oneOf: [
            closedObject({ kind: { const: 'active' }, platform: ref('nonEmptyString') }, ['kind', 'platform']),
            closedObject({ kind: { const: 'none' }, reason: { type: 'string' } }, ['kind', 'reason']),
            closedObject({ kind: { const: 'off' } }, ['kind']),
          ],
        },
      },
      ['version', 'projectRoot', 'model', 'sandboxMode'],
    ),
    sessionModeRecord: record(
      'session.mode',
      { sandboxMode: ref('sandboxMode'), plan: { type: 'boolean' }, reason: { enum: ['host', 'plan-approved'] } },
      ['sandboxMode', 'plan', 'reason'],
    ),
    userMessageRecord: record(
      'user.message',
      {
        turn,
        content: { type: 'string' },
        source: { enum: ['user', 'inject', 'feedback'] },
        materials: { type: 'array', items: ref('nonEmptyString') },
      },
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
    turnStartRecord: record('turn.start', { turn, handbook: { type: 'array', items: ref('nonEmptyString') } }, ['turn']),
    turnEndRecord: record('turn.end', { turn, reason: ref('turnEndReason') }, ['turn', 'reason']),
    checkpointRecord: record(
      'checkpoint',
      { coversSeq: ref('positiveInteger'), base: ref('positiveInteger'), keep: { type: 'integer', minimum: 0 }, state: ref('sessionState') },
      ['coversSeq', 'state'],
    ),
    errorRecord: record('error', { turn, error: ref('errorInfo'), fatal: { type: 'boolean' } }, ['error', 'fatal']),
    approvalRequestRecord: record('approval.request', { turn, request: ref('approvalRequest') }, ['turn', 'request']),
    approvalDecisionRecord: record('approval.decision', { turn, decision: ref('approvalDecision') }, [
      'turn',
      'decision',
    ]),
    approvalGrantRecord: record('approval.grant', { grant: ref('approvalGrant') }, ['grant']),
    materialAddedRecord: record('material.added', { turn, material: ref('materialRef') }, ['material']),
    deliverablePresentedRecord: record(
      'deliverable.presented',
      { turn, step, toolCallId: ref('nonEmptyString'), deliverable: ref('deliverableVersionRef') },
      ['turn', 'step', 'toolCallId', 'deliverable'],
    ),
    turnFilesRecord: record(
      'turn.files',
      { turn, changes: { type: 'array', items: ref('fileChange') }, omitted: ref('positiveInteger') },
      ['turn', 'changes'],
    ),
    feedbackRecord: record('feedback', { turn, feedback: ref('feedbackEntry') }, ['turn', 'feedback']),
    goalSetRecord: record('goal.set', { turn, goal: ref('goal') }, ['goal']),
    goalUpdateRecord: record(
      'goal.update',
      { turn, goalId: ref('nonEmptyString'), status: ref('goalStatus'), text: { type: 'string' }, note: { type: 'string' } },
      ['goalId', 'status'],
    ),
    sessionTitleRecord: record('session.title', { turn, title: ref('nonEmptyString') }, ['title']),
    compactionRecord: record(
      'compaction',
      {
        turn,
        step,
        summary: ref('nonEmptyString'),
        keepMessages: ref('positiveInteger'),
        compactedMessages: ref('positiveInteger'),
        requestId: ref('nonEmptyString'),
        usage: ref('usage'),
        trigger: closedObject(
          { inputTokens: { type: 'integer', minimum: 0 }, threshold: { type: 'integer', minimum: 1 } },
          ['inputTokens', 'threshold'],
        ),
      },
      ['turn', 'step', 'summary', 'keepMessages', 'compactedMessages', 'requestId', 'usage', 'trigger'],
    ),
    forkSeedRecord: record(
      'fork.seed',
      { fromSessionId: ref('nonEmptyString'), throughSeq: ref('positiveInteger'), messages: ref('conversationMessages') },
      ['fromSessionId', 'throughSeq', 'messages'],
    ),
    subagentStartRecord: record(
      'subagent.start',
      {
        turn,
        toolCallId: ref('nonEmptyString'),
        childSessionId: ref('nonEmptyString'),
        childTurn: ref('positiveInteger'),
        name: ref('memberName'),
        executionForm: ref('memberExecutionForm'),
        mode: { enum: ['fresh', 'fork'] },
        preset: ref('nonEmptyString'),
        workflowId: ref('nonEmptyString'),
        task: { type: 'string', pattern: '^[\\s\\S]{0,500}$' },
        materialIds: { type: 'array', items: ref('nonEmptyString') },
      },
      ['turn', 'childSessionId', 'childTurn', 'name', 'executionForm', 'task'],
    ),
    subagentEndRecord: record(
      'subagent.end',
      { turn, childSessionId: ref('nonEmptyString'), childTurn: ref('positiveInteger'), result: ref('memberResult') },
      ['turn', 'childSessionId', 'childTurn', 'result'],
    ),
    teamMemberRecord: record('team.member', { turn, member: ref('teamMember') }, ['member']),
    teamTaskRecord: record('team.task', { turn, task: ref('teamTask') }, ['task']),
    teamMessageRecord: record('team.message', { turn, message: ref('teamMessage') }, ['message']),
    workflowStartRecord: record(
      'workflow.start',
      {
        turn,
        toolCallId: ref('nonEmptyString'),
        workflowId: ref('nonEmptyString'),
        kind: { enum: ['script', 'graph'] },
        architecture: ref('sha256'),
        title: { type: 'string' },
      },
      ['turn', 'toolCallId', 'workflowId', 'kind'],
    ),
    workflowPhaseRecord: record(
      'workflow.phase',
      { turn, workflowId: ref('nonEmptyString'), phase: ref('nonEmptyString') },
      ['turn', 'workflowId', 'phase'],
    ),
    workflowEndRecord: record(
      'workflow.end',
      {
        turn,
        workflowId: ref('nonEmptyString'),
        status: { enum: ['completed', 'failed', 'cancelled', 'interrupted'] },
        members: { type: 'integer', minimum: 0 },
        error: ref('errorInfo'),
      },
      ['turn', 'workflowId', 'status', 'members'],
    ),
    capabilityVersion: CAPABILITY_VERSION_SCHEMA,
    sessionImprovement: closedObject(
      {
        jobId: ref('nonEmptyString'),
        phase: { enum: IMPROVEMENT_PHASES.filter(phase => phase !== 'trial') },
        improverVersion: { type: 'string', pattern: IMPROVER_VERSION_PATTERN.source },
        improverScope: { enum: [...IMPROVER_SCOPES] },
        metaJobId: ref('nonEmptyString'),
        comparisonArm: { enum: [...COMPARISON_ARMS] },
      },
      ['jobId', 'phase'],
    ),
    componentRef: closedObject(
      { kind: { enum: [...CAPABILITY_COMPONENT_KINDS] }, name: { type: 'string', pattern: COMPONENT_NAME_PATTERN.source } },
      ['kind', 'name'],
    ),
    capabilityFile: closedObject(
      {
        path: { type: 'string', pattern: COMPONENT_FILE_PATTERN.source },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        bytes: { type: 'integer', minimum: 0 },
      },
      ['path', 'sha256', 'bytes'],
    ),
    capabilityVersionRecord: record(
      'capability.version',
      {
        turn,
        version: ref('capabilityVersion'),
        previous: ref('capabilityVersion'),
        reason: { enum: [...CAPABILITY_VERSION_SWITCH_REASONS] },
        detail: { type: 'string' },
      },
      ['version', 'previous', 'reason'],
    ),
    capabilityDraftRecord: record(
      'capability.draft',
      {
        turn,
        step,
        toolCallId: ref('nonEmptyString'),
        component: ref('componentRef'),
        files: { type: 'array', minItems: 1, items: ref('capabilityFile') },
        revision: ref('positiveInteger'),
      },
      ['turn', 'step', 'toolCallId', 'component', 'files', 'revision'],
    ),
    capabilityTryRecord: record(
      'capability.try',
      {
        turn,
        step,
        toolCallId: ref('nonEmptyString'),
        component: ref('componentRef'),
        revision: ref('positiveInteger'),
        tools: { type: 'array', items: ref('nonEmptyString') },
      },
      ['turn', 'step', 'toolCallId', 'component', 'revision'],
    ),
    capabilityProposeRecord: record(
      'capability.propose',
      {
        turn,
        step,
        toolCallId: ref('nonEmptyString'),
        candidateId: ref('nonEmptyString'),
        proofs: {
          type: 'array',
          minItems: 1,
          items: closedObject(
            {
              kind: { enum: [...CAPABILITY_COMPONENT_KINDS] },
              name: { type: 'string', pattern: COMPONENT_NAME_PATTERN.source },
              turn,
              toolCallId: ref('nonEmptyString'),
            },
            ['kind', 'name', 'turn', 'toolCallId'],
          ),
        },
      },
      ['turn', 'step', 'toolCallId', 'candidateId', 'proofs'],
    ),
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
