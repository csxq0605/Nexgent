import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect } from 'vitest'
import { App } from '../App.js'
import { StoreProvider } from '../hooks.js'
import { AppStore } from '../store.js'
import { FakeBridge } from '../testing/fake-bridge.js'

afterEach(() => {
  cleanup()
})

/** Render the whole app over a fake bridge, with the project and its first session open. */
export async function renderApp(given?: FakeBridge | null, options: { readonly open?: boolean } = {}): Promise<{ bridge: FakeBridge; store: AppStore }> {
  const bridge = given === null ? undefined : (given ?? new FakeBridge())
  const store = new AppStore(bridge)
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  )
  await act(async () => {
    await store.init()
    if (options.open !== false) await store.openLastProject()
  })
  if (options.open !== false && bridge !== undefined) await waitFor(() => expect(screen.getByTestId('workspace')).toBeTruthy())
  return { bridge: bridge as FakeBridge, store }
}

/** Emit inside act so React flushes. */
export function emit(bridge: FakeBridge, event: Parameters<FakeBridge['emit']>[0]): void {
  act(() => bridge.emit(event))
}

/** Emit an application-level event (no projectId) inside act. */
export function emitApp(bridge: FakeBridge, event: Parameters<FakeBridge['emitApp']>[0]): void {
  act(() => bridge.emitApp(event))
}

type Tab = 'materials' | 'deliverables' | 'capabilities' | 'improvements'

/**
 * Show a tab whatever is on screen (ADR 0020): 资料 and 成果 live in the
 * conversation's drawer, 能力 and 改进 on the 能力 page.
 */
export function showTab(id: Tab): void {
  if (screen.queryByTestId(`tab-${id}`) === null) {
    if (id === 'capabilities' || id === 'improvements') fireEvent.click(screen.getByTestId('nav-capabilities'))
    else {
      const back = screen.queryByTestId('page-back')
      if (back !== null) fireEvent.click(back)
      fireEvent.click(screen.getByTestId('drawer-toggle'))
    }
  }
  const tab = screen.getByTestId(`tab-${id}`)
  // ADR 0028: 做法与版本 and 一次次改进 are folded parts of 改进记录; unfold them.
  if (tab instanceof HTMLDetailsElement) {
    const record = screen.queryByTestId('capabilities-record')
    if (record instanceof HTMLDetailsElement) record.open = true
    tab.open = true
    return
  }
  fireEvent.click(tab)
}
