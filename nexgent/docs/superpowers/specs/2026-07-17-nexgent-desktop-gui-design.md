# Nexgent Desktop GUI and Brand Design

Date: 2026-07-17  
Status: Approved for implementation  
Selected window direction: AutoReport-style three-column workspace  
Selected icon direction: B, Agent Relay

## 1. Purpose

Nexgent already provides a complete model-agnostic Agent Harness through its CLI and Textual TUI. The desktop project must expose that same runtime through a native GUI without creating a reduced or divergent second implementation.

The desktop product will use the interaction patterns proven by AutoReport and Manyselves: a native PyQt6 shell, a project-first start window, a persistent file workspace, a preview/editor surface, a streaming Agent timeline, structured tool-call cards, and dedicated configuration dialogs. Nexgent-specific management surfaces will extend that shell to cover sessions, permission modes, tasks, SubAgents, workflows, goals, MCP servers, plugins, skills, custom Agents, hooks, checkpoints, and logs.

## 2. Goals

1. Make the interactive `nexgent` command launch a usable native desktop GUI.
2. Keep the existing full-screen TUI available through `nexgent --tui`.
3. Preserve all non-interactive CLI behavior, including one-shot tasks, piped input, structured output, configuration flags, and session recovery.
4. Make every current slash-command capability accessible from the GUI input and give complex capabilities an equivalent graphical surface.
5. Keep `NexgentAgent`, its tool registry, permission pipeline, sessions, memory, tasks, workflows, extensions, and goals as the single runtime truth.
6. Add a coherent Nexgent brand system, application icon, title assets, screenshots, and documentation.
7. Verify the desktop application through unit, GUI, compatibility, and real-startup tests.

## 3. Non-goals

- Replacing the Textual TUI or removing script-oriented CLI usage.
- Rewriting the Agent Harness around Qt concepts.
- Creating a web server, Electron shell, or browser-based application runtime.
- Forking command implementations between CLI and GUI.
- Changing the semantics of permission modes, tools, workflows, plugins, MCP, skills, goals, or sessions.
- Adding business-specific Agent teams or report-generation behavior from AutoReport or Manyselves.

## 4. Product Entry Behavior

The command router will distinguish interactive desktop use from terminal automation.

| Invocation | Behavior |
| --- | --- |
| `nexgent` in an interactive terminal | Launch the PyQt6 desktop application |
| `nexgent --gui` | Explicitly launch the desktop application |
| `nexgent --tui` | Launch the existing Textual full-screen interface |
| `nexgent --task "..."` | Preserve one-shot CLI execution |
| piped stdin | Preserve CLI pipeline execution |
| `--output-format json` or `stream-json` | Preserve structured CLI output |
| CLI session/configuration flags | Preserve current CLI behavior unless `--gui` is explicit |

The GUI and TUI flags are mutually exclusive. Argument parsing must remain independently testable. The GUI must not initialize Qt when the invocation is routed to CLI or TUI mode.

## 5. Runtime Architecture

```text
PyQt6 GUI -----------+
Textual TUI ---------+--> NexgentRuntime --> CommandService --> NexgentAgent
Script-oriented CLI -+          |                   |               |
                                |                   |               +--> ToolRegistry
                                |                   |               +--> Permissions
                                |                   |               +--> SubAgents / Workflows
                                |                   |               +--> MCP / Plugins / Skills
                                |                   |               +--> Goal / Tasks / Hooks
                                |                   |
                                +--> Session / checkpoints / memory
                                +--> RuntimeEventSink --> GUI, TUI, or CLI renderer
```

### 5.1 `NexgentRuntime`

`NexgentRuntime` is a front-end-independent application service. It owns:

- configuration and model-registry loading;
- `NexgentAgent` construction;
- project path and session directory selection;
- new, resumed, forked, saved, and automatically saved sessions;
- message submission and queued input;
- graceful abort and force-stop coordination;
- resource cleanup and shutdown;
- a `RuntimeEventSink` used for structured progress reporting;
- a front-end-provided interaction broker for permission and user-input requests.

The runtime does not import PyQt6, Textual, or Rich.

### 5.2 `CommandService`

Business logic currently embedded in the CLI `_handle_command` path will move behind `CommandService.execute(command, context)`. The result is structured rather than printed directly:

