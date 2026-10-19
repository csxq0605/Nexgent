// Types for step6-experiment.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
export interface Experiment {
  readonly cases: Record<string, any>
  readonly report: Record<string, any>
  readonly reportScript: string
  readonly dir: string
}
export declare function loadExperiment(dir: string): Promise<Experiment>
export declare function caseHashes(task: Record<string, any>): Record<string, string>
export declare function setsObservation(experiment: Experiment): Record<string, any>
export declare function scriptedRecord(experiment: Experiment): Record<string, any>
export declare function reportObservation(experiment: Experiment, work: string, options?: { iterations?: number }): Promise<Record<string, any>>
export declare function pilotReportObservation(dir: string, records: string, work: string): Promise<Record<string, any>>
