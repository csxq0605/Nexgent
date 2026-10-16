import { describe, expect, it } from 'vitest'
import { validateProjectConfig } from '../src/index.js'

/**
 * Rework C1 (ADR 0017 decisions 3 and 5): the workspace's config reader
 * accepts USD caps, `perConversation` and `learning` like the kernel's, and
 * still reads every config written before them.
 */
describe('validateProjectConfig: rework C1 fields', () => {
  it('accepts USD caps, per-conversation caps and the learning section', () => {
    expect(() => validateProjectConfig({
      costCaps: { perTask: { maxUsd: 1.5 }, perConversation: { maxUsd: 6 }, perProject: { maxUsd: 40, windowDays: 30 } },
      learning: { enabled: true, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: false, contribute: false },
    })).not.toThrow()
  })

  it('still reads token caps and the retired autoImprove', () => {
    expect(() => validateProjectConfig({ version: 1, costCaps: { perTask: { maxTokens: 10, maxRequests: 2 }, perProject: { maxTokens: 5, windowDays: 7 } }, autoImprove: false })).not.toThrow()
  })

  it('rejects bad values with the field path', () => {
    for (const [config, field] of [
      [{ costCaps: { perConversation: { windowDays: 3 } } }, 'costCaps.perConversation.windowDays'],
      [{ costCaps: { perTask: { maxUsd: -1 } } }, 'costCaps.perTask.maxUsd'],
      [{ costCaps: { perDay: {} } }, 'costCaps.perDay'],
      [{ learning: { budget: { maxUsd: 5000 } } }, 'learning.budget.maxUsd'],
      [{ learning: { share: true } }, 'learning.share'],
    ] as const) {
      expect(() => validateProjectConfig(config), field).toThrow(expect.objectContaining({ code: 'config/invalid', details: { field } }))
    }
  })
})
