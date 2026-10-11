/**
 * Reading parts of an OOXML package (a ZIP file) with `fflate`.
 */
import { unzipSync } from 'fflate'
import { DocumentError } from './errors.js'

/** Uncompressed size above which a part is refused (guards against ZIP bombs). */
export const MAX_PART_BYTES = 200 * 1024 * 1024

/** The parts of a package, by path (`word/document.xml`); only the wanted ones are inflated. */
export type ZipParts = ReadonlyMap<string, Uint8Array>

/**
 * Inflate the parts whose path `want` accepts.
 * @throws {@link DocumentError} when the bytes are not a ZIP archive or a part is too large.
 */
export function readZipParts(data: Uint8Array, want: (path: string) => boolean, format: string): ZipParts {
  let tooLarge: string | undefined
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data, {
      filter: file => {
        if (!want(file.name)) return false
        if (file.originalSize > MAX_PART_BYTES) {
          tooLarge = file.name
          return false
        }
        return true
      },
    })
  } catch (error) {
    throw new DocumentError(`not a valid ${format} file (cannot open it as a ZIP package: ${(error as Error).message})`)
  }
  if (tooLarge !== undefined) throw new DocumentError(`${format} part ${tooLarge} is larger than ${MAX_PART_BYTES} bytes uncompressed; refusing to read it`)
  return new Map(Object.entries(files))
}

/** Decode a part as UTF-8 (BOM dropped). */
export function partText(parts: ZipParts, path: string): string | undefined {
  const bytes = parts.get(path)
  if (bytes === undefined) return undefined
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
