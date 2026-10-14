// Types for step6-rehearsal.mjs. Observations are typed loosely (the judges also read partial ones).
export declare function runRehearsal(
  work: string,
  options?: { log?: (line: string) => void; timeoutMs?: number },
): Promise<Record<string, any>>
export declare function observeOutput(out: string, durationMs?: number): Promise<Record<string, any>>
