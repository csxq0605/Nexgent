/**
 * The `load_skill` and `read_document` tools. Names, input schemas, effects
 * and approval are frozen in `packages/kernel/src/contracts/step2-tools.ts`;
 * descriptions are this package's. Both only read: they work in `read-only`
 * mode and write nothing.
 */
import { readFile, stat } from 'node:fs/promises'
import {
  LOAD_SKILL_TOOL,
  NexgentError,
  READ_DOCUMENT_TOOL,
  type Sandbox,
  type SandboxMode,
  type Tool,
  type ToolContext,
} from '@nexgent/kernel'
import type { CapabilitySkillLookup, LayeredSkillRegistry } from './capability-skills.js'
import type { SkillToolGate } from './gating.js'
import { DocumentError, documentFormat, extractDocument, DEFAULT_MAX_ROWS } from './documents/index.js'

/** Largest file `read_document` opens (50 MiB). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

/** Characters of extracted text returned at most; the rest is cut with a note. */
export const MAX_DOCUMENT_OUTPUT_CHARS = 100_000

/** `load_skill` over a registry. */
export function loadSkillTool(registry: LayeredSkillRegistry, capabilitySkills?: CapabilitySkillLookup, gate?: SkillToolGate): Tool {
  return {
    definition: {
      name: LOAD_SKILL_TOOL.name,
      description: 'Load the full instructions of a skill from the skills list given in the conversation. Call it before doing work the skill covers.',
      inputSchema: LOAD_SKILL_TOOL.inputSchema,
      effects: LOAD_SKILL_TOOL.effects,
      approval: LOAD_SKILL_TOOL.approval,
    },
    handler: async (input, context) => {
      const name = (input as { name?: unknown } | null)?.name
      if (typeof name !== 'string' || name === '') throw new NexgentError('tool/invalid-input', '"name" must be a non-empty string')
      const layers = capabilitySkills === undefined ? undefined : await capabilitySkills(context.sessionId)
      const skill = await registry.load(name, layers)
      const revealed = gate?.reveal(context.sessionId, skill.manifest.tools) ?? []
      const header = `# Skill: ${skill.manifest.name}\n${skill.manifest.description}`
      return {
        content: `${header}\n\n${skill.body.trim()}${revealed.length === 0 ? '' : `\n\nTools now available: ${revealed.join(', ')}.`}`,
        meta: { name: skill.manifest.name, source: skill.manifest.source },
      }
    },
  }
}

/** A sandbox that can answer for another mode (the workspace's `LocalSandbox`). */
interface ModalSandbox extends Sandbox {
  withMode(mode: SandboxMode): Sandbox
}

function sandboxFor(sandbox: Sandbox, mode: SandboxMode): Sandbox {
  return typeof (sandbox as Partial<ModalSandbox>).withMode === 'function' ? (sandbox as ModalSandbox).withMode(mode) : sandbox
}

/** Enforce the read policy for one path: deny → `sandbox/denied`; ask → the call's approval flow. */
async function enforceRead(sandbox: Sandbox, path: string, context: ToolContext): Promise<void> {
  const decision = await sandboxFor(sandbox, context.sandboxMode).checkRead(path)
  if (decision.allowed) return
  if (decision.code !== 'approval-required') {
    throw new NexgentError('sandbox/denied', `SANDBOX_DENIED: path ${path} — ${decision.reason} [mode ${context.sandboxMode}, ${decision.code}]`, {
      details: { mode: context.sandboxMode, code: decision.code, path },
    })
  }
  if (context.approved) return
  if (await context.requestApproval({ ...decision.ask, summary: `read ${path}` })) return
  throw new NexgentError('approval/denied', `not approved: read ${path} (${decision.reason})`)
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new NexgentError('tool/invalid-input', `"${name}" must be a string`)
  return value
}

/** `read_document` reading through `sandbox`. */
export function readDocumentTool(sandbox: Sandbox): Tool {
  return {
    definition: {
      name: READ_DOCUMENT_TOOL.name,
      description: 'Read a .docx, .xlsx or .pdf file in the project (attached materials included) as text. '
        + '.docx: paragraphs, headings and tables. .xlsx: each sheet as CSV rows of cached cell values (sheet, maxRows to narrow). '
        + '.pdf: text per page (pages like "1-3"). Read-only; nothing in the document is executed.',
      inputSchema: READ_DOCUMENT_TOOL.inputSchema,
      effects: READ_DOCUMENT_TOOL.effects,
      approval: READ_DOCUMENT_TOOL.approval,
    },
    handler: async (input, context) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new NexgentError('tool/invalid-input', 'arguments must be an object')
      const args = input as Record<string, unknown>
      const rawPath = optionalString(args, 'path')
      if (rawPath === undefined || rawPath === '') throw new NexgentError('tool/invalid-input', '"path" is required')
      const sheet = optionalString(args, 'sheet')
      const pages = optionalString(args, 'pages')
      const maxRows = args['maxRows']
      if (maxRows !== undefined && (typeof maxRows !== 'number' || !Number.isSafeInteger(maxRows) || maxRows < 1)) {
        throw new NexgentError('tool/invalid-input', '"maxRows" must be a positive integer')
      }
      const format = documentFormat(rawPath)
      if (format === undefined) {
        throw new NexgentError('tool/invalid-input', `read_document reads .docx, .xlsx and .pdf files; use read_file for ${rawPath}`)
      }
      const path = context.workspace.resolve(rawPath)
      await enforceRead(sandbox, path, context)
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        throw new NexgentError('tool/failed', `cannot read ${rawPath}: ${error.code ?? error.message}`)
      })
      if (!info.isFile()) throw new NexgentError('tool/failed', `${rawPath} is not a file`)
      if (info.size > MAX_DOCUMENT_BYTES) throw new NexgentError('tool/failed', `${rawPath} is ${info.size} bytes; read_document opens files up to ${MAX_DOCUMENT_BYTES} bytes`)
      context.signal.throwIfAborted()
      const data = await readFile(path)
      let text: string
      try {
        text = await extractDocument(format, data, {
          ...(sheet === undefined ? {} : { sheet }),
          ...(typeof maxRows === 'number' ? { maxRows } : {}),
          ...(pages === undefined ? {} : { pages }),
        })
      } catch (error) {
        if (error instanceof DocumentError) throw new NexgentError('tool/failed', `${rawPath}: ${error.message}`)
        throw new NexgentError('tool/failed', `${rawPath}: cannot extract text (${(error as Error).message})`, { cause: error })
      }
      if (text.trim() === '') text = '(the document contains no text)'
      let truncated = false
      if (text.length > MAX_DOCUMENT_OUTPUT_CHARS) {
        text = `${text.slice(0, MAX_DOCUMENT_OUTPUT_CHARS)}\n[output cut at ${MAX_DOCUMENT_OUTPUT_CHARS} characters; ${format === 'xlsx' ? 'pass sheet or a smaller maxRows' : format === 'pdf' ? 'pass pages' : 'the rest is not shown'}]`
        truncated = true
      }
      return {
        content: text,
        meta: { path: rawPath, format, bytes: info.size, truncated, ...(format === 'xlsx' ? { maxRows: typeof maxRows === 'number' ? maxRows : DEFAULT_MAX_ROWS } : {}) },
      }
    },
  }
}
