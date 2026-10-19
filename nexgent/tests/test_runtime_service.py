from nexgent.context import Session
from nexgent.runtime.events import RuntimeEventKind
from nexgent.runtime.service import NexgentRuntime


class FakeAbort:
    def request(self):
        self.requested = True


class FakePerms:
    def set_interaction_broker(self, broker):
        self.broker = broker

    def check(self, permission, action, params=None):
        return True


class FakeHarness:
    def __init__(self):
        self.model = "fake-model"
        self.graceful_abort = FakeAbort()
        self.perms = FakePerms()

    def run(self, text, session):
        print("tool activity")
        session.add_message("user", text)
        session.add_message("assistant", "answer")
        return "answer"


def test_runtime_runs_prompt_and_emits_lifecycle(tmp_path):
    events = []
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=FakeHarness(),
        session=Session("test", auto_save_dir=str(tmp_path)),
        event_sink=events.append,
    )
    result = runtime.handle_input("hello")
    assert result == "answer"
    assert events[0].kind is RuntimeEventKind.RUN_STARTED
    assert any(e.kind is RuntimeEventKind.MESSAGE_DELTA for e in events)
    assert events[-1].kind is RuntimeEventKind.RUN_FINISHED


def test_runtime_runs_real_verified_coding_loop_with_explicit_check(tmp_path):
    (tmp_path / "test_app.py").write_text(
        "import unittest\n"
        "import app\n\n"
        "class Tests(unittest.TestCase):\n"
        "    def test_value(self):\n"
        "        self.assertEqual(app.value(), 2)\n",
        encoding="utf-8",
    )

    class RepairHarness(FakeHarness):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def run(self, text, session):
            self.calls += 1
            value = 1 if self.calls == 1 else 2
            (tmp_path / "app.py").write_text(
                f"def value():\n    return {value}\n", encoding="utf-8"
            )
            session.add_message("user", text)
            return "implemented"

    events = []
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=RepairHarness(),
        session=Session("verified-coding"),
        event_sink=events.append,
    )
    payload = __import__("json").loads(
        runtime.handle_input(
            '/harness run --check "python -m unittest discover -s . -q" '
            '--task "Fix the failing acceptance test" --attempts 2 --timeout 5'
        )
    )

    assert payload["status"] == "succeeded"
    assert payload["attempts"] == 2
    assert payload["recoveries"] == 1
    assert payload["changed_files"] == ["app.py"]
    assert any(
        event.kind is RuntimeEventKind.WORKFLOW_CHANGED
        and event.payload.get("harness") is True
        and event.payload.get("stage") == "diagnose"
        for event in events
    )
    assert events[-1].payload["harness_run_id"] == payload["run_id"]


def test_goal_run_alias_uses_same_verified_persistent_harness(tmp_path):
    (tmp_path / "app.py").write_text("VALUE = 1\n", encoding="utf-8")

    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=FakeHarness(),
        session=Session("goal-run"),
    )
    payload = __import__("json").loads(
        runtime.handle_input(
            '/goal run --check "python -c \'import app; assert app.VALUE == 1\'" '
            '--task "Keep the verified value" --attempts 1 --timeout 5'
        )
    )

    assert payload["status"] == "succeeded"
    assert runtime.run_store.get_run(payload["run_id"]).status.value == "succeeded"


