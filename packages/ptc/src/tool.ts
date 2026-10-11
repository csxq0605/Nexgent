/**
 * The `run_code` tool (`step3-tools.ts` `RUN_CODE_TOOL`): run a JavaScript
 * async function body in a new Node process with the project host functions
 * (`functions.ts`). Name, schema, effects and approval come from the
 * contract; the description is this package's.
 */
import { NexgentError, RUN_CODE_TOOL, type Sandbox, type Tool, type ToolOutput } from '@nexgent/kernel'
import { projectFunctions } from './functions.js'
import { PTC_LIMITS, runProgram, type ProgramResult, type RunProgramOptions } from './runtime.js'

/** Characters of the result value shown to the model (the rest is cut with a note). */
export const MAX_SHOWN_VALUE_CHARS = 20_000

/** The model-facing description of `run_code`. */
export const RUN_CODE_DESCRIPTION = 'Run JavaScript in a fresh, isolated Node.js process and get its console output and return value. '
  + 'The code is the body of an async function: use await, and `return` a JSON-serializable value. '
  + 'The process has no environment variables, no direct file system, no child processes; it reaches the project only through these async host functions, '
  + 'each checked against this session\'s sandbox like the file tools: '
  + 'readFile(path, { encoding?: "utf8" | "base64" }) → string; '
  + 'writeFile(path, content, { encoding?, overwrite?: boolean }) → { path, bytes, created } (an existing file is replaced only with overwrite: true); '
  + 'listDir(path = ".") → [{ name, type }]; exists(path) → boolean; '
  + 'readSpreadsheet(path, { sheet? }) → { sheets, sheet, rows (calculated values, row 1 first), formulas ({ "C2": "=A2*B2" }) }; '
  + 'writeSpreadsheet({ path, sheets: [{ name, rows, headerRow? }], overwrite? }) — same input as write_spreadsheet, formulas as "=..." text. '
  + 'Paths are project paths. Use it for computing over data, transforming files and checking results; use bash for installed tools. '
  + `Default timeout ${PTC_LIMITS.defaultTimeoutMs / 1000} s (timeoutMs up to ${PTC_LIMITS.maxTimeoutMs / 1000} s); output is cut at ${PTC_LIMITS.maxOutputChars} characters.`

/** Options of {@link runCodeTool} (host process settings; tests and Electron hosts). */
export type RunCodeToolOptions = Pick<RunProgramOptions, 'nodePath' | 'permission' | 'windowsJob' | 'pwshPath'>

/** Render a program result for the model. */
export function renderProgramResult(result: ProgramResult): ToolOutput {
  const lines: string[] = []
  lines.push(result.status === 'completed' ? `Completed in ${result.durationMs} ms.` : `${result.status === 'failed' ? 'Failed' : result.status === 'timeout' ? 'Timed out' : result.status === 'cancelled' ? 'Cancelled' : 'Crashed'} after ${result.durationMs} ms: ${result.error?.name ?? 'Error'}: ${result.error?.message ?? 'unknown'}`)
  if (result.status === 'failed' && result.error?.stack !== undefined) {
    const frames = result.error.stack.split('\n').slice(1).filter(line => /<anonymous>:\d+/.test(line)).slice(0, 5)
    if (frames.length > 0) lines.push(...frames)
  }
  if (result.output !== '') {
    lines.push('', 'Output:', result.output.endsWith('\n') ? result.output.slice(0, -1) : result.output)
    if (result.outputTruncated) lines.push(`[output cut at ${PTC_LIMITS.maxOutputChars} characters]`)
  }
  if (result.value !== undefined) {
    const json = JSON.stringify(result.value, null, 2)
    lines.push('', 'Result:', json.length > MAX_SHOWN_VALUE_CHARS ? `${json.slice(0, MAX_SHOWN_VALUE_CHARS)}\n[result cut at ${MAX_SHOWN_VALUE_CHARS} characters; write large results to a file]` : json)
  }
  return {
    content: lines.join('\n'),
    isError: result.status !== 'completed',
    meta: { status: result.status, durationMs: result.durationMs, calls: result.calls, outputTruncated: result.outputTruncated },
  }
}

/** The `run_code` tool over a sandbox (the session's mode is taken per call). */
export function runCodeTool(sandbox: Sandbox, options: RunCodeToolOptions = {}): Tool {
  return {
    definition: {
      name: RUN_CODE_TOOL.name,
      description: RUN_CODE_DESCRIPTION,
      inputSchema: RUN_CODE_TOOL.inputSchema,
      effects: RUN_CODE_TOOL.effects,
      approval: RUN_CODE_TOOL.approval,
    },
    handler: async (input, context) => {
      const record = input as Record<string, unknown>
      if (typeof record?.code !== 'string' || record.code.trim() === '') throw new NexgentError('tool/invalid-input', '"code" is required')
      const timeoutMs = record.timeoutMs
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && (timeoutMs as number) >= PTC_LIMITS.minTimeoutMs && (timeoutMs as number) <= PTC_LIMITS.maxTimeoutMs)) {
        throw new NexgentError('tool/invalid-input', `"timeoutMs" must be an integer from ${PTC_LIMITS.minTimeoutMs} to ${PTC_LIMITS.maxTimeoutMs}`)
      }
      const result = await runProgram({
        ...options,
        code: record.code,
        cwd: context.workspace.root,
        functions: projectFunctions(sandbox, context),
        signal: context.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      })
      return renderProgramResult(result)
    },
  }
}
