/**
 * The `@nexgent/capabilities` plugin: provides `ctx.capabilities` (the
 * loader and the project's capability store) and `ctx.capabilityHost` (the
 * kernel's step-4 seam over the same loader, with the handbook entries a
 * root turn is given), registers the three capability tools, `handbook_mark`
 * and the `capabilities` context provider, and runs the
 * gate's host side (`ctx.capabilityGate`): the usage-regression watch before
 * every new root session and after every root turn, automatic trials of new
 * candidates, and the recovery of interrupted trials.
 */
import { resolve } from 'node:path'
import { nexgentHome, resolveUserDataLayout, type Context, type HandbookTurnSelection, type SessionRecord } from '@nexgent/kernel'
import { capabilitiesProvider, type CompactionOverrideSink } from './provider.js'
import { CapabilityService, type CapabilitiesConfig } from './service.js'
import { HandbookHost, seededRandom } from './handbook/host.js'
import { SkillLibraryHost } from './skill-library/host.js'
import { capabilityTools } from './tools.js'
import { GateHost, type GateHostConfig } from './trial/host.js'
import { OrganizationLibrary } from './organizations/library.js'

/** Plugin-row config: the loader's, plus the gate's `trial` settings. */
export type CapabilitiesPluginConfig = CapabilitiesConfig & { readonly trial?: GateHostConfig }

/** The plugin as an object, for `ctx.plugin(CapabilitiesPlugin, config)`. */
export const CapabilitiesPlugin = {
  name: '@nexgent/capabilities',
  inject: ['workspace', 'sandbox'],
  provide: ['capabilities', 'capabilityHost', 'capabilityGate', 'organizations'],
  apply(ctx: Context, config: CapabilitiesPluginConfig = {}): void {
    const service = new CapabilityService(ctx, ctx.workspace.layout.capabilities, ctx.sandbox, config ?? {})
    const gate = new GateHost(ctx, ctx.workspace.layout, service.store, config?.trial ?? {})
    const host = service.host()
    const readRecords = async (sessionId: string): Promise<readonly SessionRecord[]> => {
      const store = ctx.get('session')
      return store === undefined ? [] : (await store.readAll(sessionId)).records
    }
    const home = config?.home ?? config?.trial?.env?.NEXGENT_HOME
    const userHome = resolve(typeof home === 'string' && home !== '' ? home : nexgentHome())
    const handbook = new HandbookHost(service, {
      projectRoot: ctx.workspace.layout.root,
      readRecords,
      ...(typeof home === 'string' && home !== '' ? { home } : {}),
      ...(typeof config?.handbookSeed === 'number' ? { random: seededRandom(config.handbookSeed) } : {}),
    })
    // ADR 0025: learned skills, drawn with the handbook at a root task's turn.
    const skills = new SkillLibraryHost({
      projectRoot: ctx.workspace.layout.root,
      home: userHome,
      readRecords,
      readOnly: () => handbook.readOnly(),
      ...(typeof config?.handbookSeed === 'number' ? { random: seededRandom(config.handbookSeed + 1) } : {}),
    })
    service.setLearnedSkills(sessionId => skills.skillsFor(sessionId))
    if (config?.trial?.entry !== undefined) service.setTrialStarter(async candidateId => (await gate.trial(candidateId)).candidateId)
    ctx.provide('capabilities', service)
    // New direction step 3: the user's organization library (a trial copy records nothing).
    ctx.provide('organizations', new OrganizationLibrary(resolveUserDataLayout(userHome).organizations, {
      readOnly: () => handbook.readOnly(),
    }))
    ctx.provide('capabilityGate', gate)
    ctx.provide('capabilityHost', {
      ...host,
      // A new root session: roll back a regressed adoption before resolving its version.
      current: async () => {
        await gate.watchUsage()
        return host.current()
      },
      handbookForTurn: async input => {
        const selection = await handbook.forTurn(input)
        const learned = await skills.forTurn(input).catch(() => undefined)
        return withLearnedSkills(selection, learned)
      },
      attach: async input => {
        const attachment = await host.attach(input)
        if (input.member === undefined) gate.followWhenOpen(input.sessionId)
        return attachment
      },
    })
    void gate.recover().catch(() => undefined)
    // A propose session in a snapshot copy writes its session to the real project, which holds the job.
    const sessionsDir = (): string | undefined => {
      const dir = (ctx.get('session') as { readonly sessionsDir?: unknown } | undefined)?.sessionsDir
      return typeof dir === 'string' ? dir : undefined
    }
    ctx.inject(['tools'], scope => {
      for (const tool of capabilityTools(service, readRecords, { sessionsDir })) {
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

/** The handbook's selection with the learned-skill line after it (pure). */
export function withLearnedSkills(selection: HandbookTurnSelection | undefined, learned: string | undefined): HandbookTurnSelection | undefined {
  if (learned === undefined || learned.trim() === '') return selection
  if (selection === undefined) return { ids: [], text: learned }
  return { ids: selection.ids, text: `${selection.text}\n\n${learned}` }
}

export const name = CapabilitiesPlugin.name
export const apply = CapabilitiesPlugin.apply
