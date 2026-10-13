/**
 * The step-4 gate's process entry (W3). `@nexgent/capabilities` starts it
 * when a task that proposed a candidate ends; it runs the product itself, so
 * it lives here, above every plugin package:
 *
 * - `node trial-entry.js gate <projectRoot> <candidateId>`: runs `runGate`
 *   for the candidate (replay set, paired runs, reviewer, decision), each
 *   run in its own process (`replay` below), the reviewer through the
 *   Claude Platform route with `trialId` on its ledger records.
 * - `node trial-entry.js replay` (request JSON on stdin): boots the product
 *   on the run's project copy through the SDK, sends the case's user
 *   messages in one new session, and prints `NEXGENT_REPLAY_RESULT <json>`.
 *   Every ledger record of the run goes to the real project's ledger with
 *   `trialId` and `arm`; approvals are answered `deny` (`headless`): a trial
 *   asks nobody anything.
 *
 * The API key comes from the environment or the Nexgent home's credentials
 * file, as for any task; it is never passed on a command line or written.
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  decisionLedgerRecord,
  processReplayRunner,
  REPLAY_RESULT_PREFIX,
  runGate,
  type GateResult,
  type ReplayRunRequest,
  type ReplayRunResult,
  type ReviewInput,
  type ReviewResult,
  type TrialReviewer,
} from '@nexgent/capabilities'
import {
  addUsage,
  LocalCredentials,
  nexgentHome,
  readProjectConfig,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  ZERO_USAGE,
  type Context,
  type Ledger,
  type LedgerRecordInput,
  type LLMUsage,
  type Plugin,
  type TrialArm,
  type TurnEndReason,
} from '@nexgent/kernel'
import { AnthropicProvider } from '@nexgent/llm'
import { JsonlLedger, SessionPlugin, type SessionPluginConfig } from '@nexgent/session'
import { createSdk } from './sdk.js'

/** Absolute path of this entry (the `@nexgent/capabilities` row's `trial.entry`). */
export const TRIAL_ENTRY: string = fileURLToPath(import.meta.url)

/** Environment variables the SDK hands the gate process besides its own environment (never a secret). */
export const TRIAL_ENV_KEYS = ['NEXGENT_HOME', 'NEXGENT_API_BASE_URL', 'NEXGENT_COMPACTION_THRESHOLD'] as const

type Env = Readonly<Record<string, string | undefined>>

/** A ledger that adds the trial's fields to every record (and counts the run's model requests). */
function trialLedger(ledger: Ledger, fields: { readonly trialId: string; readonly arm?: TrialArm }, tally?: { usage: LLMUsage; requests: number }): Ledger {
  return {
    get writeFailures() {
      return ledger.writeFailures
    },
    read: range => ledger.read(range),
    append: async (input: LedgerRecordInput) => {
      const record = await ledger.append({ ...input, ...fields } as LedgerRecordInput)
      if (tally !== undefined && record.type === 'llm.request.end') {
        tally.usage = addUsage(tally.usage, record.usage)
        tally.requests += 1
      }
      return record
    },
  }
}

/** `@nexgent/session` for a replay run: data in the copy, ledger in the real project, trial fields on every record. */
function trialSessionPlugin(request: ReplayRunRequest, tally: { usage: LLMUsage; requests: number }): Plugin {
  return {
    ...SessionPlugin,
    apply(ctx: Context, config: SessionPluginConfig = {}): void {
      // The service is registered when the plugin provides it; catch the ledger on its way in.
      // The JSONL ledger keeps its own stamp (attribution, capability version); only `append` is wrapped.
      const provide = ctx.provide
      const target = ctx as unknown as { provide: (name: string, value: unknown, ...rest: unknown[]) => unknown }
      target.provide = (name, value, ...rest) => {
        if (name === 'ledger') {
          const ledger = value as JsonlLedger
          ledger.append = trialLedger({ read: ledger.read.bind(ledger), append: ledger.append.bind(ledger), get writeFailures() { return ledger.writeFailures } }, { trialId: request.trialId, arm: request.arm }, tally).append
        }
        return (provide as (...args: unknown[]) => unknown).call(ctx, name, value, ...rest)
      }
      try {
        SessionPlugin.apply(ctx, { ...config, ledgersDir: request.ledgersDir })
      } finally {
        target.provide = provide as typeof target.provide
      }
    },
  } as Plugin
}

