/**
 * Local lexical helpers of layer 1 (ADR 0018 decision 4: no vector service):
 * tokens for Chinese and English text, task keywords, text similarity for
 * deduplication, the longest shared run of characters (copied requests) and
 * the language of a text (decision 11, until the interface language is a
 * setting). Pure.
 */

const HAN = /\p{Script=Han}/u
const WORD = /[\p{L}\p{N}_]+/gu

/** Common English words that say nothing about a task. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'will', 'can', 'not', 'but', 'all', 'any', 'you', 'your',
  'our', 'its', 'has', 'have', 'had', 'per', 'via', 'use', 'using', 'please', 'make', 'each', 'every', 'then', 'than', 'when', 'what', 'which',
  'there', 'their', 'them', 'they', 'also', 'only', 'just', 'should', 'would', 'could', 'need', 'needs', 'want', 'like', 'one', 'out', 'over',
  'how', 'why', 'who', 'about', 'more', 'some', 'such', 'other', 'these', 'those', 'been', 'being', 'does', 'did', 'done', 'here', 'after', 'before',
])

/** Common Chinese bigrams that say nothing about a task. */
const HAN_STOP = new Set(['一个', '这个', '那个', '我们', '你们', '他们', '可以', '需要', '请你', '帮我', '一下', '然后', '如果', '因为', '所以', '以及', '进行', '没有', '还是', '就是', '什么', '怎么'])

/**
 * Lowercase tokens: words of letters and digits (two or more characters,
 * English stopwords left out) and, inside runs of Han characters, every
 * bigram (a single character when the run has one). Repeats are kept
 * (term frequency).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0]
    let latin = ''
    let han = ''
    const flushLatin = () => {
      if (latin.length >= 2 && !STOPWORDS.has(latin)) tokens.push(latin)
      latin = ''
    }
    const flushHan = () => {
      if (han.length === 1) tokens.push(han)
      for (let i = 0; i + 1 < han.length; i += 1) {
        const pair = han.slice(i, i + 2)
        if (!HAN_STOP.has(pair)) tokens.push(pair)
      }
      han = ''
    }
    for (const char of word) {
      if (HAN.test(char)) {
        flushLatin()
        han += char
      } else {
        flushHan()
        latin += char
      }
    }
    flushLatin()
    flushHan()
  }
  return tokens
}

/** The distinct tokens of a text, most frequent first (ties in first-seen order), at most `max`, each at most `maxChars` characters. */
export function keywordsOf(text: string, max = 16, maxChars = 40): string[] {
  const counts = new Map<string, number>()
  for (const token of tokenize(text)) {
    if (token.length > maxChars) continue
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([token]) => token)
}

/** Dice coefficient of two texts' token sets (0–1). */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

/** Whitespace collapsed, lowercase. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Length of the longest run of characters both texts contain (case and whitespace runs ignored). */
export function longestSharedRun(a: string, b: string): number {
  const x = [...normalize(a)]
  const y = [...normalize(b)]
  if (x.length === 0 || y.length === 0) return 0
  let best = 0
  let previous = new Array<number>(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i += 1) {
    const current = new Array<number>(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j += 1) {
      if (x[i - 1] === y[j - 1]) {
        current[j] = previous[j - 1]! + 1
        if (current[j]! > best) best = current[j]!
      }
    }
    previous = current
  }
  return best
}

/** A language the learner writes in: a BCP 47 tag. */
export type LearningLanguage = string

/**
 * The language of a text: `zh` when at least a fifth of its letters are Han
 * characters, else `en`.
 */
export function detectLanguage(text: string): LearningLanguage {
  let letters = 0
  let han = 0
  for (const char of text) {
    if (HAN.test(char)) {
      han += 1
      letters += 1
    } else if (/\p{L}/u.test(char)) letters += 1
  }
  return letters > 0 && han / letters >= 0.2 ? 'zh' : 'en'
}

/** How a prompt names a language. */
export function languageName(language: LearningLanguage): string {
  const tag = language.toLowerCase()
  if (tag === 'zh' || tag.startsWith('zh-')) return tag.includes('hant') || tag.endsWith('-tw') || tag.endsWith('-hk') ? 'Traditional Chinese (繁體中文)' : 'Simplified Chinese (简体中文)'
  if (tag === 'en' || tag.startsWith('en-')) return 'English'
  if (tag === 'ja' || tag.startsWith('ja-')) return 'Japanese (日本語)'
  return `the language with BCP 47 tag "${language}"`
}