def test_runtime_manages_resumes_status_and_portable_exports(tmp_path):
    (tmp_path / "test_app.py").write_text(
        "import unittest\n"
        "import app\n\n"
        "class Tests(unittest.TestCase):\n"
        "    def test_value(self):\n"
        "        self.assertEqual(app.value(), 2)\n",
        encoding="utf-8",
    )

    class StatefulHarness(FakeHarness):
        def __init__(self, value):
            super().__init__()
            self.value = value

        def run(self, text, session):
            (tmp_path / "app.py").write_text(
                f"def value():\n    return {self.value}\n", encoding="utf-8"
            )
            return "changed"

    first_runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=StatefulHarness(0),
        session=Session("first-harness"),
    )
    first = __import__("json").loads(
        first_runtime.handle_input(
            '/harness run --check "python -m unittest discover -s . -q" '
            '--task "Fix the long-running task" --attempts 1 --timeout 5'
        )
    )
    assert first["status"] == "paused"

    resumed_runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=StatefulHarness(2),
        session=Session("resumed-harness"),
    )
    resumed = __import__("json").loads(
        resumed_runtime.handle_input(
            f'/harness resume {first["run_id"]} --attempts 1 --timeout 5'
        )
    )
    assert resumed["run_id"] == first["run_id"]
    assert resumed["status"] == "succeeded"

    listed = __import__("json").loads(
        resumed_runtime.handle_input("/harness list")
    )
    assert [run["run_id"] for run in listed] == [first["run_id"]]
    status = __import__("json").loads(
        resumed_runtime.handle_input(f'/harness status {first["run_id"]}')
    )
    assert status["run"]["status"] == "succeeded"
    exported = __import__("json").loads(
        resumed_runtime.handle_input(f'/harness export {first["run_id"]}')
    )
    export_path = __import__("pathlib").Path(exported["export_path"])
    assert export_path.is_file()
    assert '"record_type":"run"' in export_path.read_text(encoding="utf-8")


def test_runtime_persists_unverified_run_and_correlated_tool_events(tmp_path):
    class EmittingHarness(FakeHarness):
        def run(self, text, session):
            self._runtime_event_callback(
                "tool_started",
                {
                    "tool": "read_file",
                    "tool_call_id": "call-1",
                    "arguments": {"path": "README.md"},
                },
            )
            self._runtime_event_callback(
                "tool_finished",
                {
                    "tool": "read_file",
                    "tool_call_id": "call-1",
                    "duration_seconds": 0.01,
                    "message": "ok",
                },
            )
            return super().run(text, session)

    events = []
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=EmittingHarness(),
        session=Session("test", auto_save_dir=str(tmp_path)),
        event_sink=events.append,
    )

    assert runtime.handle_input("inspect") == "answer"
    run_id = events[0].payload["durable_run_id"]
    stored_run = runtime.run_store.get_run(run_id)
    stored_events = runtime.run_store.list_events(run_id)

    assert stored_run.status.value == "completed_unverified"
    assert stored_run.termination_reason == "agent_completed_unverified"
    tool_events = [event for event in stored_events if event.kind.value == "tool"]
    assert [event.tool_call_id for event in tool_events] == ["call-1", "call-1"]
    assert events[-1].payload["verification"] == "not_run"


def test_runtime_builds_model_to_tool_causal_path(tmp_path):
    class CausalHarness(FakeHarness):
        def run(self, text, session):
            self._runtime_event_callback(
                "message_started", {"step": 1, "model": self.model}
            )
            self._runtime_event_callback(
                "message_finished",
                {
                    "step": 1,
                    "model": self.model,
                    "tool_call_ids": ["call-1"],
                },
            )
            self._runtime_event_callback(
                "tool_started",
                {"tool": "read_file", "tool_call_id": "call-1"},
            )
            self._runtime_event_callback(
                "tool_finished",
                {"tool": "read_file", "tool_call_id": "call-1"},
            )
            return super().run(text, session)

    events = []
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=CausalHarness(),
        session=Session("causal"),
        event_sink=events.append,
    )

    assert runtime.run_agent_task("inspect") == "answer"
    run_id = events[0].payload["durable_run_id"]
    recorded = runtime.run_store.list_events(run_id)
    by_kind = {
        event.payload.get("runtime_kind"): event
        for event in recorded
        if event.payload.get("runtime_kind")
    }
    model_start = by_kind["message_started"]
    model_finish = by_kind["message_finished"]
    tool_start = by_kind["tool_started"]
    tool_finish = by_kind["tool_finished"]

    assert model_finish.causation_event_id == model_start.event_id
    assert tool_start.causation_event_id == model_finish.event_id
    assert tool_finish.causation_event_id == tool_start.event_id
    assert runtime.run_store.list_ancestor_paths(run_id, tool_finish.event_id) == [
        (
            model_start.event_id,
            model_finish.event_id,
            tool_start.event_id,
            tool_finish.event_id,
        )
    ]


