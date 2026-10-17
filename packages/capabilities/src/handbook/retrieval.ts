/**
 * BM25 ranking of handbook entries for a task description (ADR 0018
 * decision 4). An entry's document is its text plus its keywords, the
 * keywords counted twice (they name where the entry applies). The index of a
 * set of entries is built once and reused until the set changes.
 *
 * Relevance gate: a positive BM25 score only says the task and the entry
 * share a term. An entry's keywords say where it applies (ADR 0018 decision
 * 4), so an entry is given when the task text contains one of them (every
 * term of the keyword is a term of the task), or else when the task shares
 * at least {@link HANDBOOK_MIN_SHARED_TERMS} terms with it and covers
 * {@link HANDBOOK_MIN_COVERAGE} of its own weight (its score against the
 * task over its score against itself). When nothing passes, nothing is
 * given.
 */
import type { HandbookEntry } from '@nexgent/kernel'
import { terms } from './tokens.js'
import type { HandbookEntryUsage } from './usage.js'

const K1 = 1.2
const B = 0.75

/** Share of an entry's self-score the task must reach. */
export const HANDBOOK_MIN_COVERAGE = 0.2
/** Distinct terms the task and an entry must share. */
export const HANDBOOK_MIN_SHARED_TERMS = 2

/** One ranked entry. */
export interface ScoredEntry {
  readonly entry: HandbookEntry
  readonly score: number
  /** Score over the entry's score against itself, 0–1. */
  readonly coverage: number
}

interface Doc {
  readonly entry: HandbookEntry
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
  /** The terms of each keyword (keywords without terms left out). */
  readonly keywords: readonly (readonly string[])[]
}

/** A BM25 index over entries. */
export class HandbookIndex {
  readonly #docs: Doc[]
  readonly #df = new Map<string, number>()
  readonly #avgLength: number

  constructor(entries: readonly HandbookEntry[]) {
    this.#docs = entries.map(entry => {
      const all = [...terms(entry.text), ...entry.keywords.flatMap(keyword => terms(keyword)), ...entry.keywords.flatMap(keyword => terms(keyword))]
      const tf = new Map<string, number>()
      for (const term of all) tf.set(term, (tf.get(term) ?? 0) + 1)
      for (const term of tf.keys()) this.#df.set(term, (this.#df.get(term) ?? 0) + 1)
      const keywords = entry.keywords.map(keyword => [...new Set(terms(keyword))]).filter(list => list.length > 0)
      return { entry, tf, length: all.length, keywords }
    })
    this.#avgLength = this.#docs.length === 0 ? 0 : this.#docs.reduce((sum, doc) => sum + doc.length, 0) / this.#docs.length
  }

  get size(): number {
    return this.#docs.length
  }

  /**
   * Entries with a positive score for `query`, best first; ties keep active
   * before trial, then the larger share of tasks that used it, the more
   * recent use, the better vote balance, then the older entry.
   */
  #weight(doc: Doc, term: string, f: number, n: number): number {
    const df = this.#df.get(term) ?? 0
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    return idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / (this.#avgLength || 1))))
  }

  search(query: string, k: number, exclude: ReadonlySet<string> = new Set(), usage?: ReadonlyMap<string, Pick<HandbookEntryUsage, 'used' | 'given' | 'lastUsedAt'>>): ScoredEntry[] {
    const q = new Map<string, number>()
    for (const term of terms(query)) q.set(term, (q.get(term) ?? 0) + 1)
    if (q.size === 0 || this.#docs.length === 0 || k <= 0) return []
    const n = this.#docs.length
    const scored: ScoredEntry[] = []
    for (const doc of this.#docs) {
      if (exclude.has(doc.entry.id)) continue
      let score = 0
      let shared = 0
      for (const term of q.keys()) {
        const f = doc.tf.get(term)
        if (f === undefined) continue
        shared += 1
        score += this.#weight(doc, term, f, n)
      }
      if (score <= 0) continue
      let self = 0
      for (const [term, f] of doc.tf) self += this.#weight(doc, term, f, n)
      const coverage = self > 0 ? Math.min(1, score / self) : 0
      const relevant = doc.keywords.some(keyword => keyword.every(term => q.has(term)))
        || (shared >= HANDBOOK_MIN_SHARED_TERMS && coverage >= HANDBOOK_MIN_COVERAGE)
      if (relevant) scored.push({ entry: doc.entry, score, coverage })
    }
    scored.sort((a, b) =>
      b.score - a.score
      || (a.entry.status === b.entry.status ? 0 : a.entry.status === 'active' ? -1 : 1)
      || usedRatio(usage?.get(b.entry.id)) - usedRatio(usage?.get(a.entry.id))
      || ((usage?.get(b.entry.id)?.lastUsedAt ?? '') > (usage?.get(a.entry.id)?.lastUsedAt ?? '') ? 1 : (usage?.get(b.entry.id)?.lastUsedAt ?? '') < (usage?.get(a.entry.id)?.lastUsedAt ?? '') ? -1 : 0)
      || (b.entry.helpful - b.entry.harmful) - (a.entry.helpful - a.entry.harmful)
      || (a.entry.createdAt < b.entry.createdAt ? -1 : a.entry.createdAt > b.entry.createdAt ? 1 : 0))
    return scored.slice(0, k)
  }
}

function usedRatio(usage: Pick<HandbookEntryUsage, 'used' | 'given'> | undefined): number {
  return usage === undefined || usage.given === 0 ? 0 : Math.min(1, usage.used / usage.given)
}
