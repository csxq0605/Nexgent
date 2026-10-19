# Nexgent Native Desktop GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AutoReport-style PyQt6 desktop application on top of the UI-neutral runtime while keeping all Nexgent capabilities available.

**Architecture:** A native PyQt6 shell owns project selection, the three-column workspace, runtime event rendering, and management panels. `RuntimeBridge` is the only Qt-to-runtime boundary; GUI widgets never call `NexgentAgent` directly and all long-running calls execute off the Qt main thread.

**Tech Stack:** Python 3.10+, PyQt6 6.8+, pytest-qt 4.5+, Markdown, existing Nexgent runtime, selected MIT-licensed UI patterns/assets adapted from local Manyselves/AutoReport.

## Global Constraints

- Complete `2026-07-17-nexgent-runtime-frontends.md` first.
- Preserve Python `>=3.10` compatibility.
- Use `NexgentRuntime`, `CommandService`, runtime events, and the interaction broker as the only backend boundary.
- Never import or depend on Manyselves or AutoReport at runtime.
- Do not bring report-specific folders, Agents, templates, or terminology into Nexgent.
- Update Qt widgets only on the Qt main thread.
- Permission dismissal, window shutdown, and broker loss must resolve as denial.
- Existing `.nexgent`, `.env`, and `models.json` files remain canonical.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `nexgent/gui/app.py` | QApplication lifecycle, lazy desktop entry, project selection |
| `nexgent/gui/runtime_bridge.py` | QThread worker, Qt signals, interaction-card rendezvous |
| `nexgent/gui/main_window.py` | Three-column shell and coordinated shutdown |
| `nexgent/gui/project_dialog.py` | Open/create/recent project start window |
| `nexgent/gui/config_dialog.py` | Existing model/provider configuration editor |
| `nexgent/gui/theme.py`, `scale.py`, `icons.py` | Shared visual tokens and packaged icon helpers |
| `nexgent/gui/widgets/agent_panel.py` | Model/mode header, conversation timeline, composer |
| `nexgent/gui/widgets/chat_input.py` | Multiline input, history, slash and file completion |
| `nexgent/gui/widgets/messages_area.py` | Streaming timeline container |
| `nexgent/gui/widgets/message_row.py` | User/assistant/notice/error rows |
| `nexgent/gui/widgets/tool_call_group.py` | Expandable structured tool activity |
| `nexgent/gui/widgets/permission_card.py` | Approve/deny and user-input requests |
| `nexgent/gui/widgets/file_tree.py` | Project explorer and file operations |
| `nexgent/gui/widgets/preview.py` | Text/code/Markdown/PDF/image/diff preview |
| `nexgent/gui/widgets/control_center.py` | Collapsible bottom tab container |
| `nexgent/gui/panels/tasks.py` | Tasks, background work, SubAgents |
| `nexgent/gui/panels/automation.py` | Workflows and goals |
| `nexgent/gui/panels/extensions.py` | MCP, plugins, skills, custom Agents, hooks |
| `nexgent/gui/panels/diagnostics.py` | Checkpoints, memory, logs, runtime diagnostics |
| `tests/gui/conftest.py` | Deterministic runtime/event/interaction fixtures shared by GUI tests |
| `tests/gui/` | pytest-qt unit and integration coverage |

## Task 1: PyQt6 dependencies, headless test setup, and visual primitives

**Files:**
- Modify: `setup.py:25-51`
- Modify: `.gitignore`
- Modify: `tests/conftest.py`
- Create: `nexgent/gui/__init__.py`
- Create: `nexgent/gui/theme.py`
- Create: `nexgent/gui/scale.py`
- Create: `nexgent/gui/icons.py`
- Create: `tests/gui/test_theme.py`
- Create: `tests/gui/test_imports.py`
- Create: `tests/gui/conftest.py`

**Interfaces:**
- Produces: `ThemeColors`, `theme_stylesheet()`, `scaled()`, `load_app_icon()`.
- Consumes: no runtime objects.

- [ ] **Step 1: Add failing dependency and theme tests**

