import { useEffect } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { L } from '../strings.js'
import { useUi, useView } from '../ui.js'
import { CapabilitiesPanel } from './Capabilities.js'
import { ImprovementsPanel } from './Improvements.js'
import { Decide, hasPendingRules, InUseList, LearningCard, learnedLead, MoreEntries, PendingRules, RulesList, useLearningRefresh } from './Learned.js'
import { OfflineDecision, OfflinePanel, offlineWaiting } from './Offline.js'
import { O } from '../offline-strings.js'
import { Page } from './Page.js'
import { T } from '../strings.js'

/**
 * 能力 as one quiet page (ADR 0028): one line on what is in use and its
 * effect, what waits for the user (only when something does), the project
 * rules and the practices in use. Everything about how improvement works
 * (trial entries, spend, versions, jobs, offline runs) is in the folded
 * 改进记录; a jump to one of those parts (`section`) unfolds it.
 */
export function CapabilitiesPage(): JSX.Element {
  const ui = useUi()
  const state = useAppState()
  const store = useAppStore()
  const { section } = useView()
  useLearningRefresh()
  useEffect(() => {
    void store.refreshOffline()
  }, [])
  const waitingRun = offlineWaiting(state.offline)
  const waitingApproval = state.capabilities?.candidates.some(candidate => candidate.status === 'awaiting-approval') ?? false
  const attention = waitingRun !== undefined || waitingApproval || hasPendingRules(state.handbook?.entries)
  return (
    <Page title={T.capabilitiesTitle} lead={learnedLead(state.handbook?.entries)} onClose={ui.showConversation} testId="capabilities-page">
      <div className="learned" data-testid="learned-panel">
        {attention && (
          <section className="decide" data-testid="capabilities-attention">
            <h3 className="group-title">
              <span className="dot warn" aria-hidden="true" />
              {L.attentionTitle}
            </h3>
            <PendingRules />
            <Decide />
            {waitingRun !== undefined && <OfflineDecision run={waitingRun} />}
          </section>
        )}
        <RulesList />
        <InUseList />
        <details className="entry-group folded record" open={section !== 'learned'} data-testid="capabilities-record">
          <summary className="group-title">{L.recordTitle}</summary>
          <RecordPart title={L.recordTrial} testId="record-trial">
            <MoreEntries />
          </RecordPart>
          <RecordPart title={L.recordLearning} testId="record-learning">
            {state.learning !== undefined && <LearningCard learning={state.learning} />}
          </RecordPart>
          <RecordPart title={L.recordVersions} open={section === 'capabilities'} testId="tab-capabilities">
            <CapabilitiesPanel />
          </RecordPart>
          <RecordPart title={L.recordJobs} open={section === 'improvements'} testId="tab-improvements">
            <ImprovementsPanel />
          </RecordPart>
          <RecordPart title={O.section} help={O.intro} open={section === 'offline'} testId="tab-offline">
            <OfflinePanel />
          </RecordPart>
        </details>
      </div>
    </Page>
  )
}

function RecordPart({ title, help, open, testId, children }: { readonly title: string; readonly help?: string; readonly open?: boolean; readonly testId: string; readonly children: JSX.Element | null | false | undefined | readonly (JSX.Element | null | false | undefined)[] }): JSX.Element {
  return (
    <details className="record-part" open={open} data-testid={testId}>
      <summary className="small">
        {title}
        {help !== undefined && (
          <span className="help-tip" title={help} aria-label={help}>
            ?
          </span>
        )}
      </summary>
      {children}
    </details>
  )
}
