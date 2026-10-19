import { useAppState } from '../hooks.js'
import { L } from '../strings.js'
import { useUi, useView, useViewActions } from '../ui.js'
import { CapabilitiesPanel } from './Capabilities.js'
import { ImprovementsPanel } from './Improvements.js'
import { LearnedPanel, learnedLead } from './Learned.js'
import { OfflinePanel } from './Offline.js'
import { O } from '../offline-strings.js'
import { Page } from './Page.js'
import { T } from '../strings.js'

const SECTIONS = [
  { id: 'learned', label: L.sectionLearned },
  { id: 'capabilities', label: L.sectionPractices },
  { id: 'improvements', label: L.sectionHistory },
  { id: 'offline', label: O.section },
] as const

/**
 * 能力 as one page (ADR 0020 §1, rework D2): 经验 first (what waits for the
 * user, the learning switch and spend, the handbook entries), then the
 * capability versions, the older improvement jobs and the offline runs
 * (ADR 0027), each a section.
 */
export function CapabilitiesPage(): JSX.Element {
  const ui = useUi()
  const state = useAppState()
  const { section } = useView()
  const { setSection } = useViewActions()
  return (
    <Page
      title={T.capabilitiesTitle}
      lead={learnedLead(state.handbook?.entries)}
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
      {section === 'learned' ? <LearnedPanel /> : section === 'capabilities' ? <CapabilitiesPanel /> : section === 'offline' ? <OfflinePanel /> : <ImprovementsPanel />}
    </Page>
  )
}