```python
from nexgent.gui.theme import ThemeColors, theme_stylesheet


def test_theme_uses_nexgent_family_palette():
    colors = ThemeColors()
    assert colors.brand == "#4B63FF"
    assert colors.accent == "#22D3EE"
    assert colors.ink == "#171D3B"
    assert "QScrollBar" in theme_stylesheet(colors)


def test_gui_import_does_not_create_qapplication():
    from PyQt6.QtWidgets import QApplication
    import nexgent.gui

    assert QApplication.instance() is None
```

- [ ] **Step 2: Add dependencies, create the local environment, and verify missing GUI modules**

Add `PyQt6>=6.8.0,<7.0.0` and `markdown>=3.5.0,<4.0.0` to `install_requires`. Add `pytest-qt>=4.5.0,<5.0.0` and `ruff>=0.9.0` to the `dev` extra and add `.venv/` to `.gitignore`. Create the environment with `python3 -m venv .venv`, install with `.venv/bin/pip install -e '.[dev]'`, and set `QT_QPA_PLATFORM=offscreen` with `os.environ.setdefault` at the top of `tests/conftest.py` before any Qt import.

Run: `.venv/bin/python -m pytest tests/gui/test_theme.py tests/gui/test_imports.py -q`  
Expected before implementation: import failure for `nexgent.gui.theme`.

- [ ] **Step 3: Adapt the shared theme/scale/icon primitives**

Port the proven Manyselves `theme.py`, `scale.py`, and `icons.py` patterns into the Nexgent namespace. Replace product colors with immutable `ThemeColors` defaults:

```python
@dataclass(frozen=True)
class ThemeColors:
    ink: str = "#171D3B"
    background: str = "#F7F8FB"
    surface: str = "#FFFFFF"
    border: str = "#DFE3EB"
    foreground: str = "#273044"
    muted: str = "#6F7890"
    brand: str = "#4B63FF"
    violet: str = "#8D43FF"
    accent: str = "#22D3EE"
    danger: str = "#D92D20"
    warning: str = "#B54708"
    success: str = "#087A55"
```

`load_app_icon()` reads `nexgent.branding.APP_ICON_PATH` lazily and returns an empty `QIcon` only when the packaged resource is unavailable during early development.

Add deterministic GUI fixtures:

```python
# tests/gui/conftest.py
import pytest

from nexgent.runtime.events import RuntimeEvent, RuntimeEventKind
from nexgent.runtime.interactions import InteractionKind, InteractionRequest


@pytest.fixture
def event():
    def make(kind: str, **payload):
        return RuntimeEvent(kind=RuntimeEventKind(kind), source="test", payload=payload)
    return make


@pytest.fixture
def permission_request():
    return InteractionRequest(
        kind=InteractionKind.PERMISSION,
        prompt="Write sample.py",
        metadata={"permission": "write", "path": "sample.py"},
    )


class FakeRuntime:
    def __init__(self):
        self.event_sink = None
        self.closed = False

    def set_event_sink(self, sink):
        self.event_sink = sink

    def handle_input(self, text):
        if self.event_sink:
            self.event_sink(RuntimeEvent(RuntimeEventKind.RUN_STARTED, "runtime", {"text": text}))
        return "done"

    def abort(self):
        return None

    def close(self):
        self.closed = True


@pytest.fixture
def fake_runtime():
    return FakeRuntime()
```

- [ ] **Step 4: Run primitive tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_theme.py tests/gui/test_imports.py -q`  
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add setup.py tests/conftest.py nexgent/gui tests/gui/test_theme.py tests/gui/test_imports.py
git commit -m "feat: add desktop GUI foundations"
```

## Task 2: Recent projects and start window

**Files:**
- Create: `nexgent/gui/recent_projects.py`
- Create: `nexgent/gui/project_dialog.py`
- Create: `tests/gui/test_project_dialog.py`
- Create: `tests/gui/test_recent_projects.py`

**Interfaces:**
- Produces: `RecentProjectStore`, `ProjectDialog.project_selected(Path)` signal, `selected_project()`.
- Consumes: theme primitives from Task 1.

- [ ] **Step 1: Write failing recent-project tests**

```python
from pathlib import Path

from nexgent.gui.recent_projects import RecentProjectStore


def test_recent_projects_are_deduplicated_and_most_recent_first(tmp_path: Path):
    store = RecentProjectStore(tmp_path / "recent.json")
    first = tmp_path / "one"
    second = tmp_path / "two"
    first.mkdir()
    second.mkdir()
    store.add(first)
    store.add(second)
    store.add(first)
    assert store.list() == [first.resolve(), second.resolve()]
```

