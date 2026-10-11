import type { TimelineEntry } from '../timeline.js'
import { T } from '../strings.js'

type ToolEntry = Extract<TimelineEntry, { kind: 'tool' }>

const OUTPUT_LIMIT = 4000

/** A short, human line for a tool call: the path or command it acts on. */
export function toolSummary(name: string, args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return args.slice(0, 80)
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'name', 'pattern', 'query']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value.length > 120 ? `${value.slice(0, 117)}…` : value
  }
  if (Array.isArray(record['paths'])) return (record['paths'] as unknown[]).filter(p => typeof p === 'string').join(', ')
  return name === 'present' && typeof record['summary'] === 'string' ? record['summary'] : ''
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/** A collapsible block for one tool call: name, target and status; input and output inside. */
export function ToolBlock({ entry }: { readonly entry: ToolEntry }): JSX.Element {
  const status = entry.running ? T.toolRunning : entry.isError === true ? T.toolFailed : T.toolDone
  const statusClass = entry.running ? 'live' : entry.isError === true ? 'bad' : 'ok'
  const content = entry.content ?? ''
  return (
    <details className={`tool tool-${statusClass}`} data-testid="tool-block" data-tool={entry.name}>
      <summary>
        <span className="tool-name">{entry.name}</span>
        <span className="tool-target">{toolSummary(entry.name, entry.args)}</span>
        <span className={`badge ${statusClass}`}>{status}</span>
        {entry.durationMs !== undefined && !entry.running && <span className="muted small">{(entry.durationMs / 1000).toFixed(1)}s</span>}
      </summary>
      <div className="tool-body">
        {entry.args !== '' && (
          <>
            <div className="tool-label">{T.toolInput}</div>
            <pre>{prettyArgs(entry.args)}</pre>
          </>
        )}
        {!entry.running && (
          <>
            <div className="tool-label">{T.toolOutput}</div>
            <pre className={entry.isError === true ? 'error-text' : undefined}>{content.length > OUTPUT_LIMIT ? `${content.slice(0, OUTPUT_LIMIT)}\n…` : content}</pre>
          </>
        )}
      </div>
    </details>
  )
}