def test_runtime_tracks_code_change_to_failed_command_and_records_diagnosis(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    source = project / "module.py"
    source.write_text("VALUE = 1\n", encoding="utf-8")

    class CodingHarness(FakeHarness):
        def run(self, text, session):
            self._runtime_event_callback(
                "tool_started",
                {
                    "tool": "edit_file",
                    "tool_call_id": "edit-1",
                    "arguments": {"path": "module.py"},
                },
            )
            self._runtime_event_callback(
                "tool_started",
                {
                    "tool": "run_command",
                    "tool_call_id": "test-1",
                    "arguments": {"command": "python -m pytest"},
                },
            )
            source.write_text("VALUE = 2\n", encoding="utf-8")
            self._runtime_event_callback(
                "tool_finished",
                {
                    "tool": "edit_file",
                    "tool_call_id": "edit-1",
                    "duration_seconds": 0.01,
                    "message": "updated module.py",
                },
            )
            self._runtime_event_callback(
                "tool_failed",
                {
                    "tool": "run_command",
                    "tool_call_id": "test-1",
                    "duration_seconds": 0.02,
                    "message": "1 test failed",
                },
            )
            return "investigating the failed regression"

    events = []
    runtime = NexgentRuntime(
        project_root=project,
        harness=CodingHarness(),
        session=Session("coding-trace"),
        event_sink=events.append,
    )

    runtime.run_agent_task("change the code and run its tests")
    run_id = events[0].payload["durable_run_id"]
    export = runtime.run_store.export_run(run_id)
    mutation = next(
        event
        for event in export["events"]
        if event["payload"].get("stage") == "workspace-change"
    )
    process = next(
        event for event in export["events"] if event["kind"] == "process"
    )

    assert {artifact["role"] for artifact in export["artifacts"]} >= {
        "workspace_preimage",
        "workspace_postimage",
    }
    assert process["payload"]["status"] == "failed"
    assert any(
        edge["from_ref"] == mutation["event_id"]
        and edge["to_ref"] == process["event_id"]
        and edge["kind"] == "data"
        for edge in export["dependency_edges"]
    )
    assert export["faults"][0]["record"]["detector"] == "command-exit-detector"
    assert export["diagnoses"][0]["candidates"][0]["suspect_ref"] == mutation["event_id"]
    assert export["diagnoses"][0]["method"] == "workspace-command-dependency"


def test_runtime_agent_task_preserves_console_and_durable_envelope(tmp_path, capsys):
    events = []
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=FakeHarness(),
        session=Session("cli-session", auto_save_dir=str(tmp_path / "sessions")),
        event_sink=events.append,
    )

    assert runtime.run_agent_task("hello from cli") == "answer"
    assert "tool activity" in capsys.readouterr().out
    run_id = events[0].payload["durable_run_id"]
    assert runtime.run_store.get_run(run_id).status.value == "completed_unverified"
    assert events[-1].payload["durable_run_id"] == run_id


def test_runtime_preserves_explicit_session_storage_location(tmp_path):
    session_dir = tmp_path / "operator-selected-sessions"
    runtime = NexgentRuntime(
        project_root=tmp_path / "project",
        harness=FakeHarness(),
        session=Session("test", auto_save_dir=str(session_dir)),
    )

    assert runtime.session_dir == session_dir.resolve()
    assert runtime.session.auto_save_dir == str(session_dir.resolve())


