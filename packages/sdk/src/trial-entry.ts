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
 * Step 5: a job's candidate's replay sessions belong to the job's `trial`
 * phase (`improvement: { jobId, phase: 'trial' }`, so the ledger records carry
 * `improvementId` / `improvementPhase`), the reviewer also answers feedback
 * checks, and every result carries the display-only `estimatedUsd` from
 * `@nexgent/llm`'s price table.
 *
 * The API key comes from the environment or the Nexgent home's credentials
 * file, as for any task; it is never passed on a command line or written.
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  candidateRunAttribution,
  decisionLedgerRecord,
  processReplayRunner,
  readCandidate,
  REPLAY_RESULT_PREFIX,
  runGate,
  type GateResult,
  type FeedbackCheckInput,
  type JobRunAttribution,
  type FeedbackCheckResult,
  type ReplayRunRequest,
  type ReplayRunResult,
  type ReviewInput,
  type ReviewResult,
  type TrialReviewer,
} from '@nexgent/capabilities'
import {
  addUsage,
  AgentsService,
  KERNEL_PLUGIN_NAMES,
  LocalCredentials,
  nexgentHome,
  readProjectConfig,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  ZERO_USAGE,
  type Context,
  type CreateAgentOptions,
  type ImproverComparisonParams,
  type Ledger,
  type LedgerRecordInput,
  type LLMUsage,
  type Plugin,
  type TrialArm,
  type TurnEndReason,
} from '@nexgent/kernel'
import { AnthropicProvider, estimateUsd } from '@nexgent/llm'
import { extractDocx, extractPdf, extractXlsx } from '@nexgent/skill'
import { JsonlLedger, SessionPlugin, type SessionPluginConfig } from '@nexgent/session'
import { createSdk } from './sdk.js'

/** Absolute path of this entry (the `@nexgent/capabilities` row's `trial.entry`). */
export const TRIAL_ENTRY: string = fileURLToPath(import.meta.url)

/** Environment variables the SDK hands the gate process besides its own environment (never a secret). */
export const TRIAL_ENV_KEYS = ['NEXGENT_HOME', 'NEXGENT_API_BASE_URL', 'NEXGENT_COMPACTION_THRESHOLD'] as const

type Env = Readonly<Record<string, string | undefined>>

/** A run's model requests: summed usage, count, and estimated USD (display only). */
interface RunTally {
  usage: LLMUsage
  requests: number
  usd: number | 'unknown'
}

/** A ledger that adds the trial's fields to every record (and counts the run's model requests). */
function trialLedger(ledger: Ledger, fields: { readonly trialId: string; readonly arm?: TrialArm }, tally?: RunTally): Ledger {
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
        const usd = estimateUsd(record.model, record.usage)
        tally.usd = tally.usd === 'unknown' || usd === 'unknown' ? 'unknown' : tally.usd + usd
      }
      return record
    },
  }
}

