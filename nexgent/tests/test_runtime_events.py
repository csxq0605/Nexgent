from dataclasses import FrozenInstanceError

import pytest

from nexgent.runtime.events import RuntimeEvent, RuntimeEventKind, emit_event


def test_runtime_event_is_immutable_and_payload_is_read_only():
    event = RuntimeEvent(RuntimeEventKind.MESSAGE_DELTA, "main", {"text": "hello"})
    assert event.payload["text"] == "hello"
    with pytest.raises(FrozenInstanceError):
        event.source = "other"
    with pytest.raises(TypeError):
        event.payload["text"] = "changed"


def test_emit_event_delivers_to_callable_sink():
    received = []
    event = emit_event(received.append, RuntimeEventKind.RUN_STARTED, source="runtime")
    assert received == [event]