- action: continue, quit, replace-session, or start-agent;
- messages or notices to present;
- optional data payload for a graphical panel;
- updated session when a command changes session identity;
- recoverable error details.

CLI and TUI render command results as terminal content. The GUI renders them as messages, dialogs, panels, or navigation actions. Command parsing and command names continue to come from `nexgent.commands` as the single source of truth.

### 5.3 Runtime Events

The runtime event contract includes at least:

- `run_started`, `run_finished`, `run_aborted`;
- `message_started`, `message_delta`, `message_finished`;
- `thinking_started`, `thinking_finished`;
- `tool_started`, `tool_finished`, `tool_failed`;
- `permission_requested`, `permission_resolved`;
- `user_input_requested`, `user_input_resolved`;
- `session_changed`, `checkpoint_changed`;
- `task_changed`, `subagent_changed`, `workflow_changed`, `goal_changed`;
- `model_changed`, `mode_changed`, `context_changed`;
- `notice`, `warning`, `error`.

Events are immutable dataclasses with timestamps and stable identifiers. Frontends may ignore visual detail but must not change runtime behavior.

### 5.4 Interaction Broker

Interactive runtime requests use an explicit request-response object instead of `input()` or widget-specific callbacks.

- Permission requests contain the permission type, action summary, relevant arguments, risk classification, and request ID.
- User-input requests contain prompt text, optional choices, validation metadata, and request ID.
- Closing a prompt, closing the window, timing out, or losing the front-end resolves the request as denied or cancelled.
- The existing fail-closed permission rule remains authoritative.

### 5.5 Threading

Nexgent's synchronous Agent loop runs on a dedicated Qt worker thread in GUI mode. Qt widgets are only updated on the main thread through signals. Long-lived background tasks, MCP connections, workflows, and SubAgents remain owned by the runtime and publish events rather than manipulating the GUI.

The GUI supports:

- graceful stop through the existing abort signal;
- an explicit force-stop escalation for unresponsive work;
- queued input while a run is active;
- shutdown protection when tasks are still running;
- session save before normal application exit.

## 6. Desktop Information Architecture

### 6.1 Start Window

The start window follows the AutoReport and Manyselves pattern while using Nexgent terminology.

- Open project folder.
- Create project folder.
- Resume a recent project.
- Resume a recent session.
- Open model and provider configuration.
- Open quick-start guidance.
- Show the Nexgent icon, product descriptor, and current version.

No project-specific folder scaffold is forced on an existing repository. Creating a new project may offer `.nexgent` initialization and `AGENTS.md` generation as explicit choices.

### 6.2 Main Window

The selected layout is a compact three-column workspace. The earlier bottom
control-center button matrix was removed after visible-use review: command
discovery belongs in the composer, while runtime identity belongs in an Agent
navigator.

#### Left column

- a single tabbed navigator for Files, Sessions, and Agents;
- project file explorer and preview selection;
- recent and saved conversation sessions;
- live Main/SubAgent identities and lifecycle status.

#### Center column

- tabbed text and code preview/editor;
- Markdown rendering;
- PDF and image preview;
- JSON, YAML, notebook, and spreadsheet-friendly views where supported;
- source/diff preview for tool changes and checkpoint rewinds;
- selected text can be inserted into Agent context.

#### Right column

- model selector;
- permission-mode selector: default, plan, auto, accept-edits, don't-ask, bypass, and dry-run state;
- effort selector;
- compact runtime status in the conversation header;
- one streaming conversation timeline for messages and tool activity;
- grouped and expandable tool-call cards;
- inline permission and user-input cards;
- dynamic slash-command and `@file` completion with Tab selection;
- persistent Up/Down input history;
- an always-available composer, `/btw` injection, input queue, stop, and send.

There is no bottom control center. Tasks, workflows, goals, MCP, plugins,
skills, custom Agents, hooks, and diagnostics remain accessible through the
same slash-command service. This avoids duplicating every command as a button
and keeps new commands discoverable without a GUI layout change.

## 7. Complete Capability Mapping

All current slash commands remain valid in the GUI input. Graphical surfaces are added as follows.

