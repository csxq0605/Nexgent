import { Component, type ErrorInfo as ReactErrorInfo, type ReactNode } from 'react'
import { T } from '../strings.js'

interface Props {
  readonly children: ReactNode
  /** Smaller inline fallback for one region instead of the whole window. */
  readonly region?: string
}

interface State {
  readonly error: Error | undefined
}

/** Keeps a render error from blanking the window: shows what failed and a way back. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ReactErrorInfo): void {
    console.warn('render error', error.message, info.componentStack ?? '')
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === undefined) return this.props.children
    return (
      <div className={this.props.region === undefined ? 'fatal' : 'region-error'} role="alert" data-testid="render-error">
        <h2>{T.crashedTitle}</h2>
        <p>{T.crashedBody}</p>
        <pre className="error-detail">{error.message}</pre>
        <button type="button" onClick={() => this.setState({ error: undefined })}>
          {T.retry}
        </button>
      </div>
    )
  }
}
