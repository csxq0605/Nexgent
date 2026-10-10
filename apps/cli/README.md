# @nexgent/cli

The `nexgent` command: `nexgent run` (new session, one task), `nexgent resume <sessionId>` (continue one) and `nexgent app` (desktop app; step 2). Owner of `scripts/accept-step1.mjs`.

**Status (step 1, week 4):** wired. `run` / `resume` boot the kernel's default profile (`packages/kernel/profiles/nexgent.yml`) with `@nexgent/llm` (Claude Platform, ADR 0002), `@nexgent/session` and `@nexgent/workspace` through one seam, [`src/runtime.ts`](src/runtime.ts). `scripts/accept-step1.mjs` passes on Linux against the scripted Claude Messages API server.

## Usage

```text
nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]
nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]
nexgent app --project <dir>
nexgent --version | --help | <command> --help
```

```sh
export NEXGENT_API_KEY=sk-ant-...
nexgent run --project ./my-project --task "Create hello.txt with one line: hello"
nexgent run --project ./my-project --task "Summarize README.md" > summary.txt   # stdout = the answer only
nexgent resume 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b --project ./my-project --task "Now add a test"
nexgent resume 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b --project ./my-project         # default task: continue
```

- `--project`: an existing directory (resolved against the cwd). The first run creates `.nexgent/{sessions,materials,outputs,capabilities,ledgers}` through the workspace service and writes `.nexgent/config.json` with the defaults; an existing config is never touched.
- `--sandbox`: `read-only | workspace-write | full-access`. Precedence: the flag, then `.nexgent/config.json` `sandboxMode`, then `workspace-write`. `resume` keeps the mode in the session header unless you pass the flag again. An invalid value fails; there is no silent fallback. With `full-access` the CLI prints a one-line warning.
- `--model`: model id for a new session (else `config.json` `model`, then the profile's `claude-sonnet-5-5`). On `resume` the session header's model is kept.
- Session ids are lowercase uuid v4; `resume` rejects anything else before touching the disk.
- `resume` without `--task` sends `RESUME_DEFAULT_TASK` ("Continue the previous task from where it stopped."). A turn the previous process never closed (crash, `kill -9`) is ended as `turn.end { kind: 'interrupted' }` first; the model sees the earlier history and the delivered prefix of the interrupted reply.
- Text mode: stdout carries only the assistant's streamed text. Progress goes to stderr: the session line, `> tool args`, `ok|error N ms: result`, approvals, turn status and a closing summary (status, requests, tool calls, tokens, with `?` for unknown).
- `--json`: stdout carries one bounded JSON object per event. Strings are capped at 8 KiB and lines at 32 KiB; the bounding is adapted from DSH headless `json-stream`. Events are the `CliEvent` union in `src/events.ts`, and the stream ends with an unbounded `final` line `{ sessionId, status, exitCode, text, totalUsage, requestCount, toolCallCount }`. A failure outside the stream writes `{ "type": "error", "error": { code, message } }`.
- Errors print as `nexgent: <message>`, or `nexgent: <code>: <message>` for `NexgentError`s, with no stack. Set `NEXGENT_DEBUG=1` to get the stack.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `NEXGENT_API_KEY` | The model API key (first choice). Read by the kernel credentials service on every request; the CLI only checks that it is present. |
| `ANTHROPIC_API_KEY` | Fallback key when `NEXGENT_API_KEY` is unset everywhere (the llm route's convention). |
| `NEXGENT_HOME` | Directory of the per-user `credentials.json` (`{ "version": 1, "credentials": { "NEXGENT_API_KEY": "..." } }`, mode `0600`); default `~/.nexgent`. A file with wider permissions is refused and counts as unconfigured. |
| `NEXGENT_API_BASE_URL` | Overrides the profile's endpoint (`https://api.anthropic.com`) with another origin: the acceptance script points it at the scripted server; a proxy works the same way. Against a non-`api.anthropic.com` host the llm route sends no server-side fallbacks beta. |
| `NEXGENT_DEBUG=1` | Print stacks for errors. |

The CLI hands its own `env` to the credentials and llm services (not `process.env`), so in-process tests and the acceptance script are hermetic.

### Exit codes (`src/exit-codes.ts`)

| Code | Meaning |
| --- | --- |
| 0 | task completed (also `--version`, `--help`) |
| 1 | task did not complete: model / tool error, cost cap, turn timeout, max tokens, interrupted |
| 2 | usage error, or not available in this build (`app`; a build whose runtime is not wired) |
| 3 | environment: project dir missing, no API key, bad config, session missing / locked |
| 4 | internal error (bug) |
| 130 | the user cancelled the turn (Ctrl+C) |
| 143 | terminated (SIGTERM / SIGHUP / SIGBREAK), turn closed as `shutdown` |

### Ctrl+C

The first Ctrl+C aborts the running turn: the runtime calls `agent.cancel('user')`, the model stream is aborted, the delivered prefix is written as `assistant.message { interrupted: true }`, the turn ends `cancelled`, the task outcome is written as `cancelled`, and the process exits 130. A second Ctrl+C, or a Ctrl+C with no turn running, exits at once. The lock left behind is reclaimed by the session store's stale-lock rule. SIGTERM, SIGHUP and (on Windows) SIGBREAK do the same with cause `shutdown` and exit 143. The logic is the pure `nextInterruptAction` plus `InterruptController`.

### Approvals

`createApprovalResponder` is the CLI's `ApprovalResponder` (kernel contract; `permissions.md` §CLI 与桌面应用共用的审批交互), registered with `ctx.approvals.setResponder` by the runtime. It needs a TTY on both stdin and stderr. It prints summary, detail, risk and the grant pattern, then `[a]llow once / [s]ession / [p]roject / [d]eny`, offering only the scopes in `request.options`. It waits up to 300 s, or less if `expiresAt` is sooner, and an unanswered request is denied with `decidedBy: 'timeout'`. Without a TTY it denies immediately with `decidedBy: 'headless'`. When the turn's signal aborts, it denies with `'cancel'`; when stdin closes, it denies with `'headless'`. Concurrent requests queue. The prompt goes to stderr so `--json` stdout stays clean. `project`-scope grants are persisted through the kernel's `appendProjectGrant` into `.nexgent/config.json` (`agents.setProjectGrantWriter`).

### Project data and credentials

- `initProjectLayout` (`src/layout.ts`) resolves `--project` against the cwd, checks that it is a directory, opens it with the workspace package's `openWorkspace(root, { ensureLayout: true })` (which creates `.nexgent/` and its subdirs), and writes `config.json` exclusively with `resolveProjectConfig()` defaults when missing.
- `requireApiKey` (`src/credentials.ts`) only checks that a key is present, through the kernel's `LocalCredentials` (same order and `0600` rule as the runtime) plus the `ANTHROPIC_API_KEY` fallback. It returns `{ configured, source }` and discards the value. A missing key exits 3 with setup instructions. The runtime repeats the check with `ctx.credentials.describe` before opening a session.

### PowerShell

`bin/nexgent.ps1` ports PR #4's `run.ps1` parameter design: `-Project` (default: current directory), `-SessionId` (switches to `resume`), `-Json`, and the task as the remaining positional words. It adds `-Sandbox` and `-Model`.

```powershell
./apps/cli/bin/nexgent.ps1 -Project C:\work\proj Write a hello.txt file
./apps/cli/bin/nexgent.ps1 -Project C:\work\proj -SessionId <id> -Json Continue with the README
```

## The runtime seam (`src/runtime.ts`)

`loadRuntime()` returns the wired `CliRuntime`; `open(options)` boots one app per run and returns a `RuntimeSession`:

- Boot: `createApp()` on the default profile with the registry `{ '@nexgent/kernel/credentials' (LocalCredentials over the CLI's env + NEXGENT_HOME), '@nexgent/llm' (AnthropicProvider over the CLI's env), '@nexgent/session', '@nexgent/workspace' }` and the patch `{ id: 'workspace', config: { root } }`.
- `open()`: `ctx.credentials.describe(NEXGENT_API_KEY)` (with the `ANTHROPIC_API_KEY` fallback) → `credentials/missing`; `ctx.approvals.setResponder(approvals)`; `agents.setProjectGrantWriter(appendProjectGrant)`; then `agents.create({ sessionId: uuid v4, model?, sandboxMode? })` or `agents.resume(id, { sandboxMode? })` (takes the lock, closes an open turn as `interrupted`). `info` is the opening `session` event.
- `runTurn(task, signal)`: `agent.run(task)` with `agent.subscribe` feeding an async queue; the CLI's abort signal becomes `agent.cancel(signal.reason)` so `shutdown` keeps its cause. On resume, the interrupted turn's `turn.end` is yielded first. If `run` rejects (store failure), a synthetic `turn.end { kind: 'error' }` closes the stream; the iterator never throws for request-level failures.
- `recordOutcome(outcome)`: the kernel writes the one `task.outcome` per run on `agent.close()` with its own tallies (they match the CLI's `TaskTally`); the CLI only passes its `status` through `close({ status })`, so the ledger holds exactly one outcome per finished process and the CLI's status (`max-tokens` → `failed`) wins over the kernel's derivation.
- `close()`: closes the agent (releases the lock) and disposes the app; idempotent, shared with `recordOutcome`.

Event mapping (`mapAgentEvent`):

| `AgentEvent` (kernel) | `CliEvent` |
| --- | --- |
| `turn.start` | `turn.start` |
| `request.start` | `step.start { turn, step, requestId }` (one per model request; drives `requestCount`) |
| `text.delta`, `reasoning.delta`, `tool-call.start` | forwarded verbatim |
| `assistant.message` | `tool-call.end` per completed call, then `usage` (the loop reports usage per step) |
| `tool.start` | `tool.start { callId, name, arguments }` |
| `tool.result` | `tool.end { callId, name, isError, content, durationMs }` |
| `approval.request`, `approval.decision` | forwarded |
| `error` | `run.error { error, fatal }` (budget exhausted, ledger write failure) |
| `turn.end` | `turn.end` (exactly one per turn, last) |
| `record`, `closed` | dropped |

## Acceptance script

`node scripts/accept-step1.mjs [--out summary.json] [--work-dir dir]` runs these steps on a temp project, using the scripted Claude Messages API server from `@nexgent/test-support` (loaded from its built `dist/`; run `pnpm build` first). The child processes get `NEXGENT_API_KEY=<fake>`, `NEXGENT_API_BASE_URL=<server origin>` and `NEXGENT_HOME=<temp>`:

1. `nexgent run` performs a write-file task. The script checks the file, the session JSONL (turn 1 completed, lock released) and the ledger (paired requests, `task.outcome`).
2. `nexgent resume` starts a long turn (the server stalls after the first text chunk), which is killed hard mid-stream.
3. A new process runs `nexgent resume`. The script checks that turn 2 is `interrupted`, turn 3 is completed, `seq` is contiguous, the turn-1 history reached the model (Messages API `messages[]` with text blocks), the second file exists, each finished process has exactly one outcome, and exactly one unpaired (killed) request remains.

It writes test-support's acceptance summary (the fields of `docs/validation/TEMPLATE.md`) and exits 0 on pass, 1 on fail, and 2 when it cannot run (build missing). It never fakes a pass. All test-support access goes through `scripts/accept-common/harness.mjs`; the scenario data and pure checks are in `scripts/accept-common/scenario.mjs`.

## Tests

`pnpm exec vitest run --project @nexgent/cli`. Unit tests cover parsing, layout, credentials, rendering, approvals, signals, the tally and `main()` over a fake runtime; `tests/e2e.spec.ts` drives `main()` in process against `scriptedModelServer` on a temp project (run → `write_file` → session + ledger; resume with an interrupted turn and the history; Ctrl+C mid-stream; missing session); `tests/accept-common.spec.ts` runs `scripts/accept-step1.mjs` itself.

## DSH references

| DSH (46a7f68b) | Used for |
| --- | --- |
| `packages/bundle/headless/src/json-stream.ts` | `src/json-lines.ts` (adapted: bounded JSON lines) |
| `apps/cli/src/process-shutdown.ts` | design of the two-step interrupt (rewritten as `signals.ts`) |
| `packages/bundle/headless` (README, `index.ts`) | one-shot run shape, stdout/stderr split, `final` line, exit 0/1 (extended) |
| `packages/boot/cmdline`, `apps/cli/src/args.ts` | argument-parsing conventions (rewritten on `util.parseArgs`, no commander) |
| `packages/bundle/base` | read only; profile composition belongs to the kernel |

## Not done yet

- `accept-step1` has passed on Linux only; Windows (CI `windows-latest`) and macOS runs are pending.
- `nexgent.ps1` has not been executed (no PowerShell in the authoring environment).
- Real Claude Platform manual run and its summary under `docs/validation/step-1/`.
- Approval prompts are not exercised end to end (no TTY in tests; headless denies).
- `nexgent app` (step 2).
