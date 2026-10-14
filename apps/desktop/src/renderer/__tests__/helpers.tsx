import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
