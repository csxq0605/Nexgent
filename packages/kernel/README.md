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
- `profiles/nexgent.yml` carries the product defaults: the Claude Platform route of ADR 0002 (`https://api.anthropic.com`, `claude-sonnet-5-5`, thinking off, effort medium, 16000 output tokens, 600 s request / 180 s idle timeouts, `maxRetries: 0`, server-side fallbacks on) and the PR #4 persona and suffix.

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

Policy (`permissions.md`): `decideToolPolicy` maps tool `approval` × sandbox mode to run / ask / deny; standing `session` grants (from `approval.grant`, survive resume) and `project` grants (`config.json.approvals`) are matched by command prefix or path glob. Tools escalate single calls through `KernelToolContext.requestApproval(ask)`; `context.approved` is `true` when the loop already asked. Cancellation aborts the request and tool signals; a cancelled stream is written as `assistant.message { interrupted: true }` with its delivered prefix. Every request carries `thinking` and `effort` (`.nexgent/config.json` → `agents` row → contract default). A `done` with `providerContent` (Claude's verbatim content blocks, preserved thinking) is written on the `assistant.message` record and replayed on every later request of the session, resume included. A `done { finishReason: 'refusal' }` ends the turn with `llm/refused` without running the reply's tool calls; a `max-tokens` reply with tool calls ends the turn `{ kind: 'max-tokens' }` without running them (the input may be truncated). Model timeouts (whole request and stream idle) end the turn with `llm/timeout`; tool `timeoutMs` yields `tool/timeout`; a throwing tool yields an `isError` result. `costCaps.perTask` (`maxRequests`, `maxTokens` = input + output) is checked before every request: `error` record `budget/exhausted`, `turn.end { cancelled, cost-cap }`, ledger `task.outcome`. Resume closes a turn the dead process left open with `turn.end { kind: 'interrupted' }` (when the store has not) and answers dangling tool calls in the request only.

`agent.ctx` is the agent's scoped context: `agent.ctx.tools.register()` / `restrict()` affect only that agent and vanish on `close`.

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

- `costCaps.perProject` is parsed but not enforced (step 1 defines the format only).
- No JSON Schema files for config / credentials / lock yet (`data-formats.md` lists them under this package).
- Tools run sequentially; no parallel tool execution.
- Secret redaction of tool output is the workspace package's job; the kernel does not redact.