Add a pytest-qt test that clicks `open_button` with the file dialog patched to return a temp project and asserts `project_selected` emits the resolved path.

- [ ] **Step 2: Run tests to verify missing modules**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_recent_projects.py tests/gui/test_project_dialog.py -q`  
Expected: import failure.

- [ ] **Step 3: Implement `RecentProjectStore`**

Store a JSON array under `~/.nexgent/recent_projects.json`, write atomically through a sibling temporary file, keep at most 20 existing directories, and never create project runtime files during list operations.

- [ ] **Step 4: Adapt the Manyselves start-window pattern**

Create a VS Code-style `ProjectDialog` with `Open Folder`, `New Project`, `Model Configuration`, recent projects, quick-start help, and Exit. Use Nexgent strings and `load_app_icon()`. New Project creates only the selected directory, then offers explicit actions to create `.nexgent` configuration and `AGENTS.md`; opening an existing folder never imposes a scaffold.

- [ ] **Step 5: Run project tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_recent_projects.py tests/gui/test_project_dialog.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/gui/recent_projects.py nexgent/gui/project_dialog.py tests/gui/test_recent_projects.py tests/gui/test_project_dialog.py
git commit -m "feat: add Nexgent project start window"
```

## Task 3: Conversation widgets and command-aware composer

**Files:**
- Create: `nexgent/gui/widgets/__init__.py`
- Create: `nexgent/gui/widgets/chat_input.py`
- Create: `nexgent/gui/widgets/message_row.py`
- Create: `nexgent/gui/widgets/tool_call_group.py`
- Create: `nexgent/gui/widgets/messages_area.py`
- Create: `nexgent/gui/widgets/status_indicator.py`
- Create: `nexgent/gui/widgets/permission_card.py`
- Create: `nexgent/gui/widgets/ui_utils.py`
- Create: `tests/gui/widgets/test_chat_input.py`
- Create: `tests/gui/widgets/test_messages_area.py`
- Create: `tests/gui/widgets/test_permission_card.py`
- Create: `tests/gui/widgets/test_tool_call_group.py`

**Interfaces:**
- Produces: `ChatInput.submit_requested(str)`, `MessagesArea.consume_event(RuntimeEvent)`, `PermissionCard.resolved(request_id, InteractionResponse)`.
- Consumes: `SLASH_COMMANDS`, runtime event and interaction types.

- [ ] **Step 1: Write failing composer and timeline tests**

```python
from nexgent.gui.widgets.chat_input import ChatInput


def test_chat_input_completes_shared_slash_commands(qtbot):
    widget = ChatInput(commands=["/help", "/workflow run", "/mcp refresh"])
    qtbot.addWidget(widget)
    widget.setPlainText("/wor")
    assert "/workflow run" in widget.completion_candidates()


def test_messages_area_merges_stream_deltas(qtbot, event):
    area = MessagesArea()
    qtbot.addWidget(area)
    area.consume_event(event("message_started", message_id="m1"))
    area.consume_event(event("message_delta", message_id="m1", text="hel"))
    area.consume_event(event("message_delta", message_id="m1", text="lo"))
    assert area.message_text("m1") == "hello"
```

- [ ] **Step 2: Run tests to verify missing widgets**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/widgets -q`  
Expected: import failures for new widgets.

- [ ] **Step 3: Adapt focused Manyselves widgets**

Port visual and accessibility behavior from `chat_input.py`, `message_row.py`, `messages_area.py`, `tool_call_group.py`, `status_indicator.py`, and `ui_utils.py`. Remove multi-Agent report assumptions. `ChatInput` uses `nexgent.commands.SLASH_COMMANDS`, supports `@` file completion, `!` shell text, IME-safe Enter behavior, persistent history, and queued-input display.

- [ ] **Step 4: Implement event-driven timeline rendering**

`MessagesArea.consume_event()` handles message start/delta/finish, thinking state, tool start/finish/failure, notice/warning/error, checkpoint, task, SubAgent, workflow, and goal events. Unknown event kinds render a diagnostic notice rather than raising.

- [ ] **Step 5: Implement interaction cards**

`PermissionCard` shows action, permission level, risk metadata, arguments with secret keys redacted, and Approve/Deny buttons. User-input mode shows choices or a validated text field. `closeEvent` and destruction emit a denied response exactly once.

- [ ] **Step 6: Run widget tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/widgets -q`  
Expected: all widget tests pass.

