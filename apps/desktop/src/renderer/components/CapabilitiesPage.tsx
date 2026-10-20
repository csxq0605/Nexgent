import { useAppState } from '../hooks.js'
import { L } from '../strings.js'
import { useUi } from '../ui.js'
import { hasPendingRules, InUseList, LearningCard, learnedLead, organizationLead, PendingRules, RulesList, useLearningRefresh } from './Learned.js'
import { Page } from './Page.js'
import { T } from '../strings.js'

/**
 * 能力 as one quiet page (ADR 0028): one line on what is in use and its
 * effect, what waits for the user (only when something does), the project
 * rules and the practices in use. The learning spend is in the folded
 * 改进记录.
 */
export function CapabilitiesPage(): JSX.Element {
  const ui = useUi()
  const state = useAppState()
  useLearningRefresh()
  const attention = hasPendingRules(state.handbook?.entries)
  return (
    <Page title={T.capabilitiesTitle} lead={[learnedLead(state.handbook?.entries), organizationLead(state.learning?.organizations)].filter(text => text !== '').join(' ')} onClose={ui.showConversation} testId="capabilities-page">
      <div className="learned" data-testid="learned-panel">
        {attention && (
          <section className="decide" data-testid="capabilities-attention">
            <h3 className="group-title">
              <span className="dot warn" aria-hidden="true" />
              {L.attentionTitle}
            </h3>
            <PendingRules />
          </section>
        )}
        <RulesList />
        <InUseList />
        <details className="entry-group folded record" data-testid="capabilities-record">
          <summary className="group-title">{L.recordTitle}</summary>
          <RecordPart title={L.recordLearning} testId="record-learning">
            {state.learning !== undefined && <LearningCard learning={state.learning} />}
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
