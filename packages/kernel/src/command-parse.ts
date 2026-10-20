/**
 * Shell-syntax command parsing (ADR 0022 decision 3). A small, dependency-free
 * lexer/parser that turns a script into its simple commands: quotes, escapes,
 * `;` `&&` `||` `|` `&` and newlines, `$( )`, backticks, `( )` subshells,
 * redirections and here-documents are understood, quoted text never counts as
 * syntax, and wrappers (`sh -c`, `env`, `sudo`, `xargs`, `find -exec` ...) are
 * unwrapped recursively so every command that would actually run is listed.
 *
 * It is not a full shell: it never executes or expands anything beyond `~` and
 * the variables handed in through {@link ParseOptions.env}; whatever it cannot
 * resolve is marked `unresolved`. It exists to give the command policy and the
 * grant matcher one view of a script (`docs/spec/permissions.md` §命令策略).
 */

/** Quoting and separator rules to read a script with. */
export type ShellDialect = 'posix' | 'powershell'

/** One redirection of a simple command. */
export interface Redirect {
  /** File descriptor prefix (`2` in `2>file`), when written. */
  readonly fd?: string
  /** `>` `>>` `>|` `&>` `&>>` `>&` `<` `<<` `<<-` `<<<` `<&` `<>`. */
  readonly op: string
  /** Target word with quotes removed (here-document delimiter for `<<`). */
  readonly target: string
}

/** One command that would run, after wrappers are unwrapped. */
export interface SimpleCommand {
  /** The command and its arguments as written (quotes removed, known variables expanded), including git/npm global options. */
  readonly words: readonly string[]
  /** `words` with the program lower-cased to its basename and git / npm / pnpm / yarn global options removed. */
  readonly core: readonly string[]
  /** Parallel to `words`: the word contains an expansion that could not be resolved. */
  readonly unresolved: readonly boolean[]
  /** `NAME=value` assignments that prefix the command. */
  readonly assignments: readonly string[]
  readonly redirects: readonly Redirect[]
  /** Global options removed from `core` (`-C`, `.`, `-c`, `k=v` ...), as written. */
  readonly globalOptions: readonly string[]
  /** The words of the `sudo` / `doas` / `su` ... command this one runs under, when it is privileged. */
  readonly privilegeWords?: readonly string[]
  /** More arguments are added at run time (`xargs`, `find -exec`). */
  readonly dynamicArgs?: boolean
  /** Paths a wrapper such as `find` hands to this command. */
  readonly extraTargets?: readonly string[]
  /** Wrappers this command was unwrapped from, outermost first (`sh`, `env`, ...). */
  readonly wrappers: readonly string[]
  /** Subshell nesting path; `cd` affects later commands whose path starts with its own. */
  readonly scope: readonly number[]
  readonly dialect: ShellDialect
}

/** Result of {@link parseScript}. */
export interface ParsedScript {
  /** Every command that would run, in source order (nested ones included). Redirect-only commands have empty `words`. */
  readonly commands: readonly SimpleCommand[]
  /** The script has an unterminated quote / substitution or nests too deeply; treat the result as unreliable. */
  readonly incomplete: boolean
  /** Variables the script assigns itself that were expanded (see {@link ParseOptions.scriptVariables}). */
  readonly scriptVariables?: readonly string[]
}

/** What the parser may expand. */
export interface ParseOptions {
  readonly dialect?: ShellDialect
  /** Known variables (`TMPDIR`, ...). Unlisted ones stay unresolved. PowerShell looks names up case-insensitively. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Replaces `~`, `$HOME`, `${HOME}`, `$env:USERPROFILE`. */
  readonly home?: string
  /**
   * POSIX only: expand a variable the script itself assigns (`d="$TMPDIR/x"; rm -rf "$d"`) after its
   * assignment, with the assigned text (`value`) or with the empty string (`empty`, what it holds when
   * the assignment did not run). Only a top-level `NAME=value` with a fully known value, written once,
   * in a script with no other way to change variables (`read`, `for NAME`, `eval`, `source`, `${NAME:=}`
   * ...), qualifies. Default `off`.
   */
  readonly scriptVariables?: 'off' | 'value' | 'empty'
}

/** Stand-in for text that came from a substitution. */
export const UNKNOWN_TEXT = '\uFFFC'

const MAX_DEPTH = 10

// ---------------------------------------------------------------------------
// Words

