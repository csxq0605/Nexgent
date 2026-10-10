/**
 * File tools: `read_file`, `write_file` and `str_replace`. Every call
 * resolves the path, consults the sandbox in `preflight`, and re-resolves in
 * the handler (second resolve) before opening the real path.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { NexgentError, type ApprovalGrant, type ToolContext } from '@nexgent/kernel'
import { comparablePath } from '../paths.js'
import type { SandboxAssessment } from '../sandbox.js'
import {
  enforce,
  guardPreflight,
  inputObject,
  numberField,
  objectSchema,
  preflightFrom,
  sandboxFor,
  stringField,
  type ToolDeps,
  type ToolPreflightResult,
  type WorkspaceTool,
} from './common.js'

/** Largest file `read_file` returns whole (bytes); larger reads must use a line range. */
export const MAX_READ_BYTES = 256 * 1024

/** Fields of `config.json` whose change always needs approval. */
const GUARDED_CONFIG_FIELDS = ['approvals', 'costCaps', 'sandboxMode'] as const

/**
 * Whether a config.json rewrite changes an always-ask field. Unparseable
 * text on either side counts as a change.
 */
export function guardedConfigChange(before: string | undefined, after: string): boolean {
  try {
    const old = before === undefined ? {} : JSON.parse(before) as Record<string, unknown>
    const next = JSON.parse(after) as Record<string, unknown>
    return GUARDED_CONFIG_FIELDS.some(field => JSON.stringify(old[field]) !== JSON.stringify(next[field]))
  } catch {
    return true
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Escalate full-access writes to the project config's guarded fields (always-ask table). */
async function guardConfigWrite(
  deps: ToolDeps,
  context: ToolContext,
  assessment: SandboxAssessment,
  nextContent: (current: string | undefined) => string,
): Promise<SandboxAssessment> {
  if (assessment.kind !== 'allow') return assessment
  const configFile = context.workspace.layout.configFile
  const sameFile = comparablePath(assessment.path) === comparablePath(nodePath.join(deps.sandbox.policy.projectRoot, '.nexgent', 'config.json'))
    || comparablePath(assessment.path) === comparablePath(configFile)
  if (!sameFile) return assessment
  const current = await readIfExists(assessment.path)
  let next: string
  try {
    next = nextContent(current)
  } catch {
    return assessment
  }
  if (!guardedConfigChange(current, next)) return assessment
  return {
    kind: 'ask',
    path: assessment.path,
    risk: 'high',
    options: ['once'],
    reason: 'changes approvals, costCaps or sandboxMode in .nexgent/config.json',
  }
}

function lineRange(text: string, offset: number | undefined, limit: number | undefined): { text: string; note?: string } {
  if (offset === undefined && limit === undefined) return { text }
  const lines = text.split('\n')
  const start = Math.max(1, Math.floor(offset ?? 1))
  const count = limit === undefined ? lines.length : Math.max(0, Math.floor(limit))
  const slice = lines.slice(start - 1, start - 1 + count)
  const end = start - 1 + slice.length
  return { text: slice.join('\n'), note: `[lines ${start}-${end} of ${lines.length}]` }
}

/** `read_file`: read a UTF-8 text file, optionally a line range. */
export function readFileTool(deps: ToolDeps): WorkspaceTool {
  const name = 'read_file'
  const assess = (input: unknown, context: ToolContext) =>
    sandboxFor(deps, context).assessRead(context.workspace.resolve(stringField(inputObject(input), 'path', true)))
  return {
    definition: {
      name,
      description: 'Read a UTF-8 text file in the project. Paths are relative to the project root. Use offset (1-based line) and limit for large files.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'File path, relative to the project root.' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        limit: { type: 'integer', minimum: 0, description: 'Maximum number of lines.' },
      }, ['path']),
      effects: ['read'],
      approval: 'never',
    },
    preflight: (input, context, grants) => guardPreflight(async () => {
      const path = stringField(inputObject(input), 'path', true)
      const assessment = await assess(input, context)
      return preflightFrom(assessment, {
        tool: name, mode: context.sandboxMode, summary: `read ${assessment.path}`,
        subjects: subjectsFor(deps, context, assessment.path), ...(grants === undefined ? {} : { grants }),
        detail: `requested path: ${path}`,
      })
    }),
    handler: async (input, context) => {
      const args = inputObject(input)
      const offset = numberField(args, 'offset')
      const limit = numberField(args, 'limit')
      const real = await enforcePath(deps, await assess(args, context), context, 'read')
      const info = await stat(real).catch((error: NodeJS.ErrnoException) => {
        throw new NexgentError('tool/failed', `cannot read ${real}: ${error.code ?? error.message}`)
      })
      if (info.isDirectory()) throw new NexgentError('tool/failed', `${real} is a directory; use list_files`)
      if (info.size > MAX_READ_BYTES && offset === undefined && limit === undefined) {
        throw new NexgentError('tool/failed', `${real} is ${info.size} bytes (limit ${MAX_READ_BYTES}); pass offset and limit to read part of it`)
      }
      const buffer = await readFile(real)
      if (buffer.subarray(0, 8192).includes(0)) throw new NexgentError('tool/failed', `${real} looks like a binary file`)
      const range = lineRange(buffer.toString('utf8'), offset, limit)
      const content = range.note === undefined ? range.text : `${range.text}\n${range.note}`
      return { content: deps.redactor.redact(content), meta: { path: real, bytes: info.size } }
    },
  }
}