- [ ] **Step 7: Commit**

```bash
git add nexgent/gui/widgets tests/gui/widgets
git commit -m "feat: add event-driven conversation widgets"
```

## Task 4: Project explorer and universal preview

**Files:**
- Create: `nexgent/gui/widgets/file_tree.py`
- Create: `nexgent/gui/widgets/file_search_popup.py`
- Create: `nexgent/gui/widgets/markdown_renderer.py`
- Create: `nexgent/gui/widgets/preview.py`
- Create: `tests/gui/widgets/test_file_tree.py`
- Create: `tests/gui/widgets/test_preview.py`

**Interfaces:**
- Produces: `FileTree.file_selected(Path)`, `path_changed(Path, Path)`, `Preview.selection_changed(path, text, start_line, end_line)`.
- Consumes: resolved project root and theme primitives.

- [ ] **Step 1: Write failing explorer containment tests**

```python
def test_file_tree_never_exposes_paths_above_workspace(qtbot, tmp_path):
    tree = FileTree(tmp_path)
    qtbot.addWidget(tree)
    assert tree.workspace == tmp_path.resolve()
    assert all(tmp_path.resolve() in path.parents or path == tmp_path.resolve() for path in tree.visible_paths())


def test_preview_renders_markdown_and_plain_text(qtbot, tmp_path):
    preview = Preview()
    qtbot.addWidget(preview)
    md = tmp_path / "README.md"
    md.write_text("# Heading", encoding="utf-8")
    preview.open_file(md)
    assert "Heading" in preview.visible_text()
```

- [ ] **Step 2: Run tests to verify missing widgets**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/widgets/test_file_tree.py tests/gui/widgets/test_preview.py -q`  
Expected: import failures.

- [ ] **Step 3: Adapt the file tree and file-reference popup**

Port the workspace-rooted model, new-file/new-folder actions, refresh, rename, delete confirmation, and fuzzy `@` popup. Resolve every action and reject a path whose resolved value is outside the workspace. Do not hide `.nexgent`; label it as project configuration.

- [ ] **Step 4: Implement preview dispatch**

Use suffix dispatch: UTF-8 text/code/JSON/YAML in a read-only editor initially, Markdown through `markdown_renderer`, images through `QLabel/QPixmap`, PDF through an availability-checked Qt PDF view, and unsupported/binary files through a safe metadata page. Provide a diff view for `before`/`after` text and emit selected line context.

- [ ] **Step 5: Run explorer/preview tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/widgets/test_file_tree.py tests/gui/widgets/test_preview.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/gui/widgets tests/gui/widgets/test_file_tree.py tests/gui/widgets/test_preview.py
git commit -m "feat: add workspace explorer and preview"
```

## Task 5: Qt runtime bridge and Agent panel

**Files:**
- Create: `nexgent/gui/runtime_bridge.py`
- Create: `nexgent/gui/widgets/agent_panel.py`
- Create: `tests/gui/test_runtime_bridge.py`
- Create: `tests/gui/widgets/test_agent_panel.py`

**Interfaces:**
- Produces: `RuntimeBridge.event_received`, `interaction_requested`, `submission_finished`, `state_changed`; `AgentPanel.submit_requested`, `abort_requested`.
- Consumes: `NexgentRuntime`, `RuntimeEvent`, `InteractionRequest`, widgets from Tasks 3-4.

- [ ] **Step 1: Write failing thread-boundary tests**

```python
def test_runtime_bridge_emits_events_on_qt_thread(qtbot, fake_runtime):
    bridge = RuntimeBridge(fake_runtime)
    with qtbot.waitSignal(bridge.event_received, timeout=1000) as blocker:
        bridge.submit("hello")
    assert blocker.args[0].kind.value == "run_started"


def test_agent_panel_routes_permission_resolution_once(qtbot, permission_request):
    panel = AgentPanel()
    qtbot.addWidget(panel)
    with qtbot.waitSignal(panel.interaction_resolved) as blocker:
        panel.show_interaction(permission_request)
        panel.permission_card.approve_button.click()
    assert blocker.args[0].accepted is True
```

