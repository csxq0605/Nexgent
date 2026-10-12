/**
 * Content checks of one component (`data-formats.md` §`CapabilityBundle`
 * 清单, the kind table): the entry file parses and validates against the
 * contract schema, names agree, a module's entry exists, function tool names
 * are legal. `capability_try` runs them before loading a draft; the loader
 * runs them again on an adopted bundle. Kinds whose format belongs to a
 * package that depends on this one (skills, workflow graphs) are checked by
 * a validator that package registers ({@link ComponentValidator}); without
 * one only the entry file's presence is checked.
 */
import {
  CAPABILITY_LIMITS,
  COMPONENT_ENTRY_FILES,
  componentDir,
  functionToolName,
  NexgentError,
  TOOL_NAME_PATTERN,
  type CapabilityComponentKind,
  type CapabilityComponentRef,
  type ContextPolicySpec,
  type FunctionModuleSpec,
  type PluginSpec,
  type TeamTemplateSpec,
} from '@nexgent/kernel'
import { parsePresetFile } from '@nexgent/preset'
import { validateCapabilityFile, type CapabilityFileKind } from '@nexgent/session'

/** A component's files in memory, by component-relative path. */
export type ComponentFiles = ReadonlyMap<string, Uint8Array>

/** What a registered validator receives. */
export interface ComponentValidationInput {
  readonly component: CapabilityComponentRef
  readonly files: ComponentFiles
  /** Absolute component directory the files were read from. */
  readonly directory: string
}

/** Extra check for one kind; throws `tool/invalid-input` (or any `NexgentError`) naming the problem. */
export type ComponentValidator = (input: ComponentValidationInput) => void | Promise<void>

/** A component's parsed entry, by kind. */
export type ComponentSpec =
  | { readonly kind: 'function-module'; readonly spec: FunctionModuleSpec; readonly entry: string; readonly tools: readonly string[] }
  | { readonly kind: 'plugin'; readonly spec: PluginSpec; readonly entry: string; readonly tools: readonly string[] }
  | { readonly kind: 'context-policy'; readonly spec: ContextPolicySpec }
  | { readonly kind: 'team-template'; readonly spec: TeamTemplateSpec }
  | { readonly kind: 'skill' | 'preset' | 'architecture' }

const SCHEMA_KIND: Partial<Record<CapabilityComponentKind, CapabilityFileKind>> = {
  'function-module': 'functionModule',
  plugin: 'plugin',
  'context-policy': 'contextPolicy',
  'team-template': 'teamTemplate',
}

const DEFAULT_ENTRY = 'index.mjs'

function invalid(component: CapabilityComponentRef, message: string): never {
  throw new NexgentError('tool/invalid-input', `${componentDir(component.kind, component.name)}: ${message}`)
}

function text(files: ComponentFiles, path: string): string | undefined {
  const bytes = files.get(path)
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8')
}

function parseEntry(component: CapabilityComponentRef, files: ComponentFiles): unknown {
  const entryFile = COMPONENT_ENTRY_FILES[component.kind]
  const raw = text(files, entryFile)
  if (raw === undefined) invalid(component, `missing entry file ${entryFile}`)
  try {
    return JSON.parse(raw)
  } catch (error) {
    return invalid(component, `${entryFile} is not valid JSON: ${(error as Error).message}`)
  }
}

function moduleEntry(component: CapabilityComponentRef, files: ComponentFiles, entry: string | undefined): string {
  const path = entry ?? DEFAULT_ENTRY
  if (!path.endsWith('.mjs')) invalid(component, `entry ${path} must be an .mjs module`)
  if (!files.has(path)) invalid(component, `entry module ${path} is missing`)
  return path
}

/**
 * Check one component's files and return its parsed entry.
 * @throws `tool/invalid-input` naming the component and the problem.
 */
export async function validateComponent(component: CapabilityComponentRef, files: ComponentFiles, directory: string,
  validators: ReadonlyMap<CapabilityComponentKind, ComponentValidator> = new Map()): Promise<ComponentSpec> {
  const entryFile = COMPONENT_ENTRY_FILES[component.kind]
  if (!files.has(entryFile)) invalid(component, `missing entry file ${entryFile}`)
  if (files.size > CAPABILITY_LIMITS.maxFilesPerComponent) invalid(component, `more than ${CAPABILITY_LIMITS.maxFilesPerComponent} files`)
  let result: ComponentSpec
  const schemaKind = SCHEMA_KIND[component.kind]
  if (schemaKind !== undefined) {
    const value = parseEntry(component, files)
    const issues = validateCapabilityFile(schemaKind, value)
    if (issues.length > 0) invalid(component, `${entryFile}: ${issues[0]!.path} ${issues[0]!.message}`)
    const spec = value as { readonly name: string }
    if (spec.name !== component.name) invalid(component, `${entryFile} name "${spec.name}" must equal the component name`)
    switch (component.kind) {
      case 'function-module': {
        const module = value as FunctionModuleSpec
        if (module.functions.length === 0 || module.functions.length > CAPABILITY_LIMITS.maxFunctionsPerModule) {
          invalid(component, `a function module exports 1 to ${CAPABILITY_LIMITS.maxFunctionsPerModule} functions`)
        }
        const tools = module.functions.map(fn => {
          try {
            return functionToolName(component.name, fn.name)
          } catch (error) {
            return invalid(component, (error as Error).message)
          }
        })
        if (new Set(tools).size !== tools.length) invalid(component, 'function names must be unique')
        result = { kind: 'function-module', spec: module, entry: moduleEntry(component, files, module.entry), tools }
        break
      }
      case 'plugin': {
        const plugin = value as PluginSpec
        const tools = plugin.tools ?? []
        for (const tool of tools) if (!TOOL_NAME_PATTERN.test(tool)) invalid(component, `tool name "${tool}" must match ${String(TOOL_NAME_PATTERN)}`)
        if (new Set(tools).size !== tools.length) invalid(component, 'tool names must be unique')
        result = { kind: 'plugin', spec: plugin, entry: moduleEntry(component, files, plugin.entry), tools }
        break
      }
      case 'context-policy': {
        const policy = value as ContextPolicySpec
        if (policy.instructions !== undefined && Buffer.byteLength(policy.instructions) > CAPABILITY_LIMITS.maxInstructionBytes) {
          invalid(component, `instructions exceed ${CAPABILITY_LIMITS.maxInstructionBytes} bytes`)
        }
        if (policy.personaSuffix !== undefined && Buffer.byteLength(policy.personaSuffix) > CAPABILITY_LIMITS.maxPersonaSuffixBytes) {
          invalid(component, `personaSuffix exceeds ${CAPABILITY_LIMITS.maxPersonaSuffixBytes} bytes`)
        }
        result = { kind: 'context-policy', spec: policy }
        break
      }
      default:
        result = { kind: 'team-template', spec: value as TeamTemplateSpec }
    }
  } else if (component.kind === 'preset') {
    try {
      parsePresetFile(text(files, entryFile)!, component.name)
    } catch (error) {
      invalid(component, (error as Error).message)
    }
    result = { kind: 'preset' }
  } else {
    result = { kind: component.kind as 'skill' | 'architecture' }
  }
  const extra = validators.get(component.kind)
  if (extra !== undefined) {
    try {
      await extra({ component, files, directory })
    } catch (error) {
      if (error instanceof NexgentError) throw error
      invalid(component, (error as Error).message)
    }
  }
  return result
}
