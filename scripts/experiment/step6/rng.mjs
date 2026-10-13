// @ts-check
/**
 * Seeded randomness for the step-6 experiment scripts (generators, feedback
 * template choice, bootstrap). Same seed text, same sequence, on every platform.
 *
 * Linux, macOS and Windows; no dependencies.
 */

/**
 * A mulberry32 generator seeded from text.
 * @param {string | number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function rng(seed) {
  let state = 0
  for (const char of String(seed)) state = (Math.imul(state, 31) + char.charCodeAt(0)) >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Helpers bound to one generator.
 * @param {string | number} seed
 */
export function picker(seed) {
  const next = rng(seed)
  return {
    next,
    /** @param {number} lo @param {number} hi inclusive */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** @template T @param {readonly T[]} list @returns {T} */
    pick: list => list[Math.floor(next() * list.length)],
    /** Fisher–Yates on a copy. @template T @param {readonly T[]} list @returns {T[]} */
    shuffle: list => {
      const out = [...list]
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
}
