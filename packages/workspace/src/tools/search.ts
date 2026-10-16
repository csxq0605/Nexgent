/**
 * Search tools: `list_files` (glob) and `search_text` (regular expression
 * over file contents). Walks never descend into `.nexgent/` or `.git/`, never
 * follow directory symlinks, and honour `.gitignore` (root, nested, negations,
 * `.git/info/exclude`) plus `node_modules/` unless `includeIgnored` is set.
 * Files the sandbox denies are skipped; files that need approval (sensitive
 * names) are never read here but are named in the result.
 */
import { createReadStream } from 'node:fs'
import { opendir, readFile, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { NexgentError, type ApprovalGrant, type ToolContext } from '@nexgent/kernel'
import { globToRegExp } from '../glob.js'
import { childScope, rootScope, type IgnoreScope } from '../gitignore.js'
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

/** Directory names never descended into by the search tools (unless `includeIgnored` lifts `node_modules`). */
export const SEARCH_IGNORED_DIRS: readonly string[] = ['.nexgent', 'node_modules', '.git']
/** Files larger than this are searched streaming, line by line, instead of read whole. */
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
/** Files read at the same time. */
const SEARCH_CONCURRENCY = 16
/** Largest file `multiline` reads whole. */
const MAX_MULTILINE_BYTES = 16 * 1024 * 1024
/** Longest line kept for matching; the rest of a longer line is dropped. */
const MAX_LINE_CHARS = 8 * 1024 * 1024
/** Printed line length cap. */
const PRINT_LINE_CHARS = 300
/** Most sensitive file names named in a result. */
const MAX_NAMED_SENSITIVE = 20
const MAX_CONTEXT = 50

/** One file found by {@link walkFiles}. */
export interface WalkEntry {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the walk base, `/`-separated. */
  readonly relative: string
  /** Needs approval to read (sensitive name): listed, never read by the search tools. */
  readonly sensitive?: boolean
}

/** Options of {@link walkFiles}. */
export interface WalkOptions {
  /** Directory names never entered. Default {@link SEARCH_IGNORED_DIRS}. */
  readonly ignored?: readonly string[]
  /** Do not apply `.gitignore` rules (and enter `node_modules`). */
  readonly includeIgnored?: boolean
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The `.gitignore` scope of directory `base` (project-relative `prefix`), or undefined outside the project. */
async function scopeAt(sandbox: LocalSandbox, base: string): Promise<{ scope: IgnoreScope; prefix: string; root: string } | undefined> {
  const prefix = sandbox.relative(base)
  // `.nexgent/` carries its own .gitignore for git sharing; it must not hide what the model targets there on purpose.
  if (prefix === undefined || prefix.split('/')[0] === '.nexgent') return undefined
  const root = sandbox.policy.projectRoot
  let scope = await rootScope(root)
  const segments = prefix === '' ? [] : prefix.split('/')
  for (let i = 0; i < segments.length; i += 1) scope = await childScope(root, scope, segments.slice(0, i + 1).join('/'))
  return { scope, prefix, root }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Collect readable files below `base`, sorted by relative path. Skips ignored
 * directories, `.gitignore`d entries and files the sandbox denies; files that
 * need approval are returned with `sensitive: true`.
 */
export async function collectFiles(base: string, sandbox: LocalSandbox, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const win = process.platform === 'win32'
  const names = options.ignored ?? (options.includeIgnored === true ? SEARCH_IGNORED_DIRS.filter(n => n !== 'node_modules') : SEARCH_IGNORED_DIRS)
  const ignore = new Set(names.map(name => (win ? name.toLowerCase() : name)))
  const ignoring = options.includeIgnored === true ? undefined : await scopeAt(sandbox, base)
  const prefix = ignoring?.prefix ?? ''
  const candidates: { path: string; relative: string }[] = []
  const stack: { rel: string; scope: IgnoreScope | undefined }[] = [{ rel: '', scope: ignoring?.scope }]
  while (stack.length > 0) {
    const { rel, scope } = stack.pop()!
    const dir = rel === '' ? base : nodePath.join(base, rel)
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]
    try {
      const handle = await opendir(dir)
      entries = []
      for await (const entry of handle) entries.push(entry)
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const portable = prefix === '' ? childRel : `${prefix}/${childRel}`
      if (entry.isDirectory()) {
        if (ignore.has(win ? entry.name.toLowerCase() : entry.name)) continue
        if (scope?.ignores(portable, true) === true) continue
        stack.push({ rel: childRel, scope: ignoring === undefined || scope === undefined ? undefined : await childScope(ignoring.root, scope, portable) })
        continue
      }
      const path = nodePath.join(base, childRel)
      if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => undefined)
        if (target === undefined || !target.isFile()) continue
      } else if (!entry.isFile()) {
        continue
      }
      if (scope?.ignores(portable, false) === true) continue
      candidates.push({ path, relative: childRel })
    }
  }
  candidates.sort((a, b) => compare(a.relative, b.relative))
  return candidates as WalkEntry[]
}

