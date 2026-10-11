// Types for step3-headless.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts).
import type { RepoInventory, Step3Observations } from './step3-judges.mjs'
export declare function repoInventory(root?: string): Promise<RepoInventory>
export declare function runHeadlessScenario(
  harness: unknown,
  work: string,
  options?: { readonly log?: (line: string) => void; readonly root?: string },
): Promise<Step3Observations & { readonly repo: RepoInventory }>
