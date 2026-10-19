# @nexgent/cli

The `nexgent` command: `nexgent run` (new session, one task), `nexgent resume <sessionId>` (continue one), `nexgent export <sessionId>` (minimal export bundle), `nexgent improve` (improvement jobs, including meta jobs), `nexgent improvers` (improver versions) and `nexgent app` (launch the desktop app).

**Status (step 2, W4):** the CLI goes through `@nexgent/sdk`, the in-process API the desktop app shares. `run` / `resume` open the project and the session through the SDK (kernel default profile + `@nexgent/llm`, `@nexgent/session`, `@nexgent/workspace`, `@nexgent/context`, `@nexgent/skill`, `@nexgent/tasking`) behind one seam, [`src/runtime.ts`](src/runtime.ts); their behavior is unchanged except that each turn now also records its file changes (`turn.files`) and gets the step-2 context (instructions file, materials, skills).

## Usage

```text
nexgent run --project <dir> --task "<text>" [--sandbox <mode>] [--model <id>] [--json]
nexgent resume <sessionId> --project <dir> [--task "<text>"] [--sandbox <mode>] [--json]
nexgent export <sessionId> --project <dir> [--out <dir>] [--json]
nexgent improve list --project <dir> [--json]
nexgent improve show <jobId> --project <dir> [--json]
nexgent improve run --project <dir> [--session <id>] [--deliverable <id>] [--json]
nexgent improve meta --project <dir> [--json]
nexgent improve cancel <jobId> --project <dir> [--json]
nexgent improvers list --project <dir> [--json]
nexgent improvers show <version> --project <dir> [--json]
nexgent improvers rollback [--to <version>] [--reason <text>] --project <dir> [--json]
nexgent app [--project <dir>]
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
- Members (step 3: `delegate`, teammates, workflow members): stderr shows `> member <name> (<form>[, <preset>]) started: session <id>`, then `  member <name> <status>[: error]; tokens …` and one `  member deliverable: <title> v<n> (<files>)` line per version it presented. `--json` adds `member.start` / `member.end` lines. The members' own streams are not shown; an approval a member asks for names it (`(requested by member <name>, <form>)`).
- `export`: writes `session.jsonl`, the session's ledger lines (`ledger.jsonl`), `materials.json`, `deliverables.json` and `manifest.json` into `--out` (default `./nexgent-export-<sessionId>`; must be missing or empty, else exit 1). API key values in force are searched for in every file and replaced by `[REDACTED]`. No model request is made. `--json` prints one line `{ type: 'export', sessionId, path, files }`.
- `improve` (step 5 improvement jobs, through the SDK's `improvements.*`; no model request is made by the command itself):
  - `list`: a header line (`pending <n>/<threshold>`, `active <id>` when a job holds the slot, `budget <used>/<max> tokens in <days> days`), then (when the SDK reports it) a `meta: on|off, <n>/<k> finished jobs counted, budget <used>/<max> tokens (<days> days)` line, then one line per job, newest first: short id (8 chars), kind (`job` or `meta`), status, trigger, improver version (12 chars, `v0` for step-5 jobs), created time (UTC), billed tokens (`unknown` when any phase is) and estimated cost (`≈ $0.12` or `unknown`); a job's `detail` follows on an indented line. Without jobs: `No improvement jobs yet.`
  - `show <jobId>`: status history, trigger and item count, the diagnosis (hypothesis, proposal kind, failure categories with labels and evidence counts), the improver version the job ran on, the candidate (components, status, decision), the gate verdict from the trial receipts, tokens per phase, estimated cost, first use and a rolled-back note, when present. `<jobId>` is a full id or a unique prefix; an unknown id exits 3, an ambiguous prefix exits 2.
  - `run [--session <id>] [--deliverable <id>]`: starts a job now and returns; the job keeps running in the background (follow it with `list` / `show`). Needs an API key (exit 3 without). When a job already runs, or the improvement budget is spent, it prints a readable message and exits 1.
  - `meta`: starts a meta job now (it diagnoses finished jobs, proposes one typed change to the improver and compares the old and new improver on a past task) and returns; follow it with `list` / `show`. Needs an API key (exit 3 without); busy / budget spent exit 1 as for `run`. `show` of a meta job adds the meta diagnosis (hypothesis, proposal, findings with stage, label and job ids), the change (op and fields, parent -> child version, rationale) and the comparison (origin job, each arm's improver version, status, candidate, gate verdict and pass rate, tokens and estimated cost, then the verdict with quality and cost ratio).
  - `cancel <jobId>`: cancels a job that has not finished (prefix allowed).
  - `--json` prints one line `{ type: 'improve.list' | 'improve.show' | 'improve.run' | 'improve.meta' | 'improve.cancel', ... }`.
  - `run` / `resume` print one line to stderr at the end (`nexgent: background improvement job <id> <status>; follow it with ...`) when a job started or changed status during the run; nothing otherwise.
- `improvers` (step 6 improver versions, through the SDK's `improvers.*`; no model request): versions print as 12 characters in text (full in `--json`); `<version>` is `v0`, a full sha256 or a unique prefix.
  - `list`: current version, revision, since, trigger, job and any load problem, then the activation history, oldest first (`#<n> adopt|rollback <from> -> <to>, <trigger>, job, time[: reason]`).
  - `show <version>`: whether it is in force, the diagnosis paragraph count and first lines, proposal kinds, comparison parameters and the change that produced it. An unknown version exits 3, an ambiguous prefix exits 2.
  - `rollback [--to <version>] [--reason <text>]`: returns to the previous improver (or to any earlier one, `v0` included) and prints the new current version.
  - `--json` prints one line `{ type: 'improvers.list' | 'improvers.show' | 'improvers.rollback', ... }`.