- [ ] **Step 2: Run tests to verify missing bridge/panel**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_runtime_bridge.py tests/gui/widgets/test_agent_panel.py -q`  
Expected: import failures.

- [ ] **Step 3: Implement `RuntimeBridge`**

Use a dedicated `QThread` with a worker `QObject`. The worker installs `event_sink_context` and `interaction_broker_context`, then calls `runtime.handle_input(text)`. Its broker emits a Qt interaction signal and blocks on a `threading.Condition` keyed by request ID until the GUI resolves, shutdown denies, or a configured timeout expires. No Qt widget is accessed from the worker.

- [ ] **Step 4: Build `AgentPanel`**

Compose model, permission mode, effort, status, context usage, `MessagesArea`, context attachment chip, `ChatInput`, queue indicator, stop/send controls, and command palette. Model/mode/effort changes call runtime methods through the bridge and render corresponding events.

- [ ] **Step 5: Run bridge/panel tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_runtime_bridge.py tests/gui/widgets/test_agent_panel.py -q`  
Expected: all selected tests pass without Qt cross-thread warnings.

- [ ] **Step 6: Commit**

```bash
git add nexgent/gui/runtime_bridge.py nexgent/gui/widgets/agent_panel.py tests/gui/test_runtime_bridge.py tests/gui/widgets/test_agent_panel.py
git commit -m "feat: bridge Nexgent runtime into Qt"
```

## Task 6: Three-column main window

**Files:**
- Create: `nexgent/gui/main_window.py`
- Create: `nexgent/gui/title_bar.py`
- Create: `tests/gui/test_main_window.py`

**Interfaces:**
- Produces: `MainWindow(runtime, project)`, coordinated file selection and Agent context.
- Consumes: Tasks 2-5 components.

- [ ] **Step 1: Write failing layout tests**

```python
def test_main_window_has_three_primary_columns(qtbot, fake_runtime, tmp_path):
    window = MainWindow(fake_runtime, tmp_path)
    qtbot.addWidget(window)
    assert window.primary_splitter.count() == 3
    assert window.file_tree.workspace == tmp_path.resolve()
    assert window.agent_panel is not None


def test_file_selection_opens_preview(qtbot, fake_runtime, tmp_path):
    source = tmp_path / "example.py"
    source.write_text("print('ok')", encoding="utf-8")
    window = MainWindow(fake_runtime, tmp_path)
    qtbot.addWidget(window)
    window.file_tree.file_selected.emit(source)
    assert window.preview.current_path == source.resolve()
```

- [ ] **Step 2: Run test to verify missing window**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_main_window.py -q`  
Expected: import failure for `nexgent.gui.main_window`.

- [ ] **Step 3: Implement the selected layout**

Create a horizontal `QSplitter` for file/session navigation, tabbed preview, and `AgentPanel`, with initial proportions 22/43/35 and minimum usable widths. Add a collapsed vertical bottom splitter for the control center. Persist geometry and splitter sizes in `QSettings("Nexgent", "Nexgent")` and clamp restored values to current screen bounds.

- [ ] **Step 4: Wire workspace and conversation context**

File selection opens preview; preview text selection updates the Agent context chip; `@file` completion uses the current workspace; runtime events route only through `AgentPanel.consume_event`; menu and shortcuts expose Open, Save, New File, New Folder, Settings, Help, Stop, and control-center tabs.

- [ ] **Step 5: Run main-window tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_main_window.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/gui/main_window.py nexgent/gui/title_bar.py tests/gui/test_main_window.py
git commit -m "feat: add Nexgent three-column workspace"
```

## Task 7: Complete control center and management actions

**Files:**
- Create: `nexgent/gui/widgets/control_center.py`
- Create: `nexgent/gui/panels/__init__.py`
- Create: `nexgent/gui/panels/tasks.py`
- Create: `nexgent/gui/panels/automation.py`
- Create: `nexgent/gui/panels/extensions.py`
- Create: `nexgent/gui/panels/diagnostics.py`
- Modify: `nexgent/gui/main_window.py`
- Create: `tests/gui/test_control_center.py`

