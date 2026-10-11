import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_NOT_FOUND_CODE, desktopCommand, launchDesktop } from '../src/index.js'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-app-launch-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A stand-in desktop app: a Node package whose main records its argv (Node plays Electron). */
async function fakeApp(): Promise<{ dir: string; marker: string }> {
  const dir = path.join(tmp, 'desktop')
  const marker = path.join(tmp, 'argv.json')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-desktop', main: 'main.cjs' }))
  await fs.writeFile(path.join(dir, 'main.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))\n`)
  return { dir, marker }
}

describe('nexgent app launcher', () => {
  it('refuses with cli/app-not-found when the app directory has no package.json', () => {
    expect(() => desktopCommand({ env: { NEXGENT_DESKTOP_DIR: path.join(tmp, 'missing') } })).toThrow(expect.objectContaining({ code: APP_NOT_FOUND_CODE, exitCode: 2 }))
  })

  it('builds the command: app dir first, then --project', async () => {
    const { dir } = await fakeApp()
    const command = desktopCommand({ env: { NEXGENT_DESKTOP_DIR: dir, NEXGENT_ELECTRON: process.execPath }, project: '/work/p' })
    expect(command).toEqual({ electron: process.execPath, appDir: dir, args: [dir, '--project', '/work/p'] })
  })

  it('starts the app detached with the project argument', async () => {
    const { dir, marker } = await fakeApp()
    await launchDesktop({ env: { ...process.env, NEXGENT_DESKTOP_DIR: dir, NEXGENT_ELECTRON: process.execPath }, project: tmp })
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(marker, 'utf8'))).toEqual(['--project', tmp]), { timeout: 10_000 })
  })
})
