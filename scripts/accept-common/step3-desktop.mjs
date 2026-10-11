/**
 * The step-3 desktop items D11–D14: Playwright drives the built Electron app
 * (real renderer, real `@nexgent/sdk` in the main process) against the
 * scripted Claude Messages API server routed per member — no real model.
 * Follows apps/desktop/tests/members-e2e.spec.ts: the main conversation
 * delegates to `writer`, whose `.env` write asks for approval naming the
 * member (allowed once); the member block, its deliverable link and its
 * read-only session are observed; then `slow` streams, the main process is
 * hard-killed, and after the restart the blocks, sessions and deliverable
 * are read again.
 *
 * The scenario only observes; step3-desktop-judges.mjs decides. A step that
 * throws stops the scenario and is recorded in `obs.error`.
 */
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DESKTOP_DIR, VITE_BIN, ensureDisplay, poll, run } from './step2-desktop.mjs'
import { isLoopbackUrl } from './step2-runtime.mjs'

const TIMEOUT = 60_000
const WAIT = 20_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0

/** Fake key the app runs with. */
export const MEMBERS_KEY = 'sk-accept-step3-desktop-members'
/** Texts the scenario types and the scripted model answers. */
export const MEMBER_TEXTS = {
  firstTurn: '让 writer 写北区汇总',
  writerTask: '写北区汇总 north.md，并设置时区',
  writerDone: '北区写好了。',
  rootDone: '成员 writer 写好了北区汇总。',
  secondTurn: '让 slow 写南区说明',
  slowTask: '慢慢写南区说明',
}
export const MEMBER_FILES = { north: { path: 'north.md', content: '# 北区\n1200\n' }, env: { path: '.env', content: 'REPORT_TZ=Asia/Shanghai\n' } }

const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

/** The scripted model: `{ script, routes }` (root queue and one queue per member). */
export function membersScript() {
  return {
    script: [
      { toolCalls: [{ name: 'delegate', arguments: { name: 'writer', task: MEMBER_TEXTS.writerTask } }], usage },
      { content: MEMBER_TEXTS.rootDone, usage },
      { toolCalls: [{ name: 'delegate', arguments: { name: 'slow', task: MEMBER_TEXTS.slowTask } }], usage },
    ],
    routes: {
      writer: [
        { toolCalls: [{ name: 'write_file', arguments: { path: MEMBER_FILES.north.path, content: MEMBER_FILES.north.content } }], usage },
        { toolCalls: [{ name: 'write_file', arguments: { path: MEMBER_FILES.env.path, content: MEMBER_FILES.env.content } }], usage },
        { toolCalls: [{ name: 'present', arguments: { paths: [MEMBER_FILES.north.path], summary: '北区汇总' } }], usage },
        { content: MEMBER_TEXTS.writerDone, usage },
      ],
      slow: [{ content: Array.from({ length: 600 }, (_, i) => `第${i + 1}句。`), chunkDelayMs: 50 }],
    },
  }
}

/** The member blocks of the page: name, status attribute and status label. */
const blocksOf = page => page.evaluate(() => [...document.querySelectorAll('[data-testid="member-block"]')].map(el => ({
  member: el.dataset.member ?? null,
  status: el.dataset.status ?? null,
  label: el.querySelector('[data-testid="member-status"]')?.textContent ?? null,
})))

/**
 * Run the members scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer, routeByMember, sessionText, process helpers).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 */