- `app`: starts the desktop app detached and returns 0: the app directory is `NEXGENT_DESKTOP_DIR`, else the monorepo's `apps/desktop`; Electron is `NEXGENT_ELECTRON`, else the `electron` package resolved from the app. The app gets `<appDir> [--project <abs>]`. Exit 2 (`cli/app-not-found`) when the app or Electron is missing.
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
| 2 | usage error, or not available in this build (`app` without a built desktop app; a build whose runtime is not wired) |
| 3 | environment: project dir missing, no API key, bad config, session missing / locked |
| 4 | internal error (bug) |
| 130 | the user cancelled the turn (Ctrl+C) |
| 143 | terminated (SIGTERM / SIGHUP / SIGBREAK), turn closed as `shutdown` |

### Ctrl+C

The first Ctrl+C aborts the running turn: the runtime calls the SDK's `cancelTurn({ cause: 'user' })` (the agent's `cancel('user')`), the model stream is aborted, the delivered prefix is written as `assistant.message { interrupted: true }`, the turn ends `cancelled`, the task outcome is written as `cancelled`, and the process exits 130. A second Ctrl+C, or a Ctrl+C with no turn running, exits at once. The lock left behind is reclaimed by the session store's stale-lock rule. SIGTERM, SIGHUP and (on Windows) SIGBREAK do the same with cause `shutdown` and exit 143. The logic is the pure `nextInterruptAction` plus `InterruptController`.

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

`loadRuntime()` returns the wired `CliRuntime`; `open(options)` creates one SDK instance per run and returns a `RuntimeSession`:

- Boot: `createSdk({ appVersion, env, approvalResponder })`. The SDK boots the project's application with the CLI's `env` (`NEXGENT_API_BASE_URL`, `NEXGENT_HOME`, `NEXGENT_COMPACTION_THRESHOLD`) and registers the CLI's TTY prompt as the approval responder; `project`-scope grants go to `.nexgent/config.json` through `appendProjectGrant`.
- `open()`: `projects.open`; `settings.get` → no key → `credentials/missing`; then `createSession({ model?, sandboxMode? })` + `openSession`, or `openSession({ sessionId, sandboxMode? })` (takes the lock; a turn the dead process left open is closed as `interrupted` and reported as an SDK `turn.end` event, which `runTurn` replays first). `info` is the opening `session` event. Opening also adds the project to `~/.nexgent/recent-projects.json`.
- `runTurn(task, signal)`: `startTurn` with the SDK's raw kernel events (`onAgentEvent`, in-process only) feeding an async queue; the CLI's abort signal becomes `cancelTurn({ cause })` so `shutdown` keeps its cause. If the turn cannot run at all, a synthetic `turn.end { kind: 'error' }` closes the stream; the iterator never throws for request-level failures.
- `recordOutcome(outcome)`: no-op. The SDK appends one `task.outcome` per turn when it ends (a `run` / `resume` is one turn), with the same status mapping as the CLI's `TaskTally` (`completed` / `cancelled` / anything else `failed`); a cost-cap stop keeps the kernel's own record.
- `close()`: `sessions.close` (releases the lock) and `sdk.dispose()`; idempotent.

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

`scripts/accept-step1.mjs` (run → kill mid-stream → resume through the CLI) was retired on 2026-10-11. The step-2 acceptance script `scripts/accept-step2.mjs` covers that chain in its headless layer (through `@nexgent/sdk`, with the kills in child processes) and uses `nexgent export`; `scripts/accept-common/scenario.mjs` remains as the scenario data of the PowerShell launcher smoke (`ps1-smoke.mjs`).

## Tests

`pnpm exec vitest run --project @nexgent/cli`. Unit tests cover parsing, layout, credentials, rendering, approvals, signals, the tally and `main()` over a fake runtime; `tests/e2e.spec.ts` drives `main()` in process against `scriptedModelServer` on a temp project (run → `write_file` → session + ledger; resume with an interrupted turn and the history; Ctrl+C mid-stream; export; missing session); `tests/app-launch.spec.ts` starts a stand-in desktop app with Node playing Electron; `tests/accept-common.spec.ts` checks the scenario data of the PowerShell launcher smoke.

## DSH references

| DSH (46a7f68b) | Used for |
| --- | --- |
| `packages/bundle/headless/src/json-stream.ts` | `src/json-lines.ts` (adapted: bounded JSON lines) |
| `apps/cli/src/process-shutdown.ts` | design of the two-step interrupt (rewritten as `signals.ts`) |
| `packages/bundle/headless` (README, `index.ts`) | one-shot run shape, stdout/stderr split, `final` line, exit 0/1 (extended) |
| `packages/boot/cmdline`, `apps/cli/src/args.ts` | argument-parsing conventions (rewritten on `util.parseArgs`, no commander) |
| `packages/bundle/base` | read only; profile composition belongs to the kernel |

## Not done yet

- `nexgent.ps1` has not been executed (no PowerShell in the authoring environment).
- Approval prompts are not exercised end to end (no TTY in tests; headless denies).
- `nexgent app` has only been run against a stand-in app; the real `apps/desktop` (W5) must accept `<appDir> [--project <abs>]`.
