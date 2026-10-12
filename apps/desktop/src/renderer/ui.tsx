/** View-only state shared across columns: which dialog is open. Not persisted, not in the store. */
import { createContext, useContext } from 'react'

export interface DeliverableTarget {
  readonly deliverableId: string
  readonly version: number
  readonly mode: 'preview' | 'diff' | 'feedback'
}

export type PanelTab = 'materials' | 'deliverables' | 'files' | 'goal' | 'capabilities'

export interface UiActions {
  openDeliverable(target: DeliverableTarget): void
  openSettings(): void
  showPanel(tab: PanelTab): void
}

export const UiContext = createContext<UiActions>({
  openDeliverable: () => undefined,
  openSettings: () => undefined,
  showPanel: () => undefined,
})

export function useUi(): UiActions {
  return useContext(UiContext)
}