/** Program name: basename, lower-cased, without `.exe`. */
export function programOf(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word
  return base.toLowerCase().replace(/\.exe$/, '')
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~-]+$/

/** Quote one word so that {@link lexWords} reads it back unchanged. */
export function quoteWord(word: string): string {
  if (word !== '' && SAFE_WORD.test(word)) return word
  return `'${word.replaceAll("'", "'\\''")}'`
}

/** Quote and join words. */
export function quoteWords(words: readonly string[]): string {
  return words.map(quoteWord).join(' ')
}

/** Words of the first simple command of `text` (POSIX quoting, nothing unwrapped or expanded). */
export function lexWords(text: string): string[] {
  const ctx = newContext({ dialect: 'posix' }, false)
  new Parser(text, ctx, []).parseList(null)
  return ctx.raw[0]?.words ?? []
}

// ---------------------------------------------------------------------------
// Parser

interface RawCommand {
  words: string[]
  unresolved: boolean[]
  assignments: string[]
  /** Parallel to `assignments`: the value had an expansion that could not be resolved, and where the word ends. */
  assignmentInfo: { unresolved: boolean; end: number }[]
  redirects: Redirect[]
  scope: number[]
}

interface Context {
  dialect: ShellDialect
  readonly env: ReadonlyMap<string, string>
  readonly home: string | undefined
  readonly sink: SimpleCommand[]
  readonly raw: RawCommand[]
  readonly normalizeSink: boolean
  counter: number
  depth: number
  incomplete: boolean
  /** Script variables expanded in the top-level source `src` once the parser is past `after`. */
  locals?: { readonly src: string; readonly values: ReadonlyMap<string, { readonly value: string; readonly after: number }> }
}

function newContext(options: ParseOptions, normalizeSink: boolean): Context {
  const dialect = options.dialect ?? 'posix'
  const env = new Map<string, string>()
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env.set(dialect === 'powershell' ? key.toLowerCase() : key, value)
  }
  return { dialect, env, home: options.home, sink: [], raw: [], normalizeSink, counter: 0, depth: 0, incomplete: false }
}

const RESERVED_SKIP = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'esac', 'function'])
const RESERVED_DISCARD = new Set(['for', 'case', 'select'])

class Parser {
  pos = 0
  private readonly heredocs: { delimiter: string; strip: boolean; quoted: boolean }[] = []

  constructor(
    private readonly src: string,
    private readonly ctx: Context,
    private scope: number[],
  ) {}

  private get ps(): boolean {
    return this.ctx.dialect === 'powershell'
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? ''
  }

  private eof(): boolean {
    return this.pos >= this.src.length
  }

  /** Parse commands until the closer (`)` / `}`), or the end when `closer` is null. */
  parseList(closer: ')' | '}' | null): void {
    while (!this.eof()) {
      const c = this.peek()
      if (c === '\n') {
        this.pos += 1
        if (this.heredocs.length > 0) this.readHeredocBodies()
      } else if (c === ' ' || c === '\t' || c === '\r' || c === ';' || c === '|' || c === '&') {
        this.pos += 1
      } else if (c === '#') {
        this.skipComment()
      } else if (c === ')' || (this.ps && c === '}')) {
        this.pos += 1
        if (c === closer) return
        // A stray closer (case pattern `a)`) is skipped.
      } else {
        this.parseCommand()
      }
    }
    if (closer !== null) this.ctx.incomplete = true
  }

  private skipComment(): void {
    while (!this.eof() && this.peek() !== '\n') this.pos += 1
  }

  private nested(closer: ')' | '}'): void {
    const saved = this.scope
    this.scope = [...saved, ++this.ctx.counter]
    this.ctx.depth += 1
    if (this.ctx.depth > MAX_DEPTH) {
      this.ctx.incomplete = true
      this.pos = this.src.length
    } else {
      this.parseList(closer)
    }
    this.ctx.depth -= 1
    this.scope = saved
  }

