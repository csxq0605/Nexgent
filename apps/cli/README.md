# @nexgent/cli

The `nexgent` command: `nexgent run` (new session, one task), `nexgent resume <sessionId>` (continue one) and `nexgent app` (desktop app; step 2). Owner of `scripts/accept-step1.mjs`.

**Status (step 1, phase 2):** the skeleton is complete — parsing, project data directory, API-key presence check, rendering, approval prompt, Ctrl+C handling, task outcome, exit codes. The runtime packages (kernel / llm / session / workspace) are wired in week 4 through one seam, [`src/runtime.ts`](src/runtime.ts); until then `run` / `resume` exit `2` with `runtime not wired yet`.

## Usage

```text
nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]
nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]
nexgent app --project <dir>
nexgent --version | --help | <command> --help
```

- `--sandbox`: `read-only | workspace-write | full-access`. Precedence: the flag, then `.nexgent/config.json` `sandboxMode`, then `workspace-write`. `resume` keeps the mode in the session header unless you pass the flag again. An invalid value fails; there is no silent fallback. With `full-access` the CLI prints a one-line warning.
- `resume` without `--task` sends `RESUME_DEFAULT_TASK` ("Continue the previous task from where it stopped."). A turn the previous process never closed is ended as `interrupted` first. That is the runtime's job (see the seam).
- Text mode: stdout carries only the assistant's streamed text. Progress goes to stderr: the session line, `> tool args`, `ok|error N ms: result`, approvals, turn status and a closing summary (status, requests, tool calls, tokens, with `?` for unknown).
- `--json`: stdout carries one bounded JSON object per event. Strings are capped at 8 KiB and lines at 32 KiB; the bounding is adapted from DSH headless `json-stream`. Events are the `CliEvent` union in `src/events.ts`, and the stream ends with an unbounded `final` line `{ sessionId, status, exitCode, text, totalUsage, requestCount, toolCallCount }`. A failure outside the stream writes `{ "type": "error", "error": { code, message } }`.
- Errors print as `nexgent: <message>`, or `nexgent: <code>: <message>` for `NexgentError`s, with no stack. Set `NEXGENT_DEBUG=1` to get the stack.

### Exit codes (`src/exit-codes.ts`)

| Code | Meaning |
| --- | --- |
| 0 | task completed (also `--version`, `--help`) |
| 1 | task did not complete: model / tool error, cost cap, turn timeout, max tokens, interrupted |
| 2 | usage error, or not available in this build (`app`, runtime not wired) |
| 3 | environment: project dir missing, no API key, bad config, session missing / locked |
| 4 | internal error (bug) |
| 130 | the user cancelled the turn (Ctrl+C) |
| 143 | terminated (SIGTERM / SIGHUP / SIGBREAK), turn closed as `shutdown` |

### Ctrl+C

The first Ctrl+C aborts the running turn. The turn signal's `reason` is the `TurnCancelCause` `user`, the turn ends `cancelled`, text already streamed is kept, the task outcome is written, and the process exits 130. A second Ctrl+C, or a Ctrl+C with no turn running, exits at once. The lock left behind is reclaimed by the session store's stale-lock rule. SIGTERM, SIGHUP and (on Windows) SIGBREAK do the same with cause `shutdown` and exit 143. The logic is the pure `nextInterruptAction` plus `InterruptController`.

### Approvals

`createApprovalResponder` is the CLI's `ApprovalResponder` (kernel contract; `permissions.md` §CLI 与桌面应用共用的审批交互). It needs a TTY on both stdin and stderr. It prints summary, detail, risk and the grant pattern, then `[a]llow once / [s]ession / [p]roject / [d]eny`, offering only the scopes in `request.options`. It waits up to 300 s, or less if `expiresAt` is sooner, and an unanswered request is denied with `decidedBy: 'timeout'`. Without a TTY it denies immediately with `decidedBy: 'headless'`. When the turn's signal aborts, it denies with `'cancel'`; when stdin closes, it denies with `'headless'`. Concurrent requests queue. The prompt goes to stderr so `--json` stdout stays clean.

### Project data and credentials

