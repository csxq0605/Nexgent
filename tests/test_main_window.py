"""Conversation-first Nexgent UI contracts."""

from copy import deepcopy
import threading

from PyQt6.QtCore import Qt

from nexgent.ui.main_window import (
    MAIN_CAPABILITY_AUTHORITY, MAIN_PACKAGE_CHANNEL, MainWindow,
)
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.runtime import TaskService


class FakeMainService:
    def __init__(self):
        self.states = {}
        self.entered = threading.Event()
        self.release = threading.Event()
        self.created = []
        self.created_packages = []
        self.created_options = []

    def create(self, objective, **kwargs):
        identity = f"episode-{len(self.states) + 1:04d}"
        self.created.append(objective)
        self.created_packages.append(kwargs.get("package"))
        self.created_options.append(kwargs)
        state = {
            "id": identity,
            "task": {"objective": objective},
            "status": "ready",
            "nodes": {},
            "events": [],
            "artifacts": [],
            "calls": [],
            "input_refs": {},
            "output_refs": {},
            "children": [],
            "usage": {"model_calls": 0, "tool_calls": 0, "nodes": 0},
            "outcome": None,
            "last_error": None,
        }
        self.states[identity] = state
        return deepcopy(state)

    def list(self):
        return [deepcopy(value) for value in reversed(list(self.states.values()))]

    def get(self, identity):
        return deepcopy(self.states[identity])

    def run(self, identity, on_update=None, stop_event=None):
        state = self.states[identity]
        state["status"] = "running"
        state["events"].append({"kind": "episode_started", "content": {}})
        if on_update:
            on_update(self.get(identity))
        self.entered.set()
        while not self.release.wait(0.005) and not stop_event.is_set():
            pass
        state["status"] = "paused" if stop_event.is_set() else "completed"
        state["outcome"] = {"delivery_status": "delivered", "acceptance_status": "not_tested", "limitations": []}
        return self.get(identity)

    def export(self, identity, destination=None):
        return str(destination)


def test_main_starts_from_conversation_and_uses_task_service(qtbot, tmp_path):
    service = FakeMainService()
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)
    window.composer.setPlainText("比较两个方案并给出有证据的建议")
    window.send_message()
    qtbot.waitUntil(service.entered.is_set)

    assert service.created == ["比较两个方案并给出有证据的建议"]
    assert service.created_packages[0]["provenance"]["origin"] == (
        "nexgent.self-orchestration-seed")
    assert service.created_options[0]["context"]["split_role"] == "development"
    assert service.created_options[0]["capability_authority"] == MAIN_CAPABILITY_AUTHORITY
    assert window.selected_id == "episode-0001"
    assert "目标已接收" in window.messages.toPlainText()
    assert not hasattr(window, "objective")
    assert not hasattr(window, "max_calls")

    window.stop_running()
    qtbot.waitUntil(lambda: window.worker is None)
    assert service.get("episode-0001")["status"] == "paused"


def test_real_main_resolves_a_project_package_channel(qtbot, tmp_path):
    service = TaskService(tmp_path)
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)

    selection = window._package_selection()
    assert selection == {"package_channel": MAIN_PACKAGE_CHANNEL}
    active = EvolutionService(service).active(MAIN_PACKAGE_CHANNEL)
    assert active["package"]["provenance"]["origin"] == (
        "nexgent.self-orchestration-seed")
    assert window._package_selection() == selection
    episode = service.create("Plan a task", **selection)
    assert episode["package_digest"] == active["package_digest"]


def test_main_keeps_prior_channel_registration_intact(qtbot, tmp_path):
    service = TaskService(tmp_path)
    evolution = EvolutionService(service)
    from nexgent.tasks.self_orchestration_seed import self_orchestration_package
    old = evolution.register("nexgent-main", self_orchestration_package())
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)
    assert window._package_selection() == {"package_channel": MAIN_PACKAGE_CHANNEL}
    assert EvolutionService(service).active("nexgent-main")["package_digest"] == old["package_digest"]


def test_new_conversation_keeps_advanced_controls_out_of_main(qtbot, tmp_path):
    window = MainWindow(tmp_path, service=FakeMainService())
    qtbot.addWidget(window)
    assert window.windowTitle() == "Nexgent · Main"
    assert window.advanced_button.text() == "打开高级控制台"
    window.new_conversation()
    assert "今天要处理什么" in window.messages.toPlainText()


def test_ctrl_enter_submits_main_message(qtbot, tmp_path):
    service = FakeMainService()
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)
    window.composer.setPlainText("用快捷键提交")
    qtbot.keyClick(window.composer, Qt.Key.Key_Return, modifier=Qt.KeyboardModifier.ControlModifier)
    qtbot.waitUntil(service.entered.is_set)
    assert service.created == ["用快捷键提交"]
    window.stop_running()
    qtbot.waitUntil(lambda: window.worker is None)


def test_main_information_window_summarizes_run_without_raw_json(qtbot, tmp_path):
    service = FakeMainService()
    episode = service.create("比较两个方案")
    state = service.states[episode["id"]]
    state["status"] = "completed"
    state["nodes"] = {
        "plan/nodes/proposer_a": {"status": "completed", "operator": "ask"},
        "plan/nodes/old_retry": {"status": "superseded", "operator": "ask"},
    }
    state["usage"] = {"model_calls": 1, "tool_calls": 0, "nodes": 2}
    state["outcome"] = {"delivery_status": "delivered",
                        "acceptance_status": "passed", "summary": "答案已验证"}
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)
    window.show_task(episode["id"])

    assert "proposer a（ask）" in window.run_view.toPlainText()
    assert "模型调用：1" in window.run_view.toPlainText()
    assert "已替代" in window.run_view.toPlainText()
    assert "答案已验证" in window.messages.toPlainText()
    assert "答案已验证" in window.delivery_view.toPlainText()
    assert '"nodes"' not in window.run_view.toPlainText()


def test_main_evidence_summarizes_service_identity_without_source(qtbot, tmp_path):
    service = FakeMainService()
    episode = service.create("整理证据")
    state = service.states[episode["id"]]
    state["task"]["capability_authority"] = MAIN_CAPABILITY_AUTHORITY
    state["events"] = [
        {"kind": "service_definition_staged", "content": {
            "definition_id": "service-definition-abc", "source": "private source"}},
        {"kind": "service_provider_activated", "content": {
            "definition_id": "service-definition-abc", "revision": 1}},
        {"kind": "service_applied", "content": {
            "binding": {"definition_id": "service-definition-abc"},
            "payload": "private model payload"}},
    ]
    window = MainWindow(tmp_path, service=service)
    qtbot.addWidget(window)
    window.show_task(episode["id"])
    evidence = window.evidence_view.toPlainText()
    assert "服务定义已暂存" in evidence
    assert "服务已激活" in evidence
    assert "服务已应用于模型调用" in evidence
    assert "service-definition-abc" in evidence
    assert "private source" not in evidence
    assert "private model payload" not in evidence
