/**
 * Search tools: `list_files` (glob) and `search_text` (regular expression
 * over file contents). Walks never descend into `.nexgent/`, `node_modules/`
 * or `.git/`, never follow directory symlinks, and skip files the sandbox
 * would not let `read_file` open (including sensitive files, which need
 * approval).
 */
import { opendir, readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { NexgentError, type ToolContext } from '@nexgent/kernel'
import { globToRegExp } from '../glob.js'
import type { LocalSandbox } from '../sandbox.js'
import {
  booleanField,
  enforce,
  guardPreflight,
  inputObject,
  numberField,
  objectSchema,
  preflightFrom,
  sandboxFor,
  stringField,
  type ToolDeps,
  type WorkspaceTool,
} from './common.js'

/** Directory names never descended into by the search tools. */
export const SEARCH_IGNORED_DIRS: readonly string[] = ['.nexgent', 'node_modules', '.git']
/** Files larger than this are skipped by `search_text`. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024

/** One file found by {@link walkFiles}. */
export interface WalkEntry {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the walk base, `/`-separated. */
  readonly relative: string
}

/**
 * Yield readable files below `base` (depth-first, sorted), skipping ignored
 * directories and anything the sandbox does not allow to read without asking.
 */
export async function* walkFiles(base: string, sandbox: LocalSandbox, ignored: readonly string[] = SEARCH_IGNORED_DIRS): AsyncGenerator<WalkEntry> {
  const ignore = new Set(ignored.map(name => (process.platform === 'win32' ? name.toLowerCase() : name)))
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    const dir = rel === '' ? base : nodePath.join(base, rel)
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]
    try {
      const handle = await opendir(dir)
      entries = []
      for await (const entry of handle) entries.push(entry)
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const subdirs: string[] = []
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const key = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
      if (entry.isDirectory()) {
        if (!ignore.has(key)) subdirs.push(childRel)
        continue
      }
      const path = nodePath.join(base, childRel)
      if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => undefined)
        if (target === undefined || !target.isFile()) continue
      } else if (!entry.isFile()) {
        continue
      }
      if ((await sandbox.assessRead(path)).kind !== 'allow') continue
      yield { path, relative: childRel }
    }
    for (const sub of subdirs.reverse()) stack.push(sub)
  }
}

async function resolveBase(deps: ToolDeps, context: ToolContext, args: Record<string, unknown>) {
  const raw = stringField(args, 'path') ?? '.'
  return sandboxFor(deps, context).assessRead(context.workspace.resolve(raw))
}

function basePreflight(deps: ToolDeps, name: string) {
  return (input: unknown, context: ToolContext) => guardPreflight(async () => {
    const assessment = await resolveBase(deps, context, inputObject(input))
    // Directory reads never escalate: a sensitive name is not a directory to search.
    return preflightFrom(assessment.kind === 'ask' ? { ...assessment, kind: 'allow' } : assessment, {
      tool: name, mode: context.sandboxMode, summary: `search ${assessment.path}`, subjects: [],
    })
  })
}

async function directoryBase(deps: ToolDeps, context: ToolContext, args: Record<string, unknown>): Promise<string> {
  const assessment = await resolveBase(deps, context, args)
  const real = await enforce(assessment.kind === 'ask' ? { kind: 'allow', path: assessment.path } : assessment, context, { summary: `search ${assessment.path}` })
  const info = await stat(real).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) throw new NexgentError('tool/failed', `${real} is not a directory`)
  return real
}

