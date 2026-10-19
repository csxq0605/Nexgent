/**
 * JSON Schemas of the step-2 metadata files `@nexgent/tasking` writes:
 * `.nexgent/materials/<id>/material.json` and
 * `.nexgent/outputs/<deliverableId>/v<n>/deliverable.json`. Published as
 * `schema/material.v1.schema.json` and `schema/deliverable.v1.schema.json`;
 * a test keeps the files identical to these objects.
 *
 * They live here, next to the session and ledger schemas, so every
 * persisted format shares one evaluator. Normative text:
 * `docs/spec/data-formats.md` §材料元数据 and §成果元数据. Type mirror:
 * `packages/kernel/src/contracts/tasking.ts`.
 */
import { isJsonValue, type JsonObject } from '@nexgent/kernel'
import { closedObject, COMMON_DEFS, ref } from './common.js'
import { evaluateSchema, type EvaluateOptions, type SchemaIssue } from './evaluator.js'

const SHARED_DEFS: Record<string, JsonObject> = {
  timestamp: COMMON_DEFS.timestamp as JsonObject,
  nonEmptyString: COMMON_DEFS.nonEmptyString as JsonObject,
  positiveInteger: COMMON_DEFS.positiveInteger as JsonObject,
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  /** Project-relative, `/`-separated. */
  portablePath: { type: 'string', minLength: 1, pattern: '^[^\\\\]+$' },
  size: { type: 'integer', minimum: 0 },
}

/** Schema of `material.json`. */
export const materialMetadataSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/material.v1.schema.json',
  title: 'Nexgent material metadata v1',
  description: '.nexgent/materials/<id>/material.json. See docs/spec/data-formats.md.',
  ...closedObject(
    {
      formatVersion: { const: 1 },
      id: ref('nonEmptyString'),
      originalName: ref('nonEmptyString'),
      path: ref('portablePath'),
      size: ref('size'),
      sha256: ref('sha256'),
      mediaType: ref('nonEmptyString'),
      text: { type: 'boolean' },
      addedAt: ref('timestamp'),
      sessionId: ref('nonEmptyString'),
      status: { enum: ['active', 'removed'] },
      removedAt: ref('timestamp'),
    },
    ['formatVersion', 'id', 'originalName', 'path', 'size', 'sha256', 'mediaType', 'text', 'addedAt', 'status'],
  ),
  $defs: SHARED_DEFS,
}

/** Schema of `deliverable.json`. */
export const deliverableVersionSchema: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://nexgent.dev/schema/deliverable.v1.schema.json',
  title: 'Nexgent deliverable version metadata v1',
  description: '.nexgent/outputs/<deliverableId>/v<n>/deliverable.json. See docs/spec/data-formats.md.',
  ...closedObject(
    {
      formatVersion: { const: 1 },
      deliverableId: ref('nonEmptyString'),
      version: ref('positiveInteger'),
      title: ref('nonEmptyString'),
      summary: { type: 'string' },
      files: { type: 'array', minItems: 1, items: ref('deliverableFile') },
      presentedAt: ref('timestamp'),
      sessionId: ref('nonEmptyString'),
      turn: ref('positiveInteger'),
      toolCallId: ref('nonEmptyString'),
      memberId: ref('nonEmptyString'),
      memberName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
    },
    ['formatVersion', 'deliverableId', 'version', 'title', 'summary', 'files', 'presentedAt', 'sessionId', 'turn', 'toolCallId'],
  ),
  $defs: {
    ...SHARED_DEFS,
    deliverableFile: closedObject(
      { path: ref('portablePath'), size: ref('size'), sha256: ref('sha256'), mediaType: ref('nonEmptyString') },
      ['path', 'size', 'sha256', 'mediaType'],
    ),
  },
}

function validator(schema: JsonObject) {
  return (value: unknown, options?: EvaluateOptions): SchemaIssue[] => {
    if (!isJsonValue(value)) return [{ path: '/', message: 'not a JSON-safe value' }]
    return evaluateSchema(schema, schema, value, options)
  }
}

/** Validate a `material.json` value; empty = valid. */
export const validateMaterialMetadata = validator(materialMetadataSchema)

/** Validate a `deliverable.json` value; empty = valid. */
export const validateDeliverableVersion = validator(deliverableVersionSchema)
