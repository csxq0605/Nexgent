"""Task desktop contracts against deterministic services; no model calls."""

from copy import deepcopy
import threading

from PyQt6.QtCore import Qt

from nexgent.ui.tasks_window import TaskWindow, task_status


class Tools:
    def describe(self):
        return [{"name": "workbench.inspect", "effect": "read_only"}]


class FakeService:
    def __init__(self):
        self.states = {}
        self.tools = Tools()
        self.created = []
        self.run_ids = []
        self.exported = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.fail = False

    def create(self, objective, inputs=None, deliverables=None, budget=None, capabilities=None, package=None,
               context=None, constraints=None):
        identity = "episode-" + f"{len(self.states) + 1:016x}"
        self.created.append({"objective": objective, "inputs": deepcopy(inputs),
                             "deliverables": deepcopy(deliverables), "constraints": deepcopy(constraints),
                             "budget": deepcopy(budget), "capabilities": deepcopy(capabilities)})
        state = {"id": identity, "task": {"objective": objective}, "status": "ready", "nodes": {},
                 "input_refs": {"document": "artifact-input"}, "output_refs": {}, "children": [],
                 "usage": {"model_calls": 0, "tool_calls": 0, "nodes": 0, "reserved_completion_tokens": 0,
                           "usage_missing_call_ids": []}, "calls": [], "events": [], "artifacts": [],
                 "outcome": None, "execution": {}, "last_error": None,
                 "package_id": "package-frozen", "package_digest": "digest-frozen", "memory_snapshot_id": "snapshot-actual"}
        self.states[identity] = state
        return self.get(identity)

    def list(self):
        return deepcopy(list(reversed(list(self.states.values()))))

    def get(self, identity):
        return deepcopy(self.states[identity])

    def run(self, identity, on_update=None, stop_event=None):
        self.run_ids.append(identity)
        state = self.states[identity]
        state.update(status="running", nodes={"inspect": {"status": "running", "operator": "tool",
                                                        "control_dependencies": ["prepare"],
                                                        "bindings": {"evidence": "artifact-input"}, "attempt_id": "inspect/0"}})
        if on_update:
            on_update(self.get(identity))
        self.entered.set()
        while not self.release.wait(0.005) and not stop_event.is_set():
            pass
        if self.fail:
            state.update(status="failed", last_error="Provider response unknown; request remains charged")
            self.finished.set()
            raise RuntimeError("provider request failed")
        state.update(status="paused" if stop_event.is_set() else "completed")
        if state["status"] == "completed":
            state["outcome"] = {"delivery_status": "delivered", "acceptance_status": "not_tested",
                                "limitations": ["Independent acceptance was not configured"]}
            state["output_refs"] = {"answer": "artifact-answer"}
            state["artifacts"] = [{"id": "artifact-answer", "content": {"answer": "Stored deliverable"}}]
            state["usage"] = {"model_calls": 1, "tool_calls": 1, "nodes": 1,
                              "reserved_completion_tokens": 300, "usage_missing_call_ids": ["call-unknown"]}
            state["nodes"]["inspect"]["status"] = "completed"
        self.finished.set()
        return self.get(identity)

    def export(self, identity, destination=None):
        self.exported.append((identity, destination))
        return str(destination) + "/" + identity


def window(qtbot, tmp_path, service):
    widget = TaskWindow(tmp_path, service=service)
    qtbot.addWidget(widget)
    widget.show()
    return widget