| Capability group | Command compatibility | Graphical surface |
| --- | --- | --- |
| Help and tools | `/help`, `/tools` | command palette and help dialog |
| Context and statistics | `/compact`, `/context`, `/stats` | context popover and session menu |
| Checkpoints and sessions | `/rewind`, `/fork`, `/clear`, `/save`, `/load` | session history, checkpoint/diff dialog |
| Effort and models | `/effort`, `/model ...` | top toolbar selectors and model settings |
| Memory | `/memory`, `/remember` | memory browser/editor |
| Hooks and project setup | `/hooks`, `/init`, `/init-config` | project settings and initialization actions |
| SubAgents | `/subagents`, `/subagent`, `/parallel`, `/pipeline` | dynamic Agent navigator and per-Agent conversation |
| Custom Agents | `/agents ...` | Agent manager dialog |
| Tasks and background work | `/tasks ...`, background syntax | command result in the unified timeline |
| Goals | `/goal ...` | goal editor, state, and evaluation timeline |
| Skills | `/skills ...` | skills manager |
| MCP | `/mcp install/connect/disconnect/refresh` | MCP manager |
| Workflows | `/workflow run/list/status/resume/save` | workflow manager and run timeline |
| Plugins | `/plugin list/install/load/unload` | plugin manager |
| Runtime guidance | `/btw` | inline guidance action while running |
| Files | `@file`, `@folder`, glob references | file explorer and input completion |
| Shell | `!command` | command input plus log/console output |
| Exit | `/quit`, `/exit`, `/q` | normal close flow with running-work guard |

Every tool registered through `ToolRegistry`, including built-in, plugin, and MCP tools, remains available to the Agent. GUI support is defined at the event/result rendering level, so newly registered tools work without adding command-specific GUI execution paths.

## 8. Configuration and Persistence

- Existing `.env`, `models.json`, `.nexgent/settings.json`, `.nexgent/permissions.json`, `.nexgent/mcp.json`, user skills, and custom Agent locations remain canonical.
- GUI settings write through the same configuration and registry services used by CLI startup.
- Secrets are never placed in screenshots, logs, session displays, or brand assets.
- Recent projects and window state are user-level UI preferences, separate from project runtime configuration.
- Project paths are resolved explicitly so GUI launch behavior does not depend on the process working directory.

## 9. Brand System

### 9.1 Identity

- Product name: Nexgent.
- Descriptor: Production-grade model-agnostic Agent Harness.
- Brand concept: Agent Relay.
- Meaning: connected Agent and tool nodes move work forward through a controlled runtime.
- Voice: capable, direct, technical, and calm.

### 9.2 Visual Direction

The selected mark uses two connected forward forms and relay nodes. It must remain recognizable as a silhouette at 16–32 px and must not depend on fine line details.

Primary palette:

- deep indigo background: `#171D3B`;
- near-black depth: `#080B1D`;
- relay blue: `#4B63FF`;
- relay violet: `#8D43FF`;
- electric cyan: `#22D3EE`;
- light foreground: `#E3E7FF`.

The brand is related to the AutoReport/Manyselves visual family through the indigo, violet, and cyan palette, but the relay silhouette is specific to Nexgent and must not reuse the Manyselves multi-face cube.

### 9.3 Canonical Brand Source

`nexgent/branding.py` becomes the single source for product name, version-facing descriptor, tagline, and packaged icon path. Window titles, dialogs, banners, README generation helpers, and tests import those constants rather than duplicating strings.

### 9.4 Assets

The repository will include:

- `assets/brand/nexgent-app-icon.png`;
- `assets/brand/nexgent-mark.png` with transparent background;
- `assets/brand/nexgent-mark-dark.png` and light-background presentation;
- `assets/brand/nexgent-title.png` for README headers;
- `nexgent/resources/icon.png` for the packaged application;
- a repeatable brand-asset generation script;
- `assets/brand/README.md` with palette, safe area, minimum size, and usage rules;
- `docs/brand.md` with identity and product-language rules.

Generated raster assets must be deterministic from a checked-in source or script after the selected concept has been established. README screenshots are captured from the implemented GUI with test credentials and sanitized content.

## 10. Error Handling