function outcomeOf(reason: TurnEndReason): ReplayRunResult['outcome'] | undefined {
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
      return undefined
    case 'cancelled':
      return reason.cause === 'cost-cap' ? 'budget' : reason.cause === 'timeout' ? 'timeout' : 'cancelled'
    case 'error':
      return reason.error.code === 'budget/exhausted' ? 'budget' : 'error'
    case 'interrupted':
      return 'error'
  }
}

/** Run one replay in this process (the `replay` mode). */
export async function runReplay(request: ReplayRunRequest, env: Env = process.env): Promise<ReplayRunResult> {
  const tally = { usage: ZERO_USAGE as LLMUsage, requests: 0 }
  const sdk = createSdk({
    appVersion: 'trial',
    env,
    // A replay runs on a project copy: it starts no gate and no improvement job of its own.
    background: false,
    approvalResponder: async request => ({ id: request.id, decision: 'deny', scope: 'once', decidedBy: 'headless', reason: 'gate trials run without anyone to ask' }),
    registry: { '@nexgent/session': trialSessionPlugin(request, tally) },
  })
  try {
    const project = await sdk.call('projects.open', { root: request.projectRoot })
    const session = await sdk.call('sessions.create', { projectId: project.projectId, title: `trial ${request.trialId} ${request.arm} ${request.caseId}#${request.repeat}` })
    for (const message of request.messages) {
      const started = await sdk.startTurn({
        projectId: project.projectId,
        sessionId: session.sessionId,
        text: message.text,
        ...(message.materialIds === undefined ? {} : { materialIds: [...message.materialIds] }),
      })
      const result = await started.done
      const ended = outcomeOf(result.reason)
      if (ended !== undefined) {
        const detail = result.reason.kind === 'error' ? `${result.reason.error.code}: ${result.reason.error.message}` : result.reason.kind
        return { outcome: ended, detail: detail.slice(0, 500), usage: tally.usage, requestCount: tally.requests }
      }
    }
    return { outcome: 'completed', usage: tally.usage, requestCount: tally.requests }
  } catch (error) {
    return { outcome: 'error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 500), usage: tally.requests === 0 ? UNKNOWN_USAGE : tally.usage, requestCount: tally.requests }
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
}

const REVIEW_SYSTEM = [
  'You compare two attempts at the same task for a quality gate.',
  'You see the task (the user messages) and the files each attempt created or changed.',
  'Judge which attempt better does what the user asked: correct results first, then completeness, then clarity.',
  'Answer with one JSON object and nothing else: {"better": "A" | "B" | "tie", "reason": "<one or two sentences>"}.',
].join(' ')

function renderOutput(label: string, output: ReviewInput['candidate']): string {
  if (output.files.length === 0) return `## Attempt ${label}\n(no files created or changed)`
  return [`## Attempt ${label}`, ...output.files.map(file => `### ${file.path}\n\`\`\`\n${file.text}\n\`\`\``)].join('\n')
}

/** Parse the reviewer's JSON answer; `undefined` when it is not one. */
export function parseReview(text: string): { readonly better: 'A' | 'B' | 'tie'; readonly reason: string } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { better?: unknown; reason?: unknown }
    if (value.better !== 'A' && value.better !== 'B' && value.better !== 'tie') return undefined
    return { better: value.better, reason: typeof value.reason === 'string' ? value.reason : '' }
  } catch {
    return undefined
  }
}