class FakeEvolution:
    def active(self, channel):
        return {"channel": channel, "package_id": "package-active", "package_digest": "digest-active",
                "revision": 4, "promotion": {"decision_id": "decision-7"}, "updated_at": 1.0,
                "package": {"files": {"private.py": "hidden source"}}}

    def events(self, channel):
        return [
            {"channel": channel, "sequence": 8, "kind": "candidate_admitted", "created": 1.0,
             "content": {"candidate_id": "candidate-8", "package_id": "package-next",
                         "hidden_evaluator": "private rubric"},
             "previous": "old", "digest": "candidate-event"},
            {"channel": channel, "sequence": 9, "kind": "promotion_assessed", "created": 2.0,
             "content": {"decision_id": "decision-9", "trial_id": "trial-9", "eligible": True},
             "previous": "candidate-event", "digest": "decision-event"},
            {"channel": channel, "sequence": 10, "kind": "package_promoted", "created": 3.0,
             "content": {"candidate_id": "candidate-8", "decision_id": "decision-9",
                         "trial_id": "trial-9", "to_package_id": "package-next"},
             "previous": "decision-event", "digest": "promotion-event"},
            {"channel": channel, "sequence": 11, "kind": "package_rolled_back", "created": 4.0,
             "content": {"from_package_id": "package-next", "to_package_id": "package-active",
                         "reason": "guard regression", "evidence": {"private": "hidden result"}},
             "previous": "promotion-event", "digest": "rollback-event"},
        ]


def test_rsi_information_view_shows_versions_and_public_audit_only(qtbot, tmp_path):
    service = FakeService()
    ui = TaskWindow(tmp_path, service=service, evolution=FakeEvolution())
    qtbot.addWidget(ui)
    ui.show()
    text = ui.rsi_view.toPlainText()
    assert "package-active" in text and '"revision": 4' in text
    assert "candidate-8" in text and "trial-9" in text and "decision-9" in text
    assert "package_promoted" in text and "package_rolled_back" in text
    assert "private rubric" not in text and "hidden source" not in text and "hidden result" not in text


def test_register_freeform_task_with_inputs_and_budget(qtbot, tmp_path):
    service = FakeService()
    ui = window(qtbot, tmp_path, service)
    ui.objective.setPlainText("Compare two proposed storage designs")
    ui.inputs.setPlainText('{"document": {"facts": [1, 2]}}')
    ui.contract.setPlainText('{"deliverables":[{"name":"report","schema":{"type":"object"}}],"constraints":{"quality_requirements":["cite inputs"]}}')
    ui.max_calls.setValue(3)
    ui.max_tools.setValue(4)
    ui.tool_permissions.item(0).setCheckState(Qt.CheckState.Checked)
    qtbot.mouseClick(ui.create_button, Qt.MouseButton.LeftButton)
    assert service.created == [{"objective": "Compare two proposed storage designs", "inputs": {"document": {"facts": [1, 2]}},
                                "deliverables": [{"name": "report", "schema": {"type": "object"}}],
                                "constraints": {"quality_requirements": ["cite inputs"]},
                                "budget": {"max_model_calls": 3, "max_completion_tokens": 80000, "max_tool_calls": 4, "max_nodes": 100},
                                "capabilities": ["workbench.inspect"]}]
    assert ui.task_list.count() == 1
    assert ui.run_button.isEnabled()
    assert service.run_ids == []
    assert "workbench.inspect" in ui.tools.toPlainText()
    assert "Compare two" in ui.heading.text()


def test_invalid_json_does_not_register_or_execute(qtbot, tmp_path):
    service = FakeService()
    ui = window(qtbot, tmp_path, service)
    ui.objective.setPlainText("Prepare deliverable")
    for invalid in ('{"bad":', "[1, 2]"):
        ui.inputs.setPlainText(invalid)
        qtbot.mouseClick(ui.create_button, Qt.MouseButton.LeftButton)
        assert ui.error_label.isVisible()
        assert not service.created
    assert service.run_ids == []


def test_viewing_history_and_refresh_never_starts_work(qtbot, tmp_path):
    service = FakeService()
    first = service.create("Historical completed task")
    service.states[first["id"]].update(status="completed", outcome={"acceptance_status": "missing", "limitations": ["Missing independent evidence"]})
    second = service.create("Second ready task")
    ui = window(qtbot, tmp_path, service)
    ui.show_task(first["id"])
    ui.refresh_tasks()
    assert "验收缺测" in ui.status_label.text()
    assert not ui.run_button.isEnabled()
    assert "Missing independent evidence" in ui.delivery.toPlainText()
    ui.show_task(second["id"])
    assert ui.run_button.isEnabled()
    assert service.run_ids == []


