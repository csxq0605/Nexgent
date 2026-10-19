/**
 * SEAM: the step-4 contract functions the acceptance scripts use, loaded
 * from the built `@nexgent/kernel` (scripts/ is not a workspace package).
 * Contract functions only (contracts/capabilities.ts); no implementation.
 */
const kernel = await import(new URL('../../packages/kernel/dist/index.js', import.meta.url).href)

/** `cap_<module>_<function>`, the model tool a function module's function becomes. */
export const functionToolName = kernel.functionToolName

/** Canonical manifest text; its SHA-256 is the bundle version. */
export const canonicalManifestText = kernel.canonicalManifestText

/** `baseline`. */
export const BASELINE_VERSION = kernel.BASELINE_VERSION

/** Tools no member may see (step 3 collaboration tools and the step-4 capability tools). */
export const MEMBER_DENIED_TOOLS = kernel.MEMBER_DENIED_TOOLS

/** `<kind-dir>/<name>`: where a component lives inside a bundle, candidate or draft area. */
export const componentDir = kernel.componentDir
