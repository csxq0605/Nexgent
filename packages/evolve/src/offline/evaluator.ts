/**
 * How a layer-3 run scores a candidate on practice cases (ADR 0026). The
 * evaluator is outside what the run learns (ADR 0018 decision 6): the run
 * only hands it a candidate and case ids.
 *
 * {@link ReplayPracticeEvaluator} is the product shape: each case runs in a
 * throw-away copy of its input snapshot with the candidate in force, and is
 * scored from the copy afterwards. Preparing the copy, running the task and
 * scoring it are passed in: `practiceReplayEvaluator` (`replay.ts`) plugs in
 * the gate's copy with the candidate as its execution profile (ADR 0027),
 * the gate's runner, and the external reviewer on the frozen rubric.
 */
import type { OfflineCandidate, PracticeCase } from '@nexgent/kernel'

/** One case's result. */
export interface PracticeCaseResult {
  readonly caseId: string
  /** 0–1. An unknown result (the run did not finish, scoring failed) is 0, never a success. */
  readonly score: number
  /** What the scorer said about the result (the proposal reads it). */
  readonly feedback: string
  /** The task, as the proposal shows it. */
  readonly input?: string
  /** What the run produced, in short. */
  readonly output?: string
  /** Estimated dollars of this case's run and scoring. */
  readonly usd?: number
  readonly unknown?: boolean
}

/** Scores a candidate on cases. */
export interface PracticeEvaluator {
  evaluate(input: { readonly candidate: OfflineCandidate; readonly caseIds: readonly string[]; readonly repeat?: number; readonly signal: AbortSignal }): Promise<readonly PracticeCaseResult[]>
}

/** How a replayed case ended. */
export interface PracticeRunOutcome {
  readonly outcome: 'completed' | 'cancelled' | 'budget' | 'error' | 'timeout'
  readonly detail?: string
  readonly usd?: number
  /** A short account of what the run did. */
  readonly output?: string
}

/** The pieces of {@link ReplayPracticeEvaluator}. */
export interface ReplayPracticeEvaluatorOptions {
  /** The practice case of an id (`undefined`: gone from the set, scored 0). */
  readonly practiceCase: (caseId: string) => Promise<PracticeCase | undefined>
  /** A copy of the case's input snapshot with the candidate in force. */
  readonly prepare: (practiceCase: PracticeCase, candidate: OfflineCandidate) => Promise<{ readonly projectRoot: string; dispose(): Promise<void> }>
  /** Run the case's task in the copy. */
  readonly run: (input: { readonly practiceCase: PracticeCase; readonly projectRoot: string; readonly repeat: number; readonly signal: AbortSignal }) => Promise<PracticeRunOutcome>
  /** Score a finished run from the copy (deterministic checks, external review on the frozen rubric). A thrown error may carry the dollars it spent as `usd`. */
  readonly score: (input: { readonly practiceCase: PracticeCase; readonly projectRoot: string; readonly run: PracticeRunOutcome; readonly signal: AbortSignal }) => Promise<{ readonly score: number; readonly feedback: string; readonly usd?: number }>
}

/** Replays each case in its own copy; cases run one after another. */
export class ReplayPracticeEvaluator implements PracticeEvaluator {
  readonly #options: ReplayPracticeEvaluatorOptions

  constructor(options: ReplayPracticeEvaluatorOptions) {
    this.#options = options
  }

  async evaluate(input: { readonly candidate: OfflineCandidate; readonly caseIds: readonly string[]; readonly repeat?: number; readonly signal: AbortSignal }): Promise<readonly PracticeCaseResult[]> {
    const results: PracticeCaseResult[] = []
    for (const caseId of input.caseIds) {
      input.signal.throwIfAborted()
      const practiceCase = await this.#options.practiceCase(caseId)
      if (practiceCase === undefined) {
        results.push({ caseId, score: 0, feedback: 'the case is no longer in the practice set', unknown: true })
        continue
      }
      let copy: { readonly projectRoot: string; dispose(): Promise<void> } | undefined
      // Dollars already spent on this case when a later step fails (a score function may attach its own as `usd` on the error).
      let spent = 0
      try {
        // A case whose copy cannot be made (its snapshot or session is gone) is an unknown result, not the end of the run.
        copy = await this.#options.prepare(practiceCase, input.candidate)
        const run = await this.#options.run({ practiceCase, projectRoot: copy.projectRoot, repeat: input.repeat ?? 0, signal: input.signal })
        spent = run.usd ?? 0
        if (run.outcome !== 'completed') {
          results.push({ caseId, score: 0, feedback: `the run did not finish (${run.outcome}${run.detail === undefined ? '' : `: ${run.detail}`})`, input: practiceCase.prompt, ...(run.output === undefined ? {} : { output: run.output }), ...(run.usd === undefined ? {} : { usd: run.usd }), unknown: true })
          continue
        }
        const scored = await this.#options.score({ practiceCase, projectRoot: copy.projectRoot, run, signal: input.signal })
        const score = Number.isFinite(scored.score) ? Math.min(1, Math.max(0, scored.score)) : 0
        results.push({ caseId, score, feedback: scored.feedback, input: practiceCase.prompt, ...(run.output === undefined ? {} : { output: run.output }), usd: (run.usd ?? 0) + (scored.usd ?? 0) })
      } catch (error) {
        if (input.signal.aborted) throw error
        const extra = (error as { usd?: unknown } | undefined)?.usd
        spent += typeof extra === 'number' && Number.isFinite(extra) ? extra : 0
        results.push({ caseId, score: 0, feedback: `the case could not be run or scored: ${error instanceof Error ? error.message : String(error)}`, input: practiceCase.prompt, ...(spent === 0 ? {} : { usd: spent }), unknown: true })
      } finally {
        await copy?.dispose().catch(() => undefined)
      }
    }
    return results
  }
}