/** Assess candidates against the sandbox (bounded concurrency): denied are dropped, `ask` becomes `sensitive`. */
async function classify(entries: readonly WalkEntry[], sandbox: LocalSandbox): Promise<WalkEntry[]> {
  const assessed = await mapLimit(entries, SEARCH_CONCURRENCY, async entry => ({ entry, kind: (await sandbox.assessRead(entry.path)).kind }))
  const out: WalkEntry[] = []
  for (const { entry, kind } of assessed) {
    if (kind === 'allow') out.push(entry)
    else if (kind === 'ask') out.push({ ...entry, sensitive: true })
  }
  return out
}

/**
 * Yield readable files below `base` (sorted by relative path), skipping
 * ignored directories and anything the sandbox does not allow to read without
 * asking. Sensitive files are not yielded; use {@link collectFiles} to see them.
 */
export async function* walkFiles(base: string, sandbox: LocalSandbox, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  for (const entry of await classify(await collectFiles(base, sandbox, options), sandbox)) {
    if (entry.sensitive !== true) yield entry
  }
}

async function resolveBase(deps: ToolDeps, context: ToolContext, args: Record<string, unknown>) {
  const raw = stringField(args, 'path') ?? '.'
  return sandboxFor(deps, context).assessRead(context.workspace.resolve(raw))
}

function basePreflight(deps: ToolDeps, name: string) {
  return (input: unknown, context: ToolContext, grants?: readonly ApprovalGrant[]) => guardPreflight(async () => {
    const assessment = await resolveBase(deps, context, inputObject(input))
    // A sensitive name is not a directory to search; only a directory outside the project asks.
    return preflightFrom(assessment.kind === 'ask' && assessment.grantTool === undefined ? { ...assessment, kind: 'allow' } : assessment, {
      tool: name, mode: context.sandboxMode, summary: `search ${assessment.path}`,
      subjects: [{ kind: 'path', value: assessment.path.replaceAll('\\', '/') }],
      ...(grants === undefined ? {} : { grants }),
    })
  })
}

/**
 * The directory to walk and the sandbox to walk it with. A directory outside
 * the project asks first (ADR 0022 decision 2); once allowed, the walk reads
 * below it.
 */
async function directoryBase(deps: ToolDeps, context: ToolContext, args: Record<string, unknown>): Promise<{ base: string; sandbox: LocalSandbox }> {
  const assessment = await resolveBase(deps, context, args)
  const outside = assessment.kind === 'ask' && assessment.grantTool !== undefined
  const real = outside
    ? await enforce(assessment, context, { summary: `search ${assessment.path}`, subject: { kind: 'path', value: assessment.path.replaceAll('\\', '/') } })
    : await enforce(assessment.kind === 'ask' ? { kind: 'allow', path: assessment.path } : assessment, context, { summary: `search ${assessment.path}` })
  const info = await stat(real).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) throw new NexgentError('tool/failed', `${real} is not a directory`)
  const sandbox = sandboxFor(deps, context)
  return { base: real, sandbox: outside ? sandbox.withReadRoots([real]) : sandbox }
}

