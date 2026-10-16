/** View-only state shared across the window: which page, drawer and dialog are open. Not persisted, not in the store. */
import { createContext, useContext } from 'react'

export interface DeliverableTarget {
  readonly deliverableId: string
  readonly version: number
  readonly mode: 'preview' | 'diff' | 'feedback'
}

/** The main area: the conversation, or one of the two full pages (ADR 0020 §1). */
export type MainView = 'conversation' | 'capabilities' | 'settings'

/** Drawer tabs (`materials`, `deliverables`) and the capability page's sections (`capabilities`, `improvements`). */
export type PanelTab = 'materials' | 'deliverables' | 'capabilities' | 'improvements'

export interface UiActions {
  openDeliverable(target: DeliverableTarget): void
  openSettings(): void
  /** A drawer tab opens the drawer on it; a capability section opens the 能力 page on it. */
  showPanel(tab: PanelTab): void
  /** Back to the conversation from a full page. */
  showConversation(): void
}

export const UiContext = createContext<UiActions>({
  openDeliverable: () => undefined,
  openSettings: () => undefined,
  showPanel: () => undefined,
  showConversation: () => undefined,
})

export function useUi(): UiActions {
  return useContext(UiContext)
}

/** What the window shows, for the components that render it. */
export interface ViewState {
  readonly view: MainView
  readonly drawer: 'materials' | 'deliverables' | undefined
  readonly section: 'capabilities' | 'improvements'
}

export const ViewContext = createContext<ViewState>({ view: 'conversation', drawer: undefined, section: 'capabilities' })

export function useView(): ViewState {
  return useContext(ViewContext)
}

export interface ViewActions {
  setDrawer(tab: 'materials' | 'deliverables' | undefined): void
  setSection(section: 'capabilities' | 'improvements'): void
}

export const ViewActionsContext = createContext<ViewActions>({ setDrawer: () => undefined, setSection: () => undefined })

export function useViewActions(): ViewActions {
  return useContext(ViewActionsContext)
}
