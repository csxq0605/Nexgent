# Nexgent Runtime and Frontend Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a UI-neutral Nexgent runtime, structured event and interaction contracts, a shared command service, and compatible GUI/TUI/CLI entry routing.

**Architecture:** Existing `NexgentAgent`, `Session`, tools, permissions, extensions, workflows, and goals remain authoritative. A new `nexgent.runtime` package owns frontend-neutral orchestration and emits immutable events; CLI, Textual, and later PyQt6 adapters consume those interfaces without duplicating Agent behavior.

**Tech Stack:** Python 3.10+, dataclasses, enum, contextlib, threading, existing OpenAI/Rich/Textual runtime, pytest.

## Global Constraints

- Preserve Python `>=3.10` compatibility from `setup.py`.
- Do not import PyQt6, Textual, or Rich from `nexgent.runtime`.
- Keep all existing permission, tool, workflow, plugin, MCP, skill, goal, and session semantics unchanged.
- `nexgent --task`, piped stdin, JSON, and stream-JSON must not initialize Qt.
- `nexgent --tui` must start the existing Textual application.
- Permission and user-input requests must fail closed when the frontend disappears.
- Use absolute project paths internally; do not make runtime behavior depend on process CWD.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `nexgent/runtime/events.py` | Immutable runtime event model and sink protocol |
| `nexgent/runtime/interactions.py` | Frontend-neutral permission/user-input requests and broker |
| `nexgent/runtime/service.py` | Harness/session lifecycle and prompt/command orchestration |
| `nexgent/runtime/__init__.py` | Stable public runtime imports |
| `nexgent/command_service.py` | Shared slash-command dispatch and structured command results |
| `nexgent/display.py` | Terminal renderer plus optional structured event emission |
| `nexgent/permissions.py` | Generic interaction handler instead of TUI-only callback |
| `nexgent/tools/interactive.py` | Generic broker-backed user questions |
| `nexgent/cli.py` | Lazy frontend routing and compatibility entry point |
| `nexgent/tui.py` | Textual adapter to shared runtime/interaction contracts |
| `tests/test_runtime_events.py` | Event and sink contract tests |
| `tests/test_runtime_interactions.py` | Request resolution and fail-closed tests |
| `tests/test_runtime_service.py` | Runtime lifecycle tests with injected Agent factory |
| `tests/test_command_service.py` | Shared command-family tests |
| `tests/test_frontend_routing.py` | GUI/TUI/CLI selection tests and lazy-import checks |

## Task 1: Runtime event contract

**Files:**
- Create: `nexgent/runtime/events.py`
- Create: `nexgent/runtime/__init__.py`
- Create: `tests/test_runtime_events.py`

**Interfaces:**
- Produces: `RuntimeEventKind`, `RuntimeEvent`, `RuntimeEventSink`, `NullEventSink`, `emit_event()`.
- Consumes: standard-library dataclasses, enum, time, typing.

- [ ] **Step 1: Write the failing event contract tests**

```python
from dataclasses import FrozenInstanceError

import pytest

from nexgent.runtime.events import RuntimeEvent, RuntimeEventKind, emit_event


def test_runtime_event_is_immutable_and_has_stable_payload():
    event = RuntimeEvent(
        kind=RuntimeEventKind.MESSAGE_DELTA,
        source="main",
        payload={"text": "hello"},
        event_id="event-1",
        timestamp=123.0,
    )
    assert event.payload == {"text": "hello"}
    with pytest.raises(FrozenInstanceError):
        event.source = "other"


def test_emit_event_delivers_one_event_to_callable_sink():
    received = []
    event = emit_event(received.append, RuntimeEventKind.RUN_STARTED, source="runtime")
    assert received == [event]
    assert event.kind is RuntimeEventKind.RUN_STARTED
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run: `python3 -m pytest tests/test_runtime_events.py -q`  
Expected: collection fails with `ModuleNotFoundError: No module named 'nexgent.runtime'`.

- [ ] **Step 3: Implement the immutable event model**

```python
# nexgent/runtime/events.py
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Callable, Mapping, Protocol


