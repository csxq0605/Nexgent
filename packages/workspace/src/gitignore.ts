/**
 * A `.gitignore` matcher without dependencies. Sources, lowest priority
 * first: `.git/info/exclude`, the root `.gitignore`, then each nested
 * `.gitignore` (its patterns apply below its own directory). Within one
 * source the last matching pattern wins, a deeper source beats a shallower
 * one, and a file under an ignored directory cannot be re-included (the
 * directory is never entered; {@link GitignoreMatcher.isIgnored} checks every
 * ancestor).
 *
 * Syntax: blank and `#` lines, `\#` / `\!` escapes, `!` negation, a leading
 * `/` or a `/` inside the pattern anchors it to the `.gitignore`'s
 * directory, a trailing `/` matches directories only, `*`, `?`, `[...]`
 * (`!` or `^` negates), and `**` as a leading,
 * inner or trailing whole path segment. Trailing spaces are dropped unless escaped. Matching is
 * case-sensitive, except on Windows (as git's `core.ignorecase` default).
 *
 * `.git/`, `node_modules/` (any depth) and the root `.nexgent/` are always
 * skipped by the walkers, whatever the rules say ({@link isAlwaysSkipped}).
 */
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'

/** Whether a project-relative portable path lies in `.nexgent/` (case-insensitive on Windows and macOS). */
function isInDataDir(portable: string): boolean {
  const first = portable.split('/')[0] ?? ''
  return process.platform === 'win32' || process.platform === 'darwin' ? first.toLowerCase() === '.nexgent' : first === '.nexgent'
}

/** One parsed pattern line. */
export interface IgnoreRule {
  readonly negated: boolean
  readonly dirOnly: boolean
  /** Matched against the basename (no `/` in the pattern) or the path below the rule's base directory. */
  readonly basenameOnly: boolean
  readonly regex: RegExp
}

const CASE_FLAG = process.platform === 'win32' ? 'i' : ''

/** Directory names skipped at any depth, whatever the rules say. */
export const ALWAYS_SKIPPED_DIRS: readonly string[] = ['node_modules', '.git']

/** Whether an entry is never walked: `.git` / `node_modules` at any depth, `.nexgent` at the root. */
export function isAlwaysSkipped(name: string, atRoot: boolean): boolean {
  const lower = process.platform === 'win32' ? name.toLowerCase() : name
  return ALWAYS_SKIPPED_DIRS.includes(lower) || (atRoot && isInDataDir(name))
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char
}

/** Translate a glob (one pattern body, no leading `/` or trailing `/`) to a regex source. */
function globToRegex(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        let end = i
        while (glob[end] === '*') end += 1
        const atStart = i === 0 || glob[i - 1] === '/'
        const next = glob[end]
        if (atStart && next === '/') {
          out += '(?:.*/)?' // `**/`: zero or more directories
          i = end + 1
          continue
        }
        if (atStart && next === undefined) {
          out += '.+' // trailing `/**` (or a bare `**`): everything inside
          i = end
          continue
        }
        out += '[^/]*' // `**` glued to other text acts like `*`
        i = end
        continue
      }
      out += '[^/]*'
      i += 1
    } else if (char === '?') {
      out += '[^/]'
      i += 1
    } else if (char === '[') {
      const closed = parseClass(glob, i)
      if (closed === undefined) {
        out += '\\['
        i += 1
      } else {
        out += closed.source
        i = closed.next
      }
    } else if (char === '\\') {
      const next = glob[i + 1]
      if (next === undefined) {
        out += '\\\\'
        i += 1
      } else {
        out += escapeRegex(next)
        i += 2
      }
    } else {
      out += escapeRegex(char)
      i += 1
    }
  }
  return out
}

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
}

/** Parse `[...]` starting at `start`; `undefined` when it never closes. */
function parseClass(glob: string, start: number): { source: string; next: number } | undefined {
  let i = start + 1
  let negated = false
  if (glob[i] === '!' || glob[i] === '^') {
    negated = true
    i += 1
  }
  let body = ''
  let first = true
  while (i < glob.length) {
    const char = glob[i]!
    if (char === ']' && !first) {
      if (body === '') return undefined
      return { source: `[${negated ? '^/' : ''}${body}]`, next: i + 1 }
    }
    first = false
    if (char === '[' && glob[i + 1] === ':') {
      const close = glob.indexOf(':]', i + 2)
      const known = close < 0 ? undefined : POSIX_CLASSES[glob.slice(i + 2, close)]
      if (known !== undefined) {
        body += known
        i = close + 2
        continue
      }
    }
    if (char === '\\' && i + 1 < glob.length) {
      body += `\\${glob[i + 1]!}`
      i += 2
      continue
    }
    body += char === '\\' || char === '^' || char === '[' || char === ']' ? `\\${char}` : char
    i += 1
  }
  return undefined
}

