/**
 * What a task run produced, as text for a reviewer: the self-evaluation
 * shows these to the scorer (ADR 0015, ADR 0016).
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The files a run created or changed (text, truncated; at most
 * {@link OUTPUT_FILES} with their contents), and the paths of the other
 * changed files and of the snapshot files the run removed, so that a
 * reviewer never mistakes a shortened listing for missing work.
 */
export interface RunOutput {
  readonly files: readonly { readonly path: string; readonly text: string }[]
  /** Created or changed files whose contents are not shown (sorted; at most {@link OUTPUT_PATHS}). */
  readonly unshown?: readonly string[]
  /** How many created or changed files are not listed at all (beyond {@link OUTPUT_PATHS}). */
  readonly unlisted?: number
  /** Snapshot files the run removed (sorted; at most {@link OUTPUT_PATHS}). */
  readonly removed?: readonly string[]
  /** How many removed files are not listed (beyond {@link OUTPUT_PATHS}). */
  readonly removedUnlisted?: number
}

/** Changed files shown to the reviewer with their contents. */
export const OUTPUT_FILES = 12
/** Characters of one file's contents shown to the reviewer. */
export const OUTPUT_CHARS = 6_000
/** Paths listed (without contents) per list: changed files not shown, removed files. */
export const OUTPUT_PATHS = 200

/** Reads a non-UTF-8 file (a PDF, an office document) as text; `undefined` shows it as binary. */
export type DocumentText = ((path: string, bytes: Uint8Array) => Promise<string | undefined> | string | undefined) | undefined

/** A file's text for a reviewer: UTF-8, else (ADR 0016) the host's document reader, else a binary marker; truncated at `maxChars`. */
export async function fileText(path: string, bytes: Uint8Array, documentText: DocumentText, maxChars: number = OUTPUT_CHARS): Promise<string> {
  let text: string | undefined
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = await Promise.resolve(documentText?.(path, bytes)).catch(() => undefined)
  }
  text ??= `(binary, ${bytes.byteLength} bytes)`
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text
}

/**
 * Files of the copy the run created or changed, for the reviewer (ADR 0015):
 * every changed path is found first; the first {@link OUTPUT_FILES} in path
 * order are shown with their (truncated) text, the rest by path, and the
 * snapshot files the run removed are listed too.
 */
export async function runOutput(root: string, before: ReadonlyMap<string, string>, documentText?: DocumentText): Promise<RunOutput> {
  const changed: string[] = []
  const present = new Set<string>()
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (['.nexgent', '.git', 'node_modules'].includes(entry.name)) continue
        await visit(join(directory, entry.name), path)
      } else if (entry.isFile()) {
        present.add(path)
        const bytes = await readFile(join(directory, entry.name)).catch(() => undefined)
        if (bytes === undefined) continue
        if (before.get(path) === createHash('sha256').update(bytes).digest('hex')) continue
        changed.push(path)
      }
    }
  }
  await visit(root, '')
  changed.sort()
  // Only the shown files are kept in memory: they are read again here.
  const files: { path: string; text: string }[] = []
  for (const path of changed.slice(0, OUTPUT_FILES)) {
    const bytes = await readFile(join(root, ...path.split('/'))).catch(() => undefined)
    if (bytes === undefined) continue
    files.push({ path, text: await fileText(path, bytes, documentText) })
  }
  const rest = changed.slice(OUTPUT_FILES)
  const gone = [...before.keys()].filter(path => !present.has(path) && !path.startsWith('.nexgent/')).sort()
  return {
    files,
    ...(rest.length === 0 ? {} : { unshown: rest.slice(0, OUTPUT_PATHS) }),
    ...(rest.length > OUTPUT_PATHS ? { unlisted: rest.length - OUTPUT_PATHS } : {}),
    ...(gone.length === 0 ? {} : { removed: gone.slice(0, OUTPUT_PATHS) }),
    ...(gone.length > OUTPUT_PATHS ? { removedUnlisted: gone.length - OUTPUT_PATHS } : {}),
  }
}