class RuntimeEventKind(str, Enum):
    RUN_STARTED = "run_started"
    RUN_FINISHED = "run_finished"
    RUN_ABORTED = "run_aborted"
    MESSAGE_STARTED = "message_started"
    MESSAGE_DELTA = "message_delta"
    MESSAGE_FINISHED = "message_finished"
    THINKING_STARTED = "thinking_started"
    THINKING_FINISHED = "thinking_finished"
    TOOL_STARTED = "tool_started"
    TOOL_FINISHED = "tool_finished"
    TOOL_FAILED = "tool_failed"
    PERMISSION_REQUESTED = "permission_requested"
    PERMISSION_RESOLVED = "permission_resolved"
    USER_INPUT_REQUESTED = "user_input_requested"
    USER_INPUT_RESOLVED = "user_input_resolved"
    SESSION_CHANGED = "session_changed"
    CHECKPOINT_CHANGED = "checkpoint_changed"
    TASK_CHANGED = "task_changed"
    SUBAGENT_CHANGED = "subagent_changed"
    WORKFLOW_CHANGED = "workflow_changed"
    GOAL_CHANGED = "goal_changed"
    MODEL_CHANGED = "model_changed"
    MODE_CHANGED = "mode_changed"
    CONTEXT_CHANGED = "context_changed"
    NOTICE = "notice"
    WARNING = "warning"
    ERROR = "error"


class RuntimeEventSink(Protocol):
    def __call__(self, event: "RuntimeEvent") -> None: ...


@dataclass(frozen=True)
class RuntimeEvent:
    kind: RuntimeEventKind
    source: str
    payload: Mapping[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))


def emit_event(
    sink: RuntimeEventSink | None,
    kind: RuntimeEventKind,
    *,
    source: str,
    payload: Mapping[str, Any] | None = None,
) -> RuntimeEvent:
    event = RuntimeEvent(kind=kind, source=source, payload=payload or {})
    if sink is not None:
        sink(event)
    return event


def null_event_sink(_event: RuntimeEvent) -> None:
    return None
```

Export these names from `nexgent/runtime/__init__.py`.

- [ ] **Step 4: Run event tests**

Run: `python3 -m pytest tests/test_runtime_events.py -q`  
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add nexgent/runtime tests/test_runtime_events.py
git commit -m "feat: add runtime event contract"
```

## Task 2: Frontend-neutral interaction broker

**Files:**
- Create: `nexgent/runtime/interactions.py`
- Modify: `nexgent/runtime/__init__.py`
- Create: `tests/test_runtime_interactions.py`

**Interfaces:**
- Consumes: `RuntimeEventSink`, `RuntimeEventKind`, `emit_event` from Task 1.
- Produces: `InteractionKind`, `InteractionRequest`, `InteractionResponse`, `InteractionBroker`, `FailClosedInteractionBroker`, `interaction_broker_context()`, `current_interaction_broker()`.

- [ ] **Step 1: Write failing fail-closed and broker tests**

```python
from nexgent.runtime.interactions import (
    FailClosedInteractionBroker,
    InteractionKind,
    InteractionRequest,
    InteractionResponse,
)


def test_fail_closed_broker_denies_permission():
    broker = FailClosedInteractionBroker()
    response = broker.request(
        InteractionRequest(kind=InteractionKind.PERMISSION, prompt="write file")
    )
    assert response == InteractionResponse(accepted=False, value=None)


def test_request_ids_are_unique():
    first = InteractionRequest(kind=InteractionKind.USER_INPUT, prompt="one")
    second = InteractionRequest(kind=InteractionKind.USER_INPUT, prompt="two")
    assert first.request_id != second.request_id
```

- [ ] **Step 2: Run tests to verify failure**