/** Parse the text of a `.gitignore` (or `info/exclude`) into rules, in file order. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split('\n')) {
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // Trailing spaces are ignored unless escaped with a backslash.
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1)
    if (line === '' || line.startsWith('#')) continue
    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }
    // `\#` and `\!` at the start are literal; the glob translation unescapes them.
    let dirOnly = false
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    if (line === '') continue
    rules.push({
      negated,
      dirOnly,
      basenameOnly: !anchored,
      regex: new RegExp(`^${globToRegex(line)}$`, CASE_FLAG),
    })
  }
  return rules
}

/** The rules of one `.gitignore` and the directory it applies below. */
interface Source {
  /** Portable directory of the file (`''` for the root). */
  readonly base: string
  readonly rules: readonly IgnoreRule[]
}

/**
 * Immutable chain of sources from the root down to one directory. A walker
 * holds one per directory and extends it with {@link IgnoreScope.child}.
 */
export class IgnoreScope {
  private constructor(private readonly sources: readonly Source[]) {}

  static readonly empty = new IgnoreScope([])

  /** The scope below this one for a directory that has `rules` (a `.gitignore` at `base`). */
  with(base: string, rules: readonly IgnoreRule[]): IgnoreScope {
    return rules.length === 0 ? this : new IgnoreScope([...this.sources, { base, rules }])
  }

  /** Whether `portable` (below the project root) is ignored by this scope; its ancestors are assumed not ignored. */
  ignores(portable: string, isDir: boolean): boolean {
    for (let s = this.sources.length - 1; s >= 0; s -= 1) {
      const source = this.sources[s]!
      let relative: string
      if (source.base === '') relative = portable
      else if (portable.startsWith(`${source.base}/`)) relative = portable.slice(source.base.length + 1)
      else continue
      const basename = relative.slice(relative.lastIndexOf('/') + 1)
      for (let r = source.rules.length - 1; r >= 0; r -= 1) {
        const rule = source.rules[r]!
        if (rule.dirOnly && !isDir) continue
        if (rule.regex.test(rule.basenameOnly ? basename : relative)) return !rule.negated
      }
    }
    return false
  }
}

/** Read and parse a rules file; missing or unreadable files have no rules. */
async function readRules(path: string): Promise<IgnoreRule[]> {
  try {
    return parseGitignore(await readFile(path, 'utf8'))
  } catch {
    return []
  }
}

/**
 * The scope of the project root: `.git/info/exclude` below the root
 * `.gitignore`. Walkers call {@link childScope} on entering a directory.
 */
export async function rootScope(root: string): Promise<IgnoreScope> {
  const exclude = await readRules(nodePath.join(root, '.git', 'info', 'exclude'))
  const rules = await readRules(nodePath.join(root, '.gitignore'))
  return IgnoreScope.empty.with('', exclude).with('', rules)
}

/** The scope inside directory `portable` (non-root): `parent` plus that directory's `.gitignore`. */
export async function childScope(root: string, parent: IgnoreScope, portable: string): Promise<IgnoreScope> {
  const rules = await readRules(nodePath.join(root, ...portable.split('/'), '.gitignore'))
  return parent.with(portable, rules)
}

/**
 * Path-at-a-time matcher for callers that do not walk: it loads and caches
 * the rule files of every ancestor directory and answers whether a path is
 * ignored, including through an ignored parent directory.
 */
export class GitignoreMatcher {
  private readonly scopes = new Map<string, Promise<IgnoreScope>>()

  constructor(private readonly root: string) {}

  /** Forget cached rule files (after a `.gitignore` changed). */
  reset(): void {
    this.scopes.clear()
  }

  private scopeOf(dir: string): Promise<IgnoreScope> {
    let scope = this.scopes.get(dir)
    if (scope === undefined) {
      scope = dir === ''
        ? rootScope(this.root)
        : this.scopeOf(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '').then(parent => childScope(this.root, parent, dir))
      this.scopes.set(dir, scope)
    }
    return scope
  }

  /**
   * Whether the project-relative `portable` path is ignored: skipped by
   * {@link isAlwaysSkipped} or by the rules, or inside an ignored directory.
   */
  async isIgnored(portable: string, isDir = false): Promise<boolean> {
    const segments = portable.split('/')
    let dir = ''
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i]!
      const last = i === segments.length - 1
      const path = dir === '' ? name : `${dir}/${name}`
      const entryIsDir = !last || isDir
      if (isAlwaysSkipped(name, dir === '') && (entryIsDir || (dir === '' && isInDataDir(name)))) return true
      if ((await this.scopeOf(dir)).ignores(path, entryIsDir)) return true
      dir = path
    }
    return false
  }
}
