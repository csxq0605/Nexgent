from PyQt6.QtCore import Qt

from nexgent.gui.main_window import MainWindow
from nexgent.gui.widgets.agent_panel import Composer
from nexgent.gui.widgets.harness_runs import (
    HarnessResumeDialog,
    HarnessResumeRequest,
    HarnessRunDialog,
    HarnessRunRequest,
)
from nexgent.runtime.contracts import RunMode
from nexgent.runtime.events import RuntimeEvent, RuntimeEventKind
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.service import NexgentRuntime
from nexgent.runtime.store import SQLiteRunStore


def set_composer_text(composer, text):
    composer.setPlainText(text)
    cursor = composer.textCursor()
    cursor.movePosition(cursor.MoveOperation.End)
    composer.setTextCursor(cursor)
    composer._update_completions()


def test_main_window_is_compact_and_has_no_control_center(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    assert window.file_tree is not None
    assert window.preview is not None
    assert window.agent is not None
    assert window.navigation_tabs.count() == 4
    assert window.harness_runs is not None
    assert not hasattr(window, "control")
    assert not hasattr(window.agent, "activity")


def test_mode_selector_updates_authoritative_permission_gate(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window._change_mode("plan")
    assert fake_runtime.harness.perms.mode == "plan"
    assert fake_runtime.harness.plan_mode is True


def test_runtime_activity_is_folded_into_conversation_and_ansi_free(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window.show()
    window._run_started("inspect")
    fake_runtime.event_sink(
        RuntimeEvent(
            RuntimeEventKind.MESSAGE_DELTA,
            "console",
            {"text": "\x1b[31mtool output\x1b[0m\n"},
        )
    )
    assert "tool output" in window.agent.messages.toPlainText()
    assert "\x1b" not in window.agent.messages.toPlainText()


def test_long_tool_result_is_compact_in_conversation(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.TOOL_FINISHED,
            "main",
            {"tool": "read_file", "message": "result " * 100},
        )
    )
    text = window.agent.messages.toPlainText()
    assert "✓ read_file" in text
    assert text.endswith("…")
    assert len(text) < 200


def test_new_run_preserves_unified_conversation(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window.agent.append_activity("old output")
    window._run_started("new task")
    text = window.agent.messages.toPlainText()
    assert "old output" in text
    assert "new task" in text


def test_failed_run_updates_status_and_conversation(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window._run_failed("provider unavailable")
    assert window.statusBar().currentMessage() == "Run failed"
    assert "provider unavailable" in window.agent.messages.toPlainText()


def test_verified_harness_progress_and_result_are_visible(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.WORKFLOW_CHANGED,
            "runtime",
            {
                "harness": True,
                "stage": "diagnose",
                "suspect_ref": "changed-app-py",
            },
        )
    )
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.RUN_FINISHED,
            "runtime",
            {
                "harness": True,
                "status": "succeeded",
                "attempts": 2,
                "recoveries": 1,
                "result": "acceptance command passed",
            },
        )
    )

    text = window.agent.messages.toPlainText()
    assert "Harness · diagnose · runtime" in text
    assert "suspect changed-app-py" in text
    assert "Harness run succeeded" in text
    assert "attempts=2" in text


def test_new_harness_run_is_created_from_gui_form(qtbot, fake_runtime, monkeypatch):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    request = HarnessRunRequest(
        task="repair unstable simulation",
        check_command="python simulate.py --verify",
        attempts=4,
        timeout_seconds=90,
    )
    monkeypatch.setattr(
        HarnessRunDialog,
        "get_request",
        staticmethod(lambda _parent=None: request),
    )
    submitted = []

    def submit(text):
        submitted.append(text)
        window._run_started(text)
        return True

    monkeypatch.setattr(window.bridge, "submit", submit)

    window.harness_runs.new_run.click()

    assert submitted == [
        "/harness run --check 'python simulate.py --verify' "
        "--task 'repair unstable simulation' --attempts 4 --timeout 90"
    ]
    conversation = window.agent.messages.toPlainText()
    assert "Start verified Run" in conversation
    assert "repair unstable simulation" in conversation
    assert "/harness run" not in conversation
    assert window.navigation_tabs.currentWidget() is window.harness_runs


def test_runs_page_inspects_resumes_and_exports_without_typed_commands(
    qtbot, fake_runtime, tmp_path, monkeypatch
):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, fake_runtime.project_root)
    context = recorder.start_run("repair simulation", mode=RunMode.CODING)
    recorder.pause(context, "awaiting more attempts")
    fake_runtime.run_store = store
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)

    assert window.harness_runs.runs.count() == 1
    assert "PAUSED" in window.harness_runs.runs.item(0).text()
    assert window.harness_runs.resume.isEnabled()

    window.harness_runs.details.click()
    detail = window.preview.text.toPlainText()
    assert context.run_id in detail
    assert "Status: paused" in detail
    assert "Objective: repair simulation" in detail

    submitted = []
    monkeypatch.setattr(
        window.bridge,
        "submit",
        lambda text: submitted.append(text) or True,
    )
    monkeypatch.setattr(
        HarnessResumeDialog,
        "get_request",
        staticmethod(lambda _parent=None: HarnessResumeRequest(2, 45)),
    )
    window.harness_runs.resume.click()
    assert submitted[-1] == (
        f"/harness resume {context.run_id} --attempts 2 --timeout 45"
    )

    destination = tmp_path / "exported run.jsonl"
    monkeypatch.setattr(
        "nexgent.gui.main_window.QFileDialog.getSaveFileName",
        lambda *_args, **_kwargs: (str(destination), "JSON Lines (*.jsonl)"),
    )
    window.harness_runs.export.click()
    assert submitted[-1] == (
        f"/harness export {context.run_id} --output "
        f"'{destination}'"
    )


