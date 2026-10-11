// Types for step3-real.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts).
export declare function realPrerequisites(
  env: Readonly<Record<string, string | undefined>>,
  budgetUsd: number,
  spent: ReadonlyArray<number | string>,
): { readonly ok: false; readonly reason: string }
