import { useUi, useView, useViewActions } from '../ui.js'
import { T } from '../strings.js'
import { CapabilitiesPanel } from './Capabilities.js'
import { ImprovementsPanel } from './Improvements.js'
import { Page } from './Page.js'

const SECTIONS = [
  { id: 'capabilities', label: T.panelCapabilities },
  { id: 'improvements', label: T.panelImprovements },
] as const

/**
 * 能力 as one page (ADR 0020 §1): the capability version and the improvement
 * jobs, each a section. This round changes only the container; the content
 * is redone with the evolution output (rework partition D2).
 */
export function CapabilitiesPage(): JSX.Element {
  const ui = useUi()
  const { section } = useView()
  const { setSection } = useViewActions()
  return (
    <Page
      title={T.capabilitiesTitle}
      lead={T.capabilitiesLead}
      onClose={ui.showConversation}
      testId="capabilities-page"
      bar={
        <div className="segmented" role="tablist">
          {SECTIONS.map(s => (
            <button type="button" key={s.id} role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)} data-testid={`tab-${s.id}`}>
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      {section === 'capabilities' ? <CapabilitiesPanel /> : <ImprovementsPanel />}
    </Page>
  )
}
