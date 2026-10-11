# @nexgent/kernel

The Nexgent runtime kernel: the frozen service contracts (`src/contracts/`), profile boot, `ctx.agents` and the agent loop, `ctx.tools`, `ctx.approvals`, `ctx.credentials`, system-prompt assembly, and the atomic-write / JSON storage primitives. It imports no other `@nexgent/*` package; the model route, session store and workspace arrive as Cordis plugins the host registers by name.

## Boot

```ts
import { createApp, loadPatchFile } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { WorkspacePlugin } from '@nexgent/workspace'
import { LLMPlugin } from '@nexgent/llm'

const app = await createApp({
  // profile: defaults to profiles/nexgent.yml (defaultProfile())
  patches: [{ id: 'workspace', config: { root: projectDir } }, ...(await loadPatchFile('my.patch.yml'))],
  registry: { '@nexgent/llm': LLMPlugin, '@nexgent/session': SessionPlugin, '@nexgent/workspace': WorkspacePlugin },
})
```

- A profile is a YAML sequence of `AppProfileRow`s (`id`, `name`, `config?`, `disabled?`); patch files use the `cordis.patch.yml` form (`{ insert: [rows] }` or `{ id, name?, config?, disabled? }`) and are applied with the contract's `applyProfilePatches`. No `!!js` tags.
- Each enabled row is started in order with `ctx.plugin(plugin, config)`, so the plugin's schemastery `Config` validates its config. A host registry entry wins over the kernel's own plugins (`@nexgent/kernel/credentials|tools|approvals|agents`). Unknown names, rejected configs, start failures and services that never appear fail the boot with `config/invalid`.
- `profiles/nexgent.yml` carries the product defaults: the Claude Platform route of ADR 0002 (`https://api.anthropic.com`, `claude-sonnet-5-5`, thinking on (adaptive, ADR 0003), effort medium, 16000 output tokens, 600 s request / 180 s idle timeouts, `maxRetries: 0`, server-side fallbacks on) and the PR #4 persona and suffix.

## Agents

```ts
app.ctx.approvals.setResponder(async (request, signal) => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }))
app.agents.setProjectGrantWriter((grant, { projectRoot }) => appendProjectGrant(configFile, grant)) // optional

const agent = await app.agents.create({ sandboxMode, model, title })   // or app.agents.resume(sessionId, { sandboxMode })
const off = agent.subscribe(event => render(event))                      // or: for await (const e of agent.events())
const result = await agent.run('task text', { signal })                  // TurnResult { turn, reason, text, usage }
agent.cancel()                                                            // cause 'user'; keeps streamed text
await agent.close()                                                       // task.outcome, release lock, dispose scope
```

A turn writes `turn.start`, `user.message`, then per model call `assistant.message` and per tool call (`approval.request` → `approval.decision` → `approval.grant`?) `tool.result`, then `turn.end`; ledger `tool.call` per call and one `task.outcome` per task (on `close`, or immediately on a cost cap). Events (`AgentEvent`): `turn.start`, `request.start`, `text.delta`, `reasoning.delta`, `tool-call.start`, `assistant.message`, `tool.start`, `approval.request`, `approval.decision`, `tool.result`, `error`, `turn.end`, `record` (every persisted session record), `closed`.

