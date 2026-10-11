/**
 * Host functions over the project: the only way a PTC program touches
 * files. Every path resolves against the workspace and is checked with the
 * calling session's sandbox mode and path policy, the same rules as the
 * file tools (`permissions.md` §代码执行进程): a denial throws
 * `sandbox/denied`, an `ask` goes through the call's approval flow, and in
 * `read-only` every write is refused. Spreadsheets go through
 * `@nexgent/tool-spreadsheet` (the same reader, calculator and writer as
 * `read_spreadsheet` / `write_spreadsheet`).
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { NexgentError, type JsonValue, type Sandbox, type SandboxMode, type ToolContext } from '@nexgent/kernel'
import { DocumentError, serialToIso } from '@nexgent/skill'
import { Calculator, cellKey, columnLetters, FormulaError, loadWorkbook, MAX_SPREADSHEET_BYTES, usedBounds, writeSpreadsheetTool } from '@nexgent/tool-spreadsheet'
import type { HostFunction } from './runtime.js'

/** Largest file `readFile` returns. */
export const MAX_READ_BYTES = 10 * 1024 * 1024
/** Largest content `writeFile` accepts. */
export const MAX_WRITE_BYTES = 10 * 1024 * 1024
/** Entries `listDir` returns at most. */
export const MAX_LIST_ENTRIES = 2_000

interface ScopedSandbox extends Sandbox {
  withMode(mode: SandboxMode): Sandbox
  forSession(sessionId: string | undefined): Sandbox
}

/** The sandbox for one call: the session's mode and its own temp directory, as the file tools use it. */
function sandboxFor(sandbox: Sandbox, context: ToolContext): Sandbox {
  const scoped = sandbox as Partial<ScopedSandbox>
  const moded = typeof scoped.withMode === 'function' ? (scoped as ScopedSandbox).withMode(context.sandboxMode) : sandbox
  const session = moded as Partial<ScopedSandbox>
  return typeof session.forSession === 'function' ? (session as ScopedSandbox).forSession(context.sessionId) : moded
}

/** Check one path for the calling session; deny → `sandbox/denied`, ask → the call's approval flow. */
export async function enforcePath(sandbox: Sandbox, kind: 'read' | 'write', path: string, context: ToolContext): Promise<void> {
  if (kind === 'write' && context.sandboxMode === 'read-only') {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: write ${context.workspace.relative(path)} — the session is read-only`, { details: { mode: context.sandboxMode, path } })
  }
  const scoped = sandboxFor(sandbox, context)
  const decision = kind === 'read' ? await scoped.checkRead(path) : await scoped.checkWrite(path)
  if (decision.allowed) return
  if (decision.code !== 'approval-required') {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: ${kind} ${path} — ${decision.reason} [mode ${context.sandboxMode}, ${decision.code}]`, {
      details: { mode: context.sandboxMode, code: decision.code, path },
    })
  }
  if (await context.requestApproval({ ...decision.ask, summary: `${kind} ${path}` })) return
  throw new NexgentError('approval/denied', `not approved: ${kind} ${path} (${decision.reason})`)
}

function text(args: readonly JsonValue[], index: number, what: string): string {
  const value = args[index]
  if (typeof value !== 'string' || value === '') throw new NexgentError('tool/invalid-input', `${what} must be a non-empty string`)
  return value
}

function options(args: readonly JsonValue[], index: number, fn: string, allowed: readonly string[]): Record<string, JsonValue> {
  const value = args[index]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new NexgentError('tool/invalid-input', `${fn}() options must be an object`)
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new NexgentError('tool/invalid-input', `${fn}() does not take ${extra.join(', ')}`)
  return value as Record<string, JsonValue>
}

function encodingOf(value: JsonValue | undefined, fn: string): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf8') return 'utf8'
  if (value === 'base64') return 'base64'
  throw new NexgentError('tool/invalid-input', `${fn}() encoding must be "utf8" or "base64"`)
}

function cellValue(value: ReturnType<Calculator['value']>, date: boolean, date1904: boolean): JsonValue {
  if (value instanceof FormulaError) return value.code
  if (date && typeof value === 'number') return serialToIso(value, date1904)
  return value
}

/**
 * The project host functions for one tool call: `readFile(path, { encoding })`,
 * `writeFile(path, content, { encoding, overwrite })`, `listDir(path)`,
 * `exists(path)`, `readSpreadsheet(path, { sheet })` and
 * `writeSpreadsheet({ path, sheets, overwrite })`.
 */
