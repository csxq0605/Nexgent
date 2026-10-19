/**
 * Command-shape rules (`docs/spec/permissions.md` §命令策略 形态黑名单 and
 * §工具审批 始终审批表), ADR 0022 decision 3. The script is parsed with the
 * kernel's shell parser (quotes, separators, `$( )`, `sh -c` / `env` / `xargs`
 * wrappers, git / npm / pnpm / yarn global options), every simple command that
 * would run is matched against the rules, and `~` / `$HOME` / `$TMPDIR` are
 * expanded before the delete-outside check. Quoted text never matches. This is
 * still not a security boundary (the system sandbox is); it hands high-risk
 * shapes to the user.
 */
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import {
  parseScript,
  programOf,
  quoteWords,
  UNKNOWN_TEXT,
  type ApprovalRisk,
  type ApprovalScope,
  type ShellDialect,
  type SimpleCommand,
} from '@nexgent/kernel'
import { isWithin, type PathFlavor, HOST_FLAVOR } from './paths.js'

/** Rule families from the spec tables. */
export type CommandRuleKind =
  | 'install'
  | 'publish'
  | 'delete-outside'
  | 'delete-project'
  | 'privilege'
  | 'download-exec'
  | 'system'
  | 'discard-changes'

/** One rule hit. */
export interface CommandMatch {
  readonly kind: CommandRuleKind
  /** `high` for the always-ask table, `medium` for the blacklist. */
  readonly risk: ApprovalRisk
  /** Always-ask hits ignore the sandbox mode and stored grants and only offer `once`. */
  readonly alwaysAsk: boolean
  /** What a `session` / `project` grant stores: the full word sequence of the simple command that triggered the ask, e.g. `git push origin main`. */
  readonly pattern: string
  /** The simple command that matched (same text as `pattern`); use it as the grant subject. */
  readonly segment: string
  /** Scopes that may be offered for this hit: only `once` for privilege, delete-outside, delete-project, download-exec and system. */
  readonly allowedScopes: readonly ApprovalScope[]
  /** Human-readable rule description. */
  readonly description: string
}

/** Where relative arguments resolve and what counts as the project. */
export interface CommandScope {
  readonly root: string
  readonly cwd: string
  readonly flavor?: PathFlavor
  readonly home?: string
  /** The session temp directory: deleting inside it is allowed, and `$TMPDIR` / `$TMP` / `$TEMP` expand to it. */
  readonly tempDir?: string
  /** Other directories the session may write (granted by the user): deleting inside them is allowed. */
  readonly writeRoots?: readonly string[]
  /** Extra variables to expand (`$NAME`). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Defaults from `flavor`: `win32` reads PowerShell, otherwise POSIX shell. */
  readonly dialect?: ShellDialect
}

const ONCE: readonly ApprovalScope[] = ['once']
const ALL_SCOPES: readonly ApprovalScope[] = ['once', 'session', 'project']

function dialectOf(scope: { flavor?: PathFlavor; dialect?: ShellDialect }): ShellDialect {
  return scope.dialect ?? ((scope.flavor ?? HOST_FLAVOR) === 'win32' ? 'powershell' : 'posix')
}

function parseFor(script: string, scope: CommandScope, scriptVariables: 'off' | 'value' | 'empty' = 'off') {
  const home = scope.home ?? homedir()
  const env: Record<string, string | undefined> = { HOME: home, ...scope.env }
  if (scope.tempDir !== undefined) Object.assign(env, { TMPDIR: scope.tempDir, TMP: scope.tempDir, TEMP: scope.tempDir })
  return parseScript(script, { dialect: dialectOf(scope), env, home, scriptVariables })
}

/** The words of every simple command in a script (wrappers unwrapped), without expansion. For callers that only need a rough list. */
export function commandSegments(script: string): string[][] {
  return parseScript(script).commands.filter(command => command.words.length > 0).map(command => [...command.words])
}

const program = programOf

const INSTALLERS: Record<string, readonly string[]> = {
  npm: ['install', 'i', 'add', 'ci', 'isntall'],
  pnpm: ['install', 'i', 'add'],
  yarn: ['install', 'add'],
  bun: ['install', 'i', 'add'],
  pip: ['install'],
  pip3: ['install'],
  pipx: ['install'],
  poetry: ['install', 'add'],
  conda: ['install'],
  uv: ['install', 'add', 'pip'],
  cargo: ['install', 'add'],
  go: ['install', 'get'],
  apt: ['install'],
  'apt-get': ['install'],
  brew: ['install'],
  choco: ['install'],
  winget: ['install'],
  scoop: ['install'],
  gem: ['install'],
}