async function enforcePath(deps: ToolDeps, assessment: SandboxAssessment, context: ToolContext, verb: string): Promise<string> {
  const [subject] = subjectsFor(deps, context, assessment.path)
  return enforce(assessment, context, { summary: `${verb} ${assessment.path}`, ...(subject === undefined ? {} : { subject }) })
}

function subjectsFor(deps: ToolDeps, _context: ToolContext, real: string): { kind: 'path'; value: string }[] {
  const rel = deps.sandbox.relative(real)
  return rel === undefined ? [] : [{ kind: 'path', value: rel }]
}

/** `write_file`: create or overwrite a file (parents are created). */
export function writeFileTool(deps: ToolDeps): WorkspaceTool {
  const name = 'write_file'
  const assess = async (args: Record<string, unknown>, context: ToolContext) => {
    const content = stringField(args, 'content', true)
    const first = await sandboxFor(deps, context).assessWrite(context.workspace.resolve(stringField(args, 'path', true)))
    return guardConfigWrite(deps, context, first, () => content)
  }
  return {
    definition: {
      name,
      description: 'Create or overwrite a UTF-8 text file in the project with the given content. Parent directories are created.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'File path, relative to the project root.' },
        content: { type: 'string', description: 'Complete new file content.' },
      }, ['path', 'content']),
      effects: ['write'],
      approval: 'never',
    },
    preflight: (input, context, grants) => guardPreflight(async () => {
      const args = inputObject(input)
      const assessment = await assess(args, context)
      return preflightFrom(assessment, {
        tool: name, mode: context.sandboxMode, summary: `write ${assessment.path}`,
        subjects: subjectsFor(deps, context, assessment.path), ...(grants === undefined ? {} : { grants }),
      })
    }),
    handler: async (input, context) => {
      const args = inputObject(input)
      const content = stringField(args, 'content', true)
      const real = await enforcePath(deps, await assess(args, context), context, 'write')
      const existed = (await readIfExists(real).catch(() => undefined)) !== undefined
      await mkdir(nodePath.dirname(real), { recursive: true })
      await writeFile(real, content, 'utf8')
      const bytes = Buffer.byteLength(content, 'utf8')
      return {
        content: `${existed ? 'Overwrote' : 'Created'} ${context.workspace.relative(real)} (${bytes} bytes)`,
        meta: { path: real, bytes, created: !existed },
      }
    },
  }
}

