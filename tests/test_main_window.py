"""Conversation-first Nexgent UI contracts."""

from copy import deepcopy
import threading

from PyQt6.QtCore import Qt

from nexgent.ui.main_window import MainWindow


class FakeMainService:
    def __init__(self):
        self.states = {}
        self.entered = threading.Event()
        self.release = threading.Event()
        self.created = []
        self.created_packages = []

    def create(self, objective, **kwargs):
        identity = f"episode-{len(self.states) + 1:04d}"
        self.created.append(objective)
        self.created_packages.append(kwargs.get("package"))
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
    assert window.selected_id == "episode-0001"
    assert "目标已接收" in window.messages.toPlainText()
    assert not hasattr(window, "objective")
    assert not hasattr(window, "max_calls")

    window.stop_running()
    qtbot.waitUntil(lambda: window.worker is None)
    assert service.get("episode-0001")["status"] == "paused"


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