Policy (`permissions.md`): `decideToolPolicy` maps tool `approval` × sandbox mode to run / ask / deny; standing `session` grants (from `approval.grant`, survive resume) and `project` grants (`config.json.approvals`) are matched by command prefix or path glob. Tools escalate single calls through `KernelToolContext.requestApproval(ask)`; `context.approved` is `true` when the loop already asked. Cancellation aborts the request and tool signals; a cancelled stream is written as `assistant.message { interrupted: true }` with its delivered prefix. Every request carries `thinking` and `effort` (`.nexgent/config.json` → `agents` row → contract default). A `done` with `providerContent` (Claude's verbatim content blocks, preserved thinking) is written on the `assistant.message` record and replayed on every later request of the session, resume included. A `done { finishReason: 'refusal' }` ends the turn with `llm/refused` without running the reply's tool calls; a `done { finishReason: 'pause' }` (Claude `pause_turn`) is recorded and sent back unchanged on the next request, with no new user message, up to `maxPauseContinuations` (default 8) consecutive pauses, after which the turn ends with `llm/invalid-response`; a `max-tokens` reply with tool calls ends the turn `{ kind: 'max-tokens' }` without running them (the input may be truncated). Model timeouts (whole request and stream idle) end the turn with `llm/timeout`; tool `timeoutMs` yields `tool/timeout`; a throwing tool yields an `isError` result. `costCaps.perTask` (`maxRequests`, `maxTokens` = input + output) is checked before every request, then `costCaps.perProject`: the ledger is read once per turn over the last `windowDays` (default 30; every `llm.request.start` is a request, `llm.request.end` adds its known input + output tokens) and the task's own requests since that read are added. Reaching either cap writes an `error` record `budget/exhausted` (`details.scope` `task` or `project`), `turn.end { cancelled, cost-cap }` and ledger `task.outcome`; when the ledger cannot be read the turn ends with an error before any request is sent (an unknown total is not under the cap). The system prompt adds a "Working with files" section (edit with `str_replace`, create with `write_file`, which refuses existing files, write files only through those two and keep the shell for running things, declare results with `present` and pass `deliverableId` for a revision), each line only when that tool is offered, plus a line that `.nexgent/materials/` is read-only when the project has materials. Resume closes a turn the dead process left open with `turn.end { kind: 'interrupted' }` (when the store has not) and answers dangling tool calls in the request only.

`agent.ctx` is the agent's scoped context: `agent.ctx.tools.register()` / `restrict()` affect only that agent and vanish on `close`.

### Step-2 hooks

The loop calls the optional services `ctx.context` (`ContextService`) and `ctx.tasking` (`TaskingService`) at the points `docs/spec/agent-hooks.md` fixes; both are looked up at each turn start without an inject requirement, and without them a turn runs exactly as in step 1. Both are declared on `Context` in `services.ts` with the contract types; another package may repeat the declaration with the same type.

- Turn input: `agent.run(text)` or `agent.run({ text, materialIds? })` for a user turn, `agent.run({ source: 'feedback', feedback })` for a feedback turn (`feedback` record after `turn.start`, message text `renderFeedbackPrompt(feedback)`). `materialIds` go on the user message as `materials`.
- Turn start: `files.beginTurn`, then each provider's `beginTurn` with the session state read just before `turn.start` (never mid-turn: a lock-holding `JsonlSessionStore.resume` closes an open turn as interrupted). Sections are rendered for every request of the turn (provider order, then `id`) after "Working with files"; `inject` texts are written as `user.message { source: 'inject' }` before the user message. A throwing provider is skipped with a non-fatal `error` record. A failed `beginTurn` writes an `error` record and the turn runs untracked (no `turn.files`).
- Before each model call: `compactor.shouldCompact` with the agent's last reported usage (unknown after resume until the first request); on `compact` the kernel checks `keepMessages` (1..history length, tail starts with `user`), writes `compaction`, replaces the in-memory history with the summary plus the tail and counts the summary request in the task's totals. A failure writes a non-fatal `error`, keeps the history and skips compaction for the rest of the turn.
- Tools: `KernelToolContext.step` and `appendRecord(record)`, which accepts the tool record types (`TOOL_RECORD_TYPES`: `deliverable.presented` with this call's `turn` / `step` / `toolCallId`; the step-3 `subagent.*`, `team.*`, `workflow.*` with this call's `turn`, stamped when an optional one is left out, and this call's `toolCallId` where the record has one) before the call settles; a refused or failed append ends the call as `tool/failed` even if the handler caught it. `files.observe` runs after every `tool.result`; its errors are ignored.
- Turn end: `files.endTurn` (its signal fires `FILES_END_CANCEL_MS` = 5 s after the turn is cancelled), then `turn.files` sorted by path, at most `TURN_FILES_LIMIT` entries plus `omitted`; a failure writes an `error` record instead. Then `turn.end`.
- Host records: `agent.appendHostRecord(record)` (a `HostRecordSink`) accepts `HOST_RECORD_TYPES` (`material.added`, `goal.set`, `goal.update`, `session.title`, and for step 3 `subagent.end`, `team.*`, `workflow.phase`, `workflow.end`); during a turn it adds the running turn's number, between turns the record has none; any other type or another turn number is refused with `session/invalid-record`.

### Step-3 members

ADR 0004, `permissions.md` §子会话继承, `agent-hooks.md` §宿主接口 (step 3).

```ts
const member = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'helper', executionForm: 'delegated' }, preset, sandboxMode, mode: 'fork', budget } })
await member.run(task, { signal })                                       // one member run = one turn of the child session
await member.close()                                                      // the member's own task.outcome
await app.agents.resume(id, { child: { parentSessionId: root.sessionId }, preset })   // a teammate in a later Lead turn
root.holdTurn(work)                                                       // keep the turn open until work (e.g. writing subagent.end) settles
```

- Parent: a root agent open in this process (`session/not-found` otherwise); a member as parent is `tool/denied` (depth 1), as is the 17th member of one task (`COLLABORATION_LIMITS.maxMembersPerTask`). A child session is resumed only with `child`, under its open parent.
- Header and history: `session.start` carries `parentSessionId` and `member` (the preset's name added when the identity leaves it out). `mode: 'fork'` writes `fork.seed` at seq 2: the parent's history as of the end of its last completed turn (`agent.forkSeed()`), `throughSeq` that turn's `turn.end`.
- Narrowing: sandbox `childSandboxMode(parent, preset, request)` (wider is `sandbox/denied`); tools: the member scope inherits the parent scope's restrictions (`ToolRegistryService.inherit`), then denies `MEMBER_DENIED_TOOLS`, then applies the preset's `tools`; the preset's `persona` replaces the default persona, its `model`, `effort`, `thinking`, `maxSteps` apply (else the parent's). `resume` re-checks the sandbox against the parent and takes the preset again from `ResumeAgentOptions.preset` (the header keeps only its name).
- Prompt: a member's system prompt has `renderMemberPromptLine(member)` (`Member: <name> (<form>)`) on its own line after the persona, then one sentence on its role. A prompt that offers `delegate`, `spawn_teammate` or `workflow` gets `# Working with others` (do it yourself by default; delegate / team / workflow principles; members write to their own subdirectory, the root reads their results and presents).
- Attribution: every agent has `attribution` (`taskId` minted when a root opens, `memberId` `main` or the member's session id, `executionForm`). It is on the agent's `tool.call` and `task.outcome` records, in the `complete` options of its requests (`@nexgent/llm` writes it on `llm.request.*`) and on `ToolContext.attribution` / `member`. A root's `task.outcome` adds `formsUsed` (`agent.formsUsed()`). The `@nexgent/session` ledger stamps the same fields on records a host writes outside the loop with the `sessionId` of an open agent (an SDK's `task.outcome`, a compactor's request).
- Cost: `costCaps.perTask` counts the whole tree (root and members share one total); a member's `budget` (`BudgetShare`) caps its own requests / tokens. The member that hits a cap ends `cancelled / cost-cap`; the parent's next request is refused the same way.
- Cancel: a cancelled parent turn cancels its running members at once with cause `parent`; when a parent turn's loop ends for any reason, running members are cancelled with `parent` and the turn waits for them and for `holdTurn` work at most `toolAbortGraceMs` before `turn.end`. Closing a parent closes its members (`closeAs('parent')`).
- Approvals: a member's requests go through the same broker and rules; `ApprovalRequest.member` names it (`name`, `executionForm`, `parentSessionId`). `session` grants stay per session; `project` grants obtained by any session of the tree apply to the whole tree at once.

## Other services and primitives

- `ctx.tools` (`ToolRegistryService`): contract `ToolRegistry`; global registrations from non-agent contexts, fiber-scoped disposal.
- `ctx.approvals` (`ApprovalBrokerService`, config `timeoutMs`): one responder; none → deny `timeout`; abort → `cancel`; late answers dropped.
- `ctx.credentials` (`CredentialsService` / `LocalCredentials`): env var, then `<NEXGENT_HOME or ~/.nexgent>/credentials.json`; POSIX mode wider than 0600 is refused with a `chmod 600` hint; no caching. `saveCredential` writes it with 0600.
- `readProjectConfig` / `parseProjectConfig` / `appendProjectGrant` for `.nexgent/config.json`.
- `writeFileAtomic` (temp + fsync + rename + dir fsync, Windows rename retry), `readJsonFile`, `writeJsonFile`, `JsonStore`.
- `deadline` / `timeoutOf`, `renderSystemPrompt`, `validateJsonSchema`.

## DSH references

Adapted (file headers say so): `util/atomic-write`, `storage/storage-json` (atomic, JSON store), `util/timeout`, `boot/app-boot` (profile, app boot), `core/agent` + `core/agent-default-model` (agents service), `core/tools` + `core/scope` (scoped registry). Design references without copied code: `core/agent-loop`, `core/system-prompt`, `credentials/credentials(-local)`, `guard/timeout-policy`.

## Not done yet

- No JSON Schema files for config / credentials / lock yet (`data-formats.md` lists them under this package).
- Tools run sequentially; no parallel tool execution.
- The kernel enforces the member total per task, not `maxConcurrentMembers`: the workflow and team packages limit concurrency.
- Secret redaction of tool output is the workspace package's job; the kernel does not redact.
