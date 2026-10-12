// Types for step4-real.mjs (consumed by packages/test-support/tests/accept-step4.spec.ts).
export declare function realPrerequisites(
  env: Readonly<Record<string, string | undefined>>,
  budgetUsd: number,
  spent: readonly (number | 'unknown')[],
):
  | { readonly ok: true; readonly keySource: string; readonly remainingUsd: number }
  | { readonly ok: false; readonly reason: string }
