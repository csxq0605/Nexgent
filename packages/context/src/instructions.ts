/**
 * The workspace-instructions provider (`id: 'workspace-instructions'`): the
 * project root's `AGENTS.md` (else `NEXGENT.md`) as a `# Project instructions`
 * system-prompt section. Read fresh at every turn start, so edits apply from
 * the next turn; never written to the session.
 */
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { NexgentError, type ContextContribution, type ContextProvider, type TurnContextInput } from '@nexgent/kernel'
import { decodeUtf8, formatBytes, truncateUtf8 } from './text.js'

/** Provider id (fixed call order: first). */
export const WORKSPACE_INSTRUCTIONS_PROVIDER_ID = 'workspace-instructions'

/** File names looked up in the project root, in priority order; the first that exists wins. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'NEXGENT.md'] as const

/** Default byte cap of the injected file (32 KiB). */
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32 * 1024

/** Options of {@link workspaceInstructionsProvider}. */
export interface WorkspaceInstructionsOptions {
  /** Bytes of the file injected at most; the rest is cut at a character (preferably line) boundary. */
  readonly maxBytes?: number
}

/** What was found for a project root. */
export interface LoadedInstructions {
  /** File name relative to the root (`AGENTS.md` or `NEXGENT.md`). */
  readonly file: string
  /** Injected text (possibly truncated). */
  readonly text: string
  /** Full file size in bytes. */
  readonly size: number
  readonly truncated: boolean
}

/**
 * Read the instructions file of a project root: `AGENTS.md` when it exists
 * (even if empty), else `NEXGENT.md`; `undefined` when neither exists or the
 * chosen one is blank. A directory of that name counts as absent.
 * @throws `internal` for an I/O error other than "missing" (the loop then skips the provider for this turn).
 */
export async function loadInstructions(root: string, maxBytes = DEFAULT_INSTRUCTIONS_MAX_BYTES): Promise<LoadedInstructions | undefined> {
  for (const file of INSTRUCTION_FILES) {
    const path = join(root, file)
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw new NexgentError('internal', `cannot read ${file}: ${code ?? String(error)}`, { cause: error })
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) continue
      // Read one byte past the cap so truncation is detected without loading a huge file.
      const want = Math.min(info.size, maxBytes + 4)
      const buffer = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buffer, 0, want, 0)
      const head = buffer.subarray(0, bytesRead)
      const truncated = info.size > maxBytes
      const text = truncated ? truncateUtf8(head, maxBytes).text : decodeUtf8(head)
      if (text.trim() === '') return undefined
      return { file, text, size: info.size, truncated }
    } finally {
      await handle.close()
    }
  }
  return undefined
}

/** Render the section body for loaded instructions. Pure. */
export function renderInstructionsBody(loaded: LoadedInstructions): string {
  const lines = [
    `The project owner's instructions, from ${loaded.file} in the project root. Follow them unless the user says otherwise in this conversation.`,
    '',
    loaded.text.replace(/\s+$/, ''),
  ]
  if (loaded.truncated) {
    lines.push('', `[${loaded.file} is ${formatBytes(loaded.size)}; only the beginning is shown here. Read the file for the rest.]`)
  }
  return lines.join('\n')
}

/** The workspace-instructions {@link ContextProvider}. */
export function workspaceInstructionsProvider(options: WorkspaceInstructionsOptions = {}): ContextProvider {
  const maxBytes = options.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new NexgentError('config/invalid', `instructions maxBytes must be a positive integer, got ${String(maxBytes)}`)
  }
  return {
    id: WORKSPACE_INSTRUCTIONS_PROVIDER_ID,
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      const loaded = await loadInstructions(input.projectRoot, maxBytes)
      if (loaded === undefined) return {}
      return { systemSections: [{ id: 'workspace-instructions', title: 'Project instructions', body: renderInstructionsBody(loaded) }] }
    },
  }
}