**Interfaces:**
- Produces: `ControlCenter.command_requested(str)`, `refresh_all(snapshot)`.
- Consumes: runtime snapshots and `CommandService` results through `RuntimeBridge`.

- [ ] **Step 1: Write failing tab and action-parity tests**

```python
EXPECTED_TABS = {"Tasks", "Agents", "Workflows", "Goals", "MCP", "Plugins", "Skills", "Hooks", "Checkpoints", "Memory", "Logs"}


def test_control_center_exposes_every_management_area(qtbot):
    center = ControlCenter()
    qtbot.addWidget(center)
    assert set(center.tab_names()) == EXPECTED_TABS


def test_mcp_refresh_button_uses_shared_command_service(qtbot):
    center = ControlCenter()
    qtbot.addWidget(center)
    with qtbot.waitSignal(center.command_requested) as blocker:
        center.extensions_panel.mcp_refresh_button.click()
    assert blocker.args == ["/mcp refresh"]
```

- [ ] **Step 2: Run test to verify missing control center**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_control_center.py -q`  
Expected: import failure.

- [ ] **Step 3: Implement focused panel models**

Tasks panel renders `task_list` and background-task state with cancel/cleanup. Agents panel renders SubAgent and custom-Agent state with run/parallel/pipeline/create/delete. Automation renders workflow list/status/run/resume/save and goal create/clear/history. Extensions renders MCP install/connect/disconnect/refresh, plugin list/install/load/unload, skills list/install, and hooks. Diagnostics renders checkpoints/rewind, memories/remember, context/stats, and logs.

- [ ] **Step 4: Route every graphical action through shared commands**

Buttons and forms emit the exact slash command already supported by `CommandService`; arguments are quoted with `shlex.quote`. Structured command payloads refresh rows without parsing terminal ANSI text. This guarantees the graphical action and typed command share the same backend implementation.

- [ ] **Step 5: Consume live runtime snapshots/events**

Update task, SubAgent, workflow, goal, checkpoint, context, and error rows from runtime events. A Refresh button requests a runtime snapshot. Empty managers show actionable empty states instead of disabled blank tabs.

- [ ] **Step 6: Run control-center and command parity tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_control_center.py tests/test_command_service.py -q`  
Expected: all selected tests pass and every graphical action maps to a registered command family.

- [ ] **Step 7: Commit**

```bash
git add nexgent/gui/widgets/control_center.py nexgent/gui/panels nexgent/gui/main_window.py tests/gui/test_control_center.py
git commit -m "feat: add complete Nexgent control center"
```

## Task 8: Configuration, sessions, checkpoints, and shutdown

**Files:**
- Create: `nexgent/gui/config_dialog.py`
- Create: `nexgent/gui/session_dialog.py`
- Modify: `nexgent/gui/main_window.py`
- Create: `tests/gui/test_config_dialog.py`
- Create: `tests/gui/test_session_dialog.py`
- Create: `tests/gui/test_shutdown.py`

**Interfaces:**
- Produces: validated writes to existing config services; session selection/fork/save/rewind commands; guarded close behavior.
- Consumes: `ModelRegistry`, settings paths, runtime/command bridge.

- [ ] **Step 1: Write failing configuration persistence test**

```python
def test_config_dialog_saves_existing_models_json_schema(qtbot, tmp_path, model_registry):
    dialog = ConfigDialog(model_registry=model_registry, config_path=tmp_path / "models.json")
    qtbot.addWidget(dialog)
    dialog.select_model("openai/gpt-test")
    dialog.save_button.click()
    saved = json.loads((tmp_path / "models.json").read_text())
    assert saved["defaults"]["main"] == "openai/gpt-test"
```

Add tests for resume/fork/save/rewind commands and for a close event that denies an outstanding permission and requests graceful abort before accepting.

