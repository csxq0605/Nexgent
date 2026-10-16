/** The 能力 page counts helpful votes the way the kernel activates handbook entries (it imports no kernel values). */
import { describe, expect, it } from 'vitest'
import { HANDBOOK_ACTIVATE_HELPFUL } from '@nexgent/kernel'
import { ACTIVATE_HELPFUL } from '../components/Learned.js'

describe('handbook constants in the renderer', () => {
  it('match the kernel', () => {
    expect(ACTIVATE_HELPFUL).toBe(HANDBOOK_ACTIVATE_HELPFUL)
  })
})
