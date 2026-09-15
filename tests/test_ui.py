"""Information-space behavior with a deterministic, non-network controller."""

from copy import deepcopy
import json
from pathlib import Path
import threading

import pytest
from PyQt6.QtCore import Qt

from nexgent.kernel.programs import make_bundle
from nexgent.ui.app import project_root
from nexgent.ui.window import ARMS, ResearchWindow, json_text


def source_pair():
    parent = make_bundle({"task.py": "def solve(problem, tools): return {'model': 1}\n",
                          "meta.py": "def improve(context, broker): return {'candidates': []}\n"})
    child = make_bundle({"task.py": "def solve(problem, tools): return {'model': 2}\n"}, parent=parent)
    return parent, child


class FakeController:
    def __init__(self):
        parent, child = source_pair()
        self.programs = {p["id"]: p for p in (parent, child)}
        self.states = {}
        self.created = []
        self.run_ids = []
        self.exported = []
        self.continued = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.fail = False

    def state(self, identity="study-0000000000000001", status="completed"):
        parent, child = list(self.programs.values())
        state = {"id": identity, "question": "从含噪时间序列中发现动力学方程", "status": status,
            "stage": "study completed; evidence available", "generation": 3, "max_generations": 3,
            "arm": "full", "budget": {"max_model_calls": 36, "max_completion_tokens": 144000},
            "usage": {"model_calls": 2, "reported_total_tokens": 321, "unknown_usage_calls": 1,
                      "reserved_completion_tokens": 12000}, "created": 1,
            "active_program": child["id"], "research_program": parent["id"],
            "archive": [{key: p[key] for key in ("id", "parent_id", "generation")} for p in (parent, child)],
            "evaluations": [{"generation": 1, "candidate_id": child["id"], "parent_id": parent["id"],
                "score": 0.8, "delta": 0.02, "decision": "promoted", "reason": "paired evidence"}],
            "research": {"literature": [{"generation": 1, "content": [{"papers": [{"title": "A real stored paper",
                "url": "https://arxiv.org/abs/2501.00001", "evidence_level": "metadata_and_abstract", "abstract": "Stored abstract"}]}]}],
                "hypotheses": [{"generation": 1, "content": [{"claim": "平滑可能降低导数误差", "prediction": "验证误差下降"}]}],
                "experiments": [{"label": "development experiment", "score": 0.8}],
                "failures": [{"error": "held-out trajectory diverged"}], "knowledge": [{"claim": "需要新验证", "status": "uncertain"}]},
            "conclusion": {"protocol_completed": True, "mean_transfer_delta": 0.0,
                "source_self_modification": True, "meta_productivity": "Requires independent comparison"},
            "events": [{"kind": "capability", "content": {"input_artifact_ids": ["input-hash"], "output_artifact_ids": ["output-hash"]}}],
            "calls": [{"role": "critic", "model": "provider/model", "status": "received", "usage": {"total_tokens": 321}},
                      {"role": "designer", "model": "provider/model", "status": "failed", "usage": {}}]}
        self.states[identity] = state
        return deepcopy(state)

    def list_studies(self): return deepcopy(list(self.states.values()))
    def get(self, identity): return deepcopy(self.states[identity])
    def get_program(self, identity): return deepcopy(self.programs[identity])

    def create(self, question, generations=3, arm="full", seed=0, budget=None):
        self.created.append({"question": question, "generations": generations, "arm": arm, "budget": deepcopy(budget)})
        identity = f"study-{len(self.states) + 1:016x}"
        state = self.state(identity, "ready")
        state.update(question=question, generation=0, max_generations=generations, arm=arm, budget=deepcopy(budget))
        self.states[identity] = state
        return deepcopy(state)

    def run(self, identity, progress=None, stop_event=None):
        self.run_ids.append(identity)
        self.states[identity].update(status="running", stage="actual source research")
        if progress: progress(self.get(identity))
        self.entered.set()
        while not self.release.wait(0.01) and not stop_event.is_set():
            pass
        if self.fail:
            self.states[identity].update(status="failed", last_error="Provider receipt remained reserved")
            self.finished.set()
            raise RuntimeError("visible provider failure")
        self.states[identity].update(status="paused" if stop_event.is_set() else "completed", stage="saved")
        self.finished.set()
        return self.get(identity)

    def continue_research(self, identity, *, generations=3, budget=None):
        self.continued.append({"study_id": identity, "generations": generations, "budget": deepcopy(budget)})
        previous = self.get(identity)
        result = self.state(f"study-{len(self.states)+1:016x}", "ready")
        result.update(question=previous["question"], arm=previous["arm"], generation=0,
                      max_generations=generations, budget=deepcopy(budget), origin_study=identity)
        self.states[result["id"]] = result
        return deepcopy(result)

    def export(self, identity, destination=None):
        self.exported.append((identity, str(destination)))
        Path(destination).write_text(json.dumps(self.get(identity)), encoding="utf-8")
        return str(destination)


