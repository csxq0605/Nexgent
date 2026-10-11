// Adapted from deepseek-harness@46a7f68b packages/storage/storage-json/src/index.ts (MIT)
/**
 * JSON storage primitives on top of {@link writeFileAtomic}: read a whole
 * JSON document, durably replace it, and a small keyed store with one file
 * per key. Only {@link JsonValue}s are written, so nothing degrades silently.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { NexgentError } from '../contracts/errors.js'
import { isJsonValue, type JsonValue } from '../contracts/json.js'
import { writeFileAtomic, type WriteFileAtomicOptions } from '../util/atomic-write.js'

/**
 * Read and parse a JSON file.
 * @returns the parsed value, or `undefined` when the file does not exist.
 * @throws `config/invalid` when the file is not valid JSON.
 */
export async function readJsonFile(path: string): Promise<JsonValue | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as JsonValue
  } catch (cause) {
    throw new NexgentError('config/invalid', `${path} is not valid JSON`, { cause, details: { path } })
  }
}

/**
 * Durably replace a JSON file (2-space indent, trailing newline).
 * @throws `TypeError` when `value` is not a plain JSON value.
 */
export async function writeJsonFile(path: string, value: unknown, options: WriteFileAtomicOptions = {}): Promise<void> {
  if (!isJsonValue(value)) throw new TypeError(`refusing to write a non-JSON value to ${path}`)
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options)
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A directory of `<key>.json` documents with atomic replacement per key. */
export class JsonStore {
  constructor(readonly directory: string, private readonly options: WriteFileAtomicOptions = {}) {}

  private file(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..')) throw new TypeError(`invalid storage key: ${key}`)
    return join(this.directory, `${key}.json`)
  }

  /** Read one document; `undefined` when absent. */
  get(key: string): Promise<JsonValue | undefined> {
    return readJsonFile(this.file(key))
  }

  /** Durably replace one document. */
  set(key: string, value: JsonValue): Promise<void> {
    return writeJsonFile(this.file(key), value, this.options)
  }

  /** Remove one document; `false` when it did not exist. */
  async delete(key: string): Promise<boolean> {
    const file = this.file(key)
    try {
      await rm(file)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** Every stored key, sorted. */
  async keys(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return names
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(key => KEY_PATTERN.test(key))
      .sort()
  }
}
