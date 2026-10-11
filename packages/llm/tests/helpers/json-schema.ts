/**
 * A deliberately small JSON Schema (draft 2020-12) validator covering the
 * keywords `ledger.v1.schema.json` uses: `$ref` (local `#/$defs/...`),
 * `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`
 * (boolean), `items`, `oneOf`, `anyOf`, `allOf`, `minimum`, `maximum`,
 * `minLength`, `pattern`. No dependency on ajv.
 */
type Schema = Record<string, unknown> | boolean

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

function resolveRef(root: Record<string, unknown>, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`)
  let node: unknown = root
  for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown>)[part]
  if (node === undefined) throw new Error(`unresolved $ref ${ref}`)
  return node as Schema
}

/**
 * Validate a value; returns a list of error strings (empty = valid).
 * @param root - the root schema document.
 * @param value - the instance.
 */
export function validate(root: Record<string, unknown>, value: unknown, schema: Schema = root, path = '$'): string[] {
  if (schema === true) return []
  if (schema === false) return [`${path}: schema is false`]
  const errors: string[] = []
  if (typeof schema['$ref'] === 'string') errors.push(...validate(root, value, resolveRef(root, schema['$ref']), path))
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? schema['type'] as string[] : [schema['type'] as string]
    if (!types.some(type => matchesType(value, type))) return [...errors, `${path}: expected ${types.join('|')}, got ${typeOf(value)}`]
  }
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) errors.push(`${path}: expected const ${JSON.stringify(schema['const'])}`)
  if (Array.isArray(schema['enum']) && !schema['enum'].some(item => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`)
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) errors.push(`${path}: below minimum`)
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) errors.push(`${path}: above maximum`)
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) errors.push(`${path}: shorter than minLength`)
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) errors.push(`${path}: does not match ${schema['pattern']}`)
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in object)) errors.push(`${path}: missing required "${key}"`)
    }
    const properties = (schema['properties'] as Record<string, Schema> | undefined) ?? {}
    for (const [key, child] of Object.entries(object)) {
      const sub = properties[key]
      if (sub !== undefined) errors.push(...validate(root, child, sub, `${path}.${key}`))
      else if (schema['additionalProperties'] === false) errors.push(`${path}: unexpected property "${key}"`)
    }
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((item, i) => errors.push(...validate(root, item, schema['items'] as Schema, `${path}[${i}]`)))
  }
  if (Array.isArray(schema['allOf'])) {
    for (const sub of schema['allOf'] as Schema[]) errors.push(...validate(root, value, sub, path))
  }
  if (Array.isArray(schema['anyOf'])) {
    const results = (schema['anyOf'] as Schema[]).map(sub => validate(root, value, sub, path))
    if (!results.some(result => result.length === 0)) errors.push(`${path}: matches no anyOf branch`)
  }
  if (Array.isArray(schema['oneOf'])) {
    const results = (schema['oneOf'] as Schema[]).map(sub => validate(root, value, sub, path))
    const passing = results.filter(result => result.length === 0).length
    if (passing !== 1) {
      const nearest = results.reduce((best, result) => result.length < best.length ? result : best)
      errors.push(`${path}: matches ${passing} oneOf branches${passing === 0 ? ` (nearest: ${nearest.join('; ')})` : ''}`)
    }
  }
  return errors
}
