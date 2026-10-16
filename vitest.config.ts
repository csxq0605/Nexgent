import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: false,
    // Project data lives in `<NEXGENT_HOME>/projects/<projectId>/` (K1): every run gets its own home,
    // so tests never write into the user's real ~/.nexgent.
    env: { NEXGENT_HOME: process.env.NEXGENT_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'nxhome-')) },
  },
})
