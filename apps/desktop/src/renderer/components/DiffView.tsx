import type { DeliverableDiff, DeliverableFileChange } from '@nexgent/kernel'
import { T } from '../strings.js'

const CHANGE_LABEL: Record<DeliverableFileChange, string> = { added: T.fileAdded, removed: T.fileRemoved, modified: T.fileModified, unchanged: T.fileUnchanged }

/** Unified-style line diff of two deliverable versions, file by file. */
export function DiffView({ diff }: { readonly diff: DeliverableDiff }): JSX.Element {
  const changed = diff.files.filter(file => file.change !== 'unchanged')
  return (
    <div className="diff" data-testid="diff-view">
      <h3>{T.diffTitle(diff.from, diff.to)}</h3>
      {changed.length === 0 && <p className="muted">{T.noDiff}</p>}
      {changed.map(file => (
        <section key={file.path} className="diff-file" data-testid="diff-file">
          <header>
            <span className={`badge change-${file.change}`}>{CHANGE_LABEL[file.change]}</span> <code>{file.path}</code>
          </header>
          {file.binary ? (
            <p className="muted small">{T.binaryFile}</p>
          ) : (
            (file.hunks ?? []).map((hunk, index) => (
              <pre key={index} className="hunk">
                <span className="hunk-head">
                  @@ -{hunk.fromStart},{hunk.fromLines} +{hunk.toStart},{hunk.toLines} @@
                </span>
                {hunk.lines.map((line, i) => (
                  <span key={i} className={`line ${line.op}`} data-op={line.op}>
                    {line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '}
                    {line.text}
                  </span>
                ))}
              </pre>
            ))
          )}
        </section>
      ))}
    </div>
  )
}
