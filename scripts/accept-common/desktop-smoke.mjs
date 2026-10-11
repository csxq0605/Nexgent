#!/usr/bin/env node
/**
 * Desktop smoke check (step-2 round 1): Playwright's Electron driver launches
 * an empty Electron app, waits for its window to load, reads the page and the
 * window's isolation settings, and closes it. Proves the CI runners can start
 * Electron under Playwright (Linux under xvfb, Windows directly) before the
 * desktop layer of accept-step2 (D01–D10) is built on top of it.
 *
 * Usage: node scripts/accept-common/desktop-smoke.mjs [<main.cjs>]
 * Exit codes: 0 window loaded and checked; 1 anything else.
 */
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const main = process.argv[2] ?? fileURLToPath(new URL('./electron-empty/main.cjs', import.meta.url))
const TIMEOUT_MS = 60_000

function log(line) {
  process.stderr.write(`desktop-smoke: ${line}\n`)
}

async function run() {
  // Chromium refuses to run as root with its sandbox on (local containers); CI runners are not root.
  const args = typeof process.getuid === 'function' && process.getuid() === 0 ? [main, '--no-sandbox'] : [main]
  const consoleErrors = []
  const started = Date.now()
  const app = await electron.launch({ args, timeout: TIMEOUT_MS })
  try {
    const window = await app.firstWindow({ timeout: TIMEOUT_MS })
    window.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await window.waitForLoadState('load', { timeout: TIMEOUT_MS })
    const title = await window.title()
    const text = await window.textContent('#ok')
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences() ?? {}
      return { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration }
    })
    const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }))
    const failures = []
    if (title !== 'nexgent-empty') failures.push(`title ${JSON.stringify(title)}`)
    if (text !== 'ok') failures.push(`page text ${JSON.stringify(text)}`)
    if (prefs.contextIsolation !== true || prefs.sandbox !== true || prefs.nodeIntegration !== false) failures.push(`webPreferences ${JSON.stringify(prefs)}`)
    if (consoleErrors.length > 0) failures.push(`renderer console errors: ${consoleErrors.join(' | ')}`)
    log(`electron ${versions.electron} (chrome ${versions.chrome}); window loaded in ${Date.now() - started} ms`)
    if (failures.length > 0) {
      log(`FAIL: ${failures.join('; ')}`)
      return 1
    }
    log('window loaded; isolation settings and page content checked')
    return 0
  } finally {
    await app.close()
  }
}

run().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    process.exitCode = 1
  },
)
