/**
 * The `@nexgent/capabilities` plugin: provides `ctx.capabilities` (the
 * loader and the project's capability store), `ctx.capabilityHost` (the
 * kernel's step-4 seam over the same loader, with the handbook entries a
 * root turn is given) and `ctx.organizations` (the user's organization
 * library), and registers the two capability tools, `handbook_mark` and the
 * `capabilities` context provider.
 */
import { resolve } from 'node:path'
import { nexgentHome, resolveUserDataLayout, type Context, type LLMProvider, type SessionRecord } from '@nexgent/kernel'
import { capabilitiesProvider, type CompactionOverrideSink } from './provider.js'
import { CapabilityService, type CapabilitiesConfig } from './service.js'
import { HandbookHost, seededRandom } from './handbook/host.js'
import { capabilityTools } from './tools.js'
import { OrganizationLibrary } from './organizations/library.js'
import { modelReflector } from './organizations/model-reflection.js'

/** Plugin-row config. */
export type CapabilitiesPluginConfig = CapabilitiesConfig

/** The plugin as an object, for `ctx.plugin(CapabilitiesPlugin, config)`. */
export const CapabilitiesPlugin = {
  name: '@nexgent/capabilities',
  inject: ['workspace', 'sandbox'],
  provide: ['capabilities', 'capabilityHost', 'organizations'],
  apply(ctx: Context, config: CapabilitiesPluginConfig = {}): void {
    const service = new CapabilityService(ctx, ctx.workspace.layout.capabilities, ctx.sandbox, config ?? {})
    const host = service.host()
    const readRecords = async (sessionId: string): Promise<readonly SessionRecord[]> => {
      const store = ctx.get('session')
      return store === undefined ? [] : (await store.readAll(sessionId)).records
    }
    const home = config?.home
    const userHome = resolve(typeof home === 'string' && home !== '' ? home : nexgentHome())
    const handbook = new HandbookHost(service, {
      projectRoot: ctx.workspace.layout.root,
      readRecords,
      ...(typeof home === 'string' && home !== '' ? { home } : {}),
      ...(typeof config?.handbookSeed === 'number' ? { random: seededRandom(config.handbookSeed) } : {}),
    })
    ctx.provide('capabilities', service)
    // New direction step 3: the user's organization library.
    // Coordinator step three: a model picks the change for a run's hotspot from its records (the rule decides when it cannot).
    ctx.provide('organizations', new OrganizationLibrary(resolveUserDataLayout(userHome).organizations, {
      reflector: modelReflector({ llm: () => ctx.get('llm') as LLMProvider | undefined, readRecords }),
    }))
    ctx.provide('capabilityHost', { ...host, handbookForTurn: input => handbook.forTurn(input) })
    ctx.inject(['tools'], scope => {
      for (const tool of capabilityTools(service, readRecords)) {
        scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      }
      const mark = handbook.markTool()
      scope.effect(() => scope.tools.register(mark), `tools.register(${mark.definition.name})`)
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
