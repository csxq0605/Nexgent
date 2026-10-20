// @vitest-environment jsdom
/**
 * Windows without PowerShell 7: `app.info` says the command shell is
 * missing, and the window says so (and what to install) before any task runs.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge } from '../testing/fake-bridge.js'
import { renderApp } from './helpers.js'

describe('command shell check', () => {
  it('tells the user to install PowerShell 7 when pwsh is missing', async () => {
    const bridge = new FakeBridge()
    bridge.handlers['app.info'] = () => ({ sdkVersion: 8, appVersion: '0.0.0-test', platform: 'win32', commandShell: { shell: 'pwsh', required: true, available: false } })
    await renderApp(bridge, { open: false })
    const notice = await waitFor(() => screen.getByTestId('shell-missing'))
    expect(notice.textContent).toContain('PowerShell 7')
    expect(notice.textContent).toContain('winget install --id Microsoft.PowerShell')
    expect(notice.textContent).toContain('5.1')
    fireEvent.click(screen.getByText('关闭'))
    await waitFor(() => expect(screen.queryByTestId('shell-missing')).toBeNull())
  })

  it('says nothing when the shell is there', async () => {
    await renderApp(new FakeBridge())
    expect(screen.queryByTestId('shell-missing')).toBeNull()
  })
})
