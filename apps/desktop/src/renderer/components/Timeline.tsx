import { useEffect, useRef, useState } from 'react'
import type { DeliverableSummary, FileChange } from '@nexgent/kernel'
import type { CheckFailureView } from '@nexgent/sdk'
import { rewindableTurns, type TimelineEntry } from '../timeline.js'
import { T, durationText, errorText, fileChangeText, riskText, stepsParts, toolVerb, turnEndText, turnUsdText } from '../strings.js'
import { DeliverableCard } from './DeliverableCard.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import { TeamCard, TeamMessageNote, WorkflowBlock } from './MemberBlock.js'
import { ToolBlock, toolSummary } from './ToolBlock.js'

type Entry = TimelineEntry
type MemberEntry = Extract<Entry, { kind: 'member' }>

/** What the stream shows: single entries, folded process groups, a team card per turn. */
export type Block =
  | { readonly kind: 'entry'; readonly key: string; readonly entry: Entry }
  | { readonly kind: 'steps'; readonly key: string; readonly entries: readonly Entry[] }
  | { readonly kind: 'team'; readonly key: string; readonly members: readonly MemberEntry[] }

/** Process entries fold into one line (ADR 0020 §1): tool calls, thinking, workflow phases, team mail. */
const FOLDED = new Set<Entry['kind']>(['tool', 'reasoning', 'workflow', 'team.message'])

/**
 * Group the flat timeline for display: consecutive process entries of a turn
 * become one `steps` block; all member runs of a turn become one `team` card
 * where the first of them appears. Everything else stays as it is.
 */
export function blocksOf(entries: readonly Entry[]): Block[] {
  const blocks: Block[] = []
  const membersByTurn = new Map<number, MemberEntry[]>()
  for (const entry of entries) if (entry.kind === 'member') membersByTurn.set(entry.turn, [...(membersByTurn.get(entry.turn) ?? []), entry])
  const placed = new Set<number>()
  let run: Entry[] = []
  const flush = (): void => {
    if (run.length === 0) return
    blocks.push({ kind: 'steps', key: `s:${run[0]!.key}`, entries: run })
    run = []
  }
  for (const entry of entries) {
    if (FOLDED.has(entry.kind)) {
      if (run.length > 0 && run[0]!.turn !== entry.turn) flush()
      run.push(entry)
      continue
    }
    flush()
    if (entry.kind === 'member') {
      if (placed.has(entry.turn)) continue
      placed.add(entry.turn)
      blocks.push({ kind: 'team', key: `team:${entry.turn}`, members: membersByTurn.get(entry.turn)! })
      continue
    }
    blocks.push({ kind: 'entry', key: entry.key, entry })
  }
  flush()
  return blocks
}