const SENSITIVE_MARK = '[sensitive: not read without approval]'

function globFilter(glob: string | undefined): (relative: string) => boolean {
  if (glob === undefined) return () => true
  const regexp = globToRegExp(glob, process.platform === 'win32')
  const noSlash = !glob.includes('/')
  return relative => regexp.test(relative) || (noSlash && regexp.test(relative.slice(relative.lastIndexOf('/') + 1)))
}

function intField(args: Record<string, unknown>, name: string, min: number, max?: number): number | undefined {
  const value = numberField(args, name)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new NexgentError('tool/invalid-input', `"${name}" must be an integer${max === undefined ? ` >= ${min}` : ` between ${min} and ${max}`}`)
  }
  return value
}

function limitField(args: Record<string, unknown>, fallback: number): number {
  return intField(args, 'limit', 1) ?? intField(args, 'maxResults', 1) ?? fallback
}

function clip(text: string): string {
  return text.length > PRINT_LINE_CHARS ? `${text.slice(0, PRINT_LINE_CHARS)}…` : text
}

function sensitiveFooter(sensitive: readonly string[]): string | undefined {
  if (sensitive.length === 0) return undefined
  const shown = sensitive.slice(0, MAX_NAMED_SENSITIVE).join(', ')
  const more = sensitive.length > MAX_NAMED_SENSITIVE ? `, … (+${sensitive.length - MAX_NAMED_SENSITIVE} more)` : ''
  return `[skipped ${sensitive.length} sensitive file${sensitive.length === 1 ? '' : 's'}, not searched (reading one needs approval; use read_file): ${shown}${more}]`
}

/** `list_files`: list files matching a glob below a directory. */
export function listFilesTool(deps: ToolDeps): WorkspaceTool {
  const name = 'list_files'
  return {
    definition: {
      name,
      description: 'List files below a project directory whose relative path matches a glob (default "**/*"), sorted by path. Respects .gitignore and skips .nexgent/, .git/ and node_modules/ (includeIgnored lifts the .gitignore rules). Sensitive files (need approval to read) are listed with a marker. Pages with offset/limit and reports the total.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'Directory to search, relative to the project root (default ".").' },
        pattern: { type: 'string', description: 'Glob over paths relative to that directory, e.g. "src/**/*.ts".' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum entries to return (default 500).' },
        maxResults: { type: 'integer', minimum: 1, description: 'Alias of limit.' },
        offset: { type: 'integer', minimum: 0, description: 'Entries to skip, for paging (default 0).' },
        includeIgnored: { type: 'boolean', description: 'Also list files excluded by .gitignore and node_modules/.' },
      }, []),
      effects: ['read'],
      approval: 'never',
    },
    preflight: basePreflight(deps, name),
    handler: async (input, context) => {
      const args = inputObject(input)
      const accept = globFilter(stringField(args, 'pattern') ?? '**/*')
      const limit = limitField(args, 500)
      const offset = intField(args, 'offset', 0) ?? 0
      const { base, sandbox } = await directoryBase(deps, context, args)
      const found = (await collectFiles(base, sandbox, { includeIgnored: booleanField(args, 'includeIgnored') === true })).filter(e => accept(e.relative))
      const all = await classify(found, sandbox)
      const page = all.slice(offset, offset + limit)
      const end = offset + page.length
      const lines = page.map(e => (e.sensitive === true ? `${e.relative}  ${SENSITIVE_MARK}` : e.relative))
      const more = end < all.length
      let footer: string
      if (all.length === 0) footer = 'No files found.'
      else if (page.length === 0) footer = `[offset ${offset} is past the end: ${all.length} files total]`
      else if (more) footer = `[showing ${offset + 1}-${end} of ${all.length} files; more results: pass offset ${end}]`
      else footer = `[${offset > 0 ? `showing ${offset + 1}-${end} of ${all.length}` : `${all.length}`} files total]`
      const content = lines.length === 0 ? footer : `${lines.join('\n')}\n${footer}`
      return { content, meta: { count: page.length, total: all.length, offset, truncated: more } }
    },
  }
}

