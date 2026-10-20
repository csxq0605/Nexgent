/**
 * Skills from capability bundles (step 4). `@nexgent/capabilities` provides
 * `ctx.capabilities`; this package does not depend on it, it only reads the
 * service through the narrow {@link CapabilitySkillService} shape when the
 * service is loaded, and registers a validator so `capability_try` and the
 * loader refuse a `SKILL.md` this package could not use.
 */
import type { LoadedSkill, SkillCatalog } from '@nexgent/kernel'
import { parseSkillFile } from './frontmatter.js'
import { MAX_SKILL_FILE_BYTES, type CapabilitySkillLayers } from './registry.js'

/** A registry that also takes the session's capability skills. */
export interface LayeredSkillRegistry {
  catalog(layers?: CapabilitySkillLayers): Promise<SkillCatalog>
  load(name: string, layers?: CapabilitySkillLayers): Promise<LoadedSkill>
}

/** Capability skills in force for one session. */
export type CapabilitySkillLookup = (sessionId: string) => Promise<CapabilitySkillLayers>

/** What this package uses of `ctx.capabilities`. */
export interface CapabilitySkillService {
  components(sessionId: string, kind: 'skill'): Promise<readonly { readonly name: string; readonly entryPath: string; readonly version: string }[]>
  registerValidator(kind: 'skill', validator: (input: {
    readonly component: { readonly kind: string; readonly name: string }
    readonly files: ReadonlyMap<string, Uint8Array>
    readonly directory: string
  }) => void): () => void
}

/** Lookup over the service (absent service → no capability skills). */
export function capabilitySkillLookup(service: () => CapabilitySkillService | undefined): CapabilitySkillLookup {
  return async sessionId => {
    const capabilities = service()
    if (capabilities === undefined) return []
    return (await capabilities.components(sessionId, 'skill'))
      .map(component => ({ name: component.name, entryPath: component.entryPath, tried: component.version === 'draft' }))
  }
}

/** Thrown by {@link validateCapabilitySkill}; the capability service reports it as `tool/invalid-input`. */
export class CapabilitySkillInvalid extends Error {}

/**
 * The `skill` component check: `SKILL.md` parses, its `name` equals the
 * component name, and it is within the size limit.
 */
export function validateCapabilitySkill(input: Parameters<Parameters<CapabilitySkillService['registerValidator']>[1]>[0]): void {
  const bytes = input.files.get('SKILL.md')
  if (bytes === undefined) throw new CapabilitySkillInvalid('missing SKILL.md')
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new CapabilitySkillInvalid(`SKILL.md is ${bytes.byteLength} bytes; the limit is ${MAX_SKILL_FILE_BYTES}`)
  const parsed = parseSkillFile(Buffer.from(bytes).toString('utf8'), `${input.directory}/SKILL.md`, 'project')
  if (!parsed.ok) throw new CapabilitySkillInvalid(`SKILL.md: ${parsed.reason}`)
  if (parsed.manifest.name !== input.component.name) throw new CapabilitySkillInvalid(`SKILL.md names the skill ${parsed.manifest.name}; the component is ${input.component.name}`)
}
