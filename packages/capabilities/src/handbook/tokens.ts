/**
 * Lexical terms of a text for handbook retrieval and duplicate detection
 * (ADR 0018 decision 4: local lexical retrieval, no vector service).
 *
 * - Latin letters and digits: lowercase words of two or more characters
 *   (`_` and `-` split words too, so `avg_order_value` also yields `avg`,
 *   `order`, `value`), common English function words left out, a trailing
 *   plural `s` folded.
 * - CJK runs (Han, kana, Hangul): every pair of neighbouring characters
 *   (character bigrams, the usual segmentation-free approach for Chinese and
 *   Japanese); a run of one character is that character. Single characters
 *   are not terms (almost any two Chinese texts share some), nor are pairs
 *   with a function character such as 的 or 了.
 *
 * The same function serves every language: nothing depends on the task.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its',
  'not', 'of', 'on', 'or', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'those', 'to', 'was', 'were', 'when',
  'which', 'while', 'with', 'you', 'your', 'we', 'our', 'can', 'will', 'should', 'must', 'all', 'any', 'each', 'one', 'use',
])

/**
 * Chinese function characters (particles, pronouns, the commonest
 * adverbs and copulas) that rarely start or end a content word: a bigram
 * that contains one is mostly a seam between words
 * (`的文` in `项目的文件`), so it is not a term.
 */
const CJK_STOP_CHARS = new Set([...'的了吗呢吧啊着们这那我你他她它也就都在是'])

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u
const RUNS = /[\p{L}\p{N}]+/gu

function fold(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

function latinTerms(word: string, out: string[]): void {
  const lower = word.toLowerCase()
  if (lower.length >= 2 && !STOP_WORDS.has(lower)) out.push(fold(lower))
}

/** The terms of `text`, in order, with repeats (term frequency counts them). */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const match of text.normalize('NFKC').matchAll(RUNS)) {
    const run = match[0]
    let latin = ''
    let cjk = ''
    const flushLatin = () => {
      if (latin !== '') latinTerms(latin, out)
      latin = ''
    }
    const flushCjk = () => {
      const chars = [...cjk]
      if (chars.length === 1 && !CJK_STOP_CHARS.has(chars[0]!)) out.push(chars[0]!)
      for (let i = 0; i + 1 < chars.length; i += 1) {
        if (!CJK_STOP_CHARS.has(chars[i]!) && !CJK_STOP_CHARS.has(chars[i + 1]!)) out.push(chars[i]! + chars[i + 1]!)
      }
      cjk = ''
    }
    for (const char of run) {
      if (CJK.test(char)) {
        flushLatin()
        cjk += char
      } else {
        flushCjk()
        latin += char
      }
    }
    flushLatin()
    flushCjk()
  }
  // `snake_case` and `kebab-case` names: the whole name was split by RUNS already; add it back joined.
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+(?:[_-][a-z0-9]+)+/g)) out.push(match[0])
  return out
}

/** Distinct terms. */
export function termSet(text: string): Set<string> {
  return new Set(terms(text))
}

/** Jaccard similarity of two term sets (0 when both are empty). */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0
  let shared = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const term of small) if (large.has(term)) shared += 1
  return shared / (left.size + right.size - shared)
}
