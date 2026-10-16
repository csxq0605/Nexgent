/**
 * Skill-gated tools: tools a plugin offers (`ctx.skillTools.offer`) that a
 * session sees only after it ran `load_skill` for a skill whose `tools`
 * names them. The tool is registered in the session's own agent scope, so it
 * leaves with the session; a resumed session gets it back from its
 * `load_skill` results (`restore`).
 */
import type { Context, SessionRecord, SessionStore, SkillGatedTools, Tool } from '@nexgent/kernel'

/** How the gate reaches an open agent's scoped context (`ctx.agents.get(id)?.ctx`). */
export type AgentScopeLookup = (sessionId: string) => Pick<Context, 'tools'> | undefined

/** The gate behind `ctx.skillTools`. */
export class SkillToolGate implements SkillGatedTools {
  private readonly offered = new Map<string, Tool>()
  private readonly restored = new Set<string>()

  constructor(private readonly scopeOf: AgentScopeLookup, private readonly sessions: () => SessionStore | undefined = () => undefined) {}

  offer(tool: Tool): () => void {
    const name = tool.definition.name
    this.offered.set(name, tool)
    return () => {
      if (this.offered.get(name) === tool) this.offered.delete(name)
    }
  }

  /** Make the offered tools among `names` visible to `sessionId`. Unknown names and tools the session already sees are skipped. @returns the names registered now. */
  reveal(sessionId: string, names: readonly string[] | undefined): string[] {
    if (names === undefined || names.length === 0) return []
    const scope = this.scopeOf(sessionId)
    if (scope === undefined) return []
    const revealed: string[] = []
    for (const name of names) {
      const tool = this.offered.get(name)
      if (tool === undefined || scope.tools.get(name) !== undefined) continue
      scope.tools.register(tool)
      revealed.push(name)
    }
    return revealed
  }

  /**
   * Once per session and process, on a session that already has history:
   * run {@link reveal} for every skill the session loaded before (read from
   * its `load_skill` results), so a resumed session keeps the tools.
   */
  async restore(sessionId: string, hasHistory: boolean, toolsOf: (skill: string) => Promise<readonly string[] | undefined>): Promise<void> {
    if (!hasHistory || this.restored.has(sessionId)) return
    this.restored.add(sessionId)
    const store = this.sessions()
    if (store === undefined || this.offered.size === 0) return
    let records: readonly SessionRecord[]
    try {
      records = (await store.readAll(sessionId)).records
    } catch {
      return
    }
    const skills = new Set<string>()
    for (const record of records) {
      if (record.type !== 'tool.result' || record.name !== 'load_skill' || record.isError) continue
      const name = (record.meta as { name?: unknown } | undefined)?.name
      if (typeof name === 'string') skills.add(name)
    }
    for (const skill of skills) this.reveal(sessionId, await toolsOf(skill).catch(() => undefined))
  }
}