const PUBLISH: readonly (readonly string[])[] = [
  ['git', 'push'], ['git', 'remote', 'add'], ['npm', 'publish'], ['pnpm', 'publish'], ['yarn', 'publish'], ['yarn', 'npm', 'publish'],
  ['gh', 'pr', 'merge'], ['cargo', 'publish'], ['docker', 'push'], ['twine', 'upload'],
]

const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'runas', 'pkexec', 'gsudo'])
const FETCHERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby'])
const SYSTEM = new Set([
  'systemctl', 'sc', 'set-executionpolicy', 'launchctl', 'service', 'bcdedit', 'diskpart', 'mkfs', 'shutdown', 'reboot', 'halt', 'poweroff',
  'mount', 'umount', 'useradd', 'userdel', 'usermod', 'groupadd', 'passwd', 'crontab', 'iptables', 'ufw', 'sysctl', 'modprobe', 'insmod', 'fdisk', 'parted',
])
const DELETERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd', 'unlink', 'shred'])
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const PERMISSION_TOOLS = new Set(['chmod', 'chown', 'chgrp'])

function isPrefix(prefix: readonly number[], of: readonly number[]): boolean {
  return prefix.length <= of.length && prefix.every((n, i) => of[i] === n)
}

interface PathContext {
  readonly p: typeof nodePath.posix
  readonly flavor: PathFlavor
  readonly scope: CommandScope
  readonly home: string
}

function pathContext(scope: CommandScope): PathContext {
  const flavor = scope.flavor ?? HOST_FLAVOR
  return { p: flavor === 'win32' ? nodePath.win32 : nodePath.posix, flavor, scope, home: scope.home ?? homedir() }
}

type PathClass = 'root' | 'protected' | 'ok' | 'outside'

