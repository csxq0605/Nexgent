/**
 * `ctx.capabilities`: the loader. It knows which capability version each
 * open session runs on, which of its components are in force for that
 * session (the adopted bundle's, overridden by drafts the session tried),
 * and hands them to the plugins that use them: function modules and plugin
 * packs become tools in the session's own tool scope; skills, presets, team
 * templates and context policies are read by the skill, preset and context
 * consumers through {@link CapabilityService.components}.
 *
 * Versions: `resolveVersion` is what the kernel calls when a session opens
 * (or resumes): it verifies the adopted bundle (and every component in it),
 * rolls back on a load failure, and reports a damaged activation chain
 * (`status().problem`) so the host can tell the user. A session's version
 * comes from its records (`session.start.capabilityVersion`, then the latest
 * `capability.version`), or from {@link CapabilityService.bindSession}; a
 * session without one runs on the baseline.
 *
 * The kernel reaches the loader through `ctx.capabilityHost`
 * ({@link CapabilityService.host}): `current` and `verify` when a session
 * opens or resumes, `attach` with the agent's scoped context (tools land in
 * that scope and leave with it), `componentOf` for uses its own rules do not
 * name (team templates, workflow graphs).
 */
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import {
  canonicalJson,
  COMPONENT_ENTRY_FILES,
  componentDir,
  NexgentError,
  type CapabilityComponentKind,
  type CapabilityComponentRef,
  type CapabilityDecision,
  type CapabilityVersion,
  type CapabilityVersionSwitchReason,
  type AttachedComponent,
  type CapabilityAttachInput,
  type CapabilityAttachment,
  type CapabilityHost,
  type ComponentCallInput,
  type ComponentUseRef,
  type Context,
  type Sandbox,
  type SessionRecord,
  type ToolContext,
} from '@nexgent/kernel'
import type { RunCodeToolOptions } from '@nexgent/ptc'
import type { ActivationProblem } from './activation.js'
import { CapabilityStore, type ResolvedCapabilities } from './capability-store.js'
import { validateComponent, type ComponentSpec, type ComponentValidator } from './components.js'
import { draftDirectory, freezeDraft, readComponentDirectory, triedDirectory } from './drafts.js'
import { functionModuleTools } from './function-tools.js'
import { CapabilityIntegrityError, componentDirectory, type StoredBundle } from './store.js'

/** One component in force for a session. */
export interface ActiveComponent extends CapabilityComponentRef {
  /** Bundle it came from, or `draft` for a component this session tried. */
  readonly version: CapabilityVersion | 'draft'
  /** Absolute component directory (bundle, or the frozen tried revision). */
  readonly directory: string
  /** Absolute path of the kind's entry file. */
  readonly entryPath: string
  /** Draft revision that was tried (drafts only). */
  readonly revision?: number
  readonly spec: ComponentSpec
}

/** What {@link CapabilityService.resolveVersion} settled on. */
export interface VersionResolution {
  /** Version the session runs on. */
  readonly version: CapabilityVersion
  /** Set when a recorded version could not be used: write `capability.version` with these fields. */
  readonly switched?: { readonly previous: CapabilityVersion; readonly reason: CapabilityVersionSwitchReason; readonly detail: string }
  /** Load-failure rollbacks this call published. */
  readonly rollbacks: readonly CapabilityDecision[]
  /** The activation chain is damaged after the version in force (tell the user). */
  readonly problem?: ActivationProblem
}

/** The project's capability state for hosts (mirrors the SDK's `CapabilityVersionView`). */
export interface CapabilityStatus {
  readonly version: CapabilityVersion
  readonly revision: number
  readonly since?: string
  readonly trigger?: CapabilityDecision['trigger']
  readonly components: readonly CapabilityComponentRef[]
  /** Why the host is not on the chain's tail, or the chain needs repair; for the user. */
  readonly problem?: string
}

/** Who a tool belongs to (for `task.outcome.componentsUsed`). */
export interface ToolComponent extends CapabilityComponentRef {
  readonly version: CapabilityVersion | 'draft'
}

