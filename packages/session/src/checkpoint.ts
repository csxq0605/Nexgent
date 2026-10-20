/**
 * Incremental checkpoints: reconstruct the full state a checkpoint stands for.
 *
 * A checkpoint without `base` is full (`state` is the whole projection). One
 * with `base`/`keep` is incremental: its state is the base checkpoint's
 * messages truncated to the first `keep`, followed by `state.messages`, with
 * the checkpoint's own `metadata`. A checkpoint is usable only when its base
 * is the latest usable checkpoint before it; otherwise resume falls back to
 * the previous usable one (or `session.start`) and replays the records after.
 */
import type { CheckpointRecord, SessionRecord, SessionState } from '@nexgent/kernel'

/** A writer starts a new full checkpoint after this many incremental links, which bounds the chain. */
export const MAX_CHECKPOINT_CHAIN = 256

type Message = SessionState['messages'][number]

/** A usable checkpoint with its reconstructed full state. */
export interface ResolvedCheckpoint {
  /** Index of the record in the record list. */
  readonly index: number
  /** The record as written. */
  readonly record: CheckpointRecord
  /** The full projected state as of `coversSeq`. */
  readonly state: SessionState
  /** Number of incremental links behind it (0 for a full one). */
  readonly depth: number
}

interface Link {
  readonly index: number
  readonly record: CheckpointRecord
  /** Index into `links` of the base, when incremental. */
  readonly base: number | undefined
  /** Messages of the full state. */
  readonly count: number
  readonly depth: number
}

/**
 * The latest usable checkpoint of a record list (linear time), or `undefined`
 * when there is none.
 * @param records - valid records in `seq` order, starting with `session.start`.
 */
export function resolveLatestCheckpoint(records: readonly SessionRecord[]): ResolvedCheckpoint | undefined {
  const links: Link[] = []
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] as SessionRecord
    if (record.type !== 'checkpoint') continue
    const previous = links.at(-1)
    if (record.base === undefined) {
      links.push({ index, record, base: undefined, count: record.state.messages.length, depth: 0 })
    } else if (
      previous !== undefined &&
      previous.record.seq === record.base &&
      record.keep !== undefined &&
      record.keep <= previous.count
    ) {
      links.push({ index, record, base: links.length - 1, count: record.keep + record.state.messages.length, depth: previous.depth + 1 })
    }
  }
  const last = links.at(-1)
  if (last === undefined) return undefined
  // Walk back collecting the segment each link contributes to the final message list.
  const segments: (readonly Message[])[] = []
  let need = last.count
  let link: Link | undefined = last
  while (link !== undefined) {
    const own = link.record.state.messages
    const inherited = link.base === undefined ? 0 : (link.record.keep as number)
    if (need > inherited) segments.push(own.slice(0, need - inherited))
    need = Math.min(need, inherited)
    link = link.base === undefined ? undefined : links[link.base]
  }
  const messages = segments.reverse().flat()
  return { index: last.index, record: last.record, state: { ...last.record.state, messages }, depth: last.depth }
}
