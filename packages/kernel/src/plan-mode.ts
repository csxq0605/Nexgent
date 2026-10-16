/**
 * Plan mode (ADR 0022 decision 4): a session that starts with `plan: true`
 * works as in `read-only` until the user approves a plan. The agent offers
 * `exit_plan` in its own tool scope only while plan mode is on; the tool asks
 * every time (`approval: 'always'`), and an approval switches the session to
 * its execution mode with a `session.mode` record.
 */
import type { Tool, ToolDefinition } from './contracts/tools.js'
import { NexgentError } from './contracts/errors.js'

/** `exit_plan`'s definition. */
export const EXIT_PLAN_DEFINITION: ToolDefinition = {
  name: 'exit_plan',
  description: 'Plan mode is on: you can read and run read-only commands but not change anything. When you have a plan, call this with it; the user reviews it, and if they approve, you can carry it out.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', minLength: 1, description: 'The plan, in the user\'s language: what you will change and how you will check it.' },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  effects: ['read'],
  approval: 'always',
  approvalText: input => {
    const plan = (input as { plan?: unknown } | null)?.plan
    return { summary: 'Approve this plan and let the session carry it out', ...(typeof plan === 'string' ? { detail: plan } : {}) }
  },
}

/**
 * Build `exit_plan`. The loop asks the user before the handler runs (the
 * approval detail shows the plan); the handler runs only after an approval
 * and calls `approve` to leave plan mode.
 */
export function exitPlanTool(approve: () => Promise<string>): Tool {
  return {
    definition: EXIT_PLAN_DEFINITION,
    handler: async input => {
      const plan = (input as { plan?: unknown }).plan
      if (typeof plan !== 'string' || plan.trim() === '') throw new NexgentError('tool/invalid-input', 'plan must be a non-empty string')
      const mode = await approve()
      return { content: `The user approved the plan. Plan mode is off; the session now runs in ${mode} mode, so carry out the plan.` }
    },
  }
}