@pytest.fixture
def make_window(qtbot, tmp_path, monkeypatch):
    monkeypatch.setenv("NEXGENT_API_KEY", "test-key-for-testing")
    windows = []
    def create(controller=None):
        window = ResearchWindow(tmp_path, controller=controller or FakeController())
        windows.append(window); qtbot.addWidget(window); window.show()
        return window
    yield create
    for window in windows:
        window.stop_study()
        qtbot.waitUntil(lambda w=window: w._worker is None, timeout=4000)
        window.close()


def test_history_renders_actual_usage_generation_sources_and_conclusion(make_window):
    controller = FakeController(); state = controller.state()
    window = make_window(controller)
    assert window.selected_id == state["id"]
    assert window.program_card.value.text() == "第 1 代"
    assert window.program_card.value.toolTip() == state["active_program"]
    assert window.round_card.value.text() == "3 / 3"
    assert window.calls_card.value.text() == "2 / 36"
    assert window.tokens_card.value.text() == "321"
    assert "1 次请求" in window.tokens_card.hint.text()
    assert window.sources_list.count() == 1
    assert window.sources_list.item(0).text() == "A real stored paper"
    assert "Stored abstract" in window.sources_detail.toPlainText()
    assert "平滑" in window.hypotheses_list.item(0).text()
    assert "研究流程已完成" in window.conclusion.toPlainText()
    assert "尚未形成最终结论" not in window.overview.toPlainText()
    assert controller.run_ids == []


def test_history_and_running_study_remain_separate(make_window, qtbot):
    controller = FakeController(); a = controller.state(status="paused")
    b = controller.state("study-0000000000000002")
    b["question"] = "历史 B"; controller.states[b["id"]] = b
    window = make_window(controller); window.select_study(a["id"]); window.resume_study()
    qtbot.waitUntil(controller.entered.is_set)
    window.select_study(b["id"])
    progress = controller.get(a["id"]); progress["generation"] = 8
    window._progress(progress)
    assert window.snapshot["id"] == b["id"]
    assert window.subtitle.text() == "历史 B"
    assert window.round_card.value.text() == "3 / 3"
    assert window.running_id == a["id"]
    window.stop_study(); qtbot.waitUntil(lambda: window._worker is None)
    assert window.selected_id == b["id"]
    assert controller.states[a["id"]]["status"] == "paused"


def test_queued_older_snapshot_cannot_replace_newer_selection(make_window):
    controller = FakeController(); state = controller.state()
    state["updated"] = 10; controller.states[state["id"]] = state
    window = make_window(controller)
    earlier = deepcopy(state); earlier.update(updated=9, generation=0, status="running")
    window._progress(earlier)
    assert window.snapshot["status"] == "completed"
    assert window.round_card.value.text() == "3 / 3"


def test_source_lookup_failure_remains_visible(make_window):
    controller = FakeController(); controller.state()
    def failed_lookup(identity):
        raise ValueError("source artifact missing")
    controller.get_program = failed_lookup
    window = make_window(controller)
    assert not window.error_label.isHidden()
    assert "source artifact missing" in window.error_label.text()


def test_create_passes_registered_arm_and_explicit_budget(make_window, qtbot):
    controller = FakeController(); window = make_window(controller)
    assert [window.arm.itemData(i) for i in range(window.arm.count())] == list(ARMS)
    window.question.setPlainText("改进一个科学方法")
    window.arm.setCurrentIndex(window.arm.findData("task_only"))
    window.generations.setValue(4); window.max_calls.setValue(12); window.max_tokens.setValue(60000)
    window.start_study(); qtbot.waitUntil(controller.entered.is_set)
    assert controller.created == [{"question": "改进一个科学方法", "generations": 4, "arm": "task_only",
                                   "budget": {"max_model_calls": 12, "max_completion_tokens": 60000}}]
    assert not window.start_button.isEnabled()
    controller.release.set(); qtbot.waitUntil(lambda: window._worker is None)


