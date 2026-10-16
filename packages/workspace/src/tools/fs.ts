/**
 * File tools: `read_file`, `write_file` and `str_replace`. Every call
 * resolves the path, consults the sandbox in `preflight`, and re-resolves in
 * the handler (second resolve) before opening the real path.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  GUARDED_PROJECT_CONFIG_FIELDS,
  MAX_TEXT_EDITS,
  NexgentError,
  STR_REPLACE_INPUT_SCHEMA,
  WRITE_FILE_INPUT_SCHEMA,
  applyTextEdits,
  editsOf,
  mayWriteFile,
  numberLines,
  type ApprovalGrant,
  type StrReplaceInput,
  type TextEdit,
  type ToolContext,
} from '@nexgent/kernel'
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

/** Fields of `config.json` whose change always needs approval (contract list). */
const GUARDED_CONFIG_FIELDS = GUARDED_PROJECT_CONFIG_FIELDS

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

/** Whether anything (file, directory, link target) exists at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
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
    reason: 'changes approvals, costCaps, sandboxMode or capabilities in .nexgent/config.json',
  }
}

/** Files each session has read or written (real paths); in memory, per tool set, reset on process restart. */
const sessionFiles = new WeakMap<object, Map<string, Set<string>>>()

function touched(deps: ToolDeps, sessionId: string): Set<string> {
  let sessions = sessionFiles.get(deps)
  if (sessions === undefined) sessionFiles.set(deps, sessions = new Map())
  let files = sessions.get(sessionId)
  if (files === undefined) sessions.set(sessionId, files = new Set())
  return files
}

const markTouched = (deps: ToolDeps, context: ToolContext, real: string): void => {
  touched(deps, context.sessionId).add(comparablePath(real))
}

function lineRange(text: string, offset: number | undefined, limit: number | undefined): { lines: string[]; first: number; note?: string } {
  const lines = text.split('\n')
  if (offset === undefined && limit === undefined) return { lines, first: 1 }
  const start = Math.max(1, Math.floor(offset ?? 1))
  const count = limit === undefined ? lines.length : Math.max(0, Math.floor(limit))
  const slice = lines.slice(start - 1, start - 1 + count)
  const end = start - 1 + slice.length
  return { lines: slice, first: start, note: `[lines ${start}-${end} of ${lines.length}]` }
}