export function projectFunctions(sandbox: Sandbox, context: ToolContext): HostFunction[] {
  const ws = context.workspace
  return [
    {
      name: 'readFile',
      async call(args) {
        const raw = text(args, 0, 'readFile() path')
        const encoding = encodingOf(options(args, 1, 'readFile', ['encoding']).encoding, 'readFile')
        const path = ws.resolve(raw)
        await enforcePath(sandbox, 'read', path, context)
        const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
          throw new NexgentError('tool/failed', `cannot read ${raw}: ${error.code ?? error.message}`)
        })
        if (!info.isFile()) throw new NexgentError('tool/failed', `${raw} is not a file`)
        if (info.size > MAX_READ_BYTES) throw new NexgentError('tool/failed', `${raw} is ${info.size} bytes; readFile returns files up to ${MAX_READ_BYTES} bytes`)
        return (await readFile(path)).toString(encoding)
      },
    },
    {
      name: 'writeFile',
      async call(args) {
        const raw = text(args, 0, 'writeFile() path')
        const content = args[1]
        if (typeof content !== 'string') throw new NexgentError('tool/invalid-input', 'writeFile() content must be a string')
        const opts = options(args, 2, 'writeFile', ['encoding', 'overwrite'])
        const encoding = encodingOf(opts.encoding, 'writeFile')
        if (opts.overwrite !== undefined && typeof opts.overwrite !== 'boolean') throw new NexgentError('tool/invalid-input', 'writeFile() overwrite must be a boolean')
        const bytes = Buffer.from(content, encoding)
        if (bytes.length > MAX_WRITE_BYTES) throw new NexgentError('tool/invalid-input', `writeFile() content is ${bytes.length} bytes; the limit is ${MAX_WRITE_BYTES}`)
        const path = ws.resolve(raw)
        await enforcePath(sandbox, 'write', path, context)
        const existing = await stat(path).then(info => info, () => undefined)
        if (existing !== undefined && !existing.isFile()) throw new NexgentError('tool/failed', `${raw} exists and is not a file`)
        if (existing !== undefined && opts.overwrite !== true) {
          throw new NexgentError('tool/failed', `${ws.relative(path)} already exists; pass { overwrite: true } to replace it`)
        }
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes, { flag: opts.overwrite === true ? 'w' : 'wx' })
        return { path: ws.relative(path), bytes: bytes.length, created: existing === undefined }
      },
    },
    {
      name: 'listDir',
      async call(args) {
        const raw = args[0] === undefined || args[0] === null ? '.' : text(args, 0, 'listDir() path')
        const path = ws.resolve(raw)
        await enforcePath(sandbox, 'read', path, context)
        const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          throw new NexgentError('tool/failed', `cannot list ${raw}: ${error.code ?? error.message}`)
        })
        return entries
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .slice(0, MAX_LIST_ENTRIES)
          .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other' }))
      },
    },
    {
      name: 'exists',
      async call(args) {
        const path = ws.resolve(text(args, 0, 'exists() path'))
        await enforcePath(sandbox, 'read', path, context)
        return await stat(path).then(() => true, () => false)
      },
    },
    {
      name: 'readSpreadsheet',
      async call(args) {
        const raw = text(args, 0, 'readSpreadsheet() path')
        const sheetName = options(args, 1, 'readSpreadsheet', ['sheet']).sheet
        if (sheetName !== undefined && typeof sheetName !== 'string') throw new NexgentError('tool/invalid-input', 'readSpreadsheet() sheet must be a string')
        const extension = extname(raw).toLowerCase()
        if (extension !== '.xlsx' && extension !== '.xlsm') throw new NexgentError('tool/invalid-input', `readSpreadsheet() reads .xlsx files, not ${raw}`)
        const path = ws.resolve(raw)
        await enforcePath(sandbox, 'read', path, context)
        const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
          throw new NexgentError('tool/failed', `cannot read ${raw}: ${error.code ?? error.message}`)
        })
        if (info.size > MAX_SPREADSHEET_BYTES) throw new NexgentError('tool/failed', `${raw} is ${info.size} bytes; the limit is ${MAX_SPREADSHEET_BYTES}`)
        let book
        try {
          book = loadWorkbook(await readFile(path))
        } catch (error) {
          if (error instanceof DocumentError) throw new NexgentError('tool/failed', `${raw}: ${error.message}`)
          throw error
        }
        const sheet = sheetName === undefined ? book.sheets[0] : book.sheets.find(candidate => candidate.name.toUpperCase() === sheetName.toUpperCase())
        if (sheet === undefined) {
          throw new NexgentError('tool/invalid-input', `no sheet named ${JSON.stringify(sheetName)}; sheets: ${book.sheets.map(s => s.name).join(', ')}`)
        }
        const calculator = new Calculator(book.sheets, { strict: false })
        const bounds = usedBounds(sheet)
        const rows: JsonValue[][] = []
        const formulas: Record<string, string> = {}
        if (bounds !== undefined) {
          for (let r = 1; r <= bounds.bottom; r++) {
            const row: JsonValue[] = []
            for (let c = 1; c <= bounds.right; c++) {
              const entry = sheet.cells.get(cellKey(r, c))
              row.push(cellValue(calculator.value(sheet.name, r, c), entry?.date === true, book.date1904))
              if (entry?.formula !== undefined) formulas[`${columnLetters(c)}${r}`] = `=${entry.formula}`
            }
            rows.push(row)
          }
        }
        return { sheets: book.sheets.map(s => s.name), sheet: sheet.name, rows, formulas }
      },
    },
    {
      name: 'writeSpreadsheet',
      async call(args) {
        const input = args[0]
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new NexgentError('tool/invalid-input', 'writeSpreadsheet() takes { path, sheets, overwrite? } like the write_spreadsheet tool')
        }
        const path = (input as Record<string, JsonValue>).path
        if (typeof path === 'string' && path !== '') await enforcePath(sandbox, 'write', ws.resolve(path), context)
        // The tool checks the path again with the same rules; approval was already obtained above.
        const output = await writeSpreadsheetTool(sandbox).handler(input, { ...context, approved: true })
        if (output.isError === true) throw new NexgentError('tool/failed', output.content)
        return { message: output.content, ...(output.meta === undefined ? {} : { meta: output.meta }) }
      },
    },
  ]
}
