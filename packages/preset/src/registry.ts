/**
 * The preset registry: built-in presets plus project presets read from
 * `.nexgent/presets/<name>.json` (`data-formats.md` §预设). Project files are
 * untrusted input: each is parsed and checked with `assertPresetFile`, and
 * its `name` must equal the file's base name. A project preset with a
 * built-in's name replaces the built-in. Files are read on every call, so an
 * edit takes effect at the next member start without a restart.
 */
import { readdir, readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  assertPresetFile,
  BUILTIN_PRESET_NAMES,
  isNexgentError,
  NexgentError,
  PRESET_NAME_PATTERN,
  PROJECT_PRESETS_DIR,
  type AgentPreset,
  type PresetFile,
} from '@nexgent/kernel'
import { BUILTIN_PRESETS } from './builtin.js'

/** Largest preset file read, in bytes. */
export const MAX_PRESET_FILE_BYTES = 65_536

/** Where a listed preset came from. */
export type PresetSource = 'builtin' | 'project'

/** One usable preset. */
export interface PresetEntry {
  readonly preset: AgentPreset
  readonly source: PresetSource
  /** Absolute path of the project file. */
  readonly file?: string
}

/** A project preset file that could not be used, with a message naming the field or JSON error. */
export interface PresetFileError {
  /** Absolute path of the file. */
  readonly file: string
  readonly message: string
}

/** What {@link PresetRegistry.load} returns. */
export interface PresetLoadResult {
  /** Built-ins first (in their fixed order, replaced in place by a project file of the same name), then project presets by name. */
  readonly presets: readonly PresetEntry[]
  readonly errors: readonly PresetFileError[]
}

/** Strip the `formatVersion` of a preset file. */
function toPreset(file: PresetFile): AgentPreset {
  const { formatVersion: _version, ...preset } = file
  return preset
}

/**
 * Parse and check one preset file's text.
 * @param text - the file content.
 * @param baseName - the file name without `.json`; must equal the `name` field.
 * @throws `config/invalid` naming the problem.
 */
export function parsePresetFile(text: string, baseName: string): AgentPreset {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new NexgentError('config/invalid', `preset is not valid JSON: ${(error as Error).message}`)
  }
  assertPresetFile(value)
  if (value.name !== baseName) {
    throw new NexgentError('config/invalid', `preset name "${value.name}" must equal the file name "${baseName}"`)
  }
  return toPreset(value)
}

/** The presets of one project. */
export class PresetRegistry {
  /** Absolute `.nexgent/presets` directory. */
  readonly directory: string

  /** @param projectRoot - absolute project root. */
  constructor(projectRoot: string) {
    this.directory = nodePath.join(projectRoot, ...PROJECT_PRESETS_DIR.split('/'))
  }

  /** Read every project preset file; a broken file is reported in `errors`, never thrown. */
  async load(): Promise<PresetLoadResult> {
    const project = new Map<string, PresetEntry>()
    const errors: PresetFileError[] = []
    let names: string[]
    try {
      names = (await readdir(this.directory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        errors.push({ file: this.directory, message: `presets directory cannot be read: ${(error as Error).message}` })
      }
      names = []
    }
    for (const name of names) {
      const file = nodePath.join(this.directory, name)
      const baseName = name.slice(0, -'.json'.length)
      try {
        if (!PRESET_NAME_PATTERN.test(baseName)) {
          throw new NexgentError('config/invalid', `preset file name must match ${String(PRESET_NAME_PATTERN)}.json`)
        }
        const bytes = await readFile(file)
        if (bytes.byteLength > MAX_PRESET_FILE_BYTES) {
          throw new NexgentError('config/invalid', `preset file is larger than ${MAX_PRESET_FILE_BYTES} bytes`)
        }
        project.set(baseName, { preset: parsePresetFile(bytes.toString('utf8'), baseName), source: 'project', file })
      } catch (error) {
        errors.push({ file, message: isNexgentError(error) ? error.message : `cannot be read: ${(error as Error).message}` })
      }
    }
    const presets: PresetEntry[] = BUILTIN_PRESET_NAMES.map(name => project.get(name) ?? { preset: BUILTIN_PRESETS[name], source: 'builtin' as const })
    for (const [name, entry] of [...project].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!(BUILTIN_PRESET_NAMES as readonly string[]).includes(name)) presets.push(entry)
    }
    return { presets, errors }
  }

  /**
   * Look a preset up by name.
   * @throws `config/invalid` when the project file of that name is broken (the message names the file and field);
   *   `tool/invalid-input` when no preset has that name (the message lists the available ones).
   */
  async resolve(name: string): Promise<AgentPreset> {
    const { presets, errors } = await this.load()
    const found = presets.find(entry => entry.preset.name === name)
    if (found !== undefined) return found.preset
    const broken = errors.find(error => nodePath.basename(error.file) === `${name}.json`)
    if (broken !== undefined) {
      throw new NexgentError('config/invalid', `preset "${name}" (${broken.file}) is invalid: ${broken.message}`, { details: { file: broken.file } })
    }
    throw new NexgentError('tool/invalid-input', `unknown preset "${name}"; available: ${presets.map(entry => entry.preset.name).join(', ')}`)
  }
}

/** One line per preset, for a tool description: `- name: description`. */
export function describePresets(presets: readonly PresetEntry[]): string {
  return presets.map(entry => `- ${entry.preset.name}: ${entry.preset.description}`).join('\n')
}
