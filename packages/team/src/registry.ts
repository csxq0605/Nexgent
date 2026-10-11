/**
 * The teams of this process, one per Lead session, loaded from the Lead's
 * records on first use; and the context provider that injects undelivered
 * mail at the start of a recipient's turn.
 */
import type { AgentsService, ContextProvider, SessionStore, TurnContextInput } from '@nexgent/kernel'
import { hasTeam, reduceTeam } from './state.js'
import { Team, type TeamDeps } from './team.js'

/** Id of the mail provider (`ContextService.register`). */
export const TEAM_MAIL_PROVIDER_ID = 'team-mail'

/** Options of {@link TeamRegistry}. */
export type TeamRegistryOptions = TeamDeps

export class TeamRegistry {
  private readonly deps: TeamDeps
  private readonly teams = new Map<string, Team>()
  private readonly loading = new Map<string, Promise<Team | undefined>>()
  /** Root sessions known to have no team (cleared when one starts a team). */
  private readonly without = new Set<string>()

  constructor(deps: TeamDeps) {
    this.deps = deps
  }

  /** The loaded team of a Lead session, if any. */
  get(leadSessionId: string): Team | undefined {
    return this.teams.get(leadSessionId)
  }

  /**
   * The team of a Lead session, rebuilt from its records the first time
   * (queued mail a recipient already saw is recorded `delivered`). With
   * `create`, a session without team records gets an empty team.
   */
  async open(leadSessionId: string, create: true): Promise<Team>
  async open(leadSessionId: string, create: boolean): Promise<Team | undefined>
  async open(leadSessionId: string, create: boolean): Promise<Team | undefined> {
    const known = this.teams.get(leadSessionId)
    if (known !== undefined) return known
    if (!create && this.without.has(leadSessionId)) return undefined
    let pending = this.loading.get(leadSessionId)
    if (pending === undefined) {
      pending = this.load(leadSessionId).finally(() => this.loading.delete(leadSessionId))
      this.loading.set(leadSessionId, pending)
    }
    const loaded = await pending
    if (loaded !== undefined || !create) return loaded
    this.without.delete(leadSessionId)
    const team = new Team(this.deps, leadSessionId, reduceTeam([]))
    this.teams.set(leadSessionId, team)
    return team
  }

  private async load(leadSessionId: string): Promise<Team | undefined> {
    const { records } = await this.deps.store.readAll(leadSessionId)
    const state = reduceTeam(records)
    if (!hasTeam(state)) {
      this.without.add(leadSessionId)
      return undefined
    }
    const team = new Team(this.deps, leadSessionId, state)
    this.teams.set(leadSessionId, team)
    await team.reconcile(records)
    return team
  }

  /** Injects a recipient's undelivered mail at its turn start (teammates and the Lead). */
  provider(): ContextProvider {
    return {
      id: TEAM_MAIL_PROVIDER_ID,
      beginTurn: async (input: TurnContextInput) => {
        const { member, parentSessionId } = input.state.metadata
        let team: Team | undefined
        if (parentSessionId === undefined) team = await this.open(input.sessionId, false)
        else if (member?.executionForm === 'team') team = this.teams.get(parentSessionId)
        const inject = team?.takeInjections(input.sessionId) ?? []
        return inject.length === 0 ? {} : { inject }
      },
    }
  }
}

/** The services a registry needs from a context. */
export interface RegistryServices {
  readonly agents: Pick<AgentsService, 'get' | 'create' | 'resume'>
  readonly store: Pick<SessionStore, 'readAll'>
}