- Missing provider credentials open configuration instead of terminating the desktop application.
- Invalid configuration is shown with the responsible file and actionable correction.
- Agent, model, tool, plugin, MCP, workflow, and SubAgent failures become structured events and remain recoverable when runtime semantics allow.
- A preview failure displays an error in that preview tab without closing the main window.
- Permission prompts fail closed.
- A failed command result does not corrupt or silently replace the current session.
- Worker exceptions always restore the GUI to an idle or failed state and leave the stop/send controls coherent.
- Shutdown waits for graceful cleanup, then offers a clearly labelled force-quit path if work is unresponsive.
- Session and project paths are validated before use and user-visible errors never expose secrets.

## 11. Reuse from AutoReport and Manyselves

The implementation may adapt these proven PyQt6 concepts and components:

- application startup and Qt/backend thread separation;
- start/project dialog and recent-project list;
- theme and scaling utilities;
- title bar and window chrome;
- file explorer and fuzzy file reference popup;
- preview container and Markdown renderer;
- message rows, message timeline, and grouped tool-call cards;
- chat input, history, status indicator, and configuration-dialog visual language;
- branding constants, packaged icon loading, brand scripts, and branding tests.

Report-specific project structure, report Agents, report templates, report workflows, and report terminology are excluded. Adapted code must use Nexgent runtime interfaces rather than importing AutoReport or Manyselves at runtime.

## 12. Documentation

`README.md` will be updated to lead with the desktop experience while preserving complete CLI/TUI documentation. It will include:

- branded title asset and application screenshots;
- GUI quick start and project-opening flow;
- `--tui` compatibility instructions;
- non-interactive CLI examples;
- provider and model configuration;
- complete capability overview;
- architecture and development sections;
- GUI testing and headless/offscreen commands;
- links to brand documentation.

Any version or command described in Markdown must be sourced from or checked against the live package and parser behavior.

## 13. Verification Strategy

### 13.1 Unit tests

- command routing and mutually exclusive GUI/TUI behavior;
- `NexgentRuntime` lifecycle and session management;
- event ordering and immutable payloads;
- command-service results for every command family;
- permission and user-input request resolution;
- configuration persistence and path independence;
- branding constants and packaged asset existence.

### 13.2 GUI tests

- start window and project selection;
- main-window layout and restored splitter state;
- file tree, preview, and editor-context insertion;
- streaming message deltas;
- grouped tool-call success and failure states;
- permission approve, deny, dismiss, and shutdown behavior;
- model, mode, and effort selectors;
- sessions and checkpoints;
- compact Files/Sessions/Agents navigation and command-completion popup;
- settings and extension-management dialogs;
- clean stop and close behavior.

### 13.3 Compatibility tests

- the existing Nexgent suite remains green;
- `nexgent --task` remains non-GUI;
- piped stdin remains non-GUI;
- text, JSON, and stream-JSON formats preserve their contracts;
- session ID, continue, resume, and cleanup behavior remains valid;
- `nexgent --tui` starts the existing Textual application;
- command names and help output remain synchronized.

### 13.4 Runtime verification

- run the full GUI test suite with `QT_QPA_PLATFORM=offscreen`;
- launch the real desktop process and confirm the start window remains responsive;
- open the demo project and run a simulated deterministic Agent event stream;
- exercise permission approval and denial;
- exercise graceful stop and queued input;
- close and reopen to validate session/project persistence;
- capture and inspect brand, start-window, configuration, and main-workspace screenshots;
- run lint, full tests, package build, and a built-artifact import/startup smoke test.

## 14. Acceptance Criteria

The work is complete only when all of the following are demonstrated from the current checkout:

1. `nexgent` launches the native GUI for interactive use.
2. `nexgent --tui` launches the existing TUI.
3. One-shot and piped CLI invocations do not initialize Qt and retain output contracts.
4. The GUI can open a project, create or resume a session, send a prompt, stream output, show tool activity, request permission, stop work, and persist the session.
5. Every current slash command is executable from the GUI input.
6. Tasks, SubAgents, workflows, goals, MCP, plugins, skills, custom Agents, hooks, checkpoints, memory, models, and permission modes have working GUI access or a structured graphical result surface in addition to command compatibility.
7. Built-in, plugin, and MCP tools continue to use the existing `ToolRegistry` and permission pipeline.
8. Agent Relay brand assets are packaged and visible in application surfaces and documentation.
9. README and brand documentation accurately describe the implemented product.
10. Existing tests, new runtime/GUI/brand tests, lint, package build, offscreen smoke, and real-window startup checks pass.