  private parseCommand(): void {
    const words: string[] = []
    const unresolved: boolean[] = []
    const assignments: string[] = []
    const assignmentInfo: { unresolved: boolean; end: number }[] = []
    const redirects: Redirect[] = []
    let discard = false
    for (;;) {
      this.skipBlanks()
      if (this.eof()) break
      const c = this.peek()
      if (c === '\n' || c === ';' || c === '|') break
      if (c === '&' && this.peek(1) !== '>') break
      if (c === '#') break
      if (c === ')' || (this.ps && c === '}')) break
      if (c === '(' || (this.ps && c === '{')) {
        const closer = c === '(' ? ')' : '}'
        this.pos += 1
        if (!this.ps && words.length > 0) {
          // `name() { ... }`: a function definition, not a command.
          let probe = this.pos
          while (this.src[probe] === ' ' || this.src[probe] === '\t') probe += 1
          if (this.src[probe] === ')') {
            this.pos = probe + 1
            words.length = 0
            unresolved.length = 0
            continue
          }
        }
        this.nested(closer)
        if (words.length > 0 || assignments.length > 0) {
          words.push(UNKNOWN_TEXT)
          unresolved.push(true)
        }
        continue
      }
      if (!this.ps && (c === '<' || c === '>') && this.peek(1) === '(') {
        this.pos += 2
        this.nested(')')
        words.push(UNKNOWN_TEXT)
        unresolved.push(true)
        continue
      }
      if (this.atRedirect()) {
        redirects.push(this.readRedirect())
        continue
      }
      const start = this.pos
      const word = this.readWord()
      const raw = this.src.slice(start, this.pos)
      if (words.length === 0 && !this.ps) {
        if (raw === word.text && RESERVED_SKIP.has(word.text)) continue
        if (raw === word.text && RESERVED_DISCARD.has(word.text) && assignments.length === 0) discard = true
        if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(raw)) {
          assignments.push(word.text)
          assignmentInfo.push({ unresolved: word.unresolved, end: this.pos })
          continue
        }
      }
      words.push(word.text)
      unresolved.push(word.unresolved)
    }
    if (discard) return
    if (words.length > 0 || assignments.length > 0 || redirects.length > 0) {
      const command: RawCommand = { words, unresolved, assignments, assignmentInfo, redirects, scope: this.scope }
      this.ctx.raw.push(command)
      if (this.ctx.normalizeSink) normalize(command, this.ctx, { wrappers: [] })
    }
  }

  private skipBlanks(): void {
    for (;;) {
      const c = this.peek()
      if (c === ' ' || c === '\t' || c === '\r') this.pos += 1
      else if (!this.ps && c === '\\' && this.peek(1) === '\n') this.pos += 2
      else if (this.ps && c === '`' && this.peek(1) === '\n') this.pos += 2
      else return
    }
  }

  private atRedirect(): boolean {
    const c = this.peek()
    if (c === '<' || c === '>') return true
    if (c === '&' && this.peek(1) === '>') return true
    if (this.ps && c === '*' && this.peek(1) === '>') return true
    if (/[0-9]/.test(c)) {
      let i = this.pos
      while (/[0-9]/.test(this.src[i] ?? '')) i += 1
      return this.src[i] === '>' || (!this.ps && this.src[i] === '<')
    }
    return false
  }

  private readRedirect(): Redirect {
    let fd: string | undefined
    const c = this.peek()
    if (/[0-9]/.test(c)) {
      const start = this.pos
      while (/[0-9]/.test(this.peek())) this.pos += 1
      fd = this.src.slice(start, this.pos)
    } else if (c === '*') {
      fd = '*'
      this.pos += 1
    }
    let op: string
    const first = this.peek()
    if (first === '&') {
      op = '&>'
      this.pos += 2
      if (this.peek() === '>') {
        op = '&>>'
        this.pos += 1
      }
    } else if (first === '>') {
      op = '>'
      this.pos += 1
      const next = this.peek()
      if (next === '>') {
        op = '>>'
        this.pos += 1
      } else if (next === '&') {
        op = '>&'
        this.pos += 1
      } else if (next === '|') {
        op = '>|'
        this.pos += 1
      }
    } else {
      op = '<'
      this.pos += 1
      const next = this.peek()
      if (next === '<') {
        this.pos += 1
        if (this.peek() === '<') {
          op = '<<<'
          this.pos += 1
        } else if (this.peek() === '-') {
          op = '<<-'
          this.pos += 1
        } else {
          op = '<<'
        }
      } else if (next === '&') {
        op = '<&'
        this.pos += 1
      } else if (next === '>') {
        op = '<>'
        this.pos += 1
      }
    }
    this.skipBlanks()
    let target = ''
    if (!this.eof() && !'\n;|)'.includes(this.peek())) {
      const start = this.pos
      const word = this.readWord()
      target = word.text
      if (op === '<<' || op === '<<-') {
        this.heredocs.push({ delimiter: word.text, strip: op === '<<-', quoted: /['"\\]/.test(this.src.slice(start, this.pos)) })
      }
    }
    return { ...(fd === undefined ? {} : { fd }), op, target }
  }

  private readHeredocBodies(): void {
    const pending = this.heredocs.splice(0)
    for (const doc of pending) {
      let body = ''
      while (!this.eof()) {
        let end = this.src.indexOf('\n', this.pos)
        const last = end < 0
        if (last) end = this.src.length
        const line = this.src.slice(this.pos, end)
        this.pos = last ? end : end + 1
        const compare = (doc.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '')
        if (compare === doc.delimiter) break
        body += `${line}\n`
      }
      if (!doc.quoted && body !== '') new Parser(body, this.ctx, this.scope).scanExpansions()
    }
  }

  /** Walk a here-document body (double-quote semantics), parsing the commands its substitutions run. */
  scanExpansions(): void {
    while (!this.eof()) {
      const c = this.peek()
      if (c === '\\') this.pos += 2
      else if (c === '$' || c === '`') this.expansion(true)
      else this.pos += 1
    }
  }

  private isBreak(c: string): boolean {
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return true
    return this.ps ? '|;&>(){}'.includes(c) : '|&;<>()'.includes(c)
  }

  private readWord(): { text: string; unresolved: boolean } {
    let text = ''
    let unresolved = false
    const start = this.pos
    while (!this.eof()) {
      const c = this.peek()
      if (this.isBreak(c)) break
      if (c === '\\' && !this.ps) {
        const next = this.peek(1)
        if (next === '\n') {
          this.pos += 2
        } else if (next === '') {
          text += '\\'
          this.pos += 1
        } else {
          text += next
          this.pos += 2
        }
      } else if (c === '`' && this.ps) {
        const next = this.peek(1)
        if (next !== '\n') text += next
        this.pos += 2
      } else if (c === "'") {
        text += this.singleQuoted()
      } else if (c === '"') {
        const part = this.doubleQuoted()
        text += part.text
        unresolved ||= part.unresolved
      } else if (c === '$' || (c === '`' && !this.ps)) {
        const part = this.expansion(false)
        text += part.text
        unresolved ||= part.unresolved
      } else if (c === '~' && this.pos === start && this.ctx.home !== undefined) {
        const next = this.peek(1)
        text += next === '' || next === '/' || (this.ps && next === '\\') || this.isBreak(next) ? this.ctx.home : c
        this.pos += 1
      } else {
        text += c
        this.pos += 1
      }
    }
    return { text, unresolved }
  }

  private singleQuoted(): string {
    this.pos += 1
    let out = ''
    for (;;) {
      if (this.eof()) {
        this.ctx.incomplete = true
        return out
      }
      const c = this.peek()
      if (c === "'") {
        if (this.ps && this.peek(1) === "'") {
          out += "'"
          this.pos += 2
          continue
        }
        this.pos += 1
        return out
      }
      out += c
      this.pos += 1
    }
  }

  private doubleQuoted(): { text: string; unresolved: boolean } {
    this.pos += 1
    let text = ''
    let unresolved = false
    for (;;) {
      if (this.eof()) {
        this.ctx.incomplete = true
        return { text, unresolved }
      }
      const c = this.peek()
      if (c === '"') {
        if (this.ps && this.peek(1) === '"') {
          text += '"'
          this.pos += 2
          continue
        }
        this.pos += 1
        return { text, unresolved }
      }
      if (c === '\\' && !this.ps) {
        const next = this.peek(1)
        if (next === '\n') {
          this.pos += 2
        } else if (next !== '' && '$`"\\'.includes(next)) {
          text += next
          this.pos += 2
        } else {
          text += c
          this.pos += 1
        }
      } else if (c === '`' && this.ps) {
        text += this.peek(1)
        this.pos += 2
      } else if (c === '$' || (c === '`' && !this.ps)) {
        const part = this.expansion(true)
        text += part.text
        unresolved ||= part.unresolved
      } else {
        text += c
        this.pos += 1
      }
    }
  }

  private lookup(name: string): string | undefined {
    const key = this.ps ? name.toLowerCase() : name
    const fromEnv = this.ctx.env.get(key)
    if (fromEnv !== undefined) return fromEnv
    const locals = this.ctx.locals
    if (locals !== undefined && !this.ps && this.src === locals.src) {
      const local = locals.values.get(name)
      if (local !== undefined && this.pos >= local.after) return local.value
    }
    if (this.ctx.home !== undefined && (name === 'HOME' || (this.ps && (key === 'home' || key === 'userprofile')))) return this.ctx.home
    return undefined
  }

  /** At `$` or a backtick: read the expansion and return the text it contributes. */
  private expansion(inDouble: boolean): { text: string; unresolved: boolean } {
    if (this.peek() === '`') {
      this.pos += 1
      let inner = ''
      for (;;) {
        if (this.eof()) {
          this.ctx.incomplete = true
          break
        }
        const d = this.peek()
        if (d === '`') {
          this.pos += 1
          break
        }
        if (d === '\\' && this.peek(1) !== '' && '`\\$'.includes(this.peek(1))) {
          inner += this.peek(1)
          this.pos += 2
        } else {
          inner += d
          this.pos += 1
        }
      }
      this.parseNested(inner)
      return { text: UNKNOWN_TEXT, unresolved: true }
    }
    const next = this.peek(1)
    if (next === '(') {
      if (this.peek(2) === '(') {
        // Arithmetic `$(( ))`: skip to the matching `))`.
        let depth = 0
        let i = this.pos + 1
        for (; i < this.src.length; i += 1) {
          if (this.src[i] === '(') depth += 1
          else if (this.src[i] === ')') {
            depth -= 1
            if (depth === 0) break
          }
        }
        if (i >= this.src.length) this.ctx.incomplete = true
        this.pos = Math.min(i + 1, this.src.length)
        return { text: UNKNOWN_TEXT, unresolved: true }
      }
      this.pos += 2
      this.nested(')')
      return { text: UNKNOWN_TEXT, unresolved: true }
    }
    if (next === '{') {
      const close = this.src.indexOf('}', this.pos + 2)
      if (close < 0) {
        this.ctx.incomplete = true
        this.pos = this.src.length
        return { text: UNKNOWN_TEXT, unresolved: true }
      }
      const body = this.src.slice(this.pos + 2, close)
      this.pos = close + 1
      const simple = /^(?:env:)?[A-Za-z_][A-Za-z0-9_]*$/i.test(body)
      const value = simple ? this.lookup(body.replace(/^env:/i, '')) : undefined
      return value === undefined ? { text: `\${${body}}`, unresolved: true } : { text: value, unresolved: false }
    }
    if (!inDouble && !this.ps && next === "'") {
      this.pos += 1
      return { text: this.ansiQuoted(), unresolved: false }
    }
    if (!inDouble && !this.ps && next === '"') {
      this.pos += 1
      return this.doubleQuoted()
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos + 1, this.pos + 200))
    if (name !== null) {
      this.pos += 1 + name[0].length
      if (this.ps && name[0].toLowerCase() === 'env' && this.peek() === ':') {
        const rest = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(this.src.slice(this.pos, this.pos + 200))
        if (rest !== null) {
          this.pos += rest[0].length
          const value = this.lookup(rest[1]!)
          return value === undefined ? { text: `$env:${rest[1]}`, unresolved: true } : { text: value, unresolved: false }
        }
      }
      const value = this.lookup(name[0])
      return value === undefined ? { text: `$${name[0]}`, unresolved: true } : { text: value, unresolved: false }
    }
    if (next !== '' && /[0-9?$!#@*-]/.test(next)) {
      this.pos += 2
      return { text: `$${next}`, unresolved: true }
    }
    this.pos += 1
    return { text: '$', unresolved: false }
  }

  private ansiQuoted(): string {
    this.pos += 1
    let out = ''
    for (;;) {
      if (this.eof()) {
        this.ctx.incomplete = true
        return out
      }
      const c = this.peek()
      if (c === "'") {
        this.pos += 1
        return out
      }
      if (c === '\\' && this.peek(1) !== '') {
        const next = this.peek(1)
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        this.pos += 2
      } else {
        out += c
        this.pos += 1
      }
    }
  }

  private parseNested(text: string): void {
    parseText(text, this.ctx, this.scope, this.ctx.dialect)
  }
}

// ---------------------------------------------------------------------------
// Unwrapping

interface Via {
  wrappers: string[]
  privilege?: readonly string[]
  dynamicArgs?: boolean
  extraTargets?: readonly string[]
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])
const POWERSHELLS = new Set(['pwsh', 'powershell'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function parseText(text: string, ctx: Context, scope: readonly number[], dialect: ShellDialect): void {
  ctx.depth += 1
  if (ctx.depth > MAX_DEPTH) {
    ctx.incomplete = true
  } else {
    const saved = ctx.dialect
    ctx.dialect = dialect
    new Parser(text, ctx, [...scope, ++ctx.counter]).parseList(null)
    ctx.dialect = saved
  }
  ctx.depth -= 1
}

function leaf(raw: RawCommand, ctx: Context, via: Via, words: readonly string[], unresolved: readonly boolean[], extra: Partial<SimpleCommand> = {}): void {
  const { core, globalOptions } = normalizeWords(words)
  ctx.sink.push({
    words,
    core,
    unresolved,
    assignments: raw.assignments,
    redirects: raw.redirects,
    globalOptions,
    ...(via.privilege === undefined ? {} : { privilegeWords: via.privilege }),
    ...(via.dynamicArgs === true ? { dynamicArgs: true } : {}),
    ...(via.extraTargets === undefined ? {} : { extraTargets: via.extraTargets }),
    wrappers: via.wrappers,
    scope: raw.scope,
    dialect: ctx.dialect,
    ...extra,
  })
}

/** Keep the redirects / assignments of a wrapper whose command was unwrapped into nested text. */
function carry(raw: RawCommand, ctx: Context, via: Via): void {
  if (raw.redirects.length > 0 || raw.assignments.length > 0) leaf(raw, ctx, via, [], [])
}

function skipOptions(words: readonly string[], index: number, withValue: ReadonlySet<string>): number {
  let i = index
  while (i < words.length) {
    const w = words[i]!
    if (w === '--') return i + 1
    if (!w.startsWith('-') || w === '-') return i
    i += withValue.has(w) ? 2 : 1
  }
  return i
}

const NONE: ReadonlySet<string> = new Set()
const ENV_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])
const SUDO_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-D', '-U', '-T', '--user', '--group', '--host', '--prompt', '--close-from', '--role', '--type', '--chdir', '--other-user'])
const DOAS_VALUE = new Set(['-u', '-C'])
const XARGS_VALUE = new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars'])
const TIMEOUT_VALUE = new Set(['-s', '-k', '--signal', '--kill-after'])
const NICE_VALUE = new Set(['-n', '--adjustment'])
const IONICE_VALUE = new Set(['-c', '-n', '-p', '-t'])
const EXEC_VALUE = new Set(['-a'])
const STDBUF_VALUE = new Set(['-i', '-o', '-e', '--input', '--output', '--error'])

function normalize(raw: RawCommand, ctx: Context, via: Via): void {
  const { words, unresolved } = raw
  if (words.length === 0) {
    leaf(raw, ctx, via, [], [])
    return
  }
  const name = programOf(words[0]!)
  const wrapped = (extra: Partial<Via> = {}): Via => ({ ...via, ...extra, wrappers: [...via.wrappers, name] })
  const sub = (from: number, extra: Partial<Via> = {}): void => {
    normalize({ ...raw, words: words.slice(from), unresolved: unresolved.slice(from) }, ctx, wrapped(extra))
  }
  const privileged = via.privilege ?? words

  if (SHELLS.has(name)) {
    const idx = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w))
    if (idx > 0 && words[idx + 1] !== undefined) {
      parseText(words[idx + 1]!, ctx, raw.scope, 'posix')
      if (unresolved[idx + 1] === true) leaf(raw, ctx, via, words, unresolved)
      else carry(raw, ctx, wrapped())
      return
    }
  }
  if (POWERSHELLS.has(name) || name === 'cmd') {
    const idx = words.findIndex((w, i) => i > 0 && (name === 'cmd' ? /^\/[ck]$/i.test(w) : /^-c(o(m(m(a(nd?)?)?)?)?)?$/i.test(w)))
    if (idx > 0 && words[idx + 1] !== undefined) {
      parseText(words.slice(idx + 1).join(' '), ctx, raw.scope, 'powershell')
      if (unresolved.slice(idx + 1).some(Boolean)) leaf(raw, ctx, via, words, unresolved)
      else carry(raw, ctx, wrapped())
      return
    }
  }

  switch (name) {
    case 'env': {
      let i = 1
      for (;;) {
        i = skipOptions(words, i, ENV_VALUE)
        if (i < words.length && ASSIGNMENT.test(words[i]!)) i += 1
        else break
      }
      if (i >= words.length) break
      sub(i)
      return
    }
    case 'nohup':
    case 'setsid':
    case 'builtin':
    case 'time':
    case 'nice':
    case 'ionice':
    case 'stdbuf':
    case 'exec':
    case 'command': {
      if (name === 'command' && words.slice(1).some(w => /^-[a-zA-Z]*[vV]/.test(w))) return carry(raw, ctx, via)
      const table = name === 'nice' ? NICE_VALUE : name === 'ionice' ? IONICE_VALUE : name === 'stdbuf' ? STDBUF_VALUE : name === 'exec' ? EXEC_VALUE : NONE
      const i = skipOptions(words, 1, table)
      if (i >= words.length) break
      sub(i)
      return
    }
    case 'timeout': {
      const i = skipOptions(words, 1, TIMEOUT_VALUE) + 1 // + the duration
      if (i >= words.length) break
      sub(i)
      return
    }
    case 'xargs': {
      const i = skipOptions(words, 1, XARGS_VALUE)
      if (i >= words.length) {
        leaf(raw, ctx, wrapped({ dynamicArgs: true }), ['echo'], [false])
        return
      }
      sub(i, { dynamicArgs: true })
      return
    }
    case 'sudo':
    case 'doas':
    case 'gsudo':
    case 'pkexec': {
      let j = skipOptions(words, 1, name === 'doas' ? DOAS_VALUE : SUDO_VALUE)
      while (j < words.length && ASSIGNMENT.test(words[j]!)) j += 1
      if (j >= words.length) {
        leaf(raw, ctx, { ...via, privilege: privileged }, words, unresolved)
        return
      }
      sub(j, { privilege: privileged })
      return
    }
    case 'su': {
      const idx = words.findIndex((w, i) => i > 0 && /^(-c|--command(=.*)?)$/.test(w))
      if (idx > 0 && words[idx + 1] !== undefined) parseText(words[idx + 1]!, ctx, raw.scope, 'posix')
      leaf(raw, ctx, { ...via, privilege: privileged }, words, unresolved)
      return
    }
    case 'runas': {
      leaf(raw, ctx, { ...via, privilege: privileged }, words, unresolved)
      return
    }
    case 'eval': {
      if (words.length > 1 && ctx.dialect === 'posix') parseText(words.slice(1).join(' '), ctx, raw.scope, 'posix')
      break
    }
    case 'find': {
      const starts: string[] = []
      let i = 1
      while (i < words.length && /^-[HLPD]/.test(words[i]!)) i += words[i] === '-D' ? 2 : 1
      while (i < words.length && !/^(-|\(|!)/.test(words[i]!)) starts.push(words[i++]!)
      const roots = starts.length > 0 ? starts : ['.']
      for (let k = i; k < words.length; k += 1) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(words[k]!)) continue
        let end = k + 1
        while (end < words.length && words[end] !== ';' && words[end] !== '+') end += 1
        if (end > k + 1) {
          normalize(
            { ...raw, words: words.slice(k + 1, end), unresolved: unresolved.slice(k + 1, end) },
            ctx,
            { ...via, wrappers: [...via.wrappers, 'find'], dynamicArgs: true, extraTargets: roots },
          )
        }
        k = end
      }
      break
    }
    default:
  }
  leaf(raw, ctx, via, words, unresolved)
}

