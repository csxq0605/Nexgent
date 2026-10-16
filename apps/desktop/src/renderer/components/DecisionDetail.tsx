import { T } from '../strings.js'

/** The gate's numbers in words when the decision has a verdict (its English detail line folded away); otherwise the decision's own detail. */
export function DecisionDetail({ detail, summary }: { readonly detail: string; readonly summary?: string | undefined }): JSX.Element {
  if (summary === undefined) return <>{detail}</>
  return (
    <>
      {summary}
      <details className="muted">
        <summary>{T.gateRecord}</summary>
        {detail}
      </details>
    </>
  )
}
