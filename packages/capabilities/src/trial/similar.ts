/**
 * ADR 0014: which selection cases of an improvement job's trial are similar
 * to its feedback task (the cases ADR 0013 decision 1 may not let get
 * worse). The selection set is filled up to its size whatever the overlap,
 * so being in it does not make a task similar.
 *
 * Two tasks are similar when the content words of their first messages
 * overlap by at least {@link SIMILAR_CASE_MIN} (Jaccard). Content words are
 * the selection's own words (lowercase letter and digit runs; one CJK
 * character per word) without
 *
 * - function words ({@link FUNCTION_WORDS}: articles, prepositions,
 *   pronouns, auxiliaries, and the CJK particles and measure words that
 *   carry no subject), which any two messages share, and
 * - words of digits only (a month, an id, an amount): the values of one
 *   instance, which ADR 0013 decision 2 already keeps out of components and
 *   which differ between two instances of the same task.
 *
 * {@link SIMILAR_CASE_MIN} = 0.25 means the two messages share at least two
 * in five of each one's content words (for messages of equal length,
 * shared / (2n − shared) ≥ 1/4 ⇔ shared ≥ 0.4 n). It was set from that
 * reading, not fitted to any task.
 */

/** Smallest content-word Jaccard overlap at which two tasks are similar. */
export const SIMILAR_CASE_MIN = 0.25

/** Words that carry no subject in English and Chinese/Japanese text (CJK: single characters). */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'if', 'then', 'than', 'as', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
  'onto', 'out', 'over', 'under', 'about', 'per', 'via', 'up', 'down', 'off', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'it', 'its', 'this', 'that',
  'these', 'those', 'there', 'here', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'his', 'her',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'any', 'each', 'every', 'some', 'no', 'not', 'also', 'too',
  'very', 'just', 'only', 'please', 'one', 'other', 'such', 'same', 'both', 'either', 'neither', 'own', 'again', 'still', 'yet', 'now',
  // Chinese / Japanese particles, pronouns, measure words
  '的', '了', '和', '与', '及', '或', '在', '是', '把', '将', '对', '为', '等', '并', '也', '都', '就', '而', '以', '于', '个', '一', '请',
  '这', '那', '其', '之', '着', '过', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '们', '要', '让', '被', '从', '向', '给', '到', '里',
  'の', 'を', 'に', 'は', 'が', 'で', 'と', 'も', 'へ', 'や', 'か', 'な', 'た', 'て', 'し', 'す', 'る', 'い', 'う', 'ます', 'です',
])

function contentWords(text: string): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const out = new Set<string>()
  const add = (word: string) => {
    if (!FUNCTION_WORDS.has(word) && !/^\p{N}+$/u.test(word)) out.add(word)
  }
  for (const token of found) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) for (const char of token) add(char)
    else add(token)
  }
  return out
}

/** Jaccard overlap of two messages' content words (0–1). Pure. */
export function contentSimilarity(left: string, right: string): number {
  const a = contentWords(left)
  const b = contentWords(right)
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** Whether a task (by its first message) is similar to the feedback task. Pure. */
export function isSimilarTask(feedbackTask: string, other: string): boolean {
  return contentSimilarity(feedbackTask, other) >= SIMILAR_CASE_MIN
}
