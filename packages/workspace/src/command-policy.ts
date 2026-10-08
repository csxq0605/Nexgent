/**
 * Command-shape rules (`docs/spec/permissions.md` §命令策略 形态黑名单 and
 * §工具审批 始终审批表). Matching is deliberately broad: the script is split
 * on pipes, separators and subshell openers, each segment is tokenized on
 * whitespace and matched by prefix. This is not a security boundary.
 */
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import type { ApprovalRisk } from '@nexgent/kernel'
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

/** One rule hit. */
export interface CommandMatch {
  readonly kind: CommandRuleKind
  /** `high` for the always-ask table, `medium` for the blacklist. */
  readonly risk: ApprovalRisk
  /** Always-ask hits ignore the sandbox mode and stored grants and only offer `once`. */
  readonly alwaysAsk: boolean
  /** Command prefix a `session` / `project` grant would store, e.g. `pnpm install`. */
  readonly pattern: string
  /** The segment that matched, normalized. */
  readonly segment: string
  /** Human-readable rule description. */
  readonly description: string
}

/** Where relative arguments resolve and what counts as the project. */
export interface CommandScope {
  readonly root: string
  readonly cwd: string
  readonly flavor?: PathFlavor
  readonly home?: string
}

const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'env', 'builtin', 'nice', 'xargs', '&'])