def test_queued_native_action_does_not_expose_internal_command(
    qtbot, fake_runtime
):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    command = "/harness resume run-123 --attempts 2 --timeout 45"
    window._native_input_labels[command] = ["Resume verified Run\nRun ID: run-123"]

    window._input_queued(command, 1)

    conversation = window.agent.messages.toPlainText()
    assert "Resume verified Run" in conversation
    assert "/harness resume" not in conversation


def test_clear_command_clears_visible_conversation(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window.agent.add_message("You", "old transcript")
    window._input_finished("/clear", "")
    text = window.agent.messages.toPlainText()
    assert "old transcript" not in text
    assert "Session cleared." in text


def test_rejected_submission_is_restored_to_composer(qtbot, fake_runtime, monkeypatch):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    monkeypatch.setattr(window.bridge, "submit", lambda _text: False)
    window._submit("keep this input")
    assert window.agent.composer.toPlainText() == "keep this input"


def test_subagent_event_creates_switchable_agent_conversation(qtbot, fake_runtime):
    window = MainWindow(fake_runtime)
    qtbot.addWidget(window)
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.SUBAGENT_CHANGED,
            "subagent:abc123",
            {
                "subagent_id": "abc123",
                "state": "created",
                "description": "Review the GUI",
            },
        )
    )
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.TOOL_FINISHED,
            "subagent:abc123",
            {"tool": "read_file", "message": "main_window.py"},
        )
    )
    window._runtime_event(
        RuntimeEvent(
            RuntimeEventKind.SUBAGENT_CHANGED,
            "subagent:abc123",
            {
                "subagent_id": "abc123",
                "state": "completed",
                "result": "Review complete",
            },
        )
    )
    assert window.agent_list.count() == 2
    window.agent_list.setCurrentRow(1)
    assert window.agent.current_agent_id == "abc123"
    assert window.agent.status.text() == "Completed"
    assert "Review the GUI" in window.agent.messages.toPlainText()
    assert "read_file" in window.agent.messages.toPlainText()
    assert "Review complete" in window.agent.messages.toPlainText()


def test_composer_slash_popup_and_tab_completion(qtbot, tmp_path):
    composer = Composer(tmp_path)
    qtbot.addWidget(composer)
    composer.show()
    composer.setFocus()
    set_composer_text(composer, "/workf")
    assert "/workflow" in composer.completion_candidates
    qtbot.keyClick(composer, Qt.Key.Key_Tab)
    assert composer.toPlainText() == "/workflow"


def test_composer_at_popup_and_tab_completion(qtbot, tmp_path):
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")
    composer = Composer(tmp_path)
    qtbot.addWidget(composer)
    composer.show()
    composer.setFocus()
    set_composer_text(composer, "Inspect @READ")
    assert "README.md" in composer.completion_candidates
    qtbot.keyClick(composer, Qt.Key.Key_Tab)
    assert composer.toPlainText() == "Inspect @README.md"


def test_composer_up_down_restores_persisted_history_and_draft(qtbot, tmp_path):
    composer = Composer(tmp_path)
    qtbot.addWidget(composer)
    submitted = []
    composer.submitted.connect(submitted.append)
    composer.setPlainText("first")
    assert composer.submit_current()
    composer.setPlainText("second")
    assert composer.submit_current()
    composer.setPlainText("draft")

    qtbot.keyClick(composer, Qt.Key.Key_Up)
    assert composer.toPlainText() == "second"
    qtbot.keyClick(composer, Qt.Key.Key_Up)
    assert composer.toPlainText() == "first"
    qtbot.keyClick(composer, Qt.Key.Key_Down)
    assert composer.toPlainText() == "second"
    qtbot.keyClick(composer, Qt.Key.Key_Down)
    assert composer.toPlainText() == "draft"
    assert submitted == ["first", "second"]
    assert (tmp_path / ".nexgent" / "input_history.json").is_file()

    reopened = Composer(tmp_path)
    qtbot.addWidget(reopened)
    qtbot.keyClick(reopened, Qt.Key.Key_Up)
    assert reopened.toPlainText() == "second"


def test_composer_down_restores_draft_when_recalled_command_opens_popup(
    qtbot, tmp_path
):
    composer = Composer(tmp_path)
    qtbot.addWidget(composer)
    composer.show()
    composer.setFocus()
    composer.setPlainText("/effort")
    assert composer.submit_current()
    composer.setPlainText("draft-visible")

    qtbot.keyClick(composer, Qt.Key.Key_Up)
    assert composer.toPlainText() == "/effort"
    composer.completer.popup().show()
    assert composer.completer.popup().isVisible()
    qtbot.keyClick(composer, Qt.Key.Key_Down)
    assert composer.toPlainText() == "draft-visible"