Run: `python3 -m pytest tests/test_runtime_interactions.py -q`  
Expected: import failure for `nexgent.runtime.interactions`.

- [ ] **Step 3: Implement request and broker types**

```python
from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol, Sequence


class InteractionKind(str, Enum):
    PERMISSION = "permission"
    USER_INPUT = "user_input"


@dataclass(frozen=True)
class InteractionRequest:
    kind: InteractionKind
    prompt: str
    choices: Sequence[str] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)


@dataclass(frozen=True)
class InteractionResponse:
    accepted: bool
    value: Any = None


class InteractionBroker(Protocol):
    def request(self, request: InteractionRequest) -> InteractionResponse: ...


class FailClosedInteractionBroker:
    def request(self, request: InteractionRequest) -> InteractionResponse:
        return InteractionResponse(accepted=False, value=None)


_current_broker: ContextVar[InteractionBroker | None] = ContextVar(
    "nexgent_interaction_broker", default=None
)


@contextmanager
def interaction_broker_context(broker: InteractionBroker):
    token = _current_broker.set(broker)
    try:
        yield
    finally:
        _current_broker.reset(token)


def current_interaction_broker() -> InteractionBroker | None:
    return _current_broker.get()
```

- [ ] **Step 4: Run interaction tests**

Run: `python3 -m pytest tests/test_runtime_interactions.py -q`  
Expected: `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add nexgent/runtime tests/test_runtime_interactions.py
git commit -m "feat: add frontend interaction broker"
```

## Task 3: Generalize permission and interactive-tool requests

**Files:**
- Modify: `nexgent/permissions.py:24-30,419-465`
- Modify: `nexgent/tools/interactive.py:1-82`
- Modify: `nexgent/tui.py:706-830,923-956,1060-1068`
- Test: `tests/test_permissions.py`
- Test: `tests/test_tools.py`

**Interfaces:**
- Consumes: `InteractionBroker`, `InteractionKind`, `InteractionRequest` from Task 2.
- Produces: broker-backed permission and user-input behavior used by TUI and GUI worker threads while retaining CLI terminal prompts when no broker is installed.

- [ ] **Step 1: Add failing permission broker tests**

```python
from nexgent.permissions import Permission, PermissionGate
from nexgent.runtime.interactions import InteractionResponse, interaction_broker_context


class ApprovingBroker:
    def request(self, request):
        assert request.metadata["permission"] == "write"
        return InteractionResponse(accepted=True, value=True)


def test_permission_gate_uses_scoped_interaction_broker(monkeypatch):
    gate = PermissionGate()
    monkeypatch.setattr("nexgent.permissions.classify_action", lambda *_: None)
    with interaction_broker_context(ApprovingBroker()):
        assert gate._interactive_confirm(Permission.WRITE, "write file", {}) is True
```

Add a tool test that installs a broker returning `"choice-b"`, calls `ask_user_question()`, and asserts the serialized tool result contains that value.

- [ ] **Step 2: Run targeted tests and verify missing context manager**

Run: `python3 -m pytest tests/test_permissions.py tests/test_tools.py -q`  
Expected: import failure for `interaction_broker_context`.

- [ ] **Step 3: Replace the TUI-only global with a context variable**

```python
# nexgent/permissions.py
from .runtime.interactions import (
    InteractionKind,
    InteractionRequest,
    current_interaction_broker,
)
```

Change `_interactive_confirm` to accept `params: dict | None = None`, and change `check()` to pass the current params. When `current_interaction_broker()` returns a broker, build an `InteractionRequest` with the action description, permission value, and redacted parameters, then return `response.accepted`. When no broker is installed, retain the existing terminal prompt so ordinary CLI use remains interactive and EOF remains fail-closed.

- [ ] **Step 4: Route `ask_user_question` through the same broker**

