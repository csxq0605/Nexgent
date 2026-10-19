/**
 * Getting around the desktop window of ADR 0020 in the acceptance scripts:
 * 资料 and 成果 are tabs of the conversation's drawer, 能力 and 改进 tabs of
 * the 能力 page, and the start screen's path form sits under 用路径打开或新建.
 */

/** Show a tab whatever is on screen. */
export async function showTab(page, id) {
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

/** Close the drawer if it is open. */
export async function closeDrawer(page) {
  const close = page.getByTestId('drawer-close')
  if ((await close.count()) > 0) await close.click()
}

/** Back from a full page (能力, 设置) to the conversation, if one is shown. */
export async function backToConversation(page) {
  const back = page.getByTestId('page-back')
  if ((await back.count()) > 0) await back.click()
}

/** Type a folder path on the start screen, opening the path form first. */
export async function fillProjectPath(page, root, options) {
  const more = page.getByTestId('start-more')
  await more.waitFor(options)
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click()
  await page.getByTestId('project-path').fill(root, options)
}

/**
 * The settings page saves each change at once (rework D2): leave the field
 * being typed in, then wait until the page says 已保存 (`user` waits for the
 * user-level section's own mark).
 */
export async function commitSettings(page, options = {}, user = false) {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.getByTestId('settings-page').getByTestId(user ? 'settings-user-saved' : 'settings-saved').waitFor(options)
}

/** Unfold a settings group (费用, 学习, 检查 and 高级 start folded since ADR 0028). */
export async function openSettingsGroup(page, id) {
  const group = page.getByTestId('settings-page').getByTestId(`settings-group-${id}`)
  if ((await group.count()) > 0 && (await group.getAttribute('open')) === null) await group.locator('summary').first().click()
}

/** Open the settings page's limits by tokens and requests (folded under the dollar caps, in the 费用 group). */
export async function showUsageCaps(page) {
  await openSettingsGroup(page, 'cost')
  const more = page.getByTestId('settings-page').locator('.usage-more')
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click()
}
