import threading
from pathlib import Path

import pytest

from nexgent.context import Session
from nexgent.runtime.interactions import InteractionBroker


class FakeAbort:
    def request(self):
        return None


class FakePerms:
    def __init__(self):
        self.mode = "default"

    def set_permission_mode(self, mode):
        self.mode = mode


class FakeHarness:
    model = "test-model"
    plan_mode = False

    def __init__(self):
        self.perms = FakePerms()
        self.graceful_abort = FakeAbort()


class FakeCommands:
    def __init__(self, session):
        self.session = session
        self.checkpoint_manager = None


class FakeRuntime:
    def __init__(self, root):
        self.project_root = Path(root)
        self.session_dir = self.project_root / ".nexgent" / "sessions"
        self.session_dir.mkdir(parents=True)
        self.session = Session("gui-test", auto_save_dir=str(self.session_dir))
        self.harness = FakeHarness()
        self.interaction_broker = InteractionBroker()
        self.commands = FakeCommands(self.session)
        self.checkpoint_manager = None
        self.run_store = None
        self.event_sink = None
        self.closed = False

    def set_event_sink(self, sink):
        self.event_sink = sink

    def handle_input(self, text):
        return f"done: {text}"

    def abort(self):
        return None

    def close(self):
        self.closed = True


@pytest.fixture
def fake_runtime(tmp_path):
    return FakeRuntime(tmp_path)
