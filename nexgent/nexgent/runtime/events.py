"""Immutable events shared by CLI, TUI, and desktop frontends."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Callable, Mapping, Optional


class RuntimeEventKind(str, Enum):
    RUN_STARTED = "run_started"
    RUN_FINISHED = "run_finished"
    RUN_ABORTED = "run_aborted"
    MESSAGE_STARTED = "message_started"
    MESSAGE_DELTA = "message_delta"
    MESSAGE_FINISHED = "message_finished"
    TOOL_STARTED = "tool_started"
    TOOL_FINISHED = "tool_finished"
    TOOL_FAILED = "tool_failed"
    PERMISSION_REQUESTED = "permission_requested"
    PERMISSION_RESOLVED = "permission_resolved"
    USER_INPUT_REQUESTED = "user_input_requested"
    USER_INPUT_RESOLVED = "user_input_resolved"
    SESSION_CHANGED = "session_changed"
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


@dataclass(frozen=True)
class RuntimeEvent:
    kind: RuntimeEventKind
    source: str
    payload: Mapping[str, Any] = field(default_factory=dict)
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))


RuntimeEventSink = Callable[[RuntimeEvent], None]


def emit_event(
    sink: Optional[RuntimeEventSink],
    kind: RuntimeEventKind,
    *,
    source: str,
    payload: Optional[Mapping[str, Any]] = None,
) -> RuntimeEvent:
    event = RuntimeEvent(kind, source, payload or {})
    if sink is not None:
        sink(event)
    return event