/** Where a delete / permission target lands relative to the project. `cwd` undefined means unknown. */
function classifyPath(arg: string, isUnresolved: boolean, cwd: string | undefined, ctx: PathContext, rootItselfOk = false): PathClass {
  const { flavor, scope, p } = ctx
  if (flavor === 'posix' && /^[a-zA-Z]:([\\/]|$)/.test(arg)) return 'outside'
  const dynamicStart = isUnresolved && /^(\$|\uFFFC|`)/.test(arg)
  if (dynamicStart) return 'outside'
  const absolute = p.isAbsolute(arg)
  if (!absolute && cwd === undefined) return 'outside'
  const resolved = p.resolve(cwd ?? scope.root, arg)
  if (isWithin(resolved, scope.root, flavor)) {
    // `find . -delete` empties the tree below; only a strict ancestor of the project is "the project itself".
    return rootItselfOk && isWithin(scope.root, resolved, flavor) ? 'ok' : 'root'
  }
  if (isWithin(p.join(scope.root, '.nexgent'), resolved, flavor) || isWithin(p.join(scope.root, '.git'), resolved, flavor)) return 'protected'
  if (isWithin(scope.root, resolved, flavor)) return 'ok'
  const roots = [scope.tempDir, ...(scope.writeRoots ?? [])]
  if (roots.some(root => root !== undefined && isWithin(root, resolved, flavor))) return 'ok'
  return 'outside'
}

function isRecursiveDelete(command: SimpleCommand): boolean {
  const name = command.core[0] ?? ''
  const flags = command.core.slice(1).filter(token => token.startsWith('-') || (/^\/[a-zA-Z]$/.test(token) && name !== 'rm'))
  if (name === 'rm' || name === 'unlink' || name === 'shred') return flags.some(flag => /^-[a-zA-Z]*[rR]/.test(flag) || flag === '--recursive')
  if (name === 'rmdir' || name === 'rd') return flags.some(flag => /^(\/s|-recurse)$/i.test(flag))
  return flags.some(flag => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(flag) || /^\/s$/i.test(flag))
}

/** Path arguments of a command (flags dropped, `--` honoured), with their unresolved flags. */
function pathArguments(command: SimpleCommand, from: number, ctx: PathContext): { value: string; unresolved: boolean }[] {
  const out: { value: string; unresolved: boolean }[] = []
  // `core` and `words` differ only by global options, which the commands used here do not have.
  const offset = command.words.length - command.core.length
  let ended = false
  for (let i = from; i < command.core.length; i += 1) {
    const arg = command.core[i]!
    if (!ended && arg === '--') {
      ended = true
      continue
    }
    if (!ended && arg.startsWith('-') && arg !== '-') continue
    if (!ended && (ctx.flavor === 'win32' || command.dialect === 'powershell') && /^\/[a-zA-Z?]$/.test(arg)) continue
    // An empty argument names no file (`rm -rf "$d"` with d empty deletes nothing).
    if (arg === '{}' || arg === '') continue
    out.push({ value: arg, unresolved: command.unresolved[i + offset] === true })
  }
  return out
}

/** Start paths of a `find` command (words before the first expression). */
function findStarts(core: readonly string[]): string[] {
  const starts: string[] = []
  let i = 1
  while (i < core.length && /^-[HLPD]/.test(core[i]!)) i += core[i] === '-D' ? 2 : 1
  while (i < core.length && !/^(-|\(|!)/.test(core[i]!)) starts.push(core[i++]!)
  return starts
}

function worstClass(classes: readonly PathClass[]): PathClass {
  for (const level of ['root', 'protected', 'outside'] as const) if (classes.includes(level)) return level
  return 'ok'
}

function match(kind: CommandRuleKind, command: SimpleCommand, description: string, words: readonly string[] = command.words): CommandMatch {
  const alwaysAsk = kind === 'privilege' || kind === 'delete-project'
  const pattern = quoteWords(words)
  return {
    kind,
    risk: alwaysAsk ? 'high' : 'medium',
    alwaysAsk,
    pattern,
    segment: pattern,
    allowedScopes: kind === 'install' || kind === 'publish' || kind === 'discard-changes' ? ALL_SCOPES : ONCE,
    description,
  }
}

function gitDiscard(core: readonly string[]): boolean {
  const sub = core[1]
  const args = core.slice(2)
  const short = (letter: string) => args.some(arg => /^-[a-zA-Z]+$/.test(arg) && arg.includes(letter))
  switch (sub) {
    case 'clean':
      return !(args.includes('--dry-run') || short('n'))
    case 'reset':
      return args.includes('--hard') || args.includes('--merge')
    case 'checkout':
      return args.includes('--') || args.includes('.') || args.includes('-f') || args.includes('--force') || args.includes('-B')
    case 'restore':
      return !(args.includes('--staged') && !args.includes('--worktree') && !short('W'))
    case 'stash':
      return args[0] === 'drop' || args[0] === 'clear'
    case 'branch':
      return args.includes('-D') || (args.includes('--delete') && args.includes('--force'))
    default:
      return false
  }
}

/** Every blacklist / always-ask hit in a script, in order. */
export function matchCommandRules(script: string, scope: CommandScope): CommandMatch[] {
  // A variable the script assigns itself (`d="$TMPDIR/x"; rm -rf "$d"`) is checked with its value and
  // with the empty string it holds when the assignment did not run; both must pass.
  const parsed = parseFor(script, scope, 'value')
  if (parsed.scriptVariables === undefined) return matchParsed(parsed.commands, scope)
  const seen = new Set<string>()
  return [...matchParsed(parsed.commands, scope), ...matchParsed(parseFor(script, scope, 'empty').commands, scope)].filter(hit => {
    const key = JSON.stringify(hit)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function matchParsed(commands: ReturnType<typeof parseFor>['commands'], scope: CommandScope): CommandMatch[] {
  const ctx = pathContext(scope)
  const hits: CommandMatch[] = []
  const hasFetcher = commands.some(command => command.words.length > 0 && FETCHERS.has(program(command.words[0]!)))
  const dirs: { scope: readonly number[]; cwd: string | undefined }[] = []
  for (const command of commands) {
    if (command.core.length === 0) continue
    // Working directory after any `cd` that precedes this command in its subshell.
    let cwd: string | undefined = scope.cwd
    for (const dir of dirs) if (isPrefix(dir.scope, command.scope)) cwd = dir.cwd
    const core = command.core
    const lower = core.map(word => word.toLowerCase())
    const name = lower[0]!

    if (CD.has(name)) {
      const offset = command.words.length - core.length
      const index = core.findIndex((arg, i) => i > 0 && !(arg.startsWith('-') && arg !== '-'))
      let next: string | undefined
      if (cwd === undefined) next = undefined
      else if (index === -1) next = ctx.home
      else if (core[index] === '-' || (command.unresolved[index + offset] === true && /^(\$|\uFFFC)/.test(core[index]!))) next = undefined
      else next = ctx.p.resolve(cwd, core[index]!)
      dirs.push({ scope: command.scope, cwd: next })
      continue
    }

    if (command.privilegeWords !== undefined || PRIVILEGE.has(name)) {
      hits.push(match('privilege', command, 'privilege escalation', command.privilegeWords ?? command.words))
    } else if (name === 'start-process' && lower.some((token, i) => token === '-verb' && lower[i + 1] === 'runas')) {
      hits.push(match('privilege', command, 'privilege escalation (Start-Process -Verb RunAs)'))
      continue
    }

    const installVerbs = INSTALLERS[name]
    if (installVerbs !== undefined && (installVerbs.includes(lower[1] ?? '') || (name === 'yarn' && lower.length === 1))) {
      hits.push(match('install', command, 'package installation'))
    } else if ((name === 'python' || name === 'python3') && lower[1] === '-m' && lower[2] === 'pip' && lower[3] === 'install') {
      hits.push(match('install', command, 'package installation'))
    } else if (PUBLISH.some(prefix => prefix.every((word, index) => lower[index] === word))) {
      hits.push(match('publish', command, 'push or publish'))
    } else if (name === 'git' && gitDiscard(core)) {
      hits.push(match('discard-changes', command, 'discards uncommitted work or history (git clean / reset --hard / checkout -- / restore / stash drop)'))
    } else if (DELETERS.has(name) || (name === 'find' && core.includes('-delete'))) {
      const recursive = name === 'find' || isRecursiveDelete(command)
      const targets = name === 'find' ? findStarts(core).map(value => ({ value, unresolved: false })) : pathArguments(command, 1, ctx)
      if (name === 'find' && targets.length === 0) targets.push({ value: '.', unresolved: false })
      for (const extra of command.extraTargets ?? []) targets.push({ value: extra, unresolved: false })
      const classes = targets.map(target => classifyPath(target.value, target.unresolved, cwd, ctx, name === 'find' || command.extraTargets !== undefined))
      if (command.dynamicArgs === true && command.extraTargets === undefined && recursive) classes.push('outside')
      const worst = worstClass(classes)
      if (worst === 'root') hits.push(match('delete-project', command, 'deletes the project directory itself'))
      else if (worst === 'protected') hits.push(match('delete-project', command, 'deletes protected project data (.nexgent / .git)'))
      else if (worst === 'outside' && recursive) hits.push(match('delete-outside', command, 'recursive delete outside the project'))
    } else if (name === 'eval' && hasFetcher) {
      hits.push(match('download-exec', command, 'download and execute'))
    } else if (name === 'invoke-expression' || name === 'iex') {
      hits.push(match('download-exec', command, 'Invoke-Expression'))
    } else if (hasFetcher && INTERPRETERS.has(name)) {
      hits.push(match('download-exec', command, 'download and execute'))
    } else if (SYSTEM.has(name) && (name !== 'sc' || command.words[0]!.toLowerCase().endsWith('.exe'))) {
      hits.push(match('system', command, 'changes system state'))
    } else if (name === 'reg' && ['add', 'delete', 'import'].includes(lower[1] ?? '')) {
      hits.push(match('system', command, 'changes the registry'))
    } else if (PERMISSION_TOOLS.has(name) && core.slice(1).some(token => /^-[a-zA-Z]*R/.test(token) || token === '--recursive')) {
      const targets = pathArguments(command, 1, ctx).slice(1)
      if (targets.some(target => classifyPath(target.value, target.unresolved, cwd, ctx) !== 'ok')) {
        hits.push(match('system', command, 'recursive permission change outside the project'))
      }
    }
  }
  return hits
}

/**
 * What to offer when the hits are asked together: the intersection of their
 * allowed scopes, and a grant pattern only when one distinct pattern covers
 * them all and `session` / `project` are still allowed.
 */
export function commandAskScopes(hits: readonly CommandMatch[]): { options: ApprovalScope[]; pattern?: string; risk: ApprovalRisk } {
  const risk: ApprovalRisk = hits.some(hit => hit.risk === 'high') ? 'high' : 'medium'
  let options = ALL_SCOPES.filter(scope => hits.every(hit => hit.allowedScopes.includes(scope)))
  const patterns = new Set(hits.map(hit => hit.pattern))
  if (patterns.size !== 1) options = options.filter(scope => scope === 'once')
  if (options.length === 0) options = ['once']
  return options.length > 1 ? { options, pattern: hits[0]!.pattern, risk } : { options, risk }
}

/**
 * Extract the script text of a shell invocation: the argument after `-c`
 * (`bash`/`sh`) or `-Command` (`pwsh`/`powershell`); otherwise the joined argv.
 */
export function commandScript(command: string, args: readonly string[]): string {
  const name = program(command)
  if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
    const index = args.indexOf('-c')
    if (index !== -1 && args[index + 1] !== undefined) return args[index + 1]!
  }
  if (name === 'pwsh' || name === 'powershell') {
    const index = args.findIndex(arg => /^-c(ommand)?$/i.test(arg))
    if (index !== -1) return args.slice(index + 1).join(' ')
  }
  return [command, ...args].join(' ')
}

/** argv[0] basename, lower-cased, without `.exe`. */
export function programName(command: string): string {
  return program(command)
}

// ---------------------------------------------------------------------------
// Read-only commands (ADR 0022 decision 4)

/** Commands that only read (or print), whatever their arguments; `-o`-style output options are screened separately. */
const READ_ONLY_POSIX = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'printf', 'which', 'type', 'du', 'df', 'file', 'stat',
  'tree', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'env', 'printenv', 'date', 'uname',
  'whoami', 'id', 'hostname', 'test', '[', '[[', 'true', 'false', ':', 'cd', 'sleep', 'exit', 'seq', 'nl', 'fold', 'rev', 'tac', 'column',
  'expand', 'paste', 'comm', 'join', 'od', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'strings', 'base64', 'nproc',
  'uptime', 'free', 'ps', 'groups', 'tty', 'arch', 'find', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'git',
])

const READ_ONLY_POWERSHELL = new Set([
  'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'get-location', 'gl', 'pwd', 'test-path',
  'get-item', 'gi', 'get-itemproperty', 'measure-object', 'measure', 'sort-object', 'sort', 'select-object', 'select', 'where-object', 'where',
  '?', 'foreach-object', '%', 'group-object', 'group', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'convertto-json',
  'convertfrom-json', 'get-date', 'get-process', 'get-command', 'gcm', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'get-filehash',
  'write-output', 'echo', 'write', 'write-host', 'compare-object', 'diff', 'get-variable', 'gv', 'get-alias', 'out-null', 'set-location', 'sl',
  'cd', 'get-psdrive', 'get-hotfix', 'whoami', 'hostname', 'findstr', 'where.exe', 'rg', 'git', 'true', 'false', 'exit', 'sleep', 'start-sleep',
])

const VERSION_PROGRAMS = new Set(['node', 'npm', 'pnpm', 'yarn', 'git', 'python', 'python3', 'pip', 'pip3', 'go', 'cargo', 'rustc', 'java', 'tsc', 'deno', 'bun', 'ruby', 'dotnet', 'pwsh', 'cmake', 'make', 'gcc', 'g++', 'clang', 'docker'])
const VERSION_FLAGS = new Set(['--version', '-v', '-V', '-version'])
const UNSAFE_ASSIGNMENT = /^(PATH|LD_.*|DYLD_.*|GIT_.*|PAGER|EDITOR|VISUAL|SHELL|BASH_ENV|ENV|IFS|PS4|PROMPT_COMMAND|NODE_OPTIONS)(\+)?=/
const TRUSTED_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/sbin/', '/usr/sbin/']

const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'ls-tree', 'cat-file', 'rev-list', 'show-ref', 'diff-tree', 'diff-files', 'diff-index', 'merge-base', 'name-rev', 'for-each-ref', 'count-objects', 'whatchanged', 'version', 'check-ignore', 'ls-remote'])

function positionals(args: readonly string[], withValue: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  let ended = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!ended && arg === '--') ended = true
    else if (!ended && arg.startsWith('-') && arg !== '-') {
      if (withValue.has(arg)) i += 1
    } else out.push(arg)
  }
  return out
}

function gitReadOnly(command: SimpleCommand): boolean {
  if (command.globalOptions.some(option => option === '-c' || option === '--config-env' || option.startsWith('--exec-path') || option.startsWith('--attr-source'))) return false
  const [, sub, ...args] = command.core
  if (sub === undefined) return false
  if (VERSION_FLAGS.has(sub)) return args.length === 0
  if (sub === 'status' || GIT_READ_SUBCOMMANDS.has(sub)) {
    return !args.some(arg => /^--output(=|$)/.test(arg) || arg === '--ext-diff' || arg === '--textconv' || /^--open-files-in-pager/.test(arg) || (sub === 'grep' && /^-O/.test(arg)) || (sub === 'diff' && /^-O/.test(arg)))
  }
  switch (sub) {
    case 'branch': {
      const list = args.includes('--list') || args.includes('-l') || args.includes('--show-current')
      const extra = positionals(args, new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--abbrev']))
      const flags = args.filter(arg => arg.startsWith('-'))
      const known = flags.every(flag => /^(-a|-r|-v|-vv|-l|--all|--remotes|--verbose|--list|--show-current|--no-color|--color(=.*)?|--sort=.*|--format=.*|--abbrev=.*|--contains|--no-contains|--merged|--no-merged|--points-at|--column|--no-column|-i|--ignore-case)$/.test(flag) || /^--(contains|merged|no-merged|points-at|sort|format)=/.test(flag))
      return known && (extra.length === 0 || list)
    }
    case 'tag':
      return args.length === 0 || args.every(arg => arg === '-l' || arg === '--list' || arg === 'n' || /^-n\d*$/.test(arg) || arg.startsWith('--sort=') || arg === '--contains' || !arg.startsWith('-')) && (args.includes('-l') || args.includes('--list') || args.length === 0)
    case 'remote':
      return args.length === 0 || args[0] === '-v' || args[0] === '--verbose' || args[0] === 'show' || args[0] === 'get-url'
    case 'config':
      return args.some(arg => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg)) && !args.some(arg => arg === '--edit' || arg === '-e' || arg === '--unset' || arg === '--add' || arg === '--replace-all')
    case 'stash':
      return args[0] === 'list' || args[0] === 'show'
    case 'reflog':
      return args.length === 0 || args[0] === 'show' || args[0]!.startsWith('-')
    case 'worktree':
      return args[0] === 'list'
    case 'submodule':
      return args.length === 0 || args[0] === 'status'
    default:
      return false
  }
}

const SED_SAFE = /^(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/|\+\d+))?\s*!?\s*(?:[pdqQ=nNlPD]|s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiI0-9]*)$/

function sedReadOnly(args: readonly string[]): boolean {
  const scripts: string[] = []
  let sawE = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(arg)) return false
    if (arg === '-f' || arg === '--file' || arg.startsWith('--file=') || /^-[a-zA-Z]*f/.test(arg)) return false
    if (arg === '-e' || arg === '--expression') {
      sawE = true
      if (args[i + 1] === undefined) return false
      scripts.push(args[i + 1]!)
      i += 1
    } else if (arg.startsWith('--expression=')) {
      sawE = true
      scripts.push(arg.slice('--expression='.length))
    } else if (arg.startsWith('-') && arg !== '-') {
      if (!/^(-[nEsrzu]+|--quiet|--silent|--regexp-extended|--separate|--null-data|--posix|--unbuffered|--debug|--sandbox)$/.test(arg)) return false
    } else if (!sawE && scripts.length === 0) {
      scripts.push(arg)
    }
  }
  if (scripts.length === 0) return false
  return scripts.every(script => script.split(/[;\n]/).map(part => part.trim()).filter(part => part !== '').every(part => SED_SAFE.test(part)))
}

function awkReadOnly(args: readonly string[]): boolean {
  let program: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (/^(-f|--file|-i|--include|--source|-E|--exec|-l|--load)/.test(arg)) return false
    if (arg === '-v' || arg === '-F') i += 1
    else if (arg.startsWith('-') && arg !== '-') continue
    else {
      program = arg
      break
    }
  }
  return program !== undefined && !/system|getline|[>|]|\bclose\b|\bfflush\b|ENVIRON|ARGV|@load|@include/.test(program)
}

function posixReadOnly(command: SimpleCommand): boolean {
  const [name = '', ...args] = command.core
  if (command.globalOptions.length > 0 && name !== 'git') return false
  if (VERSION_PROGRAMS.has(name) && args.length === 1 && VERSION_FLAGS.has(args[0]!)) return true
  if (name === 'go' && args.length === 1 && args[0] === 'version') return true
  if (!READ_ONLY_POSIX.has(name)) return false
  switch (name) {
    case 'git':
      return gitReadOnly(command)
    case 'find':
      return !args.some(arg => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
    case 'sed':
      return sedReadOnly(args)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return awkReadOnly(args)
    case 'sort':
      return !args.some(arg => arg === '-o' || arg.startsWith('--output') || /^-[a-zA-Z]*o/.test(arg) || arg.startsWith('--compress-program'))
    case 'uniq':
      return positionals(args, new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'])).length <= 1
    case 'tree':
      return !args.some(arg => arg === '-o' || arg === '--output')
    case 'file':
      return !args.some(arg => arg === '-C' || arg === '--compile')
    case 'rg':
      return !args.some(arg => arg === '--pre' || arg.startsWith('--pre=') || arg.startsWith('--hostname-bin'))
    case 'date':
      return !args.some(arg => arg === '-s' || arg.startsWith('--set') || /^-[a-zA-Z]*s/.test(arg)) && positionals(args).every(arg => arg.startsWith('+'))
    case 'hostname':
      return positionals(args).length === 0
    case 'env':
      return args.every(arg => arg.startsWith('-') && arg !== '--') && !args.some(arg => /^-[a-zA-Z]*[uCS]/.test(arg))
    case 'ps':
      return true
    default:
      return true
  }
}

const PS_PROPERTY = /^\$[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/

function powershellReadOnly(command: SimpleCommand): boolean {
  const [name = '', ...args] = command.core
  // `$_.Name -eq 'a'` inside a script block: a property read, never an assignment or a method call.
  if (PS_PROPERTY.test(command.words[0]!)) {
    return !command.words.some(word => word === UNKNOWN_TEXT || /^[-+*/%]?=$/.test(word))
  }
  if (VERSION_PROGRAMS.has(name) && args.length === 1 && VERSION_FLAGS.has(args[0]!)) return true
  if (!READ_ONLY_POWERSHELL.has(name)) return false
  if (name === 'git') return gitReadOnly(command)
  if (name === 'rg') return !args.some(arg => arg === '--pre' || arg.startsWith('--pre='))
  return true
}

function readOnlyRedirects(command: SimpleCommand): boolean {
  return command.redirects.every(redirect => {
    if (redirect.op === '<' || redirect.op === '<<' || redirect.op === '<<-' || redirect.op === '<<<') return true
    if (redirect.op === '>&' || redirect.op === '<&') return redirect.target === '-' || /^[0-9]+$/.test(redirect.target)
    const sink = redirect.target.toLowerCase()
    return sink === '/dev/null' || sink === '$null' || sink === 'nul'
  })
}

/** Names that, when a path-qualified program is used, may be run (system directories only). */
function trustedProgram(word: string): boolean {
  return !/[\\/]/.test(word) || TRUSTED_DIRS.some(dir => word.startsWith(dir))
}

/**
 * Whether every command in a script only reads (ADR 0022 decision 4): each
 * simple command (wrappers unwrapped, `$( )` and subshell contents included)
 * is on the read-only list with arguments that cannot write, execute or
 * change state, and no redirection writes anywhere but `/dev/null`. Anything
 * unknown, unresolved or unparsable is not read-only.
 *
 * `platform` selects the dialect and the list: `win32` reads PowerShell
 * (cmdlet names, case-insensitive), anything else POSIX shell.
 */
export function isReadOnlyCommand(script: string, platform: NodeJS.Platform = process.platform): boolean {
  const dialect: ShellDialect = platform === 'win32' ? 'powershell' : 'posix'
  const parsed = parseScript(script, { dialect })
  if (parsed.incomplete) return false
  for (const command of parsed.commands) {
    if (command.assignments.some(assignment => UNSAFE_ASSIGNMENT.test(assignment))) return false
    if (!readOnlyRedirects(command)) return false
    if (command.words.length === 0) continue
    if (command.privilegeWords !== undefined) return false
    if ((command.unresolved[0] === true && !(dialect === 'powershell' && PS_PROPERTY.test(command.words[0]!))) || !trustedProgram(command.words[0]!)) return false
    const ok = dialect === 'powershell' ? powershellReadOnly(command) : posixReadOnly(command)
    if (!ok) return false
  }
  return true
}
