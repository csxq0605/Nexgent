/**
 * A deliberately small JSON Schema checker for tool arguments: `type`,
 * `properties`, `required`, `additionalProperties`, `items`, `enum`,
 * `const`, `minimum` / `maximum`, `minLength` / `maxLength`, `anyOf` /
 * `oneOf`. Unknown keywords are ignored (permissive), so a richer schema
 * never rejects valid input; it may admit some invalid input, which the
 * handler then reports.
 */
import type { JsonSchema } from './contracts/json.js'

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

/**
 * Validate a value; returns the first problem found as `<path>: <message>`,
 * or `undefined` when the value conforms.
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = '$'): string | undefined {
  const s = schema as Record<string, unknown>
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    if (!types.some(type => matchesType(value, type))) return `${path}: expected ${types.join(' | ')}, got ${typeOf(value)}`
  }
  if (Array.isArray(s.enum) && !s.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path}: must be one of ${s.enum.map(item => JSON.stringify(item)).join(', ')}`
  }
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) {
    return `${path}: must equal ${JSON.stringify(s.const)}`
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `${path}: must be >= ${s.minimum}`
    if (typeof s.maximum === 'number' && value > s.maximum) return `${path}: must be <= ${s.maximum}`
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) return `${path}: shorter than ${s.minLength}`
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) return `${path}: longer than ${s.maxLength}`
  }
  if (Array.isArray(value) && s.items !== undefined && typeof s.items === 'object' && !Array.isArray(s.items)) {
    for (const [index, item] of value.entries()) {
      const problem = validateJsonSchema(item, s.items as JsonSchema, `${path}[${index}]`)
      if (problem !== undefined) return problem
    }
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>
    const properties = (s.properties ?? {}) as Record<string, JsonSchema>
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (object[key] === undefined) return `${path}.${key}: is required`
      }
    }
    for (const [key, item] of Object.entries(object)) {
      const propertySchema = properties[key]
      if (propertySchema !== undefined) {
        const problem = validateJsonSchema(item, propertySchema, `${path}.${key}`)
        if (problem !== undefined) return problem
      } else if (s.additionalProperties === false) {
        return `${path}.${key}: unknown property`
      } else if (typeof s.additionalProperties === 'object' && s.additionalProperties !== null) {
        const problem = validateJsonSchema(item, s.additionalProperties as JsonSchema, `${path}.${key}`)
        if (problem !== undefined) return problem
      }
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = s[keyword]
    if (!Array.isArray(branches)) continue
    const passing = branches.filter(branch => validateJsonSchema(value, branch as JsonSchema, path) === undefined).length
    if (passing === 0 || (keyword === 'oneOf' && passing > 1)) return `${path}: does not match ${keyword}`
  }
  return undefined
}
