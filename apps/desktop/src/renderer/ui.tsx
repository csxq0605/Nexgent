/** View-only state shared across the window: which page, drawer and dialog are open. Not persisted, not in the store. */
import { createContext, useContext } from 'react'

export interface DeliverableTarget {
  readonly deliverableId: string
  readonly version: number
  readonly mode: 'preview' | 'diff' | 'feedback'
}

/** The main area: the conversation, or one of the two full pages (ADR 0020 §1). */
export type MainView = 'conversation' | 'capabilities' | 'settings'

/** Drawer tabs (`materials`, `deliverables`) and the capability page's sections (`learned`, `capabilities`, `improvements`, `offline`). */
export type PanelTab = 'materials' | 'deliverables' | 'learned' | 'capabilities' | 'improvements' | 'offline'

/** The 能力 page's sections: 经验 (the handbook and learning), 做法与版本, 改进记录, 离线改进 (ADR 0027). */
export type CapabilitySection = 'learned' | 'capabilities' | 'improvements' | 'offline'

/** The settings page's groups (rework D2). */
export type SettingsGroup = 'general' | 'model' | 'permissions' | 'checks' | 'cost' | 'learning' | 'advanced'

export interface UiActions {
  openDeliverable(target: DeliverableTarget): void
  /** Rework D3: `group` scrolls the page to that group. */
  openSettings(group?: SettingsGroup): void
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
  readonly section: CapabilitySection
}

export const ViewContext = createContext<ViewState>({ view: 'conversation', drawer: undefined, section: 'learned' })

export function useView(): ViewState {
  return useContext(ViewContext)
}

export interface ViewActions {
  setDrawer(tab: 'materials' | 'deliverables' | undefined): void
  setSection(section: CapabilitySection): void
}

export const ViewActionsContext = createContext<ViewActions>({ setDrawer: () => undefined, setSection: () => undefined })

export function useViewActions(): ViewActions {
  return useContext(ViewActionsContext)
}
