/** JSON validation shared by workflow guests and host-side child composition. */
import type { ToolRestriction } from './index.ts'

/**
 * Validate a JSON tool mask before it crosses an execution boundary.
 * Registered names are checked later by the child's scoped `tools.restrict()`.
 * @param value - Object containing string-array `allow` and/or `deny` fields.
 * @returns Nothing; narrows the validated value to a tool restriction.
 * @throws When the mask has unsupported fields, no lists, or non-string entries.
 */
export function assertToolRestriction(value: unknown): asserts value is ToolRestriction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('toolFilter must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'allow' && key !== 'deny')) {
    throw new Error('toolFilter accepts only allow and deny')
  }
  if (record.allow === undefined && record.deny === undefined) {
    throw new Error('toolFilter must declare allow and/or deny')
  }
  for (const key of ['allow', 'deny'] as const) {
    const names: unknown = record[key]
    if (names === undefined) continue
    if (!Array.isArray(names)) {
      throw new Error(`toolFilter.${key} must be an array of strings`)
    }
    const entries: unknown[] = names
    if ([...entries].some(name => typeof name !== 'string')) {
      throw new Error(`toolFilter.${key} must be an array of strings`)
    }
  }
}
