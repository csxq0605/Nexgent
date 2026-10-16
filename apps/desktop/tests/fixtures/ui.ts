/**
 * Getting around the window of ADR 0020 in the Electron tests: 资料 and 成果
 * are tabs of the conversation's drawer, 能力 and 改进 tabs of the 能力 page,
 * and the path form of the start screen sits under 用路径打开或新建.
 */
import type { Page } from 'playwright-core'

export type Tab = 'materials' | 'deliverables' | 'capabilities' | 'improvements'

/** Show a tab whatever is on screen. */
export async function showTab(page: Page, id: Tab): Promise<void> {
  const tab = page.getByTestId(`tab-${id}`)
  if ((await tab.count()) === 0) {
    if (id === 'capabilities' || id === 'improvements') await page.getByTestId('nav-capabilities').click()
    else {
      const back = page.getByTestId('page-back')
      if ((await back.count()) > 0) await back.click()
      await page.getByTestId('drawer-toggle').click()
    }
  }
  await tab.click()
}

/** Close the drawer if it is open (it covers the right part of the conversation). */
export async function closeDrawer(page: Page): Promise<void> {
  const close = page.getByTestId('drawer-close')
  if ((await close.count()) > 0) await close.click()
}

/** Type a folder path on the start screen, opening the path form first. */
export async function fillProjectPath(page: Page, root: string): Promise<void> {
  const more = page.getByTestId('start-more')
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click()
  await page.getByTestId('project-path').fill(root)
}

/**
 * The settings page saves each change at once (rework D2): leave the field
 * being typed in, then wait until the page says 已保存 (`user` waits for the
 * user-level section's own mark).
 */
export async function commitSettings(page: Page, user = false): Promise<void> {
  // Runs in the page: the DOM is there, though this file is type-checked without it.
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.())
  await page.getByTestId('settings-page').getByTestId(user ? 'settings-user-saved' : 'settings-saved').waitFor()
}

/** Open the settings page's limits by tokens and requests (folded under the dollar caps). */
export async function showUsageCaps(page: Page): Promise<void> {
  const more = page.getByTestId('settings-page').locator('.usage-more')
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click()
}