def test_runtime_agent_task_restores_cwd_and_records_failure(tmp_path, monkeypatch):
    class FailingHarness(FakeHarness):
        def run(self, text, session):
            raise ValueError("planned failure")

    caller_dir = tmp_path / "caller"
    project_dir = tmp_path / "project"
    caller_dir.mkdir()
    project_dir.mkdir()
    monkeypatch.chdir(caller_dir)
    events = []
    runtime = NexgentRuntime(
        project_root=project_dir,
        harness=FailingHarness(),
        session=Session("test"),
        event_sink=events.append,
    )

    try:
        runtime.run_agent_task("fail")
    except ValueError as exc:
        assert str(exc) == "planned failure"
    else:
        raise AssertionError("expected the planned failure")

    assert tmp_path.joinpath("caller").samefile(".")
    run_id = events[0].payload["durable_run_id"]
    assert runtime.run_store.get_run(run_id).status.value == "failed"


def test_runtime_preserves_quit_command_action(tmp_path):
    runtime = NexgentRuntime(
        project_root=tmp_path,
        harness=FakeHarness(),
        session=Session("test", auto_save_dir=str(tmp_path)),
    )
    result = runtime.handle_input("/quit")
    assert runtime.last_command_action == "quit"
    assert "Bye!" in result


def test_runtime_abort_delegates_to_harness(tmp_path):
    harness = FakeHarness()
    runtime = NexgentRuntime(tmp_path, harness=harness, session=Session("test"))
    runtime.abort()
    assert harness.graceful_abort.requested


def test_runtime_abort_also_cancels_active_subagents(tmp_path):
    class Manager:
        def __init__(self):
            self.cancelled = False

        def cancel_all(self):
            self.cancelled = True

    harness = FakeHarness()
    harness._subagent_manager = Manager()
    runtime = NexgentRuntime(tmp_path, harness=harness, session=Session("test"))
    runtime.abort()
    assert harness.graceful_abort.requested
    assert harness._subagent_manager.cancelled


def test_runtime_turns_subagent_callback_into_typed_event(tmp_path):
    events = []
    harness = FakeHarness()
    harness._subagent_manager = None
    NexgentRuntime(
        tmp_path,
        harness=harness,
        session=Session("test"),
        event_sink=events.append,
    )
    harness._subagent_event_callback(
        {"subagent_id": "child-1", "state": "running", "task": "inspect"}
    )
    event = events[-1]
    assert event.kind is RuntimeEventKind.SUBAGENT_CHANGED
    assert event.source == "subagent:child-1"
    assert event.payload["task"] == "inspect"


def test_runtime_routes_structured_harness_tool_event(tmp_path):
    events = []
    harness = FakeHarness()
    NexgentRuntime(
        tmp_path,
        harness=harness,
        session=Session("test"),
        event_sink=events.append,
    )
    harness._runtime_event_callback(
        "tool_started", {"tool": "read_file", "arguments": {"path": "README.md"}}
    )
    event = events[-1]
    assert event.kind is RuntimeEventKind.TOOL_STARTED
    assert event.source == "main"
    assert event.payload["tool"] == "read_file"


def test_runtime_routes_subagent_tool_event_to_subagent_source(tmp_path):
    events = []
    harness = FakeHarness()
    NexgentRuntime(
        tmp_path,
        harness=harness,
        session=Session("test"),
        event_sink=events.append,
    )
    harness._subagent_event_callback({
        "subagent_id": "child-1",
        "state": "running",
        "task": "inspect",
        "event_kind": "tool_finished",
        "tool": "read_file",
        "message": "README.md",
    })
    event = events[-1]
    assert event.kind is RuntimeEventKind.TOOL_FINISHED
    assert event.source == "subagent:child-1"
    assert event.payload["tool"] == "read_file"


def test_runtime_inject_guidance_persists_in_active_session(tmp_path):
    events = []
    session = Session("test")
    runtime = NexgentRuntime(
        tmp_path,
        harness=FakeHarness(),
        session=session,
        event_sink=events.append,
    )
    runtime.inject_guidance("use the safer path")
    assert session.messages[-1] == {
        "role": "user",
        "content": "use the safer path",
        "injected": True,
    }
    assert events[-1].kind is RuntimeEventKind.NOTICE
