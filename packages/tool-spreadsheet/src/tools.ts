/**
 * The `read_spreadsheet` and `write_spreadsheet` tools. Paths resolve
 * against the workspace and pass the sandbox for the call's mode
 * (`checkRead` / `checkWrite`): a denial is `sandbox/denied`, an `ask` goes
 * through the call's approval flow. Neither tool runs anything from the
 * file.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { NexgentError, type Sandbox, type SandboxMode, type Tool, type ToolContext } from '@nexgent/kernel'
import { csvField, DocumentError, serialToIso } from '@nexgent/skill'
import { columnLetters, parseAddress } from './formula/lexer.js'
import { SUPPORTED_FUNCTIONS } from './formula/functions.js'
import { clean, FormulaError, type Scalar } from './formula/values.js'
import { loadWorkbook } from './read.js'
import { CalculationError, Calculator, cellKey, cellLabel, usedBounds, type SheetData } from './workbook.js'
import { buildWorkbook, SpreadsheetInputError, WRITE_LIMITS } from './write.js'

/** Largest file `read_spreadsheet` opens (50 MiB, as `read_document`). */
export const MAX_SPREADSHEET_BYTES = 50 * 1024 * 1024

/** Most cells one `read_spreadsheet` call returns. */
export const MAX_READ_RANGE_CELLS = 5_000

/** Formula values listed in a `write_spreadsheet` result at most. */
export const MAX_LISTED_VALUES = 60

interface ModalSandbox extends Sandbox {
  withMode(mode: SandboxMode): Sandbox
}

function sandboxFor(sandbox: Sandbox, mode: SandboxMode): Sandbox {
  return typeof (sandbox as Partial<ModalSandbox>).withMode === 'function' ? (sandbox as ModalSandbox).withMode(mode) : sandbox
}

