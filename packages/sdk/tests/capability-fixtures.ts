/**
 * Capability files of a project written directly (step 4): bundles and
 * adopted versions, so the SDK's `capabilities.*` views can be tested.
 * Nothing in the app adopts a version any more; a project may still carry
 * one an older build adopted, which {@link adopt} stands in for.
 */
import { randomUUID } from 'node:crypto'
import * as nodePath from 'node:path'
import { CapabilityStore, commitActivation, type BundleComponentInput } from '@nexgent/capabilities'
import { resolveProjectLayout } from '@nexgent/kernel'

/** The project's capabilities directory (K1: in the user data directory). `testSdk` keeps its home next to the projects: `<base>/home`, projects at `<base>/<name>`. */
export const capabilitiesDir = (root: string): string => resolveProjectLayout(root, { home: nodePath.join(nodePath.dirname(root), 'home') }).capabilities
export const capabilityStore = (root: string): CapabilityStore => new CapabilityStore(capabilitiesDir(root))

/** A skill component; `variant` changes its content. */
export function skill(name: string, variant = 'a'): BundleComponentInput {
  return { kind: 'skill', name, files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Summarize orders (${variant}).\n---\n\n1. Read the CSV.\n` }] }
}

/** Make a stored bundle the adopted version, as an older build did. */
export async function adopt(store: CapabilityStore, version: string): Promise<void> {
  const committed = await commitActivation(store.activationDirectory, await store.activation(), { type: 'adopt', version, trigger: 'manual', decisionId: randomUUID() })
  if (committed === null) throw new Error('the activation tail moved')
}