/** `@nexgent/session` for a replay run: data in the copy, ledger in the real project, trial fields on every record. */
function trialSessionPlugin(request: ReplayRunRequest, tally: RunTally): Plugin {
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

/**
 * The kernel's agents service for a job's replay: every root session it
 * opens belongs to the job's `trial` phase (members inherit nothing; the
 * kernel refuses a job on a member).
 */
function trialAgents(run: JobRunAttribution): Plugin {
  return class TrialAgentsService extends AgentsService {
    override async create(options: CreateAgentOptions = {}) {
      return super.create(options.child === undefined ? { ...options, improvement: { ...run, phase: 'trial' } } : options)
    }
  } as unknown as Plugin
}

/** Run one replay in this process (the `replay` mode). */
export async function runReplay(request: ReplayRunRequest, env: Env = process.env): Promise<ReplayRunResult> {
  const tally: RunTally = { usage: ZERO_USAGE as LLMUsage, requests: 0, usd: 0 }
  const sdk = createSdk({
    appVersion: 'trial',
    env,
    // A replay runs on a project copy: it starts no gate and no improvement job of its own.
    background: false,
    approvalResponder: async request => ({ id: request.id, decision: 'deny', scope: 'once', decidedBy: 'headless', reason: 'gate trials run without anyone to ask' }),
    registry: {
      '@nexgent/session': trialSessionPlugin(request, tally),
      ...(request.improvement === undefined ? {} : { [KERNEL_PLUGIN_NAMES.agents]: trialAgents(request.improvement) }),
    },
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
        return { outcome: ended, detail: detail.slice(0, 500), usage: tally.usage, requestCount: tally.requests, estimatedUsd: tally.usd }
      }
    }
    return { outcome: 'completed', usage: tally.usage, requestCount: tally.requests, estimatedUsd: tally.usd }
  } catch (error) {
    return { outcome: 'error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 500), usage: tally.requests === 0 ? UNKNOWN_USAGE : tally.usage, requestCount: tally.requests, estimatedUsd: tally.requests === 0 ? 'unknown' : tally.usd }
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
}

/** The preference review's system prompt (part of the evaluator rules, `EVALUATOR_RULES`). */
export const REVIEW_SYSTEM = [
  'You compare two attempts at the same task for a quality gate.',
  'You see the task (the user messages), the project\'s input files as the task started, and the files each attempt created or changed.',
  'When feedback the user gave on an earlier attempt is shown, the standing preferences it states (how the user always wants such work done) are part of what the user asked; extras it asks for only that one time are not.',
  'A listing may name files without their contents; do not count a file as missing because its contents are not shown.',
  'Check the attempts against the input files where you can, and judge which attempt better does what the user asked: correct results first, then completeness, then clarity.',
  'First find the concrete differences between the attempts that matter for what the user asked; if there is none, the answer is a tie.',
  'The order in which the attempts are shown means nothing.',
  'Answer with one JSON object and nothing else: {"better": "A" | "B" | "tie", "reason": "<one or two sentences naming the difference>"}.',
].join(' ')

/** ADR 0016: the task's input files for the reviewer (the project as the task started). */
export function renderInputs(inputs: ReviewInput['inputs']): string {
  const unshown = inputs.unshown ?? []
  if (inputs.files.length === 0 && unshown.length === 0) return '# Input files\n(none)'
  const lines = ['# Input files (the project as the task started)', ...inputs.files.map(file => `## ${file.path}\n\`\`\`\n${file.text}\n\`\`\``)]
  if (unshown.length > 0) {
    const more = inputs.unlisted ?? 0
    lines.push(`Also in the project (contents not shown): ${unshown.length + more} more file(s)`, ...unshown.map(path => `- ${path}`), ...(more > 0 ? [`- … and ${more} more`] : []))
  }
  return lines.join('\n')
}

/** ADR 0016: the text of a spreadsheet, Word document or PDF the reviewer is shown (other binary files: `undefined`). */
export async function documentText(path: string, bytes: Uint8Array): Promise<string | undefined> {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  try {
    if (extension === '.xlsx') return await extractXlsx(bytes)
    if (extension === '.docx') return await extractDocx(bytes)
    if (extension === '.pdf') return await extractPdf(bytes)
  } catch {
    // An unreadable document is shown as binary.
  }
  return undefined
}

/** One attempt's files for the reviewer: contents of the first few, then the paths of the other changed files and of removed files (ADR 0015). */
export function renderOutput(label: string, output: ReviewInput['candidate']): string {
  const unshown = output.unshown ?? []
  const removed = output.removed ?? []
  if (output.files.length === 0 && removed.length === 0) return `## Attempt ${label}\n(no files created or changed)`
  const lines = [`## Attempt ${label}`, ...output.files.map(file => `### ${file.path}\n\`\`\`\n${file.text}\n\`\`\``)]
  if (unshown.length > 0) {
    const more = output.unlisted ?? 0
    lines.push(`Also created or changed (contents not shown): ${unshown.length + more} more file(s)`, ...unshown.map(path => `- ${path}`), ...(more > 0 ? [`- … and ${more} more`] : []))
  }
  if (removed.length > 0) {
    const more = output.removedUnlisted ?? 0
    lines.push(`Removed by this attempt: ${removed.length + more} file(s)`, ...removed.map(path => `- ${path}`), ...(more > 0 ? [`- … and ${more} more`] : []))
  }
  return lines.join('\n')
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

/** The feedback check's system prompt (part of the evaluator rules, `EVALUATOR_RULES`). */
export const FEEDBACK_SYSTEM = [
  'You check one attempt at a task for a quality gate.',
  'You see the task (the user messages), the feedback the user gave on an earlier attempt at the same task, and the files this attempt created or changed.',
  'Judge only whether this attempt has solved the problem the feedback names; ignore anything the feedback does not mention.',
  'Feedback can also ask for something extra only for that one time (a new file or change beyond the task as given); this attempt was given only the task, so do not expect such one-time extras and judge only the problems the feedback names with how the task was done, including any standing preference it states.',
  'If the feedback names nothing but such one-time extras, answer null.',
  'A listing may name files without their contents; do not count a file as missing because its contents are not shown.',
  'Answer with one JSON object and nothing else: {"solved": true | false, "reason": "<one or two sentences>"}.',
  'If the files do not let you tell, answer {"solved": null, "reason": "..."}.',
].join(' ')

/** Parse the feedback check's JSON answer; `undefined` when it is not one. */
export function parseFeedbackCheck(text: string): { readonly status: 'pass' | 'fail' | 'unknown'; readonly reason: string } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { solved?: unknown; reason?: unknown }
    if (value.solved !== true && value.solved !== false && value.solved !== null) return undefined
    return { status: value.solved === true ? 'pass' : value.solved === false ? 'fail' : 'unknown', reason: typeof value.reason === 'string' ? value.reason : '' }
  } catch {
    return undefined
  }
}

function renderFeedback(feedback: FeedbackCheckInput['feedback']): string {
  return feedback.map((entry, index) => `Feedback ${index + 1}${entry.rating === undefined ? '' : ` (rating ${entry.rating}/5)`}:\n${entry.comment}`).join('\n\n')
}

/**
 * The reviewer model over the Claude Platform route, records with `trialId`
 * and no `arm` (and the job's `trial` phase for a job's candidate):
 *
 * - `review`: one request per selection run pair and order (ADR 0016: the
 *   gate asks each pair with the candidate as A and as B), with the task's
 *   input files; spreadsheets, Word documents and PDFs shown as text.
 * - `checkFeedback`: one request per run of a feedback case, that run's
 *   output alone with the feedback text (no other attempt to compare, so no
 *   position to swap).
 */
export function llmReviewer(options: { readonly ledger: Ledger; readonly home: string; readonly env: Env; readonly endpoint?: string; readonly improvement?: JobRunAttribution }): TrialReviewer {
  const ask = async (trialId: string, settings: Parameters<TrialReviewer['review']>[1], system: string, user: string, signal: AbortSignal) => {
    let usage: LLMUsage = UNKNOWN_USAGE
    const run = options.improvement
    const fields = {
      trialId,
      ...(run === undefined
        ? {}
        : {
          improvementId: run.jobId,
          improvementPhase: 'trial' as const,
          ...(run.improverVersion === undefined ? {} : { improverVersion: run.improverVersion }),
          ...(run.improverScope === undefined ? {} : { improverScope: run.improverScope }),
          ...(run.metaJobId === undefined ? {} : { metaJobId: run.metaJobId }),
          ...(run.comparisonArm === undefined ? {} : { comparisonArm: run.comparisonArm }),
        }),
    }
    const provider = new AnthropicProvider({
      credentials: new LocalCredentials({ env: options.env as NodeJS.ProcessEnv, home: options.home }),
      ledger: trialLedger(options.ledger, fields),
      env: options.env,
      defaultModel: settings.model,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    })
    let text = ''
    let failure: string | undefined
    for await (const event of provider.complete({
      requestId: randomUUID(),
      model: settings.model,
      thinking: settings.thinking,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
    }, { purpose: 'auxiliary' })) {
      if (event.type === 'text.delta') text += event.text
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
    }
    return { text, usage, failure, estimatedUsd: estimateUsd(settings.model, usage) }
  }
  const taskText = (messages: readonly { readonly text: string }[]) => messages.map((message, index) => `Message ${index + 1}:\n${message.text}`).join('\n\n')
  return {
    async review(input: ReviewInput, settings, signal): Promise<ReviewResult> {
      const candidateFirst = input.candidateFirst
      const [a, b] = candidateFirst ? [input.candidate, input.baseline] : [input.baseline, input.candidate]
      const feedback = input.feedback === undefined || input.feedback.length === 0 ? '' : `# Feedback on an earlier attempt\n${renderFeedback(input.feedback)}\n\n`
      const { text, usage, failure, estimatedUsd } = await ask(input.trialId, settings, REVIEW_SYSTEM, `# Task\n${taskText(input.messages)}\n\n${renderInputs(input.inputs)}\n\n${feedback}${renderOutput('A', a)}\n\n${renderOutput('B', b)}`, signal)
      const parsed = failure === undefined ? parseReview(text) : undefined
      if (parsed === undefined) {
        return { preference: 'unknown', reason: (failure ?? `the reviewer did not answer with the JSON object: ${text.slice(0, 300)}`).slice(0, 2_000), usage, requestCount: 1, estimatedUsd }
      }
      const preference = parsed.better === 'tie' ? 'tie' : (parsed.better === 'A') === candidateFirst ? 'candidate' : 'baseline'
      return { preference, reason: parsed.reason.slice(0, 2_000) || '(no reason given)', usage, requestCount: 1, estimatedUsd }
    },
    async checkFeedback(input: FeedbackCheckInput, settings, signal): Promise<FeedbackCheckResult> {
      const user = `# Task\n${taskText(input.messages)}\n\n# Feedback on an earlier attempt\n${renderFeedback(input.feedback)}\n\n${renderOutput('to check', input.output)}`
      const { text, usage, failure, estimatedUsd } = await ask(input.trialId, settings, FEEDBACK_SYSTEM, user, signal)
      const parsed = failure === undefined ? parseFeedbackCheck(text) : undefined
      if (parsed === undefined) {
        return { status: 'unknown', reason: (failure ?? `the reviewer did not answer with the JSON object: ${text.slice(0, 300)}`).slice(0, 2_000), usage, requestCount: 1, estimatedUsd }
      }
      return { status: parsed.status, reason: parsed.reason.slice(0, 2_000) || '(no reason given)', usage, requestCount: 1, estimatedUsd }
    },
  }
}

/** Run the gate for one candidate of a project (the `gate` mode). */
export async function runGateProcess(root: string, candidateId: string, env: Env = process.env, options: { readonly comparison?: ImproverComparisonParams; readonly epoch?: string } = {}): Promise<GateResult> {
  const layout = resolveWorkspaceLayout(root)
  const ledger = new JsonlLedger({ ledgersDir: layout.ledgers })
  const endpoint = (await readProjectConfig(layout.configFile).catch(() => undefined))?.input.endpoint
  const candidate = await readCandidate(layout.capabilities, candidateId).catch(() => undefined)
  const improvement = candidate === undefined ? undefined : await candidateRunAttribution(layout, candidate)
  return runGate({
    layout,
    candidateId,
    runner: processReplayRunner({ args: [TRIAL_ENTRY, 'replay'], env: env as NodeJS.ProcessEnv }),
    reviewer: llmReviewer({ ledger, home: nexgentHome(env as NodeJS.ProcessEnv), env, ...(endpoint === undefined ? {} : { endpoint }), ...(improvement === undefined ? {} : { improvement }) }),
    log: line => process.stderr.write(`${line}\n`),
    documentText,
    ...(options.comparison === undefined ? {} : { comparison: options.comparison }),
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
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
