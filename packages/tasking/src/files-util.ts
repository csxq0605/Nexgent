/**
 * Small file helpers shared by the stores: media types, stored names,
 * copy-with-hash, atomic JSON writes and id checks.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpath as realpathCallback } from 'node:fs'
import { mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { promisify } from 'node:util'

/** `fs.realpath.native` as a promise (expands Windows 8.3 short names and fixes case). */
export const realpathNative: (path: string) => Promise<string> = promisify(realpathCallback.native)

/** Lowercase UUID v4, the form every tasking id takes. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Whether `id` is a lowercase UUID v4 (so it is safe as a directory name). */
export function isTaskingId(id: string): boolean {
  return UUID_PATTERN.test(id)
}

/** A new lowercase UUID v4. */
export function newId(): string {
  return randomUUID()
}

/** Prefix of half-written directories that listings skip and startup removes. */
export const TEMP_PREFIX = '.tmp-'

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.ndjson': 'application/jsonl',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.ps1': 'text/plain',
  '.sql': 'application/sql',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/vnd.microsoft.icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
}

/** Media types that are never treated as text, whatever their bytes. */
const BINARY_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/wasm',
  'application/vnd.microsoft.portable-executable',
])

/** IANA media type guessed from the extension; `application/octet-stream` when unknown. */
export function guessMediaType(fileName: string): string {
  return MEDIA_TYPES[nodePath.extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

/** Whether a media type is a known binary format (images other than SVG, audio and video included). */
export function isKnownBinaryType(mediaType: string): boolean {
  if (BINARY_TYPES.has(mediaType)) return true
  if (mediaType === 'image/svg+xml') return false
  return mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/')
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * The name a material copy is stored under (data-formats.md §材料元数据):
 * base name only, `/ \ : * ? " < > |` and control characters replaced by `_`,
 * trailing dots and spaces dropped; empty or a Windows device name becomes
 * `material` plus the original extension.
 */
export function storedNameFor(originalName: string): string {
  const base = originalName.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '')
  if (cleaned === '' || WINDOWS_DEVICE.test(cleaned)) {
    const ext = nodePath.extname(base).replace(/[^A-Za-z0-9.]/g, '')
    return `material${ext === '.' ? '' : ext}`
  }
  return cleaned
}

/** What {@link copyWithHash} measured. */
export interface CopyResult {
  readonly size: number
  readonly sha256: string
  /** Bytes decode as UTF-8 and contain no NUL. */
  readonly utf8: boolean
}

/**
 * Stream-copy `source` to `target` (created exclusively), hashing and
 * UTF-8-checking the bytes on the way, then fsync the copy.
 */
export async function copyWithHash(source: string, target: string, signal?: AbortSignal): Promise<CopyResult> {
  await mkdir(nodePath.dirname(target), { recursive: true })
  const hash = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let utf8 = true
  let size = 0
  const out = await open(target, 'wx')
  try {
    const input = createReadStream(source, signal === undefined ? {} : { signal })
    for await (const chunk of input as AsyncIterable<Buffer>) {
      hash.update(chunk)
      size += chunk.length
      if (utf8) {
        if (chunk.includes(0)) utf8 = false
        else {
          try {
            decoder.decode(chunk, { stream: true })
          } catch {
            utf8 = false
          }
        }
      }
      await writeAll(out, chunk)
    }
    if (utf8) {
      try {
        decoder.decode()
      } catch {
        utf8 = false
      }
    }
    await out.sync()
  } finally {
    await out.close()
  }
  return { size, sha256: hash.digest('hex'), utf8 }
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    offset += bytesWritten
  }
}

/** Write JSON to a fresh file and fsync it (no rename; the caller owns the directory). */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Replace a file atomically: temp file + fsync + rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${newId()}.tmp`
  try {
    await writeJsonFile(temp, value)
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Best-effort fsync of a directory (a no-op where directories cannot be opened, e.g. Windows). */
export async function syncDir(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // directory fsync is advisory
  }
}

/**
 * `rename`, retried briefly on the transient Windows errors a virus scanner
 * or indexer causes (`EPERM`, `EACCES`, `EBUSY`). Other errors throw at once.
 */
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
      if (!transient || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * attempt))
    }
  }
}

/** Remove every `.tmp-*` entry directly under `dir` (leftovers of an interrupted write). */
export async function removeTempEntries(dir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue
    await rm(nodePath.join(dir, entry), { recursive: true, force: true })
    removed++
  }
  return removed
}

/** Whether an error is "no such file or directory". */
export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
