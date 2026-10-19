/**
 * The capability components a job's project already runs on (ADR 0010):
 * listed in the diagnosis prompt so the diagnosis can tell a missing
 * capability from one that exists but did not prevent the failure, or from
 * feedback on work done before the component was adopted.
 */
import { BASELINE_VERSION, type CapabilityComponentKind, type WorkspaceLayout } from '@nexgent/kernel'
import { CapabilityStore, loadBundle, readComponentFiles } from '@nexgent/capabilities'

/** One adopted component as the diagnosis sees it. */
export interface AdoptedComponent {
  readonly kind: CapabilityComponentKind
  readonly name: string
  readonly description?: string
  /** A context policy's `instructions` (truncated). */
  readonly instructions?: string
}

/** The version in force and its components (none on the baseline). */
export interface AdoptedCapabilities {
  readonly version: string
  readonly components: readonly AdoptedComponent[]
}

const MAX_DESCRIPTION_CHARS = 300
const MAX_INSTRUCTIONS_CHARS = 1_200

/** Entry file of each kind (`data-formats.md` §能力组件). */
const ENTRY: Record<CapabilityComponentKind, string> = {
  'function-module': 'functions.json',
  plugin: 'plugin.json',
  skill: 'SKILL.md',
  'context-policy': 'policy.json',
  preset: 'preset.json',
  'team-template': 'team.json',
  architecture: 'architecture.json',
}

function clip(text: string, max: number): string {
  const flat = text.trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function describe(kind: CapabilityComponentKind, text: string): Pick<AdoptedComponent, 'description' | 'instructions'> {
  if (kind === 'skill') {
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]
    return description === undefined ? {} : { description: clip(description, MAX_DESCRIPTION_CHARS) }
  }
  try {
    const value = JSON.parse(text) as { description?: unknown; instructions?: unknown }
    return {
      ...(typeof value.description === 'string' && value.description.trim() !== '' ? { description: clip(value.description, MAX_DESCRIPTION_CHARS) } : {}),
      ...(kind === 'context-policy' && typeof value.instructions === 'string' && value.instructions.trim() !== '' ? { instructions: clip(value.instructions, MAX_INSTRUCTIONS_CHARS) } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * The project's capability version now (when a job starts its diagnosis,
 * the version it started on) and its components. Unreadable details are
 * left out; an unreadable chain or bundle reads as the baseline.
 */
export async function adoptedCapabilities(layout: WorkspaceLayout): Promise<AdoptedCapabilities> {
  const version = (await new CapabilityStore(layout.capabilities).activation().catch(() => undefined))?.version ?? BASELINE_VERSION
  if (version === BASELINE_VERSION) return { version, components: [] }
  const bundle = await loadBundle(layout.capabilities, version).catch(() => undefined)
  if (bundle === undefined) return { version, components: [] }
  const components: AdoptedComponent[] = []
  for (const component of bundle.manifest.components) {
    const files = await readComponentFiles(bundle, component).catch(() => [])
    const entry = files.find(file => file.path === ENTRY[component.kind])
    const text = entry === undefined ? undefined : typeof entry.content === 'string' ? entry.content : Buffer.from(entry.content).toString('utf8')
    components.push({ kind: component.kind, name: component.name, ...(text === undefined ? {} : describe(component.kind, text)) })
  }
  return { version, components }
}

/** The diagnosis prompt's section on adopted components; empty when there are none. Pure. */
export function adoptedSection(adopted: AdoptedCapabilities | undefined): string[] {
  if (adopted === undefined || adopted.components.length === 0) return []
  const lines = [
    '',
    '# Adopted capabilities',
    `This job runs on capability version ${adopted.version}. These components were already adopted (by earlier improvements) when it started; a session that ran on an earlier version did not have them (each session's session.start record names the version it ran on):`,
  ]
  for (const component of adopted.components) {
    lines.push(`- ${component.kind} ${component.name}${component.description === undefined ? '' : `: ${component.description}`}`)
    if (component.instructions !== undefined) lines.push(`  Instructions: ${JSON.stringify(component.instructions)}`)
  }
  return lines
}