When `current_interaction_broker()` returns a broker, construct `InteractionRequest(kind=InteractionKind.USER_INPUT, prompt=question, choices=tuple(options), metadata={"tool": "ask_user_question"})`. Return the accepted value as the existing JSON result and return a cancelled error object when not accepted. When no broker is installed, retain the current CLI terminal input flow.

- [ ] **Step 5: Adapt Textual permission requests**

Create a small TUI broker whose `request()` delegates permission requests to `MiMoTUI._queue_permission_request()` and user-input requests to the existing prompt flow. Install it inside `_agent_worker` using `interaction_broker_context()` and remove direct writes to `_tui_permission_request`.

- [ ] **Step 6: Run targeted and TUI tests**

Run: `python3 -m pytest tests/test_permissions.py tests/test_tools.py tests/test_tui.py -q`  
Expected: all selected tests pass with no reference to `_tui_permission_request`.

- [ ] **Step 7: Commit**

```bash
git add nexgent/permissions.py nexgent/tools/interactive.py nexgent/tui.py tests/test_permissions.py tests/test_tools.py
git commit -m "refactor: share frontend interaction requests"
```

## Task 4: Emit structured runtime activity without breaking terminal output

**Files:**
- Modify: `nexgent/display.py:315-453,807-915,917-994`
- Modify: `nexgent/agent.py:470-980`
- Create: `tests/test_display_events.py`

**Interfaces:**
- Consumes: event types from Task 1.
- Produces: `event_sink_context(sink)` and terminal-rendering functions that also publish events.

- [ ] **Step 1: Write failing display event tests**

```python
from nexgent.display import event_sink_context, print_error, print_streaming_token
from nexgent.runtime.events import RuntimeEventKind


def test_display_publishes_stream_and_error_events(capsys):
    events = []
    with event_sink_context(events.append):
        print_streaming_token("abc")
        print_error("broken")
    assert [event.kind for event in events] == [
        RuntimeEventKind.MESSAGE_DELTA,
        RuntimeEventKind.ERROR,
    ]
    assert "abc" in capsys.readouterr().out
```

- [ ] **Step 2: Run test to verify missing context manager**

Run: `python3 -m pytest tests/test_display_events.py -q`  
Expected: import failure for `event_sink_context`.

- [ ] **Step 3: Add a context-scoped sink to `display.py`**

```python
from contextlib import contextmanager
from contextvars import ContextVar

from .runtime.events import RuntimeEventKind, RuntimeEventSink, emit_event

_event_sink: ContextVar[RuntimeEventSink | None] = ContextVar(
    "nexgent_runtime_event_sink", default=None
)


@contextmanager
def event_sink_context(sink: RuntimeEventSink | None):
    token = _event_sink.set(sink)
    try:
        yield
    finally:
        _event_sink.reset(token)


def _emit(kind: RuntimeEventKind, **payload) -> None:
    emit_event(_event_sink.get(), kind, source="display", payload=payload)
```

Map streaming, thinking, tool start/result, notice, warning, error, status, and final-message render functions to the corresponding event kinds while retaining current terminal output.

- [ ] **Step 4: Add Agent lifecycle events around `NexgentAgent.run`**

Emit `RUN_STARTED` before the loop, `MESSAGE_FINISHED` and `RUN_FINISHED` on normal completion, `RUN_ABORTED` on cooperative abort, and `ERROR` on terminal model errors. Include session ID, model, step, duration, tool ID, tool name, and success metadata where available; never include API keys.

- [ ] **Step 5: Run display and Agent tests**

