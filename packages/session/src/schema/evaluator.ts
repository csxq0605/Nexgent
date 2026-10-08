/**
 * A small JSON Schema (draft 2020-12 subset) evaluator.
 *
 * The record schemas of this package are authored as plain JSON Schema
 * objects (they are also published as `schema/session.v1.schema.json`), and
 * this evaluator runs them, so the published schema and the runtime
 * validation cannot drift apart. Supported keywords: `type`, `const`, `enum`,
 * `properties`, `required`, `additionalProperties` (boolean only), `items`,
 * `oneOf`, `anyOf`, `$ref` (local `#/$defs/<name>` only), `minimum`,
 * `minLength`, `pattern`, `minItems`. Annotation keywords (`$schema`, `$id`,
 * `title`, `description`, `$defs`) are ignored. Anything else is a
 * programming error in the schema and throws.
 */
import type { JsonObject, JsonValue } from '@nexgent/kernel'

/** A schema node, as authored. */
export type SchemaNode = JsonObject

/** Evaluation options. */
export interface EvaluateOptions {
  /**
   * Ignore `additionalProperties: false`. Readers use this so a line written
   * by a newer same-version writer (extra optional fields) is still accepted.
   */
  readonly allowAdditionalProperties?: boolean
  /**
   * Treat every object schema that lists `properties` as closed, even without
   * `additionalProperties: false`. Writers of open formats (the ledger) use
   * this so nothing outside the declared fields can be written.
   */
  readonly forbidAdditionalProperties?: boolean
}

/** One validation failure: a JSON-pointer-like path plus a message. */
export interface SchemaIssue {
  readonly path: string
  readonly message: string
}

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'title', 'description',
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items',
  'oneOf', 'anyOf', '$ref', 'minimum', 'minLength', 'pattern', 'minItems',
])

/**
 * Validate `value` against `schema`, resolving `$ref`s against `root`.
 * @returns the issues found; empty when the value is valid.
 */
export function evaluateSchema(
  root: SchemaNode,
  schema: SchemaNode,
  value: unknown,
  options: EvaluateOptions = {},
): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  visit(root, schema, value, '', options, issues)
  return issues
}

const patternCache = new Map<string, RegExp>()

function visit(
  root: SchemaNode,
  schema: SchemaNode,
  value: unknown,
  path: string,
  options: EvaluateOptions,
  issues: SchemaIssue[],
): void {
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${path || '/'}`)
  }
  const fail = (message: string): void => {
    issues.push({ path: path || '/', message })
  }

  if (typeof schema.$ref === 'string') {
    visit(root, resolveRef(root, schema.$ref), value, path, options, issues)
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    fail(`expected ${JSON.stringify(schema.type)}, got ${describe(value)}`)
    return
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    fail(`expected ${JSON.stringify(schema.const)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => jsonEqual(item, value))) {
    fail(`expected one of ${JSON.stringify(schema.enum)}`)
    return
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    fail(`must be >= ${schema.minimum}`)
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`must have length >= ${schema.minLength}`)
    if (typeof schema.pattern === 'string') {
      let regex = patternCache.get(schema.pattern)
      if (regex === undefined) {
        regex = new RegExp(schema.pattern, 'u')
        patternCache.set(schema.pattern, regex)
      }
      if (!regex.test(value)) fail(`must match ${schema.pattern}`)
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`must have >= ${schema.minItems} items`)
    const items = schema.items
    if (isSchemaNode(items)) {
      value.forEach((item, index) => visit(root, items, item, `${path}/${index}`, options, issues))
    }
  }
  if (isPlainObject(value)) {
    const properties = isSchemaNode(schema.properties) ? schema.properties : undefined
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string' && !Object.hasOwn(value, name)) fail(`missing required property "${name}"`)
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties?.[name]
      if (isSchemaNode(childSchema)) {
        visit(root, childSchema, child, `${path}/${name}`, options, issues)
      } else if (closed(schema, options)) {
        issues.push({ path: `${path}/${name}`, message: 'unknown property' })
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      branch => isSchemaNode(branch) && evaluateSchema(root, branch, value, options).length === 0,
    ).length
    if (matches !== 1) fail(matches === 0 ? 'matches none of the allowed shapes' : 'matches more than one allowed shape')
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some(branch => isSchemaNode(branch) && evaluateSchema(root, branch, value, options).length === 0)
    if (!ok) fail('matches none of the allowed shapes')
  }
}

function closed(schema: SchemaNode, options: EvaluateOptions): boolean {
  if (options.forbidAdditionalProperties === true && isSchemaNode(schema.properties)) return true
  return schema.additionalProperties === false && options.allowAdditionalProperties !== true
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  const prefix = '#/$defs/'
  const defs = root.$defs
  if (ref.startsWith(prefix) && isSchemaNode(defs)) {
    const target = defs[ref.slice(prefix.length)]
    if (isSchemaNode(target)) return target
  }
  throw new Error(`unresolvable schema $ref "${ref}"`)
}

function matchesType(type: JsonValue, value: unknown): boolean {
  if (Array.isArray(type)) return type.some(item => matchesType(item, value))
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    default:
      throw new Error(`unsupported schema type ${JSON.stringify(type)}`)
  }
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return isPlainObject(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Structural equality of two JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  }
  return false
}
