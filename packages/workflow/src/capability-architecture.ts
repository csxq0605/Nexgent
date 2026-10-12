/**
 * The `architecture` component check (step 4): a capability bundle's
 * `architectures/<name>/architecture.json` is an `ArchitectureFile`
 * (`{ "format": 1, "architecture": { "nodes": [...] } }`) whose graph this
 * package's compiler accepts. Registered with `ctx.capabilities` when that
 * service is loaded; this package does not depend on `@nexgent/capabilities`.
 */
import type { ArchitectureFile } from '@nexgent/kernel'
import { prepareArchitecture } from './architecture.js'

/** What the validator receives (the shape `@nexgent/capabilities` passes). */
export interface ArchitectureComponentInput {
  readonly component: { readonly kind: string; readonly name: string }
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly directory: string
}

/** Throws an `Error` naming the problem; the capability service reports it as `tool/invalid-input`. */
export function validateCapabilityArchitecture(input: ArchitectureComponentInput): void {
  const bytes = input.files.get('architecture.json')
  if (bytes === undefined) throw new Error('missing architecture.json')
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    throw new Error(`architecture.json is not valid JSON: ${(error as Error).message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as Partial<ArchitectureFile>).format !== 1 || !('architecture' in raw)
    || Object.keys(raw).some(key => key !== 'format' && key !== 'architecture')) {
    throw new Error('architecture.json must be { "format": 1, "architecture": { "nodes": [...] } }')
  }
  try {
    prepareArchitecture((raw as ArchitectureFile).architecture)
  } catch (error) {
    throw new Error(`architecture.json: ${(error as Error).message}`)
  }
}
