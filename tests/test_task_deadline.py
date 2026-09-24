"""Root Episode wall-deadline enforcement at runtime admission boundaries."""

from copy import deepcopy
import threading
import time

from nexgent.tasks.adaptive_orchestration_seed import (
    OPEN_LOOP_COMPONENT_ID,
    adaptive_orchestration_package,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


def controlled_package(source):
    return make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}})


class SelectorGateway:
    def __init__(self, delay=0):
        self.delay = delay
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append(role)
                receipt = {
                    "call_id": f"deadline-selector-{len(owner.calls)}",
                    "role": role,
                    "model": "DEADLINE-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                time.sleep(owner.delay)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                })
                return {
                    "selected_component_id": OPEN_LOOP_COMPONENT_ID,
                    "basis": ["Use the open-loop test backend."],
                    "stop_conditions": ["The backend returns."],
                    "estimated_cost": {"model_calls": 1, "nodes": 1},
                }

        return Gateway()


class InterruptedSelectorGateway:
    def __init__(self):
        self.calls = 0

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls += 1
                reserve({
                    "call_id": f"interrupted-selector-{owner.calls}",
                    "role": role,
                    "model": "INTERRUPTED-DEADLINE-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                })
                assert stop_event.wait(5), "root deadline timer did not fire"
                raise InterruptedError("provider outcome is unknown")

        return Gateway()


def test_expired_resume_fails_before_new_rpc_or_backend(tmp_path, monkeypatch):
    package = controlled_package(
        "def execute(payload, context):\n"
        "    raise RuntimeError('backend must not start')\n")
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = service.create(
        "Do not restart after expiry", package=package,
        constraints={"wall_seconds": 0.02})
    service.store.start_deadline(episode["id"])
    time.sleep(0.04)
    backend_calls = []
    monkeypatch.setattr(
        "nexgent.tasks.runtime.run_package",
        lambda *args, **kwargs: backend_calls.append((args, kwargs)))

    result = service.run(episode["id"])

    assert result["status"] == "failed"
    assert "deadline" in result["last_error"].lower()
    assert backend_calls == []
    assert not [event for event in result["events"]
                if event["kind"] == "rpc_started"]


def test_selector_time_is_removed_from_controlled_code_timeout(
        tmp_path, monkeypatch):
    gateway = SelectorGateway(delay=0.2)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Pass only the remaining wall time to the selected backend",
        package=adaptive_orchestration_package(),
        constraints={"wall_seconds": 3})
    observed = []

    def capture_timeout(*args, **kwargs):
        observed.append(kwargs["timeout"])
        raise RuntimeError("stop after timeout capture")

    monkeypatch.setattr("nexgent.tasks.runtime.run_package", capture_timeout)
    result = service.run(episode["id"])

    assert gateway.calls == ["strategy_selector"]
    assert result["status"] == "failed"
    assert len(observed) == 1
    assert 0 < observed[0] < 2.9


def test_controlled_code_timeout_fails_instead_of_pausing(tmp_path):
    package = controlled_package(
        "def execute(payload, context):\n"
        "    while True:\n"
        "        payload = None\n")
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = service.create(
        "Consume the wall deadline", package=package,
        constraints={"wall_seconds": 0.15})

    result = service.run(episode["id"])

    assert result["status"] == "failed"
    assert "timeout" in result["last_error"].lower() or (
        "deadline" in result["last_error"].lower())


def test_deadline_during_selector_keeps_unknown_rpc_started_and_never_replays(
        tmp_path):
    gateway = InterruptedSelectorGateway()
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Do not replay a selector interrupted after provider admission",
        package=adaptive_orchestration_package(),
        constraints={"wall_seconds": 0.5})

    first = service.run(episode["id"])
    journal = service.store.rpc_find(episode["id"], "strategy/selector")
    resumed = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway).run(
            episode["id"])

    assert first["status"] == "waiting_input", first.get("last_error")
    assert journal["status"] == "started"
    assert first["nodes"]["strategy/selector"]["status"] == "waiting_input"
    assert resumed["status"] == "waiting_input"
    assert "reconciliation" in resumed["last_error"].lower()
    assert gateway.calls == 1


def test_user_stop_remains_a_pause_before_deadline(tmp_path):
    package = controlled_package(
        "def execute(payload, context):\n"
        "    return {'deliverables': {}}\n")
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = service.create(
        "Pause independently of deadline", package=package,
        constraints={"wall_seconds": 2})
    stop = threading.Event()
    stop.set()

    result = service.run(episode["id"], stop_event=stop)

    assert result["status"] == "paused"
    assert service.store.remaining_seconds(episode["id"]) > 0


def test_child_uses_root_deadline(tmp_path):
    package = controlled_package(
        "def execute(payload, context):\n"
        "    return {'deliverables': {}}\n")
    service = TaskService(tmp_path, tools=ToolRegistry())
    parent = service.create(
        "Parent", package=package, constraints={"wall_seconds": 0.5})
    service.store.start_deadline(parent["id"])
    time.sleep(0.03)
    child = service.create(
        "Child", package=package, parent_episode_id=parent["id"],
        constraints=deepcopy(parent["task"]["constraints"]))

    parent_deadline = service.store.start_deadline(parent["id"])
    child_deadline = service.store.start_deadline(child["id"])

    assert child_deadline == parent_deadline
    assert service._package_timeout(child["id"], 10) < 0.5
