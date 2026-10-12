/**
 * The `@nexgent/capabilities` plugin: provides `ctx.capabilities` (the
 * loader and the project's capability store) and `ctx.capabilityHost` (the
 * kernel's step-4 seam over the same loader), registers the three
 * capability tools and the `capabilities` context provider, and runs the
 * gate's host side (`ctx.capabilityGate`): the usage-regression watch before
 * every new root session and after every root turn, automatic trials of new
 * candidates, and the recovery of interrupted trials.
 */
import type { Context, SessionRecord } from '@nexgent/kernel'
import { capabilitiesProvider, type CompactionOverrideSink } from './provider.js'
import { CapabilityService, type CapabilitiesConfig } from './service.js'
import { capabilityTools } from './tools.js'
import { GateHost, type GateHostConfig } from './trial/host.js'

/** Plugin-row config: the loader's, plus the gate's `trial` settings. */
export type CapabilitiesPluginConfig = CapabilitiesConfig & { readonly trial?: GateHostConfig }

/** The plugin as an object, for `ctx.plugin(CapabilitiesPlugin, config)`. */
export const CapabilitiesPlugin = {
  name: '@nexgent/capabilities',
  inject: ['workspace', 'sandbox'],
  provide: ['capabilities', 'capabilityHost', 'capabilityGate'],
  apply(ctx: Context, config: CapabilitiesPluginConfig = {}): void {
    const service = new CapabilityService(ctx, ctx.workspace.layout.capabilities, ctx.sandbox, config ?? {})
    const gate = new GateHost(ctx, ctx.workspace.layout, service.store, config?.trial ?? {})
    const host = service.host()
    if (config?.trial?.entry !== undefined) service.setTrialStarter(async candidateId => (await gate.trial(candidateId)).candidateId)
    ctx.provide('capabilities', service)
    ctx.provide('capabilityGate', gate)
    ctx.provide('capabilityHost', {
      ...host,
      // A new root session: roll back a regressed adoption before resolving its version.
      current: async () => {
        await gate.watchUsage()
        return host.current()
      },
      attach: async input => {
        const attachment = await host.attach(input)
        if (input.member === undefined) gate.followWhenOpen(input.sessionId)
        return attachment
      },
    })
    void gate.recover().catch(() => undefined)
    const readRecords = async (sessionId: string): Promise<readonly SessionRecord[]> => {
      const store = ctx.get('session')
      return store === undefined ? [] : (await store.readAll(sessionId)).records
    }
    ctx.inject(['tools'], scope => {
      for (const tool of capabilityTools(service, readRecords)) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
    })
    ctx.inject(['context'], scope => {
      const compactor = scope.context.compactor as { setSessionOverride?: CompactionOverrideSink } | undefined
      const sink = typeof compactor?.setSessionOverride === 'function' ? compactor.setSessionOverride.bind(compactor) : undefined
      scope.effect(() => scope.context.register(capabilitiesProvider(service, () => sink)), 'context.register(capabilities)')
    })
  },
}

export const name = CapabilitiesPlugin.name
export const apply = CapabilitiesPlugin.apply
