/**
 * Per-session script routing for the scripted provider and model server.
 *
 * One global queue answers requests in arrival order, which is not
 * deterministic once several sessions (delegates, teammates, workflow
 * members) run concurrently. With routing, each request is first mapped to a
 * route key (a member name or session marker) and answered from that key's
 * own queue; a single session's requests are sequential, so every queue is
 * consumed in a fixed order however the sessions interleave.
 */
import type { ScriptEntry } from './script.js'

/** Maps a request to a route key; `undefined` means the default queue. */
export type RouteKey<Req> = (request: Req) => string | undefined

/** Routing options shared by {@link scriptedProvider} and {@link scriptedModelServer}. */
export interface ScriptRouting<Req> {
  /** Per-key scripts. A request whose key has no entry here is answered from the default script. */
  readonly routes?: Readonly<Record<string, readonly ScriptEntry<Req>[]>>
  /** How to find a request's key; required for `routes` to take effect. */
  readonly routeKey?: RouteKey<Req>
}

/** The default queue plus one queue per route key. */
export class RoutedQueues<Req> {
  readonly #name: string
  readonly #defaultQueue: ScriptEntry<Req>[]
  readonly #routes = new Map<string, ScriptEntry<Req>[]>()
  readonly #routeKey: RouteKey<Req> | undefined

  constructor(name: string, script: readonly ScriptEntry<Req>[], routing: ScriptRouting<Req>) {
    this.#name = name
    this.#defaultQueue = [...script]
    this.#routeKey = routing.routeKey
    const routes = Object.entries(routing.routes ?? {})
    if (routes.length > 0 && routing.routeKey === undefined) {
      throw new Error(`${name}: \`routes\` needs a \`routeKey\` function`)
    }
    for (const [key, entries] of routes) this.#routes.set(key, [...entries])
  }

  /**
   * The route a request belongs to: its key when that key has a queue,
   * otherwise `undefined` (the default queue). A throwing `routeKey` is a
   * test bug and propagates.
   */
  routeOf(request: Req): string | undefined {
    const key = this.#routeKey?.(request)
    return key !== undefined && this.#routes.has(key) ? key : undefined
  }

  /** Take the next entry for `route` (`undefined` when that queue is empty). */
  shift(route: string | undefined): ScriptEntry<Req> | undefined {
    return (route === undefined ? this.#defaultQueue : this.#routes.get(route))?.shift()
  }

  /** Entries left in all queues. */
  get remaining(): number {
    let total = this.#defaultQueue.length
    for (const queue of this.#routes.values()) total += queue.length
    return total
  }

  /** Entries left per queue; the default queue is under `''`. */
  remainingByRoute(): Record<string, number> {
    const out: Record<string, number> = { '': this.#defaultQueue.length }
    for (const [key, queue] of this.#routes) out[key] = queue.length
    return out
  }

  /** Append to the default queue. */
  push(entries: readonly ScriptEntry<Req>[]): void {
    this.#defaultQueue.push(...entries)
  }

  /** Append to `route`'s queue, creating it (requires `routeKey`). */
  pushTo(route: string, entries: readonly ScriptEntry<Req>[]): void {
    if (this.#routeKey === undefined) throw new Error(`${this.#name}: pushTo() needs a \`routeKey\` function`)
    const queue = this.#routes.get(route)
    if (queue === undefined) this.#routes.set(route, [...entries])
    else queue.push(...entries)
  }

  /** Throw, naming each queue that still has entries. */
  assertConsumed(): void {
    const left = Object.entries(this.remainingByRoute()).filter(([, n]) => n > 0)
    if (left.length === 0) return
    const total = left.reduce((sum, [, n]) => sum + n, 0)
    const detail = left.map(([key, n]) => `${key === '' ? '(default)' : key}: ${n}`).join(', ')
    throw new Error(`${this.#name}: ${total} script entr${total === 1 ? 'y' : 'ies'} not consumed (${detail})`)
  }
}

/**
 * A `routeKey` that returns the first key whose pattern occurs in `text(request)`.
 * Patterns are checked in insertion order; a string matches as a substring.
 * @param text - the request text to search (e.g. `requestText` for the server).
 * @param patterns - key → substring or RegExp.
 */
export function routeByText<Req>(
  text: (request: Req) => string,
  patterns: Readonly<Record<string, string | RegExp>>,
): RouteKey<Req> {
  const entries = Object.entries(patterns)
  return (request) => {
    const haystack = text(request)
    for (const [key, pattern] of entries) {
      if (typeof pattern !== 'string') pattern.lastIndex = 0
      if (typeof pattern === 'string' ? haystack.includes(pattern) : pattern.test(haystack)) return key
    }
    return undefined
  }
}

/**
 * The part of a provider request that identifies its session: every system
 * message plus the first user message, joined with newlines. Later turns are
 * left out so a lead whose context quotes a member's name is not routed to
 * that member.
 */
export function llmSessionText(request: { readonly messages: readonly { readonly role: string; readonly content: string }[] }): string {
  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content)
  const firstUser = request.messages.find((m) => m.role === 'user')
  return [...system, ...firstUser === undefined ? [] : [firstUser.content]].join('\n')
}

/** The member identity line of a child session's system prompt (`renderMemberPromptLine` in `@nexgent/kernel`). */
const MEMBER_LINE = /^Member: ([a-z][a-z0-9-]{0,31}) \((delegated|team|workflow)\)$/m

/**
 * A `routeKey` that returns the member name from the `Member: <name> (<form>)`
 * line of the session-identifying text; root sessions (no such line) go to
 * the default script.
 * @param text - `sessionText` for the server, `llmSessionText` for the provider.
 */
export function routeByMember<Req>(text: (request: Req) => string): RouteKey<Req> {
  return (request) => MEMBER_LINE.exec(text(request))?.[1]
}
