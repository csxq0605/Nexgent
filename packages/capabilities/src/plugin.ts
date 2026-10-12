/**
 * The `@nexgent/capabilities` plugin: provides `ctx.capabilities` (the
 * loader and the project's capability store) and `ctx.capabilityHost` (the
 * kernel's step-4 seam over the same loader), registers the three
 * capability tools and the `capabilities` context provider.
 */
import type { Context, SessionRecord } from '@nexgent/kernel'
import { capabilitiesProvider, type CompactionOverrideSink } from './provider.js'
import { CapabilityService, type CapabilitiesConfig } from './service.js'
import { capabilityTools } from './tools.js'

/** The plugin as an object, for `ctx.plugin(CapabilitiesPlugin, config)`. */
export const CapabilitiesPlugin = {
  name: '@nexgent/capabilities',
  inject: ['workspace', 'sandbox'],
  provide: ['capabilities', 'capabilityHost'],
  apply(ctx: Context, config: CapabilitiesConfig = {}): void {
    const service = new CapabilityService(ctx, ctx.workspace.layout.capabilities, ctx.sandbox, config ?? {})
    ctx.provide('capabilities', service)
    ctx.provide('capabilityHost', service.host())
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
