import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { AppState, AppStore } from './store.js'

const StoreContext = createContext<AppStore | undefined>(undefined)

export function StoreProvider({ store, children }: { readonly store: AppStore; readonly children: ReactNode }): ReactNode {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (store === undefined) throw new Error('StoreProvider missing')
  return store
}

/** Subscribe to the whole state (the store replaces the object on every change). */
export function useAppState(): AppState {
  const store = useAppStore()
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
