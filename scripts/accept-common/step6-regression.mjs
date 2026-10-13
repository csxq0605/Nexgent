/**
 * Step 6's regressions: build the ctx accept-step5's headless and desktop layers
 * build, so H18 (step 5 H01–H19) and D01–D23 run step 5's own items over fresh
 * runs of step 5's scenarios. Nothing here calls a model; every scenario is a
 * scripted one. A crashed scenario is recorded in the ctx and fails only the
 * items that read it.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runDesktopScenario } from './step2-desktop.mjs'
import { runMembersDesktopScenario } from './step3-desktop.mjs'
import { runHeadlessScenario as runStep3Headless } from './step3-headless.mjs'
import { runCapabilitiesDesktopScenario } from './step4-desktop.mjs'
import { runImprovementsDesktopScenario } from './step5-desktop.mjs'

const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))

/** The step-4 headless ctx (accept-step4's headless layer): step 3's scenario, step 4's, the gate's. */
async function step4HeadlessCtx(harness, work, tools, log) {
  const ctx = { work, tools }
  await mkdir(join(work, 'step3'), { recursive: true })
  try {
    ctx.step3 = await runStep3Headless(harness, join(work, 'step3'), { log: line => log(`regression step3: ${line}`) })
  } catch (error) {
    ctx.step3Error = errorText(error)
  }
  try {
    await mkdir(join(work, 'step4'), { recursive: true })
    const { runStep4Headless } = await import('./step4-headless.mjs')
    ctx.step4 = await runStep4Headless(harness, join(work, 'step4'), { log: line => log(`regression step4: ${line}`) })
  } catch (error) {
    ctx.step4Error = errorText(error)
  }
  if (ctx.step4?.features?.gate === true) {
    try {
      await mkdir(join(work, 'gate'), { recursive: true })
      const { runStep4Gate } = await import('./step4-gate.mjs')
      ctx.step4.gate = await runStep4Gate(harness, join(work, 'gate'), { log: line => log(`regression gate: ${line}`) })
    } catch (error) {
      ctx.step4.gate = { error: { step: 'setup', message: errorText(error) } }
    }
  }
  return ctx
}

/**
 * The step-5 headless ctx (accept-step5's headless layer): step 4's ctx under
 * `regression` (for step 5's H19) and the step-5 scenario under `step5`.
 */
export async function step5HeadlessCtx(harness, work, tools, log = () => {}) {
  const ctx = { work, tools }
  try {
    ctx.regression = await step4HeadlessCtx(harness, join(work, 'regression'), tools, log)
  } catch (error) {
    ctx.regressionError = errorText(error)
  }
  try {
    await mkdir(join(work, 'step5'), { recursive: true })
    const { runStep5Headless } = await import('./step5-headless.mjs')
    ctx.step5 = await runStep5Headless(harness, join(work, 'step5'), { log: line => log(`step5: ${line}`) })
  } catch (error) {
    ctx.step5Error = errorText(error)
  }
  return ctx
}

/** The step-5 desktop ctx (accept-step5's desktop layer): D01–D18's scenarios and the improvements page's. */
export async function step5DesktopCtx(harness, work, log = () => {}) {
  await mkdir(work, { recursive: true })
  const ctx = { work }
  try {
    await mkdir(join(work, 'step2'), { recursive: true })
    ctx.obs = await runDesktopScenario(harness, join(work, 'step2'), { log: line => log(`desktop: ${line}`) })
  } catch (error) {
    ctx.scenarioError = errorText(error)
  }
  try {
    ctx.members = await runMembersDesktopScenario(harness, join(work, 'members'), { log: line => log(`desktop members: ${line}`) })
  } catch (error) {
    ctx.membersError = errorText(error)
  }
  try {
    ctx.capabilities = await runCapabilitiesDesktopScenario(harness, join(work, 'capabilities'), { log: line => log(`desktop capabilities: ${line}`) })
  } catch (error) {
    ctx.capabilitiesError = errorText(error)
  }
  try {
    ctx.improvements = await runImprovementsDesktopScenario(harness, join(work, 'improvements'), { log: line => log(`desktop improvements: ${line}`) })
  } catch (error) {
    ctx.improvementsError = errorText(error)
  }
  return ctx
}
