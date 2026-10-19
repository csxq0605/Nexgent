/**
 * The project's `ctx.improve`: the app-side handle layer-1 learning hangs on
 * (ADR 0018, {@link LearningHost}). The kernel signals every root task turn
 * that ended through {@link ImprovementHost.noteTurnEnd}; the learning loop
 * queues it and runs in this process in the background. The old
 * feedback-improvement jobs (counting, job processes, the gate hand-off) are
 * gone.
 */
import type { WorkspaceLayout } from '@nexgent/kernel'
import type { LearningHost, TurnEndInput } from './learning/host.js'
import { homeOf } from './user-config.js'

/** Plugin-row config. */
export interface ImprovementHostConfig {
  /** The Nexgent home (default `NEXGENT_HOME` / `~/.nexgent`): the user config and the user handbook. */
  readonly home?: string
  /** ADR 0018 decision 11: the interface language (BCP 47) of what learning writes for the user; absent: each task's language. */
  readonly language?: string
}

/** What layer-1 learning needs of a project. */
export class ImprovementHost {
  readonly layout: WorkspaceLayout
  /** The Nexgent home this host's user-level records live in. */
  readonly home: string
  /** Layer-1 learning (ADR 0018), when the app wires it. */
  learning: LearningHost | undefined

  constructor(layout: WorkspaceLayout, config: ImprovementHostConfig = {}) {
    this.layout = layout
    this.home = homeOf(config.home)
  }

  /** ADR 0018: a root task turn ended; queue it for background learning (the kernel's optional signal). */
  async noteTurnEnd(input: TurnEndInput): Promise<void> {
    await this.learning?.noteTurnEnd(input)
  }
}