Run: `python3 -m pytest tests/test_display_events.py tests/test_display.py tests/test_agent.py -q`  
Expected: all selected tests pass and terminal assertions remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add nexgent/display.py nexgent/agent.py tests/test_display_events.py
git commit -m "feat: publish structured runtime events"
```

## Task 5: Shared command service

**Files:**
- Create: `nexgent/command_service.py`
- Modify: `nexgent/cli.py:628-1958`
- Modify: `nexgent/tui.py:542-629`
- Create: `tests/test_command_service.py`
- Modify: `tests/test_cli.py`

**Interfaces:**
- Produces: `CommandAction`, `CommandContext`, `CommandMessage`, `CommandResult`, `CommandService.execute(text, context)`.
- Consumes: existing `SLASH_COMMANDS`, harness managers, `Session`, `MemoryStore`, and `CheckpointManager`.

- [ ] **Step 1: Write failing structured-result tests**

```python
import pytest

from nexgent.command_service import CommandAction, CommandContext, CommandService


@pytest.fixture
def harness_context(monkeypatch, tmp_path):
    monkeypatch.setenv("NEXGENT_API_KEY", "test-key")
    monkeypatch.setenv("NEXGENT_BASE_URL", "http://localhost:8080/v1")
    monkeypatch.setenv("NEXGENT_MODEL", "test-model")
    from nexgent.agent import NexgentAgent
    from nexgent.context import Session
    from nexgent.memory import MemoryStore

    return CommandContext(
        harness=NexgentAgent(),
        session=Session(session_id="command-test"),
        memory_store=MemoryStore(str(tmp_path)),
        session_dir=str(tmp_path / "sessions"),
    )


def test_unknown_command_returns_structured_warning(harness_context):
    result = CommandService().execute("/does-not-exist", harness_context)
    assert result.action is CommandAction.CONTINUE
    assert result.messages[0].level == "warning"
    assert "/does-not-exist" in result.messages[0].text


def test_quit_variants_return_quit(harness_context):
    service = CommandService()
    for text in ("/quit", "/exit", "/q"):
        assert service.execute(text, harness_context).action is CommandAction.QUIT
```

Add parametrized tests covering every command family listed in `nexgent.commands.SLASH_COMMANDS`. Tests for mutating families use fake managers and assert the exact manager method and arguments.

- [ ] **Step 2: Run command-service tests and verify import failure**

Run: `python3 -m pytest tests/test_command_service.py -q`  
Expected: import failure for `nexgent.command_service`.

- [ ] **Step 3: Implement the command result types**

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class CommandAction(str, Enum):
    CONTINUE = "continue"
    QUIT = "quit"
    START_AGENT = "start_agent"
    REPLACE_SESSION = "replace_session"


@dataclass(frozen=True)
class CommandMessage:
    level: str
    text: str
    data: Any = None


@dataclass
class CommandContext:
    harness: Any
    session: Any
    memory_store: Any
    checkpoint_manager: Any = None
    session_dir: str | None = None


@dataclass
class CommandResult:
    action: CommandAction = CommandAction.CONTINUE
    session: Any = None
    messages: list[CommandMessage] = field(default_factory=list)
    agent_input: str | None = None
```

- [ ] **Step 4: Move command dispatch into `CommandService.execute`**

Tokenize with `shlex.split(text)` while preserving free-form tails for `/goal`, `/subagent`, `/parallel`, `/pipeline`, `/btw`, and shell syntax. Port each existing `_handle_command` branch without semantic changes. Replace `print_*` calls with `CommandMessage(level, text, data)` and replace direct terminal input with interaction-broker requests. Maintain these exact families: help/tools, compact/context/stats, rewind/fork/clear/save/load, effort, memory/remember, hooks/init/init-config, subagents/subagent/parallel/pipeline, agents, tasks, goal, skills, MCP, workflow, model, plugin, btw, quit.

- [ ] **Step 5: Keep `_handle_command` as a compatibility adapter**

```python
def _handle_command(cmd, harness, session, memory_store, checkpoint_manager=None, session_dir=None):
    text = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
    result = CommandService().execute(
        text,
        CommandContext(
            harness=harness,
            session=session,
            memory_store=memory_store,
            checkpoint_manager=checkpoint_manager,
            session_dir=session_dir,
        ),
    )
    render_command_messages(result.messages)
    return result.action.value, result.session or session
```