def test_background_run_keeps_history_selection_separate_and_stops(qtbot, tmp_path):
    service = FakeService()
    active = service.create("Run current task")
    historical = service.create("Historical task")
    service.states[historical["id"]]["status"] = "completed"
    ui = window(qtbot, tmp_path, service)
    ui.show_task(active["id"])
    qtbot.mouseClick(ui.run_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(service.entered.is_set)
    qtbot.waitUntil(lambda: ui.node_table.rowCount() == 1)
    assert "prepare" in ui.node_table.item(0, 3).text()
    assert "artifact-input" in ui.node_table.item(0, 4).text()
    ui.show_task(historical["id"])
    assert ui.running_id == active["id"]
    assert ui.selected_id == historical["id"]
    assert ui.stop_button.isEnabled()
    qtbot.mouseClick(ui.stop_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: ui.worker is None)
    assert service.get(active["id"])["status"] == "paused"
    assert ui.selected_id == historical["id"]
    assert "Historical task" == ui.heading.text()
    assert service.run_ids == [active["id"]]
    ui.show_task(active["id"])
    assert ui.run_button.isEnabled()


def test_resume_preserves_episode_and_delivers_unmeasured_result(qtbot, tmp_path):
    service = FakeService()
    state = service.create("Deliver an answer")
    service.states[state["id"]]["status"] = "paused"
    service.release.set()
    ui = window(qtbot, tmp_path, service)
    ui.show_task(state["id"])
    qtbot.mouseClick(ui.run_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: ui.worker is None)
    assert service.run_ids == [state["id"]]
    assert len(service.states) == 1
    assert "执行完成 · 未验收" == ui.status_label.text()
    assert "Stored deliverable" in ui.delivery.toPlainText()
    assert "用量缺失请求：1" in ui.delivery.toPlainText()
    assert "digest-frozen" in ui.memory.toPlainText()
    assert "snapshot-actual" in ui.memory.toPlainText()
    assert not ui.run_button.isEnabled()


def test_failure_exposes_persisted_status_and_unknown_cost(qtbot, tmp_path):
    service = FakeService()
    state = service.create("Task with provider failure")
    service.fail = True
    service.release.set()
    ui = window(qtbot, tmp_path, service)
    ui.show_task(state["id"])
    qtbot.mouseClick(ui.run_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(lambda: ui.worker is None)
    assert ui.status_label.text() == "执行失败"
    assert "request remains charged" in ui.error_label.text()
    assert ui.error_label.isVisible()


def test_close_stops_and_waits_for_worker_finish(qtbot, tmp_path):
    service = FakeService()
    state = service.create("Running task before close")
    ui = window(qtbot, tmp_path, service)
    ui.show_task(state["id"])
    qtbot.mouseClick(ui.run_button, Qt.MouseButton.LeftButton)
    qtbot.waitUntil(service.entered.is_set)
    ui.close()
    qtbot.waitUntil(lambda: ui.worker is None)
    qtbot.waitUntil(lambda: not ui.isVisible())
    assert service.finished.is_set()
    assert service.get(state["id"])["status"] == "paused"


def test_export_uses_selected_history_without_running(qtbot, tmp_path, monkeypatch):
    service = FakeService()
    state = service.create("Stored delivery")
    ui = window(qtbot, tmp_path, service)
    ui.show_task(state["id"])
    destination = str(tmp_path / "task.json")
    monkeypatch.setattr("nexgent.ui.tasks_window.QFileDialog.getSaveFileName", lambda *args: (destination, "JSON (*.json)"))
    qtbot.mouseClick(ui.export_button, Qt.MouseButton.LeftButton)
    assert service.exported == [(state["id"], destination)]
    assert "已导出" in ui.statusBar().currentMessage()
    assert service.run_ids == []


def test_completion_labels_separate_execution_and_acceptance():
    assert task_status({"status": "completed"}) == "执行完成 · 未验收"
    assert task_status({"status": "completed", "outcome": {"acceptance_status": "passed"}}) == "执行完成 · 验收通过"
    assert task_status({"status": "completed", "outcome": {"acceptance_status": "failed"}}) == "执行完成 · 验收未通过"
    assert task_status({"status": "failed"}) == "执行失败"