type OutputMode = 'content' | 'files_with_matches' | 'count'

/** What searching one file found. */
interface FileSearch {
  readonly kind: 'ok' | 'binary' | 'unreadable' | 'too-large'
  /** Matching line numbers (capped), ascending. */
  readonly matches: readonly number[]
  /** Matching line count (uncapped only when the cap is `Infinity`). */
  readonly count: number
  /** Matching lines and captured context lines, by line number. */
  readonly lines: ReadonlyMap<number, string>
}

const NOTHING: Omit<FileSearch, 'kind'> = { matches: [], count: 0, lines: new Map() }

interface SearchSpec {
  readonly regexp: RegExp
  readonly multiline: boolean
  readonly before: number
  readonly after: number
  /** Stop after this many matching lines. */
  readonly cap: number
  readonly keepLines: boolean
  readonly signal: AbortSignal
}

/** Search one file line by line, reading it in chunks so large files are never held whole. */
async function searchStreaming(path: string, spec: SearchSpec): Promise<FileSearch> {
  const decoder = new StringDecoder('utf8')
  const matches: number[] = []
  const lines = new Map<number, string>()
  let ring: { n: number; text: string }[] = []
  let afterLeft = 0
  let lineNo = 0
  let pending = ''
  let overflow = false
  let first = true
  let count = 0
  const onLine = (raw: string): boolean => {
    lineNo += 1
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (spec.regexp.test(text)) {
      count += 1
      matches.push(lineNo)
      if (spec.keepLines) {
        lines.set(lineNo, clip(text))
        for (const entry of ring) lines.set(entry.n, entry.text)
      }
      ring = []
      afterLeft = spec.after
    } else if (afterLeft > 0) {
      afterLeft -= 1
      if (spec.keepLines) lines.set(lineNo, clip(text))
    } else if (spec.before > 0 && spec.keepLines) {
      ring.push({ n: lineNo, text: clip(text) })
      if (ring.length > spec.before) ring.shift()
    }
    return matches.length >= spec.cap && afterLeft === 0
  }
  try {
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      if (spec.signal.aborted) break
      if (first) {
        first = false
        if (chunk.subarray(0, 8192).includes(0)) return { kind: 'binary', ...NOTHING }
      }
      let text = decoder.write(chunk)
      if (overflow) {
        const newline = text.indexOf('\n')
        if (newline < 0) continue
        text = text.slice(newline)
        overflow = false
      }
      pending += text
      let start = 0
      for (let nl = pending.indexOf('\n', start); nl >= 0; nl = pending.indexOf('\n', start)) {
        const done = onLine(pending.slice(start, nl))
        start = nl + 1
        if (done) return { kind: 'ok', matches, count, lines }
      }
      pending = pending.slice(start)
      if (pending.length > MAX_LINE_CHARS) {
        pending = pending.slice(0, MAX_LINE_CHARS)
        overflow = true
      }
    }
    pending += decoder.end()
    if (pending !== '') onLine(pending)
  } catch {
    return { kind: 'unreadable', ...NOTHING }
  }
  return { kind: 'ok', matches, count, lines }
}

