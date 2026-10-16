/**
 * Function modules as model tools (`permissions.md` §能力包组件的执行边界).
 * Each exported function listed in `functions.json` becomes the tool
 * `cap_<module>_<function>` with effects `['execute', ...declared]`,
 * approval `never` and `selfSandboxed: true`. A call runs in a fresh PTC
 * process (empty environment, Node permission model, deadline and output
 * caps): the host reads the module file and hands its source to the program,
 * which imports it from a `data:` URL, so the program never reads the file
 * system itself. The function receives `(input, host)`; `host` carries the
 * project host functions of `run_code`, each checked against the calling
 * session's sandbox, and only the writing ones when the function declares
 * `write`. A module is one self-contained `.mjs` file (no relative imports).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NexgentError, type FunctionModuleSpec, type FunctionSpec, type Sandbox, type Tool, type ToolEffect } from '@nexgent/kernel'
import { projectFunctions, renderProgramResult, runProgram, type RunCodeToolOptions } from '@nexgent/ptc'

/** Host functions a function receives only when it declares `write`. */
const WRITING_FUNCTIONS = new Set(['writeFile'])

/** The program body; host function names are identifiers (checked by `runProgram`). */
function program(hostNames: readonly string[]): string {
  return [
    'const mod = await import("data:text/javascript;base64," + __moduleSource)',
    'const fn = mod[__functionName]',
    'if (typeof fn !== "function") throw new Error("the module does not export a function named " + __functionName)',
    `const host = Object.freeze({ ${hostNames.join(', ')} })`,
    'const value = await fn(__input, host)',
    'return value === undefined ? null : value',
  ].join('\n')
}

/** A module's tools, ready to register. */
export interface FunctionModuleTools {
  readonly tools: readonly Tool[]
  readonly names: readonly string[]
}

function description(module: FunctionModuleSpec, fn: FunctionSpec): string {
  return `${fn.description}\n\n(Function ${fn.name} of the capability module "${module.name}": ${module.description} Runs in an isolated process; file access follows this session's sandbox.)`
}

/**
 * Build the tools of one function module.
 * @param directory - Absolute component directory (adopted bundle or frozen tried revision).
 * @param toolNames - `functionToolName` of each function, in `spec.functions` order.
 */
export function functionModuleTools(sandbox: Sandbox, directory: string, spec: FunctionModuleSpec, entry: string, toolNames: readonly string[],
  options: RunCodeToolOptions = {}): FunctionModuleTools {
  let source: Promise<string> | undefined
  const moduleSource = (): Promise<string> => {
    source ??= readFile(join(directory, ...entry.split('/'))).then(bytes => bytes.toString('base64'))
    return source
  }
  const tools = spec.functions.map((fn, index): Tool => {
    const effects: ToolEffect[] = ['execute', ...fn.effects]
    return {
      definition: {
        name: toolNames[index]!,
        description: description(spec, fn),
        inputSchema: fn.inputSchema,
        effects,
        approval: 'never',
        selfSandboxed: true,
      },
      handler: async (input, context) => {
        const functions = projectFunctions(sandbox, context).filter(host => fn.effects.includes('write') || !WRITING_FUNCTIONS.has(host.name))
        let encoded: string
        try {
          encoded = await moduleSource()
        } catch (error) {
          source = undefined
          throw new NexgentError('tool/failed', `cannot read the module of ${spec.name}: ${(error as Error).message}`)
        }
        const result = await runProgram({
          ...options,
          code: program(functions.map(host => host.name)),
          cwd: context.workspace.root,
          functions,
          globals: {
            __moduleSource: encoded,
            __functionName: fn.name,
            __input: (input ?? {}) as never,
          },
          signal: context.signal,
        })
        return renderProgramResult(result)
      },
    }
  })
  return { tools, names: toolNames }
}