/** Enforce the sandbox for one path: deny → `sandbox/denied`; ask → the call's approval flow. */
async function enforce(sandbox: Sandbox, kind: 'read' | 'write', path: string, context: ToolContext): Promise<void> {
  const scoped = sandboxFor(sandbox, context.sandboxMode)
  const decision = kind === 'read' ? await scoped.checkRead(path) : await scoped.checkWrite(path)
  if (decision.allowed) return
  if (decision.code !== 'approval-required') {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: path ${path} — ${decision.reason} [mode ${context.sandboxMode}, ${decision.code}]`, {
      details: { mode: context.sandboxMode, code: decision.code, path },
    })
  }
  if (context.approved) return
  if (await context.requestApproval({ ...decision.ask, summary: `${kind} ${path}` })) return
  throw new NexgentError('approval/denied', `not approved: ${kind} ${path} (${decision.reason})`)
}

function args(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new NexgentError('tool/invalid-input', 'arguments must be an object')
  return input as Record<string, unknown>
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new NexgentError('tool/invalid-input', `"${name}" must be a string`)
  return value
}

/** Parse `A1:C10` / `B2` into bounds. */
export function parseRange(text: string): { top: number; left: number; bottom: number; right: number } | undefined {
  const [first, second, extra] = text.trim().split(':')
  if (first === undefined || extra !== undefined) return undefined
  const from = parseAddress(first.trim())
  const to = second === undefined ? from : parseAddress(second.trim())
  if (from === undefined || to === undefined) return undefined
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.column, to.column),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.column, to.column),
  }
}

function display(value: Scalar, date: boolean, date1904: boolean): string {
  if (value === null) return ''
  if (value instanceof FormulaError) return value.code
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return date ? serialToIso(value, date1904) : String(clean(value))
  return value
}

function sameValue(a: Scalar, b: Scalar): boolean {
  if (a instanceof FormulaError || b instanceof FormulaError) return a instanceof FormulaError && b instanceof FormulaError && a.code === b.code
  if (typeof a === 'number' && typeof b === 'number') return clean(a) === clean(b)
  return a === b
}

const RANGE_NOTE = `at most ${MAX_READ_RANGE_CELLS} cells per call`

/** `read_spreadsheet` reading through `sandbox`. */
export function readSpreadsheetTool(sandbox: Sandbox): Tool {
  return {
    definition: {
      name: 'read_spreadsheet',
      description: 'Read cells of an .xlsx workbook in the project (attached materials included): values and the formulas behind them. '
        + 'Formulas are recalculated from the workbook\'s current inputs; a formula the calculator does not support keeps the value saved in the file and is reported. '
        + `Lists every sheet with its used range; shows one sheet (default the first) as CSV with row numbers and column letters, ${RANGE_NOTE} (pass range like "A1:F40" to page). Read-only.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, description: 'Project path of an .xlsx / .xlsm file.' },
          sheet: { type: 'string', description: 'Sheet name (case-insensitive); default the first sheet.' },
          range: { type: 'string', description: `Cells to show, like "A1:F40"; default the used range (${RANGE_NOTE}).` },
        },
      },
      effects: ['read'],
      approval: 'never',
    },
    handler: async (input, context) => {
      const record = args(input)
      const rawPath = optionalString(record, 'path')
      if (rawPath === undefined || rawPath === '') throw new NexgentError('tool/invalid-input', '"path" is required')
      const sheetName = optionalString(record, 'sheet')
      const rangeText = optionalString(record, 'range')
      const extension = extname(rawPath).toLowerCase()
      if (extension !== '.xlsx' && extension !== '.xlsm') {
        throw new NexgentError('tool/invalid-input', `read_spreadsheet reads .xlsx files; ${extension === '.csv' ? 'read CSV with read_file' : extension === '.xls' ? 'the old binary .xls format is not supported; save it as .xlsx' : `use read_document or read_file for ${rawPath}`}`)
      }
      const path = context.workspace.resolve(rawPath)
      await enforce(sandbox, 'read', path, context)
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new NexgentError('tool/failed', `cannot read ${rawPath}: ${error.code ?? error.message}`)
      })
      if (!info.isFile()) throw new NexgentError('tool/failed', `${rawPath} is not a file`)
      if (info.size > MAX_SPREADSHEET_BYTES) throw new NexgentError('tool/failed', `${rawPath} is ${info.size} bytes; read_spreadsheet opens files up to ${MAX_SPREADSHEET_BYTES} bytes`)
      context.signal.throwIfAborted()
      let book
      try {
        book = loadWorkbook(await readFile(path))
      } catch (error) {
        if (error instanceof DocumentError) throw new NexgentError('tool/failed', `${rawPath}: ${error.message}`)
        throw new NexgentError('tool/failed', `${rawPath}: cannot read the workbook (${(error as Error).message})`, { cause: error })
      }
      if (book.sheets.length === 0) throw new NexgentError('tool/failed', `${rawPath}: the workbook has no sheets`)
      const sheet: SheetData | undefined = sheetName === undefined
        ? book.sheets[0]
        : book.sheets.find(candidate => candidate.name.toUpperCase() === sheetName.toUpperCase())
      if (sheet === undefined) {
        throw new NexgentError('tool/invalid-input', `no sheet named ${JSON.stringify(sheetName)}; sheets: ${book.sheets.map(s => JSON.stringify(s.name)).join(', ')}`)
      }
      const used = usedBounds(sheet)
      let bounds = used === undefined ? undefined : { top: 1, left: 1, bottom: used.bottom, right: used.right }
      let cut = false
      if (rangeText !== undefined) {
        bounds = parseRange(rangeText)
        if (bounds === undefined) throw new NexgentError('tool/invalid-input', `"range" must look like A1:F40, got ${JSON.stringify(rangeText)}`)
        if ((bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) > MAX_READ_RANGE_CELLS) {
          throw new NexgentError('tool/invalid-input', `range ${rangeText} has more than ${MAX_READ_RANGE_CELLS} cells; read it in smaller ranges`)
        }
      } else if (bounds !== undefined) {
        const width = bounds.right - bounds.left + 1
        if (width > MAX_READ_RANGE_CELLS) {
          bounds = { ...bounds, right: bounds.left + MAX_READ_RANGE_CELLS - 1, bottom: bounds.top }
          cut = true
        }
        const maxRows = Math.max(1, Math.floor(MAX_READ_RANGE_CELLS / (bounds.right - bounds.left + 1)))
        if (bounds.bottom - bounds.top + 1 > maxRows) {
          bounds = { ...bounds, bottom: bounds.top + maxRows - 1 }
          cut = true
        }
      }

      const calculator = new Calculator(book.sheets, { strict: false })
      const lines: string[] = []
      const listing = book.sheets.map(s => {
        const b = usedBounds(s)
        return `${s.name} (${b === undefined ? 'empty' : `A1:${columnLetters(b.right)}${b.bottom}`})`
      })
      lines.push(`Workbook ${context.workspace.relative(path)}: sheets ${listing.join(', ')}`)
      const formulas: string[] = []
      let changed = 0
      let formulaCount = 0
      if (bounds === undefined) {
        lines.push(`## Sheet ${sheet.name}: empty`)
      } else {
        const range = `${columnLetters(bounds.left)}${bounds.top}:${columnLetters(bounds.right)}${bounds.bottom}`
        lines.push(`## Sheet ${sheet.name}, range ${range}${cut && used !== undefined ? ` (cut from A1:${columnLetters(used.right)}${used.bottom}; pass range to read the rest)` : ''}`)
        const header = ['row']
        for (let c = bounds.left; c <= bounds.right; c++) header.push(columnLetters(c))
        lines.push(header.join(','))
        for (let r = bounds.top; r <= bounds.bottom; r++) {
          const row = [String(r)]
          for (let c = bounds.left; c <= bounds.right; c++) {
            context.signal.throwIfAborted()
            const entry = sheet.cells.get(cellKey(r, c))
            const value = calculator.value(sheet.name, r, c)
            row.push(csvField(display(value, entry?.date === true, book.date1904)))
            if (entry?.formula !== undefined) {
              formulaCount++
              const saved = entry.value
              if (saved !== null && !sameValue(saved, value)) changed++
              formulas.push(`${columnLetters(c)}${r}: =${entry.formula} → ${display(value, entry.date === true, book.date1904)}`)
            }
          }
          lines.push(row.join(','))
        }
      }
      if (formulas.length > 0) lines.push('', 'Formulas:', ...formulas)
      const kept = book.keptAsSaved.filter(item => item.sheet === sheet.name)
      const issues = calculator.issues
      if (issues.length > 0 || kept.length > 0) {
        lines.push('', 'Not recalculated (the value saved in the file is shown):')
        for (const issue of issues) lines.push(`${cellLabel(issue.sheet, issue.row, issue.column)}: ${issue.message}`)
        for (const item of kept) lines.push(`${cellLabel(item.sheet, item.row, item.column)}: ${item.reason}`)
      }
      if (changed > 0) lines.push('', `${changed} formula value(s) differ from the values saved in the file (its inputs changed after it was last calculated); the recalculated values are shown.`)
      return {
        content: lines.join('\n'),
        meta: {
          path: context.workspace.relative(path),
          sheet: sheet.name,
          ...(bounds === undefined ? {} : { range: `${columnLetters(bounds.left)}${bounds.top}:${columnLetters(bounds.right)}${bounds.bottom}` }),
          formulas: formulaCount,
          notRecalculated: issues.length + kept.length,
          changedFromSaved: changed,
          truncated: cut,
        },
      }
    },
  }
}