/** `read_file`: read a UTF-8 text file, optionally a line range. */
export function readFileTool(deps: ToolDeps): WorkspaceTool {
  const name = 'read_file'
  const assess = (input: unknown, context: ToolContext) =>
    sandboxFor(deps, context).assessRead(context.workspace.resolve(stringField(inputObject(input), 'path', true)))
  return {
    definition: {
      name,
      description: 'Read a UTF-8 text file in the project; each line is prefixed with its number and a tab (not part of the file). Paths are relative to the project root. Use offset (1-based line) and limit for large files.',
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
      const numbered = numberLines(range.lines, range.first)
      const content = range.note === undefined ? numbered : `${numbered}\n${range.note}`
      markTouched(deps, context, real)
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

/**
 * `write_file`: write a whole file (parents are created). A new path is
 * always written; an existing one only when this session read or wrote it,
 * or the call says `overwrite: true` (ADR 0017 decision 1, `mayWriteFile`).
 * A new file is created exclusively (`wx`), so one that appears between the
 * check and the write is not clobbered unnoticed.
 */
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
      description: 'Write a UTF-8 text file (parent directories are created). An existing file is replaced only if you read it in this session, or pass overwrite: true. Prefer str_replace for small changes.',
      inputSchema: WRITE_FILE_INPUT_SCHEMA as never,
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
      const overwrite = args.overwrite === true
      const real = await enforcePath(deps, await assess(args, context), context, 'write')
      const shown = context.workspace.relative(real)
      const exists = await pathExists(real)
      const readInSession = touched(deps, context.sessionId).has(comparablePath(real))
      if (exists && (await stat(real)).isDirectory()) {
        throw new NexgentError('tool/failed', `${shown} is a directory`, { details: { reason: 'directory' } })
      }
      if (!mayWriteFile({ exists, readInSession, overwrite })) {
        throw new NexgentError('tool/failed',
          `${shown} already exists and was not read in this session. Read it with read_file first, or pass overwrite: true to replace it.`,
          { details: { reason: 'exists' } })
      }
      await mkdir(nodePath.dirname(real), { recursive: true })
      if (exists) {
        await writeFile(real, content, 'utf8')
      } else {
        try {
          await writeFile(real, content, { encoding: 'utf8', flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          throw new NexgentError('tool/failed',
            `${shown} appeared while writing; read it with read_file first, or pass overwrite: true to replace it.`,
            { details: { reason: 'exists' } })
        }
      }
      markTouched(deps, context, real)
      const bytes = Buffer.byteLength(content, 'utf8')
      return {
        content: `${exists ? 'Wrote' : 'Created'} ${shown} (${bytes} bytes)`,
        meta: exists ? { path: real, bytes } : { path: real, bytes, created: true },
      }
    },
  }
}

/** Why a `str_replace` call could not be applied. */
type EditProblem = { readonly message: string; readonly details: { reason: string; index?: number; lines?: number[] } }

/**
 * Apply the edits of one call to `content` (all or nothing). In a CRLF file,
 * bare `\n` in `old_str` / `new_str` becomes `\r\n` so the file stays CRLF.
 */
export function applyEdits(content: string, edits: readonly TextEdit[], shown: string): { content: string; replacements: number } | EditProblem {
  const crlf = content.includes('\r\n')
  const toEol = (text: string): string => (crlf ? text.replace(/\r?\n/g, '\r\n') : text)
  const converted = edits.map(e => ({ ...e, old_str: toEol(e.old_str), new_str: toEol(e.new_str) }))
  const result = applyTextEdits(content, converted)
  if (result.ok) return { content: result.content, replacements: result.replacements }
  const { index } = result
  const label = edits.length > 1 ? `edit ${index + 1} of ${edits.length}` : 'old_str'
  const note = edits.length > 1 ? '; no edit was applied, the file is unchanged' : ''
  switch (result.failure) {
    case 'empty':
      return { message: `No replacement was performed: ${label} has an empty old_str${note}`, details: { reason: 'empty', index } }
    case 'not-found':
      return { message: `No replacement was performed: ${label} was not found in ${shown}${note}`, details: { reason: 'no-match', index } }
    case 'not-unique': {
      // text the failing edit saw: the earlier edits applied in order
      const before = index === 0 ? content : (applyTextEdits(content, converted.slice(0, index)) as { content: string }).content
      const needle = converted[index]!.old_str
      const lines: number[] = []
      for (let at = before.indexOf(needle); at !== -1; at = before.indexOf(needle, at + 1)) lines.push(before.slice(0, at).split('\n').length)
      return {
        message: `No replacement was performed: ${label} occurs ${lines.length} times (lines ${lines.join(', ')}) in ${shown}; include more context to make it unique, or set replace_all${note}`,
        details: { reason: 'multiple', index, lines },
      }
    }
    default:
      return { message: `No replacement was performed: expected 1 to ${MAX_TEXT_EDITS} edits`, details: { reason: 'invalid', index } }
  }
}

const isProblem = (value: ReturnType<typeof applyEdits>): value is EditProblem => 'message' in value

function editsFromArgs(args: Record<string, unknown>): readonly TextEdit[] {
  const edits = editsOf(args as unknown as StrReplaceInput)
  if (edits === undefined) {
    throw new NexgentError('tool/invalid-input', 'str_replace takes either old_str and new_str, or edits (not both)')
  }
  return edits
}

/** `str_replace`: replace text in an existing file; one inline edit or several (all or nothing). */
export function strReplaceTool(deps: ToolDeps): WorkspaceTool {
  const name = 'str_replace'
  const assess = async (args: Record<string, unknown>, context: ToolContext) => {
    const edits = editsFromArgs(args)
    const first = await sandboxFor(deps, context).assessWrite(context.workspace.resolve(stringField(args, 'path', true)))
    return guardConfigWrite(deps, context, first, current => {
      const result = applyEdits(current ?? '', edits, '')
      if (isProblem(result)) throw new Error(result.message)
      return result.content
    })
  }
  return {
    definition: {
      name,
      description: 'Change an existing text file by replacing old_str with new_str. old_str must match exactly one place unless replace_all is set. Pass edits to apply several in order; the file is written only if all succeed. Line endings are preserved.',
      inputSchema: STR_REPLACE_INPUT_SCHEMA as never,
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
      const edits = editsFromArgs(args)
      const real = await enforcePath(deps, await assess(args, context), context, 'edit')
      const current = await readIfExists(real)
      if (current === undefined) throw new NexgentError('tool/failed', `${real} does not exist; use write_file to create it`)
      const result = applyEdits(current, edits, real)
      if (isProblem(result)) throw new NexgentError('tool/failed', result.message, { details: result.details })
      await writeFile(real, result.content, 'utf8')
      markTouched(deps, context, real)
      return {
        content: `Edited ${context.workspace.relative(real)} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'})`,
        meta: { path: real, replacements: result.replacements },
      }
    },
  }
}
