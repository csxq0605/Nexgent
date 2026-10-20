/** The 能力 page counts helpful votes the way the kernel activates handbook entries (it imports no kernel values). */
import { describe, expect, it } from 'vitest'
import { HANDBOOK_ACTIVATE_HELPFUL, MAX_CHECK_COMMAND_CHARS, MAX_CHECK_COMMANDS, MAX_CHECK_RETRIES } from '@nexgent/kernel'
import { ACTIVATE_HELPFUL } from '../components/Learned.js'
import * as settings from '../components/SettingsPage.js'

describe('handbook constants in the renderer', () => {
  it('match the kernel', () => {
    expect(ACTIVATE_HELPFUL).toBe(HANDBOOK_ACTIVATE_HELPFUL)
    expect([settings.MAX_CHECK_RETRIES, settings.MAX_CHECK_COMMANDS, settings.MAX_CHECK_COMMAND_CHARS]).toEqual([MAX_CHECK_RETRIES, MAX_CHECK_COMMANDS, MAX_CHECK_COMMAND_CHARS])
  })
})