Textual calls the same service and renders messages into its `RichLog`.

- [ ] **Step 6: Run all command, CLI, and TUI tests**

Run: `python3 -m pytest tests/test_command_service.py tests/test_cli.py tests/test_tui.py -q`  
Expected: all selected tests pass; the command coverage test proves every `SLASH_COMMANDS` root has a handler.

- [ ] **Step 7: Commit**

```bash
git add nexgent/command_service.py nexgent/cli.py nexgent/tui.py tests/test_command_service.py tests/test_cli.py
git commit -m "refactor: share slash command service"
```

## Task 6: UI-neutral runtime service

**Files:**
- Create: `nexgent/runtime/service.py`
- Modify: `nexgent/runtime/__init__.py`
- Create: `tests/test_runtime_service.py`

**Interfaces:**
- Consumes: Tasks 1-5 contracts and existing `NexgentAgent`, `Session`, `MemoryStore`, `CheckpointManager`.
- Produces: `RuntimeOptions`, `RuntimeState`, `NexgentRuntime.set_event_sink()`, `handle_input()`, `abort()`, `force_stop()`, `close()`.

- [ ] **Step 1: Write failing lifecycle tests with an injected Agent factory**

```python
from pathlib import Path

from nexgent.runtime.service import NexgentRuntime, RuntimeOptions, RuntimeState


class FakeAgent:
    def __init__(self):
        self.graceful_abort = type("Abort", (), {"request": lambda self: None})()

    def run(self, prompt, session):
        session.add_message("assistant", "done")
        return "done"


def test_runtime_runs_prompt_and_keeps_session(tmp_path: Path):
    runtime = NexgentRuntime(
        RuntimeOptions(project=tmp_path, session_dir=tmp_path / "sessions"),
        agent_factory=lambda _options: FakeAgent(),
    )
    assert runtime.handle_input("hello") == "done"
    assert runtime.state is RuntimeState.IDLE
    assert runtime.session.messages[-1]["content"] == "done"
```

- [ ] **Step 2: Run the test and verify missing service**

Run: `python3 -m pytest tests/test_runtime_service.py -q`  
Expected: import failure for `nexgent.runtime.service`.

- [ ] **Step 3: Implement runtime options and state**

```python
@dataclass(frozen=True)
class RuntimeOptions:
    project: Path
    session_dir: Path
    model: str | None = None
    permission_mode: str = "default"
    effort: str = "medium"
    stream: bool = True
    bare: bool = False
    max_steps: int = 0


class RuntimeState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    STOPPING = "stopping"
    CLOSED = "closed"
```

Implement `NexgentRuntime` so constructor paths are resolved, the session directory is created, session creation/resume is explicit, normal input calls `agent.run`, slash input calls `CommandService`, and lifecycle events wrap every transition. Accept an optional event sink in the constructor, expose `set_event_sink(sink)`, and install `event_sink_context(self._event_sink)` around each submission. Use dependency injection for Agent, session, memory, and checkpoint factories.

- [ ] **Step 4: Implement stop and close behavior**

`abort()` transitions RUNNING to STOPPING and calls `graceful_abort.request()`. `force_stop()` calls an injected frontend cancellation hook but never kills the process itself. `close()` aborts active work, auto-saves the session, closes MCP/plugin resources that expose `close`/`shutdown`, and becomes idempotently CLOSED.

- [ ] **Step 5: Run runtime tests**

Run: `python3 -m pytest tests/test_runtime_service.py tests/test_runtime_events.py tests/test_runtime_interactions.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/runtime tests/test_runtime_service.py
git commit -m "feat: add UI-neutral Nexgent runtime"
```

## Task 7: Lazy GUI/TUI/CLI routing

**Files:**
- Modify: `nexgent/cli.py:257-626`
- Modify: `nexgent/tui.py:1243-1265`
- Create: `tests/test_frontend_routing.py`
- Modify: `tests/test_cli.py`