/** Split a script into whitespace-tokenized segments. */
export function commandSegments(script: string): string[][] {
  return script
    .split(/\|\||&&|\$\(|[|;&\n\r`(){}]/)
    .map(segment => tokenize(segment))
    .filter(tokens => tokens.length > 0)
}

function tokenize(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(token => token.replace(/^["']+|["']+$/g, ''))
  // Drop leading `FOO=bar` assignments and transparent wrappers.
  while (tokens.length > 0) {
    const head = tokens[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || WRAPPERS.has(head.toLowerCase())) tokens.shift()
    else break
  }
  return tokens
}

function program(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, '')
}

const INSTALLERS: Record<string, readonly string[]> = {
  npm: ['install', 'i', 'add', 'ci', 'isntall'],
  pnpm: ['install', 'i', 'add'],
  yarn: ['install', 'add'],
  pip: ['install'],
  pip3: ['install'],
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
  ['git', 'push'], ['git', 'remote', 'add'], ['npm', 'publish'], ['pnpm', 'publish'], ['yarn', 'publish'], ['gh', 'pr', 'merge'],
]

const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'runas', 'pkexec', 'gsudo'])
const FETCHERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby'])
const SYSTEM = new Set(['systemctl', 'sc', 'set-executionpolicy', 'launchctl', 'service', 'bcdedit', 'diskpart', 'mkfs', 'shutdown', 'reboot'])
const DELETERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd'])

function lowerTokens(tokens: readonly string[]): string[] {
  return tokens.map(token => token.toLowerCase())
}

function startsWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => (index === 0 ? program(tokens[0] ?? '') : tokens[index]) === word)
}

function expandArg(arg: string, scope: CommandScope): string {
  const home = scope.home ?? homedir()
  const flavor = scope.flavor ?? HOST_FLAVOR
  const p = flavor === 'win32' ? nodePath.win32 : nodePath.posix
  let value = arg
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = home + value.slice(1)
  value = value.replace(/^\$(HOME|\{HOME\})/, home).replace(/^\$env:(USERPROFILE|HOME)/i, home)
  return p.resolve(scope.cwd, value)
}

/** Classify each path argument of a delete / chmod as project, outside or project-root (or ancestor). */
function pathTargets(args: readonly string[], scope: CommandScope): { outside: boolean; project: boolean } {
  const flavor = scope.flavor ?? HOST_FLAVOR
  let outside = false
  let project = false
  for (const arg of args) {
    if (arg.startsWith('-') && arg !== '-') continue
    if (flavor === 'posix' && /^[a-zA-Z]:([\\/]|$)/.test(arg)) {
      outside = true
      continue
    }
    const resolved = expandArg(arg, scope)
    if (isWithin(resolved, scope.root, flavor)) project = true
    else if (!isWithin(scope.root, resolved, flavor)) outside = true
  }
  return { outside, project }
}

function isRecursiveDelete(tokens: readonly string[]): boolean {
  const name = program(tokens[0] ?? '')
  const flags = tokens.slice(1).filter(token => token.startsWith('-') || token.startsWith('/'))
  if (name === 'rm') return flags.some(flag => /^-[a-zA-Z]*[rR]/.test(flag) || flag === '--recursive')
  if (name === 'rmdir' || name === 'rd') return flags.some(flag => /^(\/s|-recurse)$/i.test(flag))
  return flags.some(flag => /^-r(ecurse)?$/i.test(flag) || /^\/s$/i.test(flag))
}

function match(kind: CommandRuleKind, tokens: readonly string[], words: number, description: string): CommandMatch {
  const alwaysAsk = kind === 'privilege' || kind === 'delete-project'
  return {
    kind,
    risk: alwaysAsk ? 'high' : 'medium',
    alwaysAsk,
    pattern: tokens.slice(0, words).join(' '),
    segment: tokens.join(' '),
    description,
  }
}

/** Every blacklist / always-ask hit in a script, in order. */
export function matchCommandRules(script: string, scope: CommandScope): CommandMatch[] {
  const segments = commandSegments(script)
  const hits: CommandMatch[] = []
  const hasFetcher = segments.some(tokens => FETCHERS.has(program(tokens[0]!)))
  for (const tokens of segments) {
    const lower = lowerTokens(tokens)
    const name = program(lower[0]!)
    if (PRIVILEGE.has(name)) {
      hits.push(match('privilege', tokens, 1, 'privilege escalation'))
      continue
    }
    if (name === 'start-process' && lower.some((token, i) => token === '-verb' && lower[i + 1] === 'runas')) {
      hits.push(match('privilege', tokens, 1, 'privilege escalation (Start-Process -Verb RunAs)'))
      continue
    }
    const installVerbs = INSTALLERS[name]
    if (installVerbs !== undefined && lower[1] !== undefined && installVerbs.includes(lower[1])) {
      hits.push(match('install', tokens, 2, 'package installation'))
      continue
    }
    if ((name === 'python' || name === 'python3') && lower[1] === '-m' && lower[2] === 'pip' && lower[3] === 'install') {
      hits.push(match('install', tokens, 4, 'package installation'))
      continue
    }
    const publish = PUBLISH.find(prefix => startsWith(lower, prefix))
    if (publish !== undefined) {
      hits.push(match('publish', tokens, publish.length, 'push or publish'))
      continue
    }
    if (DELETERS.has(name) && isRecursiveDelete(lower)) {
      const targets = pathTargets(tokens.slice(1), scope)
      if (targets.project) hits.push(match('delete-project', tokens, 1, 'deletes the project directory itself'))
      else if (targets.outside) hits.push(match('delete-outside', tokens, 1, 'recursive delete outside the project'))
      continue
    }
    if (name === 'eval' && hasFetcher) {
      hits.push(match('download-exec', tokens, 1, 'download and execute'))
      continue
    }
    if (name === 'invoke-expression' || name === 'iex') {
      hits.push(match('download-exec', tokens, 1, 'Invoke-Expression'))
      continue
    }
    if (hasFetcher && INTERPRETERS.has(name)) {
      hits.push(match('download-exec', tokens, 1, 'download and execute'))
      continue
    }
    if (SYSTEM.has(name) && (name !== 'sc' || lower[0]!.endsWith('.exe'))) {
      hits.push(match('system', tokens, 1, 'changes system state'))
      continue
    }
    if (name === 'reg' && ['add', 'delete', 'import'].includes(lower[1] ?? '')) {
      hits.push(match('system', tokens, 2, 'changes the registry'))
      continue
    }
    if ((name === 'chmod' || name === 'chown') && tokens.slice(1).some(token => /^-[a-zA-Z]*R/.test(token) || token === '--recursive')) {
      if (pathTargets(tokens.slice(1).filter(token => !/^[0-7]{3,4}$|^[ugoa]*[+=-]/.test(token) && !token.includes(':')), scope).outside) {
        hits.push(match('system', tokens, 1, 'recursive permission change outside the project'))
      }
    }
  }
  return hits
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
