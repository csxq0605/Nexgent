/**
 * Step 4 (W4): the SDK's `capabilities.*` methods over one project's
 * `@nexgent/capabilities` service: the adopted version, its activation
 * history and manual rollback.
 */
import { NexgentError, type CapabilityVersion } from '@nexgent/kernel'
import type { CapabilityService } from '@nexgent/capabilities'
import type { CapabilityListing, CapabilityVersionView } from './api.js'

/** The adopted version the way a new session would get it (a bundle that fails verification is rolled back first). */
export async function currentView(service: CapabilityService): Promise<CapabilityVersionView> {
  await service.resolveVersion()
  const status = await service.status()
  return {
    version: status.version,
    revision: status.revision,
    ...(status.since === undefined ? {} : { since: status.since }),
    ...(status.trigger === undefined ? {} : { trigger: status.trigger }),
    components: status.components,
    ...(status.problem === undefined ? {} : { problem: status.problem }),
  }
}

/** `capabilities.list`. */
export async function listing(service: CapabilityService): Promise<CapabilityListing> {
  const current = await currentView(service)
  return { current, history: await service.store.history() }
}

/** `capabilities.rollback`: back to the previous version, or down the stack to `toVersion`. */
export async function rollback(service: CapabilityService, toVersion: CapabilityVersion | undefined, reason: string | undefined): Promise<CapabilityVersionView> {
  if (reason !== undefined && typeof reason !== 'string') throw new NexgentError('tool/invalid-input', 'reason must be a string')
  const activation = await service.store.activation()
  if (activation.revision === 0 || activation.stack.length < 2) throw new NexgentError('tool/invalid-input', 'nothing to roll back: the baseline is in force')
  const stack = activation.stack
  const target = toVersion ?? stack[stack.length - 2]!
  const index = stack.lastIndexOf(target)
  if (index < 0 || index === stack.length - 1) throw new NexgentError('tool/invalid-input', `version ${String(toVersion)} is not an earlier version in the adopted history`)
  const detail = (reason ?? '').trim() === '' ? 'Rolled back by the user.' : `Rolled back by the user: ${reason!.trim()}`.slice(0, 2000)
  let base = activation
  while (base.version !== target) {
    const committed = await service.store.rollback({ trigger: 'manual', reason: 'manual', detail }, base)
    if (committed === null) throw new NexgentError('internal', 'the capability history changed meanwhile; try again')
    base = committed.activation
  }
  return currentView(service)
}