/** Outcome of {@link applyStrReplace}. */
export type StrReplaceResult =
  | { readonly ok: true; readonly content: string; readonly line: number }
  | { readonly ok: false; readonly reason: 'empty' | 'no-match' | 'multiple'; readonly lines: readonly number[] }

/**
 * Replace exactly one occurrence of `oldStr`. In a CRLF file, bare `\n` in
 * `oldStr` / `newStr` is converted to `\r\n` so the file stays CRLF.
 */
export function applyStrReplace(content: string, oldStr: string, newStr: string): StrReplaceResult {
  if (oldStr === '') return { ok: false, reason: 'empty', lines: [] }
  const crlf = content.includes('\r\n')
  const toEol = (text: string): string => (crlf ? text.replace(/\r?\n/g, '\r\n') : text)
  const needle = toEol(oldStr)
  const replacement = toEol(newStr)
  const positions: number[] = []
  for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, index + 1)) positions.push(index)
  const lineOf = (index: number): number => content.slice(0, index).split('\n').length
  if (positions.length === 0) return { ok: false, reason: 'no-match', lines: [] }
  if (positions.length > 1) return { ok: false, reason: 'multiple', lines: positions.map(lineOf) }
  const at = positions[0]!
  return { ok: true, content: content.slice(0, at) + replacement + content.slice(at + needle.length), line: lineOf(at) }
}

/** `str_replace`: replace one unique occurrence of `old_str` with `new_str`. */
export function strReplaceTool(deps: ToolDeps): WorkspaceTool {
  const name = 'str_replace'
  const assess = async (args: Record<string, unknown>, context: ToolContext) => {
    const oldStr = stringField(args, 'old_str', true)
    const newStr = stringField(args, 'new_str', true)
    const first = await sandboxFor(deps, context).assessWrite(context.workspace.resolve(stringField(args, 'path', true)))
    return guardConfigWrite(deps, context, first, current => {
      const result = applyStrReplace(current ?? '', oldStr, newStr)
      if (!result.ok) throw new Error(result.reason)
      return result.content
    })
  }
  return {
    definition: {
      name,
      description: 'Edit a text file by replacing old_str with new_str. old_str must match exactly one location (include surrounding lines to make it unique). Line endings of the file are preserved.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'File path, relative to the project root.' },
        old_str: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
        new_str: { type: 'string', description: 'Replacement text.' },
      }, ['path', 'old_str', 'new_str']),
      effects: ['read', 'write'],
      approval: 'never',
    },
    preflight: (input, context, grants?: readonly ApprovalGrant[]): Promise<ToolPreflightResult> => guardPreflight(async () => {
      const args = inputObject(input)
      const assessment = await assess(args, context)
      return preflightFrom(assessment, {
        tool: name, mode: context.sandboxMode, summary: `edit ${assessment.path}`,
        subjects: subjectsFor(deps, context, assessment.path), ...(grants === undefined ? {} : { grants }),
      })
    }),
    handler: async (input, context) => {
      const args = inputObject(input)
      const oldStr = stringField(args, 'old_str', true)
      const newStr = stringField(args, 'new_str', true)
      const real = await enforcePath(deps, await assess(args, context), context, 'edit')
      const current = await readIfExists(real)
      if (current === undefined) throw new NexgentError('tool/failed', `${real} does not exist; use write_file to create it`)
      const result = applyStrReplace(current, oldStr, newStr)
      if (!result.ok) {
        const message = result.reason === 'empty'
          ? 'old_str must not be empty'
          : result.reason === 'no-match'
            ? `No replacement was performed: old_str was not found in ${real}`
            : `No replacement was performed: old_str occurs ${result.lines.length} times (lines ${result.lines.join(', ')}) in ${real}; include more context to make it unique`
        throw new NexgentError('tool/failed', message, { details: { reason: result.reason, lines: [...result.lines] } })
      }
      await writeFile(real, result.content, 'utf8')
      return {
        content: `Edited ${context.workspace.relative(real)} at line ${result.line}`,
        meta: { path: real, line: result.line },
      }
    },
  }
}