**Interfaces:**
- Consumes: `NexgentRuntime` and existing `run_tui`.
- Produces: `FrontendKind`, `select_frontend(args, stdin_is_tty, stdout_is_tty)`, lazy `run_gui()` import point.

- [ ] **Step 1: Write failing route-selection tests**

```python
import pytest

from nexgent.cli import FrontendKind, _build_parser, select_frontend


@pytest.mark.parametrize(
    ("argv", "stdin_tty", "expected"),
    [
        ([], True, FrontendKind.GUI),
        (["--gui"], True, FrontendKind.GUI),
        (["--tui"], True, FrontendKind.TUI),
        (["--task", "hi"], True, FrontendKind.CLI),
        (["--output-format", "json"], True, FrontendKind.CLI),
        ([], False, FrontendKind.CLI),
    ],
)
def test_select_frontend(argv, stdin_tty, expected):
    args = _build_parser().parse_args(argv)
    assert select_frontend(args, stdin_is_tty=stdin_tty, stdout_is_tty=True) is expected
```

Add a subprocess test that imports `nexgent.cli`, selects CLI mode, and asserts `PyQt6` and `nexgent.gui` are absent from `sys.modules`.

- [ ] **Step 2: Run tests and verify missing flags/types**

Run: `python3 -m pytest tests/test_frontend_routing.py -q`  
Expected: import or argument-parser failure for `FrontendKind`, `--gui`, and `--tui`.

- [ ] **Step 3: Implement route selection**

```python
class FrontendKind(str, Enum):
    GUI = "gui"
    TUI = "tui"
    CLI = "cli"


def select_frontend(args, *, stdin_is_tty: bool, stdout_is_tty: bool) -> FrontendKind:
    if args.gui:
        return FrontendKind.GUI
    if args.tui:
        return FrontendKind.TUI
    if args.task or not stdin_is_tty or args.output_format != "text":
        return FrontendKind.CLI
    return FrontendKind.GUI
```

Add a mutually exclusive parser group for `--gui` and `--tui`. Keep the current initialization below the route decision so GUI mode can call `from .gui.app import run_gui` lazily and CLI/TUI never import Qt.

- [ ] **Step 4: Preserve existing TUI construction**

Move current TUI construction into `_run_tui_frontend(runtime)` without changing `run_tui`'s behavior. GUI routing may temporarily raise a clear `GUI frontend is not installed yet; use --tui` error until the desktop plan adds `nexgent.gui.app`.

- [ ] **Step 5: Run routing, CLI, and TUI tests**

Run: `python3 -m pytest tests/test_frontend_routing.py tests/test_cli.py tests/test_tui.py -q`  
Expected: all selected tests pass; CLI subprocess does not import PyQt6.

- [ ] **Step 6: Run the non-E2E suite**

Run: `python3 -m pytest -q -m "not e2e and not slow"`  
Expected: all collected non-E2E tests pass.

- [ ] **Step 7: Commit**

```bash
git add nexgent/cli.py nexgent/tui.py tests/test_frontend_routing.py tests/test_cli.py
git commit -m "feat: route GUI TUI and CLI frontends"
```

## Runtime Plan Completion Gate

- [ ] `python3 -m pytest tests/test_runtime_events.py tests/test_runtime_interactions.py tests/test_display_events.py tests/test_command_service.py tests/test_runtime_service.py tests/test_frontend_routing.py -q` passes.
- [ ] `python3 -m pytest -q -m "not e2e and not slow"` passes.
- [ ] A subprocess route-selection test proves `--task` and JSON modes do not import PyQt6 without making a network request.
- [ ] `python3 -m nexgent.cli --tui --help` documents the TUI route.
- [ ] `rg -n '_tui_permission_request' nexgent tests` returns no matches.
- [ ] `git diff --check` returns no output.
