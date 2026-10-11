/**
 * The `ctx.tasking` service and the Cordis plugin of `@nexgent/tasking`.
 */
import {
  type Context,
  type ContextService,
  type SessionStore,
  type TaskingService,
  type ToolRegistry,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { LocalDeliverableStore } from './deliverables.js'
import { goalContextProvider, SessionFeedbackStore, SessionGoalStore } from './feedback-goals.js'
import { LocalMaterialStore } from './materials.js'
import { presentTool } from './present-tool.js'
import { LocalTurnFileTracker, type LocalTurnFileTrackerOptions } from './turn-files.js'

/** Options of {@link createTaskingService}. */
export interface TaskingServiceOptions {
  /** Clock for metadata timestamps (tests pin it). */
  readonly now?: () => Date
  /** File-tracker options. */
  readonly files?: LocalTurnFileTrackerOptions
}

/** The concrete service: the contract plus the local store types. */
export interface LocalTaskingService extends TaskingService {
  readonly materials: LocalMaterialStore
  readonly deliverables: LocalDeliverableStore
  readonly feedback: SessionFeedbackStore
  readonly goals: SessionGoalStore
  readonly files: LocalTurnFileTracker
  /** Remove `.tmp-*` leftovers of interrupted material and deliverable writes. */
  cleanup(): Promise<number>
}

/** Build the service for one project. */
export function createTaskingService(layout: WorkspaceLayout, sessions: SessionStore, options: TaskingServiceOptions = {}): LocalTaskingService {
  const clock = options.now === undefined ? {} : { now: options.now }
  const materials = new LocalMaterialStore(layout, clock)
  const deliverables = new LocalDeliverableStore(layout, clock)
  return {
    materials,
    deliverables,
    feedback: new SessionFeedbackStore(layout, sessions),
    goals: new SessionGoalStore(sessions, clock),
    files: new LocalTurnFileTracker(layout.root, options.files ?? {}),
    async cleanup() {
      return (await materials.cleanup()) + (await deliverables.cleanup())
    },
  }
}

/** Cordis plugin name. */
export const name = '@nexgent/tasking'

/** Plugin config (none yet). */
export type Config = Record<string, never>

/**
 * Cordis plugin: provides `ctx.tasking`; registers `present` whenever
 * `ctx.tools` is available and the goal provider whenever `ctx.context` is
 * (both unregistered when either side is disposed). Leftover `.tmp-*`
 * directories are removed on start.
 */
export async function apply(ctx: Context): Promise<void> {
  const service = createTaskingService(ctx.workspace.layout, ctx.session)
  await service.cleanup()
  ctx.provide('tasking', service)
  ctx.inject(['tools'], scope => {
    const registry = scope.tools as ToolRegistry
    scope.effect(() => registry.register(presentTool(service.deliverables)), 'tools.register(present)')
  })
  ctx.inject(['context'], scope => {
    const context = (scope as unknown as { readonly context: ContextService }).context
    scope.effect(() => context.register(goalContextProvider()), 'context.register(goal)')
  })
}

/** The plugin as an object, for `ctx.plugin(TaskingPlugin)`. */
export const TaskingPlugin = { name, inject: ['workspace', 'session'], provide: ['tasking'], apply }