/** Multiline mode: read the file whole and match across line breaks. */
async function searchWhole(path: string, spec: SearchSpec): Promise<FileSearch> {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) return { kind: 'unreadable', ...NOTHING }
  if (info.size > MAX_MULTILINE_BYTES) return { kind: 'too-large', ...NOTHING }
  const buffer = await readFile(path).catch(() => undefined)
  if (buffer === undefined) return { kind: 'unreadable', ...NOTHING }
  if (buffer.subarray(0, 8192).includes(0)) return { kind: 'binary', ...NOTHING }
  const text = buffer.toString('utf8')
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const lineOf = (index: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const matched = new Set<number>()
  const regexp = new RegExp(spec.regexp.source, spec.regexp.flags)
  for (let m = regexp.exec(text); m !== null; m = regexp.exec(text)) {
    if (m[0] === '') {
      regexp.lastIndex += 1
      continue
    }
    const from = lineOf(m.index)
    const to = lineOf(m.index + m[0].length - (m[0].endsWith('\n') ? 1 : 0))
    for (let n = from; n <= to; n += 1) matched.add(n)
    if (matched.size >= spec.cap) break
  }
  const matches = [...matched].sort((a, b) => a - b).slice(0, Number.isFinite(spec.cap) ? spec.cap : undefined)
  const lines = new Map<number, string>()
  if (spec.keepLines) {
    const all = text.split('\n')
    const add = (n: number): void => {
      if (n >= 1 && n <= all.length) lines.set(n, clip((all[n - 1] ?? '').replace(/\r$/, '')))
    }
    for (const n of matches) {
      for (let k = n - spec.before; k <= n + spec.after; k += 1) add(k)
    }
  }
  return { kind: 'ok', matches, count: matches.length, lines }
}

