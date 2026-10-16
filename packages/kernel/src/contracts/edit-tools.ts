/**
 * ADR 0017 decision 1: the file tools' inputs after the audit. `write_file`
 * may replace a file the session read (or any file with `overwrite: true`),
 * `str_replace` takes `replace_all` and several edits applied all or nothing,
 * and `read_file` numbers its lines. Names, input schemas and the pure
 * helpers are frozen here; `@nexgent/workspace` implements them (K2), keeps
 * the sandbox checks, and still records the previous content in the turn's
 * file changes and deliverables.
 *
 * Normative text: `docs/spec/permissions.md` §路径策略与写入限制 (编辑工具).
 */
import type { JsonSchema } from './json.js'

/** `write_file` arguments. */
export interface WriteFileInput {
  readonly path: string
  readonly content: string
  /** Replace an existing file even if this session never read it. */
  readonly overwrite?: boolean
}

/** `write_file` input schema. */
export const WRITE_FILE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', description: 'File path, relative to the project root.' },
    content: { type: 'string', description: 'Complete content of the file.' },
    overwrite: { type: 'boolean', description: 'Replace an existing file this session has not read.' },
  },
}

/**
 * Whether `write_file` may write (pure): a new path always; an existing one
 * when this session read it (any `read_file` of it, or a write by this
 * session) or the call says `overwrite: true`.
 */
export function mayWriteFile(input: { readonly exists: boolean; readonly readInSession: boolean; readonly overwrite?: boolean }): boolean {
  return !input.exists || input.readInSession || input.overwrite === true
}

/** One replacement. */
export interface TextEdit {
  readonly old_str: string
  readonly new_str: string
  /** Replace every occurrence instead of exactly one. */
  readonly replace_all?: boolean
}

/** `str_replace` arguments: one edit inline, or several in `edits` (not both). */
export interface StrReplaceInput {
  readonly path: string
  readonly old_str?: string
  readonly new_str?: string
  readonly replace_all?: boolean
  readonly edits?: readonly TextEdit[]
}

/** Edits one `str_replace` call may carry. */
export const MAX_TEXT_EDITS = 50

const editProperties = {
  old_str: { type: 'string', minLength: 1, description: 'Exact text to replace; must occur exactly once unless replace_all.' },
  new_str: { type: 'string', description: 'Replacement text.' },
  replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
} satisfies Record<string, JsonSchema>

/** `str_replace` input schema. */
export const STR_REPLACE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'File path, relative to the project root.' },
    ...editProperties,
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TEXT_EDITS,
      description: 'Several edits applied in order; the file is written only if all succeed.',
      items: { type: 'object', additionalProperties: false, required: ['old_str', 'new_str'], properties: editProperties },
    },
  },
}

/** Why an edit failed. */
export type TextEditFailure = 'empty' | 'not-found' | 'not-unique' | 'invalid'

/** The result of {@link applyTextEdits}. */
export type TextEditResult =
  | { readonly ok: true; readonly content: string; readonly replacements: number }
  | { readonly ok: false; readonly index: number; readonly failure: TextEditFailure }

/** The edits of a call: `edits`, or the inline one; `undefined` when both or neither are given. */
export function editsOf(input: StrReplaceInput): readonly TextEdit[] | undefined {
  const inline = input.old_str !== undefined || input.new_str !== undefined || input.replace_all !== undefined
  if (input.edits !== undefined) return inline ? undefined : input.edits
  if (input.old_str === undefined || input.new_str === undefined) return undefined
  return [{ old_str: input.old_str, new_str: input.new_str, ...(input.replace_all === undefined ? {} : { replace_all: input.replace_all }) }]
}

/**
 * Apply edits in order, each to the result of the previous one (pure); all
 * or nothing. An edit fails when `old_str` is empty, absent, or (without
 * `replace_all`) found more than once; `index` names the failing edit.
 */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): TextEditResult {
  if (edits.length === 0 || edits.length > MAX_TEXT_EDITS) return { ok: false, index: 0, failure: 'invalid' }
  let text = content
  let replacements = 0
  for (const [index, edit] of edits.entries()) {
    if (edit.old_str === '') return { ok: false, index, failure: 'empty' }
    const parts = text.split(edit.old_str)
    const found = parts.length - 1
    if (found === 0) return { ok: false, index, failure: 'not-found' }
    if (found > 1 && edit.replace_all !== true) return { ok: false, index, failure: 'not-unique' }
    text = parts.join(edit.new_str)
    replacements += found
  }
  return { ok: true, content: text, replacements }
}

/**
 * `read_file` output (pure): each line prefixed with its 1-based number, right-aligned to
 * six columns, and a tab (`     1\tfirst line`), like `cat -n`. `firstLine`
 * is the number of `lines[0]`. The numbers are never part of the file:
 * `str_replace` matches the text after the tab.
 */
export function numberLines(lines: readonly string[], firstLine = 1): string {
  return lines.map((line, index) => `${String(firstLine + index).padStart(6, ' ')}\t${line}`).join('\n')
}