- `initProjectLayout` (`src/layout.ts`) resolves `--project` against the cwd and checks that it is a directory. It creates `.nexgent/{sessions,materials,outputs,capabilities,ledgers}` from the kernel contract helpers (`resolveWorkspaceLayout`, `NEXGENT_SUBDIRS`). If `config.json` is missing, it writes it exclusively with `resolveProjectConfig()` defaults and never overwrites an existing one. INTERIM: `Workspace.ensureLayout()` replaces it at wiring.
- `requireApiKey` (`src/credentials.ts`) only checks that a key is present: `NEXGENT_API_KEY` first, then `credentials.json` in `$NEXGENT_HOME` or `~/.nexgent`. It returns `{ configured, source }` and discards the value. A missing key exits 3 with setup instructions. INTERIM: `ctx.credentials.describe` replaces it, and that is also where the `0600` permission check lives.

### PowerShell

`bin/nexgent.ps1` ports PR #4's `run.ps1` parameter design: `-Project` (default: current directory), `-SessionId` (switches to `resume`), `-Json`, and the task as the remaining positional words. It adds `-Sandbox` and `-Model`.

```powershell
./apps/cli/bin/nexgent.ps1 -Project C:\work\proj Write a hello.txt file
./apps/cli/bin/nexgent.ps1 -Project C:\work\proj -SessionId <id> -Json Continue with the README
```

## The runtime seam (`src/runtime.ts`)

`CliRuntime.open(options)` returns a `RuntimeSession`, which provides:

- `info`: the opening `session` event.
- `runTurn(task, signal)`: an async iterable of `CliEvent` that ends with exactly one `turn.end`; abort reason `user` or `shutdown`.
- `recordOutcome(taskOutcome)`: appends the ledger `task.outcome` that the CLI builds with `TaskTally`.
- `close()`.

The file's header lists the five wiring steps. `CliEvent` re-uses the LLM contract's stream events verbatim and adds `session`, `turn.start`, `step.start` (one per model request, which is how `requestCount` and unknown-usage steps are counted), `tool.start`, `tool.end`, `approval.request`, `approval.decision`, `turn.end` and `run.error`. The integrator maps the kernel loop's events onto it there.

## Acceptance script

`node scripts/accept-step1.mjs [--out summary.json] [--work-dir dir]` runs these steps on a temp project, using the scripted OpenAI-compatible server from `@nexgent/test-support`:

1. `nexgent run` performs a write-file task. The script checks the file, the session JSONL (turn 1 completed, lock released) and the ledger (paired requests, `task.outcome`).
2. `nexgent resume` starts a long turn, which is killed hard mid-stream.
3. A new process runs `nexgent resume`. The script checks that turn 2 is `interrupted`, turn 3 is completed, `seq` is contiguous, the history reached the model, the second file exists, each finished process has an outcome, and exactly one unpaired (killed) request remains.

It writes test-support's acceptance summary (the fields of `docs/validation/TEMPLATE.md`) and exits 0 on pass, 1 on fail, and 2 when it cannot run yet (build missing, scripted server or runtime not wired). It never fakes a pass. All test-support access goes through `scripts/accept-common/harness.mjs`; the scenario data and pure checks are in `scripts/accept-common/scenario.mjs`.

## DSH references

| DSH (46a7f68b) | Used for |
| --- | --- |
| `packages/bundle/headless/src/json-stream.ts` | `src/json-lines.ts` (adapted: bounded JSON lines) |
| `apps/cli/src/process-shutdown.ts` | design of the two-step interrupt (rewritten as `signals.ts`) |
| `packages/bundle/headless` (README, `index.ts`) | one-shot run shape, stdout/stderr split, `final` line, exit 0/1 (extended) |
| `packages/boot/cmdline`, `apps/cli/src/args.ts` | argument-parsing conventions (rewritten on `util.parseArgs`, no commander) |
| `packages/bundle/base` | read only; profile composition belongs to the kernel |

## Not done yet

- Runtime wiring (week 4): `loadRuntime()`, the event mapping and `NEXGENT_API_BASE_URL` handling in the llm route.
- `accept-step1` has not passed anywhere yet; it needs the wired runtime. Its tool name `write_file` is marked `WIRE`.
- `nexgent.ps1` has not been executed (no PowerShell in the authoring environment).
- Real MiMo manual run and its summary under `docs/validation/step-1/`.
- `nexgent app` (step 2).