interface Attachment {
  readonly signature: string
  readonly tools: readonly string[]
  dispose(): void | Promise<void>
}

interface SessionState {
  readonly version: CapabilityVersion
  readonly adopted: readonly ActiveComponent[]
  readonly tried: Map<string, ActiveComponent>
  readonly attached: Map<string, Attachment>
  /** The agent's scoped context the kernel handed over (`capabilityHost.attach`). */
  scope?: Context
  /** Serializes attach / try for the session. */
  queue: Promise<unknown>
}

/** Plugin-row config of `@nexgent/capabilities`. */
export interface CapabilitiesConfig {
  /** Passed to the PTC runtime that runs function modules (Electron hosts set `nodePath`). */
  readonly ptc?: RunCodeToolOptions
}

const key = (ref: CapabilityComponentRef) => `${ref.kind}/${ref.name}`

/** The capability loader service. */
export class CapabilityService {
  readonly store: CapabilityStore
  readonly #ctx: Context
  readonly #sandbox: Sandbox
  readonly #config: CapabilitiesConfig
  readonly #validators = new Map<CapabilityComponentKind, ComponentValidator>()
  readonly #sessions = new Map<string, Promise<SessionState>>()
  readonly #bound = new Map<string, CapabilityVersion>()
  readonly #bundles = new Map<string, Promise<readonly ActiveComponent[]>>()
  /** Components in force per session, for the synchronous `componentOf`. */
  readonly #known = new Map<string, readonly ActiveComponent[]>()
  #last: { resolved?: ResolvedCapabilities; failure?: string } = {}