/** `list_files`: list files matching a glob below a directory. */
export function listFilesTool(deps: ToolDeps): WorkspaceTool {
  const name = 'list_files'
  return {
    definition: {
      name,
      description: 'List files below a project directory whose relative path matches a glob (default "**/*"). Skips .nexgent/, node_modules/ and .git/.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Directory to search, relative to the project root (default ".").' },
        pattern: { type: 'string', description: 'Glob over paths relative to that directory, e.g. "src/**/*.ts".' },
        maxResults: { type: 'integer', minimum: 1, description: 'Maximum entries to return (default 500).' },
      }, []),
      effects: ['read'],
      approval: 'never',
    },
    preflight: basePreflight(deps, name),
    handler: async (input, context) => {
      const args = inputObject(input)
      const pattern = stringField(args, 'pattern') ?? '**/*'
      const max = Math.max(1, Math.floor(numberField(args, 'maxResults') ?? 500))
      const base = await directoryBase(deps, context, args)
      const regexp = globToRegExp(pattern, process.platform === 'win32')
      const noSlash = !pattern.includes('/')
      const results: string[] = []
      let truncated = false
      for await (const entry of walkFiles(base, sandboxFor(deps, context))) {
        const baseName = entry.relative.slice(entry.relative.lastIndexOf('/') + 1)
        if (!regexp.test(entry.relative) && !(noSlash && regexp.test(baseName))) continue
        if (results.length >= max) {
          truncated = true
          break
        }
        results.push(entry.relative)
      }
      results.sort()
      const content = results.length === 0
        ? 'No files found.'
        : `${results.join('\n')}${truncated ? `\n[truncated at ${max} results]` : ''}`
      return { content, meta: { count: results.length, truncated } }
    },
  }
}

/** `search_text`: regular-expression search over file contents. */
export function searchTextTool(deps: ToolDeps): WorkspaceTool {
  const name = 'search_text'
  return {
    definition: {
      name,
      description: 'Search file contents below a project directory with a regular expression (JavaScript syntax). Returns path:line: text. Skips .nexgent/, node_modules/, .git/, binary and large files.',
      inputSchema: objectSchema({
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search, relative to the project root (default ".").' },
        glob: { type: 'string', description: 'Only search files whose relative path matches this glob.' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text.' },
        maxResults: { type: 'integer', minimum: 1, description: 'Maximum matching lines (default 200).' },
      }, ['pattern']),
      effects: ['read'],
      approval: 'never',
    },
    preflight: basePreflight(deps, name),
    handler: async (input, context) => {
      const args = inputObject(input)
      const source = stringField(args, 'pattern', true)
      const literal = booleanField(args, 'literal') === true
      const flags = booleanField(args, 'ignoreCase') === true ? 'i' : ''
      let regexp: RegExp
      try {
        regexp = new RegExp(literal ? source.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') : source, flags)
      } catch (error) {
        throw new NexgentError('tool/invalid-input', `invalid regular expression: ${(error as Error).message}`)
      }
      const glob = stringField(args, 'glob')
      const globRegexp = glob === undefined ? undefined : globToRegExp(glob, process.platform === 'win32')
      const max = Math.max(1, Math.floor(numberField(args, 'maxResults') ?? 200))
      const base = await directoryBase(deps, context, args)
      const lines: string[] = []
      let truncated = false
      outer: for await (const entry of walkFiles(base, sandboxFor(deps, context))) {
        if (globRegexp !== undefined) {
          const baseName = entry.relative.slice(entry.relative.lastIndexOf('/') + 1)
          if (!globRegexp.test(entry.relative) && !(glob!.includes('/') ? false : globRegexp.test(baseName))) continue
        }
        const info = await stat(entry.path).catch(() => undefined)
        if (info === undefined || info.size > MAX_SEARCH_FILE_BYTES) continue
        const buffer = await readFile(entry.path).catch(() => undefined)
        if (buffer === undefined || buffer.subarray(0, 8192).includes(0)) continue
        const fileLines = buffer.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < fileLines.length; i++) {
          const line = fileLines[i]!
          if (!regexp.test(line)) continue
          if (lines.length >= max) {
            truncated = true
            break outer
          }
          lines.push(`${entry.relative}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`)
        }
      }
      const content = lines.length === 0
        ? 'No matches.'
        : `${lines.join('\n')}${truncated ? `\n[truncated at ${max} matches]` : ''}`
      return { content: deps.redactor.redact(content), meta: { count: lines.length, truncated } }
    },
  }
}