def test_stop_resume_uses_same_id_and_existing_budget(make_window, qtbot):
    controller = FakeController(); state = controller.state(status="paused")
    window = make_window(controller); window.resume_study(); qtbot.waitUntil(controller.entered.is_set)
    window.stop_study(); qtbot.waitUntil(lambda: window._worker is None)
    assert window.resume_button.isEnabled()
    before = deepcopy(controller.states[state["id"]]["budget"])
    controller.release.set(); window.resume_study(); qtbot.waitUntil(lambda: window._worker is None)
    assert controller.run_ids == [state["id"], state["id"]]
    assert controller.created == []
    assert controller.states[state["id"]]["budget"] == before


def test_orphan_running_can_resume_but_meta_experiment_cannot(make_window):
    controller = FakeController(); state = controller.state(status="running")
    window = make_window(controller)
    assert window.resume_button.isEnabled()
    controller.states[state["id"]]["kind"] = "meta_evaluation"
    window.select_study(state["id"])
    assert not window.resume_button.isEnabled()


def test_running_external_study_polls_receipts_without_starting_work(make_window, qtbot):
    controller = FakeController(); state = controller.state(status="running")
    window = make_window(controller)
    assert window._live_timer.isActive()
    assert window._live_timer.interval() == 2000
    controller.states[state["id"]]["usage"]["reported_total_tokens"] = 999
    controller.states[state["id"]]["events"].append({"sequence": 5, "kind": "model", "content": {"status": "started"}})
    qtbot.waitUntil(lambda: window.tokens_card.value.text() == "999", timeout=3500)
    assert controller.run_ids == [] and controller.created == []
    controller.states[state["id"]].update(status="completed", updated=2)
    window._refresh_live_snapshots()
    assert not window._live_timer.isActive()


def test_idle_history_and_new_composer_do_not_poll(make_window):
    controller = FakeController(); state = controller.state()
    window = make_window(controller)
    assert not window._live_timer.isActive()
    controller.states[state["id"]]["status"] = "running"
    window.select_study(state["id"])
    assert window._live_timer.isActive()
    window.new_study()
    assert not window._live_timer.isActive()


def test_running_worker_poll_does_not_overwrite_selected_completed_history(make_window, qtbot):
    controller = FakeController(); a = controller.state(status="paused")
    b = controller.state("study-0000000000000002")
    window = make_window(controller); window.select_study(a["id"]); window.resume_study()
    qtbot.waitUntil(controller.entered.is_set)
    window.select_study(b["id"])
    controller.states[a["id"]]["usage"]["reported_total_tokens"] = 777
    window._refresh_live_snapshots()
    assert window._states[a["id"]]["usage"]["reported_total_tokens"] == 777
    assert window.selected_id == b["id"] and window.tokens_card.value.text() == "321"
    controller.release.set(); qtbot.waitUntil(lambda: window._worker is None)
    assert not window._live_timer.isActive()


def test_continue_opens_budget_then_creates_new_study_from_selected_source(make_window, qtbot):
    controller = FakeController(); previous = controller.state()
    window = make_window(controller)
    assert window.continue_button.isEnabled()
    window.continue_study()
    assert window.composer.isVisible()
    assert window.question.isReadOnly()
    assert not window.arm.isEnabled()
    assert controller.continued == [] and controller.run_ids == []
    window.generations.setValue(2); window.max_calls.setValue(9); window.max_tokens.setValue(45000)
    controller.release.set(); window.start_study(); qtbot.waitUntil(lambda: window._worker is None)
    assert controller.continued == [{"study_id": previous["id"], "generations": 2,
                                    "budget": {"max_model_calls": 9, "max_completion_tokens": 45000}}]
    assert window.selected_id != previous["id"]
    assert controller.run_ids == [window.selected_id]
    assert controller.created == []
    assert controller.get(previous["id"]) == previous


def test_switching_history_cancels_previous_continuation_target(make_window):
    controller = FakeController(); a = controller.state()
    b = controller.state("study-0000000000000002")
    window = make_window(controller); window.select_study(a["id"]); window.continue_study()
    window.select_study(b["id"])
    assert window._continuation_id is None
    assert not window.composer.isVisible()
    window.continue_study()
    assert window._continuation_id == b["id"]
    assert controller.continued == [] and controller.run_ids == []


