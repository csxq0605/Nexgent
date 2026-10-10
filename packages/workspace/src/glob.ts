/**
 * A small glob matcher for policy patterns, approval grants and the search
 * tools. Paths are `/`-separated and relative.
 *
 * Supported syntax: `**` (any depth, including none when written as a whole
 * segment), `*` and `?` (within a segment), `[...]` classes and `{a,b}`.
 * A pattern without `/` matches the basename of any path as well as the
 * whole path, gitignore style.
 */

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/** Compile a glob into an anchored regular expression. */
export function globToRegExp(pattern: string, ignoreCase = false): RegExp {
  let source = ''
  let braceDepth = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const atSegmentStart = i === 0 || pattern[i - 1] === '/'
        const next = pattern[i + 2]
        i++
        if (atSegmentStart && next === '/') {
          source += '(?:.*/)?'
          i++
        } else if (atSegmentStart && next === undefined && source.endsWith('/')) {
          source = `${source.slice(0, -1)}(?:/.*)?`
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) {
        source += '\\['
      } else {
        let body = pattern.slice(i + 1, close)
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        source += `[${body.replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else if (char === '{') {
      braceDepth++
      source += '(?:'
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--
      source += ')'
    } else if (char === ',' && braceDepth > 0) {
      source += '|'
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '')
}

/** Whether a relative `/`-separated path matches a glob (see module docs). */
export function matchGlob(pattern: string, path: string, ignoreCase = false): boolean {
  const regexp = globToRegExp(pattern, ignoreCase)
  if (regexp.test(path)) return true
  if (pattern.includes('/')) return false
  const base = path.slice(path.lastIndexOf('/') + 1)
  return regexp.test(base)
}
