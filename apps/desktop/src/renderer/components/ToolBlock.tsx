import type { TimelineEntry } from '../timeline.js'
import { T, durationText, toolVerb } from '../strings.js'

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

/** One step inside the folded process: what it did, on what, how long; input and output when opened. */
export function ToolBlock({ entry }: { readonly entry: ToolEntry }): JSX.Element {
  const failed = entry.isError === true
  const content = entry.content ?? ''
  return (
    <details className={failed ? 'tool tool-failed' : 'tool'} data-testid="tool-block" data-tool={entry.name}>
      <summary>
        {entry.running && <span className="dot run" aria-hidden="true" />}
        {failed && <span className="dot bad" aria-hidden="true" />}
        <span className="tool-name">{toolVerb(entry.name)}</span>
        <span className="tool-target">{toolSummary(entry.name, entry.args)}</span>
        {entry.running && <span className="tool-time">{T.toolRunning}</span>}
        {failed && <span className="tool-time">{T.toolFailed}</span>}
        {entry.durationMs !== undefined && !entry.running && !failed && <span className="tool-time">{durationText(entry.durationMs)}</span>}
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
            <pre className={failed ? 'error-text' : undefined}>{content.length > OUTPUT_LIMIT ? `${content.slice(0, OUTPUT_LIMIT)}\n…` : content}</pre>
          </>
        )}
      </div>
    </details>
  )
}