  constructor(ctx: Context, capabilitiesDir: string, sandbox: Sandbox, config: CapabilitiesConfig = {}) {
    this.#ctx = ctx
    this.#sandbox = sandbox
    this.#config = config
    this.store = new CapabilityStore(capabilitiesDir, {
      onDecision: async decision => {
        await this.#ctx.get('ledger')?.append({
          type: 'capability.decision',
          decisionId: decision.id,
          outcome: decision.outcome,
          reason: decision.reason,
          trigger: decision.trigger,
          fromVersion: decision.fromVersion,
          toVersion: decision.toVersion,
          ...(decision.candidateId === undefined ? {} : { candidateId: decision.candidateId }),
          ...(decision.revision === undefined ? {} : { revision: decision.revision }),
        }).catch(() => {})
      },
    })
  }

  /** Register an extra content check for one kind (the skill and workflow plugins do); returns the unregister function. */
  registerValidator(kind: CapabilityComponentKind, validator: ComponentValidator): () => void {
    this.#validators.set(kind, validator)
    this.#bundles.clear()
    return () => {
      if (this.#validators.get(kind) === validator) this.#validators.delete(kind)
    }
  }

  /** Validated components of a verified bundle, cached per version. */
  #bundleComponents(bundle: StoredBundle): Promise<readonly ActiveComponent[]> {
    let cached = this.#bundles.get(bundle.version)
    if (cached === undefined) {
      cached = (async () => {
        const active: ActiveComponent[] = []
        for (const component of bundle.manifest.components) {
          const directory = componentDirectory(bundle, component)
          const files = await readComponentDirectory(directory)
          let spec: ComponentSpec
          try {
            spec = await validateComponent(component, files, directory, this.#validators)
          } catch (error) {
            throw new CapabilityIntegrityError(bundle.version, 'manifest', `component ${componentDir(component.kind, component.name)} is invalid: ${(error as Error).message}`, componentDir(component.kind, component.name))
          }
          active.push({ kind: component.kind, name: component.name, version: bundle.version, directory, entryPath: join(directory, COMPONENT_ENTRY_FILES[component.kind]), spec })
        }
        return active
      })()
      this.#bundles.set(bundle.version, cached)
      cached.catch(() => this.#bundles.delete(bundle.version))
    }
    return cached
  }

  async #usable(version: CapabilityVersion): Promise<readonly ActiveComponent[]> {
    return this.#bundleComponents(await this.store.load(version))
  }

  /**
   * The version a session opening now runs on. With `recorded` (a resumed
   * session) that version is kept when it still verifies; otherwise, and for
   * a new session, the adopted version, after load-failure rollbacks.
   */
  async resolveVersion(recorded?: CapabilityVersion): Promise<VersionResolution> {
    let recordedFailure: string | undefined
    if (recorded !== undefined) {
      try {
        await this.#usable(recorded)
        return { version: recorded, rollbacks: [] }
      } catch (error) {
        if (!(error instanceof CapabilityIntegrityError)) throw error
        recordedFailure = error.message
      }
    }
    const rollbacks: CapabilityDecision[] = []
    for (;;) {
      const resolved = await this.store.resolveAdopted()
      rollbacks.push(...resolved.rollbacks.map(rollback => rollback.decision))
      this.#last = { resolved }
      try {
        await this.#bundleComponents(resolved.bundle)
      } catch (error) {
        if (!(error instanceof CapabilityIntegrityError)) throw error
        if (resolved.problem !== undefined || resolved.bundle.version === 'baseline') {
          this.#last = { resolved, failure: error.message }
          return this.#resolution('baseline', rollbacks, resolved.problem, recorded, recordedFailure)
        }
        const committed = await this.store.rollback({ trigger: 'load-failure', reason: 'load-failure', detail: error.message }, resolved.activation)
        if (committed !== null) rollbacks.push(committed.decision)
        continue
      }
      if (resolved.fallback !== undefined) this.#last = { resolved, failure: resolved.fallback.error.message }
      return this.#resolution(resolved.bundle.version, rollbacks, resolved.problem, recorded, recordedFailure)
    }
  }

  #resolution(version: CapabilityVersion, rollbacks: CapabilityDecision[], problem: ActivationProblem | undefined,
    recorded: CapabilityVersion | undefined, recordedFailure: string | undefined): VersionResolution {
    return {
      version,
      rollbacks,
      ...(problem === undefined ? {} : { problem }),
      ...(recorded === undefined || recordedFailure === undefined ? {} : { switched: { previous: recorded, reason: 'unavailable' as const, detail: recordedFailure.slice(0, 500) } }),
    }
  }

  /** The project's state for hosts: adopted version, its components, and any problem to show the user. */
  async status(): Promise<CapabilityStatus> {
    const chain = await this.store.chain()
    const tail = chain.revisions.at(-1)
    let version = chain.activation.version
    let components: readonly CapabilityComponentRef[] = []
    let problem: string | undefined = chain.problem === undefined
      ? undefined
      : `The capability history is damaged at activation/${chain.problem.file} (${chain.problem.message}). New capability versions cannot be adopted or rolled back until it is repaired.`
    try {
      components = (await this.store.load(version)).manifest.components.map(component => ({ kind: component.kind, name: component.name }))
    } catch (error) {
      problem = [problem, `The adopted capability version failed verification (${(error as Error).message}); sessions fall back to an earlier version.`].filter(Boolean).join(' ')
      version = this.#last.resolved?.bundle.version ?? 'baseline'
    }
    if (this.#last.failure !== undefined && problem === undefined) problem = this.#last.failure
    return {
      version,
      revision: chain.activation.revision,
      ...(tail === undefined ? {} : { since: tail.committedAt, trigger: tail.trigger }),
      components,
      ...(problem === undefined ? {} : { problem }),
    }
  }

  /** Tell the loader which version a session runs on (the kernel calls it when the session opens). */
  bindSession(sessionId: string, version: CapabilityVersion): void {
    if (this.#bound.get(sessionId) === version) return
    this.#bound.set(sessionId, version)
    this.#sessions.delete(sessionId)
  }

  /** Forget a closed session (its tools went with the agent's scope). */
  releaseSession(sessionId: string): void {
    this.#bound.delete(sessionId)
    this.#sessions.delete(sessionId)
    this.#known.delete(sessionId)
  }

  /** Whether a version can still be loaded (bundle and every component verify). */
  async verify(version: CapabilityVersion): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
    try {
      await this.#usable(version)
      return { ok: true }
    } catch (error) {
      if (!(error instanceof CapabilityIntegrityError)) throw error
      return { ok: false, detail: error.message }
    }
  }

  /**
   * `capabilityHost.attach`: load `version` into one agent's scope. A
   * resumed root session gets back the drafts it had tried (not plugins:
   * loading one again needs a new approval, so the model has to try it
   * again). Throws when the version does not verify; the kernel then runs
   * the session on the baseline.
   */
  async attachAgent(input: CapabilityAttachInput): Promise<CapabilityAttachment> {
    const { sessionId } = input
    const adopted = await this.#usable(input.version)
    const state: SessionState = { version: input.version, adopted, tried: new Map(), attached: new Map(), scope: input.ctx, queue: Promise.resolve() }
    const promise = Promise.resolve(state)
    this.#bound.set(sessionId, input.version)
    this.#sessions.set(sessionId, promise)
    input.ctx.effect(() => () => {
      if (this.#sessions.get(sessionId) === promise) this.releaseSession(sessionId)
    }, 'capabilities.session')
    if (input.resumed && input.member === undefined) await this.#restoreTried(sessionId, state)
    const run = state.queue.then(() => this.#attach(sessionId, state))
    state.queue = run.catch(() => {})
    await run
    return {
      components: (await this.components(sessionId)).map((component): AttachedComponent => {
        const tools = component.spec.kind === 'function-module' || component.spec.kind === 'plugin' ? component.spec.tools : undefined
        return {
          kind: component.kind,
          name: component.name,
          ...(tools === undefined || tools.length === 0 ? {} : { tools: [...tools] }),
          ...(component.version === 'draft' ? { draft: true as const } : {}),
        }
      }),
    }
  }

  async #restoreTried(sessionId: string, state: SessionState): Promise<void> {
    const store = this.#ctx.get('session')
    if (store === undefined) return
    let records: readonly SessionRecord[]
    try {
      records = (await store.readAll(sessionId)).records
    } catch {
      return
    }
    const latest = new Map<string, { readonly ref: CapabilityComponentRef; readonly revision: number }>()
    for (const record of records) {
      if (record.type === 'capability.try') latest.set(key(record.component), { ref: record.component, revision: record.revision })
    }
    for (const [name, { ref, revision }] of latest) {
      if (ref.kind === 'plugin') continue
      const directory = triedDirectory(this.store.directory, sessionId, ref, revision)
      try {
        await access(directory)
        const spec = await validateComponent(ref, await readComponentDirectory(directory), directory, this.#validators)
        state.tried.set(name, { kind: ref.kind, name: ref.name, version: 'draft', directory, entryPath: join(directory, COMPONENT_ENTRY_FILES[ref.kind]), revision, spec })
      } catch {
        // A tried copy that is gone or no longer valid is not restored; the model can try the draft again.
      }
    }
  }

  /** `capabilityHost.componentOf`: team templates (a teammate it names) and workflow graphs (the same graph). */
  componentOf(call: ComponentCallInput): ComponentUseRef | undefined {
    const known = this.#known.get(call.sessionId)
    if (known === undefined) return undefined
    const input = call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input as Record<string, unknown> : {}
    if (call.name === 'spawn_teammate' && typeof input.name === 'string') {
      const template = known.find(component => component.spec.kind === 'team-template' && component.spec.spec.members.some(member => member.name === input.name))
      if (template !== undefined) return { kind: template.kind, name: template.name, version: template.version }
    }
    if (call.name === 'workflow' && input.graph !== undefined) {
      let wanted: string
      try {
        wanted = canonicalJson(input.graph as never)
      } catch {
        return undefined
      }
      const graph = known.find(component => {
        if (component.spec.kind !== 'architecture' || component.spec.graph === undefined) return false
        try {
          return canonicalJson(component.spec.graph as never) === wanted
        } catch {
          return false
        }
      })
      if (graph !== undefined) return { kind: graph.kind, name: graph.name, version: graph.version }
    }
    return undefined
  }

  /** The `ctx.capabilityHost` the kernel calls. */
  host(): CapabilityHost {
    return {
      current: async () => (await this.resolveVersion()).version,
      verify: version => this.verify(version),
      attach: input => this.attachAgent(input),
      componentOf: call => this.componentOf(call),
    }
  }

  async #recordedVersion(sessionId: string): Promise<CapabilityVersion | undefined> {
    const store = this.#ctx.get('session')
    if (store === undefined) return undefined
    let records: readonly SessionRecord[]
    try {
      records = (await store.readAll(sessionId)).records
    } catch {
      return undefined
    }
    let version: CapabilityVersion | undefined
    for (const record of records) {
      if (record.type === 'session.start') version = record.capabilityVersion
      else if (record.type === 'capability.version') version = record.version
    }
    return version
  }

  #session(sessionId: string): Promise<SessionState> {
    let state = this.#sessions.get(sessionId)
    if (state === undefined) {
      state = (async () => {
        let version = this.#bound.get(sessionId) ?? (await this.#recordedVersion(sessionId)) ?? 'baseline'
        let adopted: readonly ActiveComponent[]
        try {
          adopted = await this.#usable(version)
        } catch (error) {
          if (!(error instanceof CapabilityIntegrityError)) throw error
          version = (await this.resolveVersion(version)).version
          adopted = await this.#usable(version)
        }
        return { version, adopted, tried: new Map(), attached: new Map(), queue: Promise.resolve() }
      })()
      this.#sessions.set(sessionId, state)
      state.catch(() => this.#sessions.delete(sessionId))
    }
    return state
  }

  /** The version a session runs on. */
  async sessionVersion(sessionId: string): Promise<CapabilityVersion> {
    return (await this.#session(sessionId)).version
  }

  /** Components in force for a session (tried drafts override adopted ones of the same kind and name), optionally of one kind. */
  async components(sessionId: string, kind?: CapabilityComponentKind): Promise<readonly ActiveComponent[]> {
    const state = await this.#session(sessionId)
    const merged = new Map<string, ActiveComponent>()
    for (const component of state.adopted) merged.set(key(component), component)
    for (const [name, component] of state.tried) merged.set(name, component)
    return [...merged.values()].filter(component => kind === undefined || component.kind === kind)
  }

  /** The component a tool of this session belongs to, if any. */
  async toolComponent(sessionId: string, tool: string): Promise<ToolComponent | undefined> {
    const state = await this.#session(sessionId)
    for (const [name, attachment] of state.attached) {
      if (!attachment.tools.includes(tool)) continue
      const component = state.tried.get(name) ?? state.adopted.find(item => key(item) === name)
      if (component !== undefined) return { kind: component.kind, name: component.name, version: component.version }
    }
    return undefined
  }

  /**
   * Register the session's function-module and plugin tools in its agent's
   * scope (idempotent; a re-tried component replaces its earlier tools).
   * Does nothing when the session has no open agent in this process.
   */
  async attach(sessionId: string): Promise<void> {
    const state = await this.#session(sessionId)
    const run = state.queue.then(() => this.#attach(sessionId, state))
    state.queue = run.catch(() => {})
    await run
  }

  async #attach(sessionId: string, state: SessionState): Promise<void> {
    const components = await this.components(sessionId)
    this.#known.set(sessionId, components)
    const target = state.scope ?? this.#ctx.get('agents')?.get(sessionId)?.ctx
    if (target === undefined) return
    const agent = { ctx: target }
    for (const component of components) {
      if (component.spec.kind !== 'function-module' && component.spec.kind !== 'plugin') continue
      const name = key(component)
      const signature = `${component.version}:${component.revision ?? 0}`
      const current = state.attached.get(name)
      if (current?.signature === signature) continue
      if (current !== undefined) {
        state.attached.delete(name)
        await current.dispose()
      }
      if (component.spec.kind === 'function-module') {
        const built = functionModuleTools(this.#sandbox, component.directory, component.spec.spec, component.spec.entry, component.spec.tools, this.#config.ptc)
        const disposers = built.tools.map(tool => agent.ctx.tools.register(tool))
        state.attached.set(name, { signature, tools: built.names, dispose: () => { for (const dispose of disposers) dispose() } })
      } else {
        const taken = new Set(agent.ctx.tools.list().map(definition => definition.name))
        const clash = component.spec.tools.find(tool => taken.has(tool))
        if (clash !== undefined) throw new NexgentError('tool/failed', `plugin ${component.name} declares tool "${clash}", which already exists in this session`)
        const loaded: unknown = await import(pathToFileURL(join(component.directory, ...component.spec.entry.split('/'))).href)
        const plugin = ((loaded as { default?: unknown }).default ?? loaded) as { apply?: unknown }
        if (typeof plugin.apply !== 'function') throw new NexgentError('tool/failed', `plugin ${component.name}: its module exports no Cordis plugin (an object or default export with apply)`)
        const load = agent.ctx.plugin.bind(agent.ctx) as (plugin: unknown, config: unknown) => PromiseLike<unknown> & { dispose(): unknown }
        const fiber = load(plugin, {})
        await fiber
        state.attached.set(name, { signature, tools: component.spec.tools, dispose: async () => { await fiber.dispose() } })
      }
    }
  }

  /**
   * Load the current draft of one component into this session only
   * (`capability_try`). The draft is validated, frozen as revision
   * `revision`, and, for a plugin, loaded only after the user approves.
   * @throws `tool/invalid-input` for an invalid draft; `approval/denied` when a plugin is refused (nothing is loaded).
   */
  async tryDraft(context: ToolContext, component: CapabilityComponentRef, revision: number): Promise<ActiveComponent> {
    const state = await this.#session(context.sessionId)
    const run = state.queue.then(async () => {
      const capabilitiesDir = this.store.directory
      const current = await readComponentDirectory(draftDirectory(capabilitiesDir, context.sessionId, component))
      if (current.size === 0) throw new NexgentError('tool/invalid-input', `no draft of ${componentDir(component.kind, component.name)} in this session; write it with capability_draft first`)
      const spec = await validateComponent(component, current, draftDirectory(capabilitiesDir, context.sessionId, component), this.#validators)
      if (spec.kind === 'plugin') {
        const allowed = await context.requestApproval({
          summary: `Load plugin "${component.name}" into Nexgent (runs in the host process, not sandboxed)`,
          detail: `${spec.spec.description}\n\nPermissions: ${spec.spec.permissions}\nTools: ${spec.tools.length === 0 ? '(none)' : spec.tools.join(', ')}`,
          risk: 'high',
          options: ['once'],
        })
        if (!allowed) throw new NexgentError('approval/denied', `the user did not allow loading plugin ${component.name}; nothing was loaded`)
      }
      const frozen = await freezeDraft(capabilitiesDir, context.sessionId, component, revision)
      const active: ActiveComponent = {
        kind: component.kind,
        name: component.name,
        version: 'draft',
        directory: frozen.directory,
        entryPath: join(frozen.directory, COMPONENT_ENTRY_FILES[component.kind]),
        revision,
        spec,
      }
      const earlier = state.tried.get(key(component))
      state.tried.set(key(component), active)
      try {
        await this.#attach(context.sessionId, state)
      } catch (error) {
        // Loading failed: the session keeps what it had before this try.
        if (earlier === undefined) state.tried.delete(key(component))
        else state.tried.set(key(component), earlier)
        await this.#attach(context.sessionId, state).catch(() => {})
        throw error
      }
      return active
    })
    state.queue = run.catch(() => {})
    return run
  }

  /** Tool names a component in force for a session adds (function modules, plugins), attached or not. */
  async toolsOf(sessionId: string, component: CapabilityComponentRef): Promise<readonly string[]> {
    const active = (await this.components(sessionId, component.kind)).find(item => item.name === component.name)
    return active?.spec.kind === 'function-module' || active?.spec.kind === 'plugin' ? active.spec.tools : []
  }

  /** The verified bundle a session runs on. */
  async sessionBundle(sessionId: string): Promise<StoredBundle> {
    return this.store.load(await this.sessionVersion(sessionId))
  }
}

/** `ctx.capabilities` when `@nexgent/capabilities` is loaded (the service is optional, like `context`). */
export function capabilitiesOf(ctx: Context): CapabilityService | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('capabilities') as CapabilityService | undefined
}