/**
 * The reviewer model over the Claude Platform route: one request per
 * selection run pair, attempts shown as A and B (the candidate is A on odd
 * repeats, B on even ones), records with `trialId` and no `arm`.
 */
export function llmReviewer(options: { readonly ledger: Ledger; readonly home: string; readonly env: Env; readonly endpoint?: string }): TrialReviewer {
  return {
    async review(input: ReviewInput, settings, signal): Promise<ReviewResult> {
      let usage: LLMUsage = UNKNOWN_USAGE
      const provider = new AnthropicProvider({
        credentials: new LocalCredentials({ env: options.env as NodeJS.ProcessEnv, home: options.home }),
        ledger: trialLedger(options.ledger, { trialId: input.trialId }),
        env: options.env,
        defaultModel: settings.model,
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      })
      const candidateFirst = input.repeat % 2 === 1
      const [a, b] = candidateFirst ? [input.candidate, input.baseline] : [input.baseline, input.candidate]
      const task = input.messages.map((message, index) => `Message ${index + 1}:\n${message.text}`).join('\n\n')
      let text = ''
      let failure: string | undefined
      for await (const event of provider.complete({
        requestId: randomUUID(),
        model: settings.model,
        thinking: settings.thinking,
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: `# Task\n${task}\n\n${renderOutput('A', a)}\n\n${renderOutput('B', b)}` },
        ],
        signal,
      }, { purpose: 'auxiliary' })) {
        if (event.type === 'text.delta') text += event.text
        else if (event.type === 'usage') usage = event.usage
        else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
      }
      const parsed = failure === undefined ? parseReview(text) : undefined
      if (parsed === undefined) {
        return { preference: 'unknown', reason: (failure ?? `the reviewer did not answer with the JSON object: ${text.slice(0, 300)}`).slice(0, 2_000), usage, requestCount: 1 }
      }
      const preference = parsed.better === 'tie' ? 'tie' : (parsed.better === 'A') === candidateFirst ? 'candidate' : 'baseline'
      return { preference, reason: parsed.reason.slice(0, 2_000) || '(no reason given)', usage, requestCount: 1 }
    },
  }
}

/** Run the gate for one candidate of a project (the `gate` mode). */
export async function runGateProcess(root: string, candidateId: string, env: Env = process.env): Promise<GateResult> {
  const layout = resolveWorkspaceLayout(root)
  const ledger = new JsonlLedger({ ledgersDir: layout.ledgers })
  const endpoint = (await readProjectConfig(layout.configFile).catch(() => undefined))?.input.endpoint
  return runGate({
    layout,
    candidateId,
    runner: processReplayRunner({ args: [TRIAL_ENTRY, 'replay'], env: env as NodeJS.ProcessEnv }),
    reviewer: llmReviewer({ ledger, home: nexgentHome(env as NodeJS.ProcessEnv), env, ...(endpoint === undefined ? {} : { endpoint }) }),
    log: line => process.stderr.write(`${line}\n`),
    onDecision: async decision => {
      await ledger.append(decisionLedgerRecord(decision)).catch(() => undefined)
    },
  })
}

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk as string
  return text
}

/** Command-line entry. */
export async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv
  if (mode === 'replay') {
    const request = JSON.parse(await readStdin()) as ReplayRunRequest
    const result = await runReplay(request)
    process.stdout.write(`\n${REPLAY_RESULT_PREFIX}${JSON.stringify(result)}\n`)
    return 0
  }
  if (mode === 'gate' && rest.length === 2) {
    const result = await runGateProcess(rest[0]!, rest[1]!)
    process.stdout.write(`${JSON.stringify(result.status === 'decided' ? { status: result.status, trialId: result.trialId, verdict: result.verdict, decisionId: result.decision.id } : result)}\n`)
    return 0
  }
  process.stderr.write('usage: trial-entry gate <projectRoot> <candidateId> | trial-entry replay < request.json\n')
  return 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
