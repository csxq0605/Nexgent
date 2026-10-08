/**
 * Schema building blocks shared by the session and ledger record schemas.
 */
import type { JsonObject } from '@nexgent/kernel'

/** ISO-8601 UTC instant: `2026-10-07T08:00:00.000Z` (fraction optional). */
export const ISO_UTC_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$'

/** `$defs` used by both schemas. */
export const COMMON_DEFS: Record<string, JsonObject> = {
  timestamp: { type: 'string', pattern: ISO_UTC_PATTERN },
  nonEmptyString: { type: 'string', minLength: 1 },
  positiveInteger: { type: 'integer', minimum: 1 },
  nonNegativeNumber: { type: 'number', minimum: 0 },
  usageCount: { anyOf: [{ type: 'integer', minimum: 0 }, { const: 'unknown' }] },
  usage: {
    type: 'object',
    additionalProperties: false,
    required: ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens'],
    properties: {
      inputTokens: { $ref: '#/$defs/usageCount' },
      outputTokens: { $ref: '#/$defs/usageCount' },
      totalTokens: { $ref: '#/$defs/usageCount' },
      cacheReadTokens: { $ref: '#/$defs/usageCount' },
      reasoningTokens: { $ref: '#/$defs/usageCount' },
    },
  },
  finishReason: { enum: ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'] },
  errorInfo: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'code', 'message'],
    properties: {
      name: { type: 'string' },
      code: { $ref: '#/$defs/nonEmptyString' },
      message: { type: 'string' },
      details: { type: 'object' },
    },
  },
  approvalScope: { enum: ['once', 'session', 'project'] },
}

/** A closed object schema. */
export function closedObject(properties: Record<string, JsonObject>, required: readonly string[]): JsonObject {
  return { type: 'object', additionalProperties: false, required: [...required], properties }
}

/** `{ $ref: '#/$defs/<name>' }`. */
export function ref(name: string): JsonObject {
  return { $ref: `#/$defs/${name}` }
}