/** `search_text`: regular-expression search over file contents. */
export function searchTextTool(deps: ToolDeps): WorkspaceTool {
  const name = 'search_text'
  return {
    definition: {
      name,
      description: 'Search file contents below a project directory with a regular expression (JavaScript syntax), in path order. Respects .gitignore and skips .nexgent/, .git/ and node_modules/ (includeIgnored lifts the .gitignore rules). outputMode "content" (default) prints path:line: text with optional context lines (path-line- text); "files_with_matches" lists paths; "count" prints path:matches. Large files are searched line by line; binary files are skipped and counted; sensitive files are not read and are named at the end. Pages with offset/limit; the result says when more exist.',
      inputSchema: objectSchema({
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search, relative to the project root (default ".").' },
        glob: { type: 'string', description: 'Only search files whose relative path matches this glob.' },
        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'What to return (default "content").' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive match.' },
        literal: { type: 'boolean', description: 'Treat pattern as plain text.' },
        multiline: { type: 'boolean', description: 'Let the pattern span line breaks ("." matches newlines; ^ and $ match at line ends).' },
        before: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT, description: 'Context lines before each match (content mode).' },
        after: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT, description: 'Context lines after each match (content mode).' },
        context: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT, description: 'Context lines before and after each match; before/after override it.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum matching lines (content, default 200) or files (other modes, default 500).' },
        maxResults: { type: 'integer', minimum: 1, description: 'Alias of limit.' },
        offset: { type: 'integer', minimum: 0, description: 'Matches (content) or files (other modes) to skip, for paging (default 0).' },
        includeIgnored: { type: 'boolean', description: 'Also search files excluded by .gitignore and node_modules/.' },
      }, ['pattern']),
      effects: ['read'],
      approval: 'never',
    },
    preflight: basePreflight(deps, name),
    handler: async (input, context) => {
      const args = inputObject(input)
      const source = stringField(args, 'pattern', true)
      const literal = booleanField(args, 'literal') === true
      const multiline = booleanField(args, 'multiline') === true
      const flags = `${booleanField(args, 'ignoreCase') === true ? 'i' : ''}${multiline ? 'gms' : ''}`
      let regexp: RegExp
      try {
        regexp = new RegExp(literal ? source.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') : source, flags)
      } catch (error) {
        throw new NexgentError('tool/invalid-input', `invalid regular expression: ${(error as Error).message}`)
      }
      const mode = (stringField(args, 'outputMode') ?? 'content') as OutputMode
      if (mode !== 'content' && mode !== 'files_with_matches' && mode !== 'count') {
        throw new NexgentError('tool/invalid-input', '"outputMode" must be "content", "files_with_matches" or "count"')
      }
      const both = intField(args, 'context', 0, MAX_CONTEXT) ?? 0
      const before = mode === 'content' ? intField(args, 'before', 0, MAX_CONTEXT) ?? both : 0
      const after = mode === 'content' ? intField(args, 'after', 0, MAX_CONTEXT) ?? both : 0
      const limit = limitField(args, mode === 'content' ? 200 : 500)
      const offset = intField(args, 'offset', 0) ?? 0
      const need = offset + limit
      const accept = globFilter(stringField(args, 'glob'))
      const { base, sandbox } = await directoryBase(deps, context, args)
      const found = (await collectFiles(base, sandbox, { includeIgnored: booleanField(args, 'includeIgnored') === true })).filter(e => accept(e.relative))
      const classified = await classify(found, sandbox)
      const sensitive = classified.filter(e => e.sensitive === true).map(e => e.relative)
      const files = classified.filter(e => e.sensitive !== true)
      const spec: SearchSpec = {
        regexp, multiline, before, after, signal: context.signal,
        cap: mode === 'content' ? need + 1 : mode === 'files_with_matches' ? 1 : Infinity,
        keepLines: mode === 'content',
      }
      const hits: { entry: WalkEntry; result: FileSearch }[] = []
      let units = 0
      let binary = 0
      let tooLarge = 0
      let stopped = false
      for (let i = 0; i < files.length && !stopped; i += SEARCH_CONCURRENCY) {
        if (context.signal.aborted) break
        const chunk = files.slice(i, i + SEARCH_CONCURRENCY)
        const results = await Promise.all(chunk.map(entry => (multiline ? searchWhole(entry.path, spec) : searchStreaming(entry.path, spec))))
        for (let k = 0; k < chunk.length; k += 1) {
          const result = results[k]!
          if (result.kind === 'binary') binary += 1
          else if (result.kind === 'too-large') tooLarge += 1
          if (result.matches.length === 0) continue
          hits.push({ entry: chunk[k]!, result })
          units += mode === 'content' ? result.matches.length : 1
        }
        if (units > need) stopped = true
      }
      const more = units > need
      const out: string[] = []
      let shown = 0
      if (mode === 'content') {
        let seen = 0
        let previous: { file: string; line: number } | undefined
        const withContext = before > 0 || after > 0
        for (const { entry, result } of hits) {
          const selected = result.matches.filter((_, idx) => seen + idx >= offset && seen + idx < need)
          seen += result.matches.length
          if (selected.length === 0) continue
          shown += selected.length
          const matchSet = new Set(result.matches)
          const wanted = new Set<number>()
          for (const n of selected) {
            for (let line = n - before; line <= n + after; line += 1) if (result.lines.has(line)) wanted.add(line)
          }
          for (const n of [...wanted].sort((a, b) => a - b)) {
            if (withContext && previous !== undefined && (previous.file !== entry.relative || n !== previous.line + 1)) out.push('--')
            out.push(`${entry.relative}${matchSet.has(n) ? ':' : '-'}${n}${matchSet.has(n) ? ':' : '-'} ${result.lines.get(n)!}`)
            previous = { file: entry.relative, line: n }
          }
        }
      } else {
        const page = hits.slice(offset, need)
        shown = page.length
        for (const { entry, result } of page) out.push(mode === 'count' ? `${entry.relative}:${result.count}` : entry.relative)
        if (mode === 'count' && !more && offset === 0 && hits.length > 0) {
          out.push(`[${hits.reduce((sum, h) => sum + h.result.count, 0)} matches in ${hits.length} files]`)
        }
      }
      if (shown === 0) out.push(hits.length > 0 || offset > 0 ? `[offset ${offset} is past the last result]` : 'No matches.')
      if (more) out.push(`[more results: pass offset ${need}]`)
      if (binary > 0) out.push(`[skipped ${binary} binary file${binary === 1 ? '' : 's'}]`)
      if (tooLarge > 0) out.push(`[skipped ${tooLarge} file${tooLarge === 1 ? '' : 's'} over ${MAX_MULTILINE_BYTES / (1024 * 1024)} MiB (multiline reads files whole)]`)
      const footer = sensitiveFooter(sensitive)
      if (footer !== undefined) out.push(footer)
      return {
        content: deps.redactor.redact(out.join('\n')),
        meta: { count: shown, offset, truncated: more, skippedBinary: binary, skippedSensitive: sensitive.length },
      }
    },
  }
}
