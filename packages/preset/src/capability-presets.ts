/**
 * Presets from capability bundles (step 4). `@nexgent/capabilities`
 * provides `ctx.capabilities`; this package does not depend on it, it reads
 * the service through the narrow {@link CapabilityPresetService} shape when
 * the service is loaded. For one name: a preset the session tried
 * (`capability_try`) > the project's `.nexgent/presets/` > the adopted
 * capability version > built-in.
 */
import { PresetRegistry, type CapabilityPresetFile } from './registry.js'

/** What this package uses of `ctx.capabilities`. */
export interface CapabilityPresetService {
  components(sessionId: string, kind: 'preset'): Promise<readonly { readonly name: string; readonly entryPath: string; readonly version: string }[]>
}

/** Getter for the service; `undefined` while `@nexgent/capabilities` is not loaded. */
export type CapabilityPresetLookup = () => CapabilityPresetService | undefined

/** `ctx.capabilities` of a Cordis context, read on each call. */
export function capabilityPresetLookup(ctx: unknown): CapabilityPresetLookup {
  return () => {
    const service = (ctx as { get(name: string): unknown }).get('capabilities') as Partial<CapabilityPresetService> | undefined
    return typeof service?.components === 'function' ? service as CapabilityPresetService : undefined
  }
}

/** Capability presets in force for one (root) session. */
export async function capabilityPresetFiles(sessionId: string, lookup?: CapabilityPresetLookup): Promise<readonly CapabilityPresetFile[]> {
  const service = lookup?.()
  if (service === undefined) return []
  return (await service.components(sessionId, 'preset')).map(item => ({ name: item.name, file: item.entryPath, tried: item.version === 'draft' }))
}

/** The preset registry a session sees: the project's presets plus its capability presets. */
export async function sessionPresetRegistry(projectRoot: string, sessionId: string, lookup?: CapabilityPresetLookup): Promise<PresetRegistry> {
  return new PresetRegistry(projectRoot, await capabilityPresetFiles(sessionId, lookup))
}
