/**
 * Lossless JSON vocabulary shared by every contract. Everything that is
 * persisted (session records, ledger records, tool results) must be a
 * {@link JsonValue}, so a non-serializable value is rejected at the source
 * instead of silently degrading on disk.
 */

/** A JSON scalar. */
export type JsonPrimitive = null | boolean | number | string

/** Any JSON value: scalar, array or object. */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

/** A JSON object with string keys and JSON values. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/**
 * A JSON Schema document (draft 2020-12 subset) describing a tool's input.
 * Kept as a plain object so schemas can be authored by hand, generated from
 * schemastery, or handed to the model verbatim.
 */
export type JsonSchema = JsonObject

/**
 * Whether a value survives a `JSON.stringify` / `JSON.parse` round trip
 * unchanged: no `undefined`, functions, symbols, bigints, NaN/Infinity,
 * class instances or cycles.
 * @param value - the value to test.
 * @returns `true` when the value is a plain {@link JsonValue}.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJson(value, new Set())
}

function isJson(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      break
    default:
      return false
  }
  const object = value as object
  if (seen.has(object)) return false
  seen.add(object)
  try {
    if (Array.isArray(object)) return object.every(item => isJson(item, seen))
    const proto: unknown = Object.getPrototypeOf(object)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(object).every(item => isJson(item, seen))
  } finally {
    seen.delete(object)
  }
}