// Global option tables for tools whose subcommand follows them.
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])
const NPM_VALUE = new Set(['--prefix', '--workspace', '-w', '--cache', '--userconfig', '--globalconfig', '--registry', '--loglevel', '--tag', '--otp', '--scope', '--location', '--include', '--omit', '--tmp'])
const PNPM_VALUE = new Set(['-C', '--dir', '--filter', '-F', '--filter-prod', '--workspace-concurrency', '--reporter', '--loglevel', '--registry', '--store-dir', '--virtual-store-dir', '--modules-dir', '--lockfile-dir', '--use-node-version'])
const YARN_VALUE = new Set(['--cwd', '--mutex', '--registry', '--cache-folder', '--modules-folder', '--link-folder', '--global-folder', '--network-timeout', '--otp'])

/** `words` as `[program, subcommand, ...]` with global options stripped for git / npm / pnpm / yarn. */
function normalizeWords(words: readonly string[]): { core: string[]; globalOptions: string[] } {
  if (words.length === 0) return { core: [], globalOptions: [] }
  const program = programOf(words[0]!)
  const table = program === 'git' ? GIT_VALUE : program === 'npm' ? NPM_VALUE : program === 'pnpm' ? PNPM_VALUE : program === 'yarn' ? YARN_VALUE : undefined
  if (table === undefined) return { core: [program, ...words.slice(1)], globalOptions: [] }
  const removed: string[] = []
  let i = 1
  while (i < words.length) {
    const w = words[i]!
    if (!w.startsWith('-') || w === '-') break
    const length = table.has(w) ? 2 : 1
    removed.push(...words.slice(i, i + length))
    i += length
  }
  let rest = words.slice(i)
  if (program === 'yarn' && rest[0] === 'workspace' && rest.length > 2) {
    removed.push(...rest.slice(0, 2))
    rest = rest.slice(2)
  }
  if (program === 'pnpm' && ['recursive', 'multi', 'm'].includes(rest[0] ?? '') && rest.length > 1) {
    removed.push(rest[0]!)
    rest = rest.slice(1)
  }
  return { core: [program, ...rest], globalOptions: removed }
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Parse a script into the simple commands it would run. Never throws; a script
 * it cannot fully read sets `incomplete`.
 */
export function parseScript(script: string, options: ParseOptions = {}): ParsedScript {
  const ctx = newContext(options, true)
  const mode = options.scriptVariables ?? 'off'
  if (mode !== 'off' && (options.dialect ?? 'posix') === 'posix') {
    const values = scriptVariables(script, options)
    if (values.size > 0) {
      ctx.locals = { src: script, values: mode === 'value' ? values : new Map([...values].map(([name, local]) => [name, { ...local, value: '' }])) }
    }
  }
  new Parser(script, ctx, []).parseList(null)
  return { commands: ctx.sink, incomplete: ctx.incomplete, ...(ctx.locals === undefined ? {} : { scriptVariables: [...ctx.locals.values.keys()] }) }
}

/** Anything that changes a variable other than a plain `NAME=value`. */
const OTHER_ASSIGNMENT = /\b(eval|source|read|getopts|unset|declare|typeset|local|readonly|mapfile|readarray|let|alias)\b|\bprintf\s[^;&|\n]*-v|\(\(|\$\{[A-Za-z_][A-Za-z0-9_]*:?[=?]|(^|[\s;&|(])\.\s/
/** Variables the shell sets itself or that change where commands run. */
const SHELL_VARIABLES = new Set(['HOME', 'PWD', 'OLDPWD', 'PATH', 'IFS', 'CDPATH', 'ENV', 'BASH_ENV', 'SHELLOPTS', 'TMPDIR', 'TMP', 'TEMP'])

/** The script's own variables that {@link ParseOptions.scriptVariables} may expand, with their values. */
function scriptVariables(script: string, options: ParseOptions): Map<string, { value: string; after: number }> {
  const values = new Map<string, { value: string; after: number }>()
  if (OTHER_ASSIGNMENT.test(script)) return values
  const ctx = newContext(options, false)
  new Parser(script, ctx, []).parseList(null)
  if (ctx.incomplete) return values
  for (const raw of ctx.raw) {
    // Only commands that are assignments alone persist; `NAME=v cmd` sets NAME for cmd only.
    if (raw.words.length > 0 || raw.scope.length > 0) continue
    raw.assignments.forEach((text, index) => {
      const info = raw.assignmentInfo[index]!
      const eq = text.indexOf('=')
      const name = text.slice(0, eq)
      const value = text.slice(eq + 1)
      if (text[eq - 1] === '+' || info.unresolved || value.includes(UNKNOWN_TEXT) || /[\s~*?[]/.test(value) || SHELL_VARIABLES.has(name) || ctx.env.has(name)) return
      const written = script.match(new RegExp(`(?:^|[^A-Za-z0-9_$-])${name}\\+?=`, 'g'))?.length ?? 0
      if (written !== 1 || new RegExp(`\\b(for|select)\\s+${name}\\b`).test(script)) return
      values.set(name, { value, after: info.end })
    })
  }
  return values
}
