/**
 * BM25 ranking of handbook entries for a task description (ADR 0018
 * decision 4). An entry's document is its text plus its keywords, the
 * keywords counted twice (they name where the entry applies). The index of a
 * set of entries is built once and reused until the set changes.
 */
import type { HandbookEntry } from '@nexgent/kernel'
import { terms } from './tokens.js'

const K1 = 1.2
const B = 0.75

/** One ranked entry. */
export interface ScoredEntry {
  readonly entry: HandbookEntry
  readonly score: number
}

interface Doc {
  readonly entry: HandbookEntry
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
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
      return { entry, tf, length: all.length }
    })
    this.#avgLength = this.#docs.length === 0 ? 0 : this.#docs.reduce((sum, doc) => sum + doc.length, 0) / this.#docs.length
  }

  get size(): number {
    return this.#docs.length
  }

  /** Entries with a positive score for `query`, best first; ties keep active before trial, then the better vote balance, then the older entry. */
  search(query: string, k: number, exclude: ReadonlySet<string> = new Set()): ScoredEntry[] {
    const q = new Map<string, number>()
    for (const term of terms(query)) q.set(term, (q.get(term) ?? 0) + 1)
    if (q.size === 0 || this.#docs.length === 0 || k <= 0) return []
    const n = this.#docs.length
    const scored: ScoredEntry[] = []
    for (const doc of this.#docs) {
      if (exclude.has(doc.entry.id)) continue
      let score = 0
      for (const term of q.keys()) {
        const f = doc.tf.get(term)
        if (f === undefined) continue
        const df = this.#df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / (this.#avgLength || 1))))
      }
      if (score > 0) scored.push({ entry: doc.entry, score })
    }
    scored.sort((a, b) =>
      b.score - a.score
      || (a.entry.status === b.entry.status ? 0 : a.entry.status === 'active' ? -1 : 1)
      || (b.entry.helpful - b.entry.harmful) - (a.entry.helpful - a.entry.harmful)
      || (a.entry.createdAt < b.entry.createdAt ? -1 : a.entry.createdAt > b.entry.createdAt ? 1 : 0))
    return scored.slice(0, k)
  }
}
