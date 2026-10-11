/**
 * The `ctx.context` service: the ordered provider list and the compactor.
 */
import { NexgentError, type Compactor, type ContextProvider, type ContextService } from '@nexgent/kernel'

/** Provider ids with a fixed call order (`agent-hooks.md` §服务); any other id follows in registration order. */
export const PROVIDER_ORDER = ['workspace-instructions', 'goal', 'skills', 'materials'] as const

/** Sort providers: fixed ids first in {@link PROVIDER_ORDER}, then the rest in registration order. Pure. */
export function orderProviders(providers: readonly ContextProvider[]): ContextProvider[] {
  const rank = (provider: ContextProvider): number => {
    const index = (PROVIDER_ORDER as readonly string[]).indexOf(provider.id)
    return index === -1 ? PROVIDER_ORDER.length : index
  }
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(entry => entry.provider)
}

/** In-memory {@link ContextService}. */
export class ContextRegistry implements ContextService {
  readonly compactor?: Compactor
  private readonly registered: ContextProvider[] = []
  private ordered: readonly ContextProvider[] = []

  constructor(compactor?: Compactor) {
    if (compactor !== undefined) this.compactor = compactor
  }

  get providers(): readonly ContextProvider[] {
    return this.ordered
  }

  /** @throws `config/invalid` when a provider with the same id is registered. */
  register(provider: ContextProvider): () => void {
    if (this.registered.some(existing => existing.id === provider.id)) {
      throw new NexgentError('config/invalid', `context provider ${provider.id} is already registered`)
    }
    this.registered.push(provider)
    this.ordered = orderProviders(this.registered)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.registered.indexOf(provider)
      if (index !== -1) this.registered.splice(index, 1)
      this.ordered = orderProviders(this.registered)
    }
  }
}