/** The one line a folded group shows: what is happening now, or what was done and how long the steps took. */
export function stepsLine(entries: readonly Entry[]): { readonly text: string; readonly running: boolean } {
  const tools = entries.filter((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool')
  const live = tools.find(tool => tool.running)
  if (live !== undefined) {
    const target = toolSummary(live.name, live.args)
    return { text: `${T.stepsRunning}：${toolVerb(live.name)}${target === '' ? '' : ` ${target}`}`, running: true }
  }
  if (entries.some(e => e.kind === 'reasoning' && e.streaming)) return { text: T.thinkingLive, running: true }
  const timed = tools.filter(tool => tool.durationMs !== undefined)
  const total = timed.reduce((sum, tool) => sum + tool.durationMs!, 0)
  const parts = stepsParts(tools.map(tool => tool.name))
  if (parts.length === 0) return { text: T.thinking, running: false }
  return { text: T.stepsSummary(parts, timed.length === 0 ? undefined : durationText(total)), running: false }
}

function StepsBlock({ entries }: { readonly entries: readonly Entry[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const line = stepsLine(entries)
  const failed = entries.some(e => e.kind === 'tool' && e.isError === true)
  return (
    <div className="steps" data-open={open ? 'true' : 'false'} data-testid="steps">
      <button type="button" className="steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="steps-toggle">
        <Icon name="chevronRight" className="chev" />
        {line.running && <span className="dot run" />}
        {failed && !line.running && <span className="dot bad" />}
        <span className="ellipsis">{line.text}</span>
      </button>
      <div className="steps-list" hidden={!open}>
        {entries.map(entry => (
          <StepEntry key={entry.key} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function StepEntry({ entry }: { readonly entry: Entry }): JSX.Element | null {
  switch (entry.kind) {
    case 'tool':
      return <ToolBlock entry={entry} />
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>{entry.streaming ? T.thinkingLive : T.thinkingStep}</summary>
          <p className="text muted">{entry.text}</p>
        </details>
      )
    case 'workflow':
      return <WorkflowBlock entry={entry} />
    case 'team.message':
      return <TeamMessageNote entry={entry} />
    default:
      return null
  }
}

/** A turn's changed files when it presented nothing (with a deliverable they go on its card). */
function FilesNote({ changes }: { readonly changes: readonly FileChange[] }): JSX.Element {
  return (
    <details className="files-note" data-testid="files-note">
      <summary>{T.filesChanged(changes.length)}</summary>
      <ul className="change-list">
        {changes.map(change => (
          <li key={change.path}>
            <span className={`badge change-${change.change}`}>{fileChangeText(change.change)}</span> <code>{change.path}</code>
          </li>
        ))}
      </ul>
    </details>
  )
}

function failureText(failure: CheckFailureView): string {
  if (failure.check === 'test-command') return T.checkFailed['test-command'](failure.target)
  if (failure.check === 'check-command') return T.checkFailed['check-command'](failure.target)
  if (failure.check === 'parses') return T.checkFailed.parses(failure.target, failure.format ?? '')
  if (failure.check === 'exists') return T.checkFailed.exists(failure.target)
  return failure.target
}

/** Redesign 3.2: one line for an automatic retry; open it to see what failed. */
function CheckRetryNote({ entry }: { readonly entry: Extract<Entry, { kind: 'check.retry' }> }): JSX.Element {
  return (
    <details className="files-note check-retry" data-testid="check-retry">
      <summary>
        <span className="dot warn" aria-hidden="true" /> {T.checkRetry(entry.retry.attempt, entry.retry.max)}
      </summary>
      <ul className="change-list">
        {entry.retry.failed.map((failure, index) => (
          <li key={index}>
            <span>{failureText(failure)}</span>
            {failure.detail !== undefined && <span className="muted">（{T.checkDetail(failure.detail)}）</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Redesign 3.1: the files the user took back. */
function RewindNote({ entry }: { readonly entry: Extract<Entry, { kind: 'rewind' }> }): JSX.Element {
  const { restored, deleted } = entry.rewind
  return (
    <details className="files-note rewind-note" data-testid="rewind-note">
      <summary>{T.rewindDone(restored.length, deleted.length)}</summary>
      <ul className="change-list">
        {restored.map(path => (
          <li key={`r:${path}`}>
            <span className="badge change-modified">{T.rewindRestoredBadge}</span> <code>{path}</code>
          </li>
        ))}
        {deleted.map(path => (
          <li key={`d:${path}`}>
            <span className="badge change-deleted">{T.rewindDeletedBadge}</span> <code>{path}</code>
          </li>
        ))}
      </ul>
    </details>
  )
}

function latestVersion(deliverables: readonly DeliverableSummary[], deliverableId: string, fallback: number): number {
  const found = deliverables.find(d => d.deliverableId === deliverableId)
  return found === undefined ? fallback : Math.max(fallback, ...found.versions.map(v => v.version))
}

/** Per turn: its file changes (later entries win per path) and the key of its last deliverable card. */
function turnFiles(entries: readonly Entry[]): { readonly changes: Map<number, FileChange[]>; readonly lastCard: Map<number, string> } {
  const byPath = new Map<number, Map<string, FileChange>>()
  const lastCard = new Map<number, string>()
  for (const entry of entries) {
    if (entry.kind === 'files') {
      const map = byPath.get(entry.turn) ?? new Map<string, FileChange>()
      for (const change of entry.changes) map.set(change.path, change)
      byPath.set(entry.turn, map)
    }
    if (entry.kind === 'deliverable') lastCard.set(entry.turn, entry.key)
  }
  return { changes: new Map([...byPath].map(([turn, map]) => [turn, [...map.values()]])), lastCard }
}

function EntryView({
  entry,
  deliverables,
  readOnly,
  files,
  onRewind,
}: {
  readonly entry: Entry
  readonly deliverables: readonly DeliverableSummary[]
  readonly readOnly: boolean
  readonly files: ReturnType<typeof turnFiles>
  readonly onRewind?: ((turn: number) => void) | undefined
}): JSX.Element | null {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg user" data-testid="user-message">
          <div className="bubble">
            <p className="text">{entry.text}</p>
            {entry.materials.length > 0 && (
              <div className="chips">
                {entry.materials.map(name => (
                  <span key={name} className="chip">
                    @{name}
                  </span>
                ))}
              </div>
            )}
          </div>
          {onRewind !== undefined && (
            <button type="button" className="link small msg-action" title={T.rewindActionTitle} onClick={() => onRewind(entry.turn)} data-testid="rewind-open">
              {T.rewindAction}
            </button>
          )}
        </div>
      )
    case 'check.retry':
      return <CheckRetryNote entry={entry} />
    case 'rewind':
      return <RewindNote entry={entry} />
    case 'assistant':
      return (
        <div className="msg assistant" data-testid="assistant-message" data-streaming={entry.streaming ? 'true' : 'false'}>
          <Markdown text={entry.text} />
          {entry.streaming && <span className="caret" aria-hidden="true" />}
          {entry.interrupted && <p className="muted small">{T.interruptedText}</p>}
        </div>
      )
    case 'approval':
      // While it waits, the card above the composer is the approval; afterwards one quiet line records it.
      if (entry.decision === undefined) return null
      return (
        <div className="approval-note" data-testid="approval-note">
          <span className={entry.decision.decision === 'allow' ? 'dot ok' : 'dot bad'} aria-hidden="true" />
          <span>{entry.decision.decision === 'allow' ? T.approvalAllowed : T.approvalDenied}</span>
          {entry.request.member !== undefined && <span>{entry.request.member.name}</span>}
          <span>
            {toolVerb(entry.request.tool)} · {T.approvalRiskLine(riskText(entry.request.risk))}
          </span>
          <code>{entry.request.summary}</code>
        </div>
      )
    case 'deliverable':
      return (
        <DeliverableCard
          deliverable={entry.deliverable}
          latest={!readOnly && latestVersion(deliverables, entry.deliverable.deliverableId, entry.deliverable.version) === entry.deliverable.version}
          {...(files.lastCard.get(entry.turn) === entry.key && files.changes.has(entry.turn) ? { changes: files.changes.get(entry.turn)! } : {})}
        />
      )
    case 'files':
      // Shown once per turn: on its deliverable card, or here when it presented nothing.
      if (files.lastCard.has(entry.turn)) return null
      if (entries_first_files(files, entry)) return <FilesNote changes={files.changes.get(entry.turn) ?? entry.changes} />
      return null
    case 'feedback':
      return (
        <div className="msg user" data-testid="feedback-message">
          <div className="bubble feedback">
            <div className="muted small">
              {T.feedbackLabel} · {T.versionLong(entry.version)}
              {entry.rating !== undefined && ` · ${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}`}
            </div>
            <p className="text">{entry.comment}</p>
          </div>
        </div>
      )
    case 'compaction':
      return <div className="divider">{T.compacted}</div>
    case 'turn.end': {
      const text = turnEndText(entry.reason)
      // Rework D3: what the turn cost, quietly under it (nothing when no price is known).
      const cost = entry.cost !== undefined && entry.cost.usd > 0 ? entry.cost : undefined
      if (text === undefined && cost === undefined) return null
      return (
        <>
          {text !== undefined && (
            <div className={`turn-end turn-end-${entry.reason.kind}`} data-testid="turn-end">
              {text}
            </div>
          )}
          {cost !== undefined && (
            <div className="turn-cost" title={T.turnCostTitle} data-testid="turn-cost">
              {T.turnCost(turnUsdText(cost.usd), cost.estimated)}
            </div>
          )}
        </>
      )
    }
    case 'error':
      return (
        <div className="error-box" role="alert">
          {errorText(entry.error)}
        </div>
      )
    default:
      return null
  }
}

/** Only the first `files` entry of a turn draws the turn's note. */
const firstFilesKey = new WeakMap<ReturnType<typeof turnFiles>, Map<number, string>>()
function entries_first_files(files: ReturnType<typeof turnFiles>, entry: Extract<Entry, { kind: 'files' }>): boolean {
  let firsts = firstFilesKey.get(files)
  if (firsts === undefined) {
    firsts = new Map()
    firstFilesKey.set(files, firsts)
  }
  if (!firsts.has(entry.turn)) firsts.set(entry.turn, entry.key)
  return firsts.get(entry.turn) === entry.key
}

/** The conversation itself; follows the bottom while new content streams in. */
export function Timeline({
  entries,
  deliverables,
  readOnly = false,
  onRewind,
}: {
  readonly entries: readonly TimelineEntry[]
  readonly deliverables: readonly DeliverableSummary[]
  /** A member's session: no feedback buttons, no nested member views. */
  readonly readOnly?: boolean
  /** Redesign 3.1: offered on the user messages whose turn (or a later one) changed files. */
  readonly onRewind?: ((turn: number) => void) | undefined
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight
  }, [entries])
  const files = turnFiles(entries)
  const rewindable = readOnly || onRewind === undefined ? new Set<number>() : rewindableTurns(entries)
  // A message sent while its turn ran is not where that turn starts: only the turn's first message takes the files back.
  const opening = new Set<string>()
  const seenTurns = new Set<number>()
  for (const entry of entries) {
    if (entry.kind !== 'user' || seenTurns.has(entry.turn)) continue
    seenTurns.add(entry.turn)
    opening.add(entry.key)
  }
  return (
    <div
      className="timeline"
      ref={ref}
      data-testid="timeline"
      onScroll={event => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      <div className="timeline-inner">
        {blocksOf(entries).map(block =>
          block.kind === 'steps' ? (
            <StepsBlock key={block.key} entries={block.entries} />
          ) : block.kind === 'team' ? (
            <TeamCard key={block.key} members={block.members} readOnly={readOnly} />
          ) : (
            <EntryView
              key={block.key}
              entry={block.entry}
              deliverables={deliverables}
              readOnly={readOnly}
              files={files}
              onRewind={block.entry.kind === 'user' && rewindable.has(block.entry.turn) && opening.has(block.entry.key) ? onRewind : undefined}
            />
          ),
        )}
      </div>
    </div>
  )
}