def test_missing_candidate_measurement_is_not_rendered_as_zero(make_window):
    controller = FakeController(); state = controller.state()
    state["evaluations"][0].update(score=None, delta=None, decision="missing", reason="resource budget exhausted")
    controller.states[state["id"]] = state
    window = make_window(controller)
    assert window.evaluations.item(0, 2).text() == "缺测"
    assert window.evaluations.item(0, 3).text() == "—"


def test_background_error_is_visible_after_worker_cleanup(make_window, qtbot):
    controller = FakeController(); controller.state(status="paused")
    controller.fail = True; controller.release.set()
    window = make_window(controller); window.resume_study()
    qtbot.waitUntil(lambda: window._worker is None)
    assert "visible provider failure" in window.error_label.text()
    assert not window.error_label.isHidden()
    assert window.snapshot["status"] == "failed"
    assert window.resume_button.isEnabled()


def test_close_waits_for_worker_stop_and_finishes(make_window, qtbot):
    controller = FakeController(); controller.state(status="paused")
    window = make_window(controller); window.resume_study(); qtbot.waitUntil(controller.entered.is_set)
    window.close()
    qtbot.waitUntil(lambda: window._worker is None and not window.isVisible(), timeout=4000)
    assert controller.finished.is_set()
    assert controller.states[controller.run_ids[0]]["status"] == "paused"


def test_export_uses_selected_history_without_running_it(make_window, tmp_path):
    controller = FakeController(); controller.state()
    b = controller.state("study-0000000000000002")
    window = make_window(controller); window.select_study(b["id"])
    target = tmp_path / "review.json"
    assert window.export_study(target) == str(target)
    assert controller.exported == [(b["id"], str(target))]
    assert json.loads(target.read_text())["id"] == b["id"]
    assert controller.run_ids == []


def test_lineage_uses_actual_parent_and_exact_source_difference(make_window):
    controller = FakeController(); state = controller.state()
    window = make_window(controller)
    assert window.lineage.topLevelItemCount() == 1
    assert window.lineage.topLevelItem(0).childCount() == 1
    assert "'model': 2" in window.source_code.toPlainText()
    window.source_diff.setChecked(True)
    diff = window.source_code.toPlainText()
    assert "-def solve(problem, tools): return {'model': 1}" in diff
    assert "+def solve(problem, tools): return {'model': 2}" in diff
    assert state["active_program"] in window.source_identity.text()


def test_source_html_is_escaped_and_file_links_are_not_created(make_window):
    controller = FakeController(); state = controller.state()
    state["research"]["literature"] = [{"title": "<b>untrusted title</b>", "url": "file:///private.txt", "abstract": "<script>not executable</script>"}]
    controller.states[state["id"]] = state
    window = make_window(controller)
    assert "<b>untrusted title</b>" in window.sources_detail.toPlainText()
    assert "打开原始来源" not in window.sources_detail.toPlainText()
    assert "<script>not executable</script>" in window.sources_detail.toPlainText()


def test_new_goal_clears_view_without_mutating_history(make_window):
    controller = FakeController(); state = controller.state()
    window = make_window(controller); window.new_study()
    assert window.selected_id is None and window.snapshot is None
    assert not window.export_button.isEnabled()
    assert window.source_code.toPlainText() == ""
    assert controller.get(state["id"]) == state


def test_configuration_and_details_never_display_api_key(make_window, monkeypatch):
    monkeypatch.setenv("NEXGENT_API_KEY", "private-ui-sentinel")
    window = make_window()
    assert "private-ui-sentinel" not in window.configuration.text()
    assert "private-ui-sentinel" not in json_text({"nested": {"api_key": "private-ui-sentinel"}})


def test_project_root_prefers_explicit_then_environment_then_repository(tmp_path, monkeypatch):
    repo = tmp_path / "repo"; repo.mkdir(); (repo / "pyproject.toml").write_text("[project]\n")
    nested = repo / "nested"; nested.mkdir(); monkeypatch.chdir(nested)
    monkeypatch.delenv("NEXGENT_PROJECT_ROOT", raising=False)
    assert project_root() == repo
    target = tmp_path / "chosen"; monkeypatch.setenv("NEXGENT_PROJECT_ROOT", str(target))
    assert project_root() == target
    assert project_root(repo) == repo