/** `write_spreadsheet` writing through `sandbox`. */
export function writeSpreadsheetTool(sandbox: Sandbox): Tool {
  return {
    definition: {
      name: 'write_spreadsheet',
      description: 'Create an .xlsx workbook in the project from rows of cells. A cell is a number, text, true/false or null (empty); '
        + 'text starting with "=" is a live formula (A1 references, other sheets as Sheet!A1 or \'My sheet\'!A1, bounded ranges like A2:A50), '
        + 'and text starting with "\'=" is literal text. Every formula is calculated before anything is written and saved with its value; '
        + 'a formula that fails (unknown function, missing sheet, circular reference, error result such as #DIV/0!) refuses the whole write and names the cell. '
        + `Supported functions: ${SUPPORTED_FUNCTIONS.join(', ')}. `
        + 'An existing file is replaced only with overwrite: true (read it with read_spreadsheet first). '
        + `Limits: ${WRITE_LIMITS.sheets} sheets, ${WRITE_LIMITS.rowsPerSheet} rows × ${WRITE_LIMITS.columnsPerSheet} columns per sheet, ${WRITE_LIMITS.cells} non-empty cells.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sheets'],
        properties: {
          path: { type: 'string', minLength: 1, description: 'Project path of the .xlsx file to write.' },
          sheets: {
            type: 'array',
            minItems: 1,
            maxItems: WRITE_LIMITS.sheets,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'rows'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 31, description: 'Sheet name.' },
                rows: {
                  type: 'array',
                  minItems: 1,
                  description: 'Rows from row 1; each row is an array of cells from column A.',
                  items: { type: 'array', items: { type: ['number', 'string', 'boolean', 'null'] } },
                },
                headerRow: { type: 'boolean', description: 'Bold and freeze the first row (default true).' },
              },
            },
          },
          overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
        },
      },
      effects: ['write'],
      approval: 'never',
    },
    handler: async (input, context) => {
      const record = args(input)
      const rawPath = optionalString(record, 'path')
      if (rawPath === undefined || rawPath === '') throw new NexgentError('tool/invalid-input', '"path" is required')
      if (extname(rawPath).toLowerCase() !== '.xlsx') throw new NexgentError('tool/invalid-input', `write_spreadsheet writes .xlsx files; ${rawPath} has another extension`)
      const overwrite = record['overwrite']
      if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new NexgentError('tool/invalid-input', '"overwrite" must be a boolean')
      const path = context.workspace.resolve(rawPath)
      await enforce(sandbox, 'write', path, context)
      let built
      try {
        built = buildWorkbook(record['sheets'])
      } catch (error) {
        if (error instanceof SpreadsheetInputError) throw new NexgentError('tool/invalid-input', error.message)
        if (error instanceof CalculationError) throw new NexgentError('tool/failed', `nothing was written: ${error.message}`, { details: { reason: 'formula', cell: cellLabel(error.issue.sheet, error.issue.row, error.issue.column) } })
        throw error
      }
      context.signal.throwIfAborted()
      const existing = await stat(path).then(info => info, () => undefined)
      if (existing !== undefined && !existing.isFile()) throw new NexgentError('tool/failed', `${rawPath} exists and is not a file`)
      const relative = context.workspace.relative(path)
      if (existing !== undefined && overwrite !== true) {
        throw new NexgentError('tool/failed', `${relative} already exists; pass overwrite: true to replace it (read it with read_spreadsheet first)`, { details: { reason: 'exists' } })
      }
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, built.bytes, { flag: overwrite === true ? 'w' : 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new NexgentError('tool/failed', `${relative} already exists; pass overwrite: true to replace it`, { details: { reason: 'exists' } })
        }
        throw new NexgentError('tool/failed', `cannot write ${relative}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
      }
      const lines = [`${existing === undefined ? 'Created' : 'Replaced'} ${relative} (${built.bytes.byteLength} bytes): `
        + built.sheets.map(s => `${s.name} (${s.rows} rows × ${s.columns} columns, ${s.formulas} formulas)`).join(', ')]
      const listed: string[] = []
      let total = 0
      for (const [sheet, values] of Object.entries(built.values)) {
        for (const [ref, value] of Object.entries(values)) {
          total++
          if (listed.length < MAX_LISTED_VALUES) listed.push(`${sheet}!${ref} = ${display(value, false, false)}`)
        }
      }
      if (listed.length > 0) {
        lines.push('Calculated formula values:', ...listed)
        if (total > listed.length) lines.push(`… and ${total - listed.length} more (read them with read_spreadsheet)`)
      }
      return {
        content: lines.join('\n'),
        meta: { path: relative, bytes: built.bytes.byteLength, created: existing === undefined, sheets: built.sheets.map(s => ({ ...s })) },
      }
    },
  }
}