- [ ] **Step 2: Run tests to verify missing dialogs/lifecycle**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_config_dialog.py tests/gui/test_session_dialog.py tests/gui/test_shutdown.py -q`  
Expected: import failures.

- [ ] **Step 3: Adapt the configuration-dialog visual language**

Use the AutoReport/Manyselves layout pattern, but read and write Nexgent's existing provider/model/default schema through `ModelRegistry`. API keys remain environment-variable references; the dialog never writes a raw secret into screenshots or logs. Validate model IDs and base URLs before atomic save.

- [ ] **Step 4: Implement graphical session and checkpoint flows**

List sessions from the configured session directory with corruption status, timestamp, name, and message count. Route resume, fork, rename, delete confirmation, save, clear, compact, stats, and rewind through the shared runtime/command APIs. Preview checkpoint file changes before rewind.

- [ ] **Step 5: Implement coordinated shutdown**

When idle, auto-save and close. When running, offer Continue Working, Stop and Close, or Force Close. Stop and Close waits for `run_aborted`/`run_finished` up to a bounded interval. Before destruction, resolve all broker requests as denied, stop the worker thread, call `runtime.close()`, and persist window state.

- [ ] **Step 6: Run configuration/session/shutdown tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_config_dialog.py tests/gui/test_session_dialog.py tests/gui/test_shutdown.py -q`  
Expected: all selected tests pass with no surviving Qt threads.

- [ ] **Step 7: Commit**

```bash
git add nexgent/gui/config_dialog.py nexgent/gui/session_dialog.py nexgent/gui/main_window.py tests/gui/test_config_dialog.py tests/gui/test_session_dialog.py tests/gui/test_shutdown.py
git commit -m "feat: add desktop configuration and session lifecycle"
```

## Task 9: Desktop application entry and deterministic GUI smoke

**Files:**
- Create: `nexgent/gui/app.py`
- Modify: `nexgent/gui/__init__.py`
- Modify: `nexgent/cli.py`
- Create: `tests/gui/test_app.py`
- Create: `tests/gui/test_gui_smoke.py`

**Interfaces:**
- Produces: `run_gui(project: Path | None = None) -> int`, CLI GUI route.
- Consumes: project dialog, runtime options/service, main window.

- [ ] **Step 1: Write failing app-entry tests**

```python
def test_run_gui_can_open_project_without_network(qtbot, tmp_path, monkeypatch):
    monkeypatch.setenv("NEXGENT_GUI_TEST_MODE", "1")
    app = NexgentDesktopApp(runtime_factory=fake_runtime_factory)
    window = app.create_main_window(tmp_path)
    qtbot.addWidget(window)
    window.show()
    assert window.isVisible()
    assert window.windowTitle().endswith("Nexgent")
```

Add a subprocess smoke test that sets `QT_QPA_PLATFORM=offscreen` and `NEXGENT_GUI_TEST_MODE=1`, calls the explicit GUI route with a temp project, waits for the main window marker, and exits cleanly without network access.

- [ ] **Step 2: Run tests to verify missing application entry**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_app.py tests/gui/test_gui_smoke.py -q`  
Expected: import failure for `nexgent.gui.app`.

- [ ] **Step 3: Implement `NexgentDesktopApp` and `run_gui`**

Create/reuse `QApplication`, apply theme and icon, show `ProjectDialog` when no project is passed, create `RuntimeOptions` with resolved paths, build `NexgentRuntime` and `MainWindow`, and return the Qt event-loop exit code. Test mode injects a fake runtime and a timer-controlled exit; production never silently switches to fake data.

- [ ] **Step 4: Replace temporary CLI GUI error with lazy launch**

In the GUI route only, import `run_gui` lazily and pass an explicit project argument when supplied. Preserve all CLI/TUI route tests proving Qt is not imported elsewhere.

- [ ] **Step 5: Run all GUI and frontend tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui tests/test_frontend_routing.py tests/test_cli.py tests/test_tui.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/gui/app.py nexgent/gui/__init__.py nexgent/cli.py tests/gui/test_app.py tests/gui/test_gui_smoke.py
git commit -m "feat: launch Nexgent desktop application"
```

## Desktop GUI Plan Completion Gate

- [ ] `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui -q` passes.
- [ ] `.venv/bin/python -m pytest tests/test_frontend_routing.py tests/test_cli.py tests/test_tui.py -q` passes.
- [ ] Explicit GUI smoke starts and exits without network access.
- [ ] The main window has three primary columns and every control-center tab.
- [ ] Permission approve/deny/dismiss and shutdown tests prove fail-closed behavior.
- [ ] Every graphical management action maps to `CommandService`.
- [ ] `git diff --check` returns no output.