export async function runMembersDesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  await mkdir(work, { recursive: true })
  work = await realpath(work)
  const obs = { consoleErrors: { first: [], second: [] } }
  const rendererDir = join(work, 'renderer')
  const home = join(work, 'home')
  const root = join(work, 'regions')
  await mkdir(home, { recursive: true })
  createRequire(join(DESKTOP_DIR, 'package.json'))('electron')

  let server
  let display
  let app
  let step = 'setup'
  const orphans = new Set()
  const launch = async (which) => {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') env[key] = value
    Object.assign(env, display.display === undefined ? {} : { DISPLAY: display.display }, {
      NEXGENT_HOME: home,
      NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
      NEXGENT_API_KEY: MEMBERS_KEY,
      NEXGENT_API_BASE_URL: server.baseUrl,
    })
    app = await electron.launch({ args: ROOT_USER ? [DESKTOP_DIR, '--no-sandbox'] : [DESKTOP_DIR], env, timeout: TIMEOUT })
    const page = await app.firstWindow({ timeout: TIMEOUT })
    page.on('console', (message) => {
      if (message.type() === 'error') obs.consoleErrors[which].push(message.text())
    })
    page.on('pageerror', error => obs.consoleErrors[which].push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
    await page.waitForLoadState('load')
    return page
  }
  const kill = async (target) => {
    if (target === undefined) return []
    const child = target.process()
    if (child.exitCode !== null || child.signalCode !== null) return []
    const descendants = await harness.descendantPids(child.pid).catch(() => [])
    for (const pid of descendants) orphans.add(pid)
    const exited = new Promise(resolve => child.once('exit', resolve).once('error', resolve))
    if (process.platform === 'win32') await harness.killProcessTree(child.pid)
    else child.kill('SIGKILL')
    await exited
    return descendants
  }
  /** Open a member's read-only session, read it, and go back. */
  const openMember = async (page, block) => {
    if ((await block.locator('[data-testid="open-member"]').count()) === 0 || !(await block.getByTestId('open-member').isVisible())) await block.locator('summary').click()
    await block.getByTestId('open-member').click()
    const view = page.getByTestId('member-view')
    await view.waitFor({ timeout: WAIT })
    const out = {
      title: await view.getByTestId('member-view-title').textContent(),
      composerWhileOpen: await page.getByTestId('composer-input').count(),
      deliverableCards: await view.getByTestId('deliverable-card').count(),
    }
    out.text = await poll(() => view.textContent(), text => (text ?? '').length > 0, 'member view text')
    await page.getByTestId('member-back').click()
    await page.getByTestId('composer-input').waitFor({ timeout: WAIT })
    out.back = (await page.getByTestId('member-view').count()) === 0
    return out
  }

  try {
    step = 'build renderer'
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)

    step = 'start display and scripted server'
    display = await ensureDisplay()
    const { script, routes } = membersScript()
    server = await harness.scriptedModelServer({ script, routes, routeKey: harness.routeByMember(harness.sessionText) })
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)

    step = 'D11 delegate'
    log('turn 1: delegate to writer')
    let page = await launch('first')
    await page.getByTestId('start-screen').waitFor({ timeout: WAIT })
    await page.getByTestId('project-path').fill(root)
    await page.getByTestId('create-project').click()
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    await page.getByTestId('new-session').click()
    const input = page.getByTestId('composer-input')
    await input.click()
    await page.keyboard.type(MEMBER_TEXTS.firstTurn)
    await page.keyboard.press('Enter')
    const writer = page.locator('[data-testid="member-block"][data-member="writer"]')
    await writer.waitFor({ timeout: WAIT })
    obs.running = { blocks: await blocksOf(page) }

    step = 'D13 member approval'
    const dialog = page.getByTestId('approval-dialog')
    await dialog.waitFor({ timeout: WAIT })
    obs.approval = {
      memberLine: await dialog.getByTestId('approval-member').textContent(),
      summary: await dialog.textContent(),
      blocksWhileAsking: await blocksOf(page),
      envBefore: await readFile(join(root, MEMBER_FILES.env.path), 'utf8').catch(() => null),
    }
    await dialog.getByTestId('approval-once').click()
    obs.approval.rootReply = await poll(() => page.getByTestId('assistant-message').last().textContent(), text => (text ?? '').includes(MEMBER_TEXTS.rootDone), 'the root reply after the member')
    await page.getByTestId('send').waitFor({ timeout: WAIT })
    obs.approval.dialogGone = (await dialog.count()) === 0
    obs.approval.envAfter = await readFile(join(root, MEMBER_FILES.env.path), 'utf8').catch(() => null)

    step = 'D11 finished block'
    obs.finished = { blocks: await blocksOf(page), toolBlocks: await page.getByTestId('tool-block').count() }
    await writer.locator('summary').click()
    obs.finished.deliverableLinks = await writer.getByTestId('member-deliverable').allTextContents()

    step = 'D12 member view'
    obs.view = await openMember(page, writer)
    obs.view.sessionItem = await poll(() => page.getByTestId('session-item').textContent(), text => (text ?? '').includes('1 个成员'), 'the member count in the sidebar')

    step = 'D14 kill while a member streams'
    log('turn 2: hard kill while slow streams')
    await input.click()
    await page.keyboard.type(MEMBER_TEXTS.secondTurn)
    await page.keyboard.press('Enter')
    await page.locator('[data-testid="member-block"][data-member="slow"]').waitFor({ timeout: WAIT })
    obs.kill = { chunksBeforeKill: await poll(() => server.requests.find(r => r.route === 'slow')?.chunksSent ?? 0, n => n > 5, 'slow streaming') }
    obs.kill.blocksBeforeKill = await blocksOf(page)
    const descendants = await kill(app)
    obs.kill.descendants = descendants.length
    app = undefined

    step = 'D14 restart'
    log('restart')
    page = await launch('second')
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    obs.restart = {
      sessions: await poll(() => page.getByTestId('session-item').count(), n => n === 1, 'one session in the sidebar'),
      sessionItem: await poll(() => page.getByTestId('session-item').textContent(), text => (text ?? '').includes('2 个成员'), 'two members in the sidebar'),
      blocks: await poll(() => blocksOf(page), blocks => blocks.length === 2 && blocks.every(b => b.status !== 'running'), 'two settled member blocks'),
    }
    const writerAgain = page.locator('[data-testid="member-block"][data-member="writer"]')
    await writerAgain.locator('summary').click()
    obs.restart.deliverableLinks = await writerAgain.getByTestId('member-deliverable').allTextContents()
    obs.restart.writerView = await openMember(page, writerAgain)
    obs.restart.slowView = await openMember(page, page.locator('[data-testid="member-block"][data-member="slow"]'))
    obs.restart.northOnDisk = await readFile(join(root, MEMBER_FILES.north.path), 'utf8').catch(() => null)

    step = 'close'
    const closing = app
    app = undefined
    await closing.close()
  } catch (error) {
    obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`members scenario stopped at ${step}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await kill(app).catch(() => undefined)
    for (const pid of orphans) if (harness.isProcessAlive(pid)) await harness.killProcessTree(pid).catch(() => undefined)
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
