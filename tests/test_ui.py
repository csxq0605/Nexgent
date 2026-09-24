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
        self.benchmarks = [{"id": "test-domain", "title": "Test benchmark", "description": "Independent test plugin", "available": True}]

    def state(self, identity="study-0000000000000001", status="completed"):
        parent, child = list(self.programs.values())
        state = {"id": identity, "question": "从含噪时间序列中发现动力学方程", "status": status,
            "stage": "study completed; evidence available", "generation": 3, "max_generations": 3,
            "arm": "full", "budget": {"max_model_calls": 36, "max_completion_tokens": 144000},
            "benchmark": {"id": "test-domain", "title": "Test benchmark", "description": "Independent test plugin"},
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
    def list_benchmarks(self): return deepcopy(self.benchmarks)
    def get(self, identity): return deepcopy(self.states[identity])
    def get_program(self, identity): return deepcopy(self.programs[identity])

    def create(self, question, generations=3, arm="full", seed=0, budget=None, *, benchmark_id=None):
        self.created.append({"question": question, "generations": generations, "arm": arm, "budget": deepcopy(budget), "benchmark_id": benchmark_id})
        identity = f"study-{len(self.states) + 1:016x}"
        state = self.state(identity, "ready")
        state.update(question=question, generation=0, max_generations=generations, arm=arm, budget=deepcopy(budget),
                     benchmark={"id": benchmark_id, "title": benchmark_id})
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
                      max_generations=generations, budget=deepcopy(budget), origin_study=identity, benchmark=deepcopy(previous["benchmark"]))
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
                                   "budget": {"max_model_calls": 12, "max_completion_tokens": 60000}, "benchmark_id": "test-domain"}]
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


def meta_report():
    return {"protocol": {"k": 1, "seeds": [401, 502]},
        "per_seed_pairs": [
            {"seed": 401, "initial_improvement_at_k": 0.01, "evolved_improvement_at_k": 0.03,
             "difference": 0.02, "status": "complete"},
            {"seed": 502, "initial_improvement_at_k": 0.0, "evolved_improvement_at_k": None,
             "difference": None, "status": "incomplete"}],
        "aggregate": {"paired_difference": {"n": 1, "mean": 0.02}},
        "evidence": {"complete_pairs": 1, "requested_pairs": 2, "missing": [{"kind": "improve_execution"}],
                     "level": "comparison_with_missing_execution_or_cost_evidence"},
        "costs": {"model_calls_with_identity": 4, "known_usage": {"total_tokens": 1234},
                  "usage_missing_call_ids": ["call-missing"]},
        "failures": [{"stage": "generation", "error": {"type": "TimeoutError"}}]}


def test_independent_meta_record_reads_top_level_report_and_missing_pairs(make_window):
    controller = FakeController(); state = controller.state()
    state.update(kind="meta_evaluation", conclusion={}, meta_evaluation=meta_report())
    controller.states[state["id"]] = state
    window = make_window(controller); panel = window.meta_evidence
    assert panel.pairs.rowCount() == 2
    assert panel.pairs.item(0, 3).text() == "+0.0200"
    assert panel.pairs.item(1, 2).text() == "缺测"
    assert panel.pairs.item(1, 3).text() == "缺测"
    assert "完整配对 1 / 2" in panel.comparison_summary.toPlainText()
    assert "用量缺失请求 1" in panel.comparison_summary.toPlainText()
    assert "1234" in panel.comparison_summary.toPlainText()
    assert "独立改进器对照已有报告" in window.conclusion.toPlainText()
    assert panel.details_button.isEnabled()
    assert not window.continue_button.isEnabled() and controller.run_ids == []


def test_origin_study_meta_report_is_visible_and_switching_history_clears_it(make_window):
    controller = FakeController(); a = controller.state()
    controller.states[a["id"]]["conclusion"]["meta_evaluation"] = meta_report()
    b = controller.state("study-0000000000000002")
    window = make_window(controller); window.select_study(a["id"])
    assert window.meta_evidence.pairs.rowCount() == 2
    window.select_study(b["id"])
    assert window.meta_evidence.pairs.rowCount() == 0
    assert not window.meta_evidence.details_button.isEnabled()
    assert "尚未记录独立后代对照" in window.meta_evidence.comparison_summary.toPlainText()


def related_meta(controller, identity, origin, target, *, status="completed", seed=903, cross=False):
    state = controller.state(identity, status)
    benchmark = {"id": target, "title": {"bbh": "BBH · Boolean + Sorting",
        "scientific_discovery": "Scientific discovery"}.get(target, target)}
    report = meta_report()
    report.update(meta_study_id=identity, benchmark=benchmark, cross_benchmark=cross)
    report["protocol"].update(seeds=[seed], k=1)
    state.update(kind="meta_evaluation", benchmark=benchmark, conclusion={},
        registration={"origin_study": origin, "benchmark": benchmark, "cross_benchmark": cross,
                      "seeds": [seed], "k": 1}, meta_evaluation=report if status == "completed" else None)
    controller.states[identity] = state
    return deepcopy(state)


def test_main_study_lists_all_completed_targets_and_deduplicates_attached_latest_report(make_window):
    controller = FakeController(); origin = controller.state()
    controller.states[origin["id"]]["benchmark"] = {"id": "scientific_discovery", "title": "Scientific discovery"}
    science = related_meta(controller, "study-0000000000000011", origin["id"], "scientific_discovery", seed=803)
    bbh = related_meta(controller, "study-0000000000000012", origin["id"], "bbh", seed=903, cross=True)
    related_meta(controller, "study-0000000000000013", "unrelated-origin", "bbh", cross=True)
    related_meta(controller, "study-0000000000000014", origin["id"], "bbh", status="running", cross=True)
    controller.states[origin["id"]]["conclusion"]["meta_evaluation"] = bbh["meta_evaluation"]
    window = make_window(controller); window.select_study(origin["id"]); panel = window.meta_evidence
    assert panel.comparison_choice.count() == 2
    assert panel.comparison_choice.currentData() == science["id"]
    assert "Scientific discovery [scientific_discovery]" in panel.report_context.text()
    assert "同基准对照" in panel.report_context.text() and "种子：803" in panel.report_context.text()
    panel.comparison_choice.setCurrentIndex(panel.comparison_choice.findData(bbh["id"]))
    context = panel.report_context.text()
    assert "BBH · Boolean + Sorting [bbh]" in context and "跨基准迁移对照" in context
    assert bbh["id"] in context and origin["id"] in context and "种子：903" in context and "k=1" in context
    assert panel.report["meta_study_id"] == bbh["id"]
    captured = []; panel.show_details = lambda title, report: captured.append(deepcopy(report))
    panel.details_button.click()
    assert captured[0]["benchmark"]["id"] == "bbh"
    assert controller.created == [] and controller.run_ids == [] and controller.continued == []


def test_refresh_finds_newly_completed_meta_without_losing_selected_target(make_window):
    controller = FakeController(); origin = controller.state()
    bbh = related_meta(controller, "study-0000000000000011", origin["id"], "bbh", cross=True)
    related_meta(controller, "study-0000000000000012", origin["id"], "scientific_discovery", status="running", seed=803)
    window = make_window(controller); window.select_study(origin["id"]); panel = window.meta_evidence
    assert panel.comparison_choice.count() == 1 and panel.comparison_choice.currentData() == bbh["id"]
    related_meta(controller, "study-0000000000000012", origin["id"], "scientific_discovery", seed=803)
    panel.refresh_reports.click()
    assert panel.comparison_choice.count() == 2 and panel.comparison_choice.currentData() == bbh["id"]
    other = controller.state("study-0000000000000099")
    window.refresh_history(); window.select_study(other["id"])
    assert panel.comparison_choice.count() == 0 and panel.report is None
    assert controller.run_ids == []


@pytest.mark.parametrize("status", ["completed", "running", "failed", "paused"])
def test_independent_meta_has_explicit_kind_origin_target_and_cannot_launch_research(make_window, status):
    controller = FakeController(); origin = controller.state()
    meta = related_meta(controller, "study-0000000000000011", origin["id"], "bbh", status=status, cross=True)
    window = make_window(controller); window.select_study(meta["id"])
    window.question.setPlainText("A stale new-research form must not launch from this record")
    assert "独立改进器对照（只读）" in window.overview.toPlainText()
    assert origin["id"] in window.overview.toPlainText()
    context = window.meta_evidence.report_context.text()
    assert meta["id"] in context and origin["id"] in context
    assert "[bbh]" in context and "跨基准迁移对照" in context and "种子：903" in context
    assert not window.start_button.isEnabled() and not window.resume_button.isEnabled() and not window.continue_button.isEnabled()
    window.start_study(); window.resume_study(); window.continue_study()
    assert controller.created == [] and controller.run_ids == [] and controller.continued == []


def test_legacy_meta_report_does_not_guess_missing_benchmark_attribution(make_window):
    controller = FakeController(); state = controller.state()
    controller.states[state["id"]]["conclusion"]["meta_evaluation"] = meta_report()
    window = make_window(controller)
    assert window.meta_evidence.comparison_choice.count() == 1
    context = window.meta_evidence.report_context.text()
    assert "ID 未记录" in context and "跨基准关系未记录" in context
    assert "旧报告未提供独立研究 ID" in context
    assert window.meta_evidence.pairs.rowCount() == 2


def test_actual_offspring_counts_keep_benchmarks_and_main_inheritance_separate(make_window):
    controller = FakeController(); origin = controller.state()
    controller.states[origin["id"]]["conclusion"].update(executable_meta_changed=True, inherited_improver_executed=[])
    science = related_meta(controller, "study-0000000000000011", origin["id"], "scientific_discovery", seed=701)
    bbh = related_meta(controller, "study-0000000000000012", origin["id"], "bbh", cross=True)
    for record, counts in ((science, (2, 2)), (bbh, (0, 1))):
        report = controller.states[record["id"]]["meta_evaluation"]
        report["arms"] = [{"arm": arm, "attempts": [{"candidates": [{"status": "evaluated"} for _ in range(count)]}]}
            for arm, count in zip(("initial", "evolved"), counts)]
    controller.states[origin["id"]]["conclusion"]["meta_evaluation"] = deepcopy(controller.states[bbh["id"]]["meta_evaluation"])
    window = make_window(controller); window.select_study(origin["id"]); panel = window.meta_evidence
    assert "实际任务后代共 5 个，已评价 5 个" in panel.related_summary.text()
    assert "不计为主研究的继承执行" in panel.related_summary.text()
    assert "0 个修改后的改进器有继承执行记录" in panel.summary.text()
    panel.comparison_choice.setCurrentIndex(panel.comparison_choice.findData(science["id"]))
    assert "本对照实际任务后代 4 个，已评价 4 个" in panel.comparison_summary.toPlainText()
    panel.comparison_choice.setCurrentIndex(panel.comparison_choice.findData(bbh["id"]))
    assert "初始改进器产生 0 个，演化改进器产生 1 个" in panel.comparison_summary.toPlainText()


def test_meta_progress_uses_registered_pairs_and_target_start_instead_of_inherited_rounds(make_window):
    controller = FakeController(); origin = controller.state()
    meta = related_meta(controller, "study-0000000000000011", origin["id"], "bbh", status="running", cross=True)
    initial, child = list(controller.programs.values())
    controller.states[meta["id"]].update(initial_program=initial["id"], active_program=child["id"], generation=17)
    window = make_window(controller); window.select_study(meta["id"])
    assert window.program_card.caption.text() == "冻结任务起点"
    assert window.program_card.value.text() == "第 0 代"
    assert window.round_card.caption.text() == "完整 / 登记配对"
    assert window.round_card.value.text() == "— / 1"


@pytest.mark.parametrize("status,message", [("running", "正在执行"), ("failed", "未完成"), ("paused", "未完成")])
def test_incomplete_meta_study_does_not_imply_zero_or_completion(make_window, status, message):
    controller = FakeController(); state = controller.state(status=status)
    controller.states[state["id"]].update(kind="meta_evaluation", conclusion={})
    window = make_window(controller)
    assert message in window.meta_evidence.comparison_summary.toPlainText()
    assert window.meta_evidence.pairs.rowCount() == 0
    assert controller.run_ids == []


def test_probe_lifecycle_uses_real_rpc_and_keeps_development_separate(make_window):
    controller = FakeController(); state = controller.state()
    base = {"id": "rpc-probe", "method": "probe_improver", "status": "started", "source_bundle": "source-caller",
            "request": {"label": "改进器机制实验"}, "input_artifact_ids": ["request-artifact"]}
    result = {"schema": "nexgent-improver-probe-v1", "probe_id": "probe-1", "status": "incomplete", "split": "development",
              "source_candidate": {"id": "candidate-source", "digest": "actual-source-digest"},
              "arms": [{"arm": "initial", "development_gain": 0.02}, {"arm": "evolved", "development_gain": None}],
              "aggregate": {"paired_development_gain": None}, "costs": {"model_calls_with_identity": 3}}
    state["conclusion"].update(executable_meta_changed=False, inherited_improver_executed=[])
    state["events"] = [None, {"kind": "capability", "sequence": 1, "content": base},
        {"kind": "capability", "sequence": 2, "content": {**base, "status": "completed", "result": result, "output_artifact_ids": ["result-artifact"]}},
        {"kind": "agent_log", "content": {"claimed_kind": "probe_improver", "result": {"status": "completed"}}}]
    controller.states[state["id"]] = state
    window = make_window(controller); panel = window.meta_evidence
    assert panel.probes.rowCount() == 1
    assert panel.probes.item(0, 1).text() == "证据不完整"
    assert panel.probes.item(0, 2).text() == "+0.0200"
    assert panel.probes.item(0, 3).text() == "缺测"
    assert panel.probes.item(0, 5).text() == "3"
    assert "actual-source-digest" in panel.probe_detail.toPlainText()
    assert "未记录改进器或编排修改" in panel.summary.text()
    assert "0 个修改后的改进器" in panel.summary.text()
    assert panel.pairs.rowCount() == 0
    captured=[]; panel.show_details=lambda title, payload: captured.append(deepcopy(payload))
    panel._open_probe(0)
    assert captured[0]["output_artifact_ids"] == ["result-artifact"]
    assert controller.run_ids == []


@pytest.mark.parametrize("status,result,expected", [
    ("started", None, "进行中"),
    ("failed", None, "执行失败"),
    ("completed", {"status": "skipped_identical_improver"}, "改进器相同，未执行探测")])
def test_probe_unmeasured_states_are_explicit(make_window, status, result, expected):
    controller = FakeController(); state = controller.state()
    state["events"]=[{"kind": "capability", "content": {"id": "rpc-1", "method": "probe_improver",
        "status": status, "result": result, "error_type": "TimeoutError" if status == "failed" else None}}]
    controller.states[state["id"]]=state
    window=make_window(controller); panel=window.meta_evidence
    assert panel.probes.item(0, 1).text() == expected
    assert panel.probes.item(0, 4).text() == "缺测"
    if status == "failed": assert "TimeoutError" in panel.probe_detail.toPlainText()
    assert controller.run_ids == []


def test_live_refresh_preserves_selected_source_and_file(make_window):
    controller=FakeController(); state=controller.state(status="running")
    window=make_window(controller)
    window.source_file.setCurrentText("meta.py")
    identity=window.lineage.currentItem().data(0, Qt.ItemDataRole.UserRole)
    state["updated"]=100
    window._progress(state)
    assert window.lineage.currentItem().data(0, Qt.ItemDataRole.UserRole) == identity
    assert window.source_file.currentText() == "meta.py"


def test_unavailable_parent_source_cannot_be_presented_as_a_diff(make_window):
    controller=FakeController(); state=controller.state()
    parent,child=list(controller.programs.values())
    del controller.programs[parent["id"]]
    window=make_window(controller); window.source_diff.setChecked(True)
    assert not window.source_diff.isEnabled()
    assert window.source_code.toPlainText() == child["files"]["task.py"]
    assert window.error_label.isVisible()


def test_export_dialog_keeps_original_study_identity(make_window, tmp_path, monkeypatch):
    from nexgent.ui.window import QFileDialog
    controller=FakeController(); a=controller.state(); b=controller.state("study-0000000000000002")
    window=make_window(controller); window.select_study(a["id"])
    target=tmp_path/'chosen-study.json'
    def choose(*args):
        window.select_study(b["id"])
        return str(target), ""
    monkeypatch.setattr(QFileDialog, "getSaveFileName", choose)
    window.export_study()
    assert controller.exported == [(a["id"], str(target))]
    assert json.loads(target.read_text())["id"] == a["id"]


def test_no_benchmark_plugin_blocks_execution_but_preserves_history_export(make_window, tmp_path):
    controller=FakeController(); state=controller.state(); controller.benchmarks=[]
    window=make_window(controller)
    assert not window.resume_button.isEnabled() and not window.continue_button.isEnabled()
    assert window.export_study(tmp_path/'old.json')
    window.new_study(); window.question.setPlainText("A general source RSI objective")
    assert "pip install /path/to/benchmark-plugin" in window.benchmark_hint.text()
    assert not window.start_button.isEnabled()
    window.start_study()
    assert controller.created == [] and controller.run_ids == []


def test_benchmark_choices_come_only_from_installed_metadata(make_window, qtbot):
    controller=FakeController()
    controller.benchmarks=[{"id":"unavailable", "title":"Missing data", "available":False, "error":"Download the pinned dataset"},
        {"id":"custom-domain", "title":"External task plugin", "description":"A general task contract", "available":True}]
    window=make_window(controller)
    assert window.benchmark_choice.currentData() == "custom-domain"
    assert not window.benchmark_choice.model().item(0).isEnabled()
    window.question.setPlainText("Improve this task algorithm")
    window.start_study(); qtbot.waitUntil(controller.entered.is_set)
    assert controller.created[0]["benchmark_id"] == "custom-domain"
    assert not window.benchmark_choice.isEnabled()
    controller.release.set(); qtbot.waitUntil(lambda: window._worker is None)


def test_continue_locks_the_original_benchmark(make_window, qtbot):
    controller=FakeController(); state=controller.state()
    controller.benchmarks.append({"id":"another-domain", "title":"Another", "available":True})
    window=make_window(controller)
    window.benchmark_choice.setCurrentIndex(window.benchmark_choice.findData("another-domain"))
    window.continue_study()
    assert window.benchmark_choice.currentData() == "test-domain"
    assert not window.benchmark_choice.isEnabled()
    window.start_study(); qtbot.waitUntil(controller.entered.is_set)
    assert controller.continued[0]["study_id"] == state["id"]
    assert window.snapshot["benchmark"]["id"] == "test-domain"
    controller.release.set(); qtbot.waitUntil(lambda: window._worker is None)


def test_unavailable_plugin_reports_its_actual_configuration_error(make_window):
    controller=FakeController(); controller.benchmarks=[{"id":"bbh", "available":False, "error":"NEXGENT_BBH_DATA is missing"}]
    window=make_window(controller)
    assert "NEXGENT_BBH_DATA is missing" in window.benchmark_hint.text()
    assert window.benchmark_choice.currentData() is None


@pytest.mark.parametrize("kind", ["benchmark_counterexample", "scientific_counterexample"])
def test_generic_and_legacy_counterexamples_remain_visible(make_window, kind):
    controller=FakeController(); state=controller.state()
    state["research"]["failures"]=[{"kind":kind, "decision":{"delta":-0.04}, "generation":2}]
    controller.states[state["id"]]=state
    window=make_window(controller)
    assert "任务反例" in window.failures_list.item(0).text()
    assert "-0.040" in window.failures_list.item(0).text()


@pytest.mark.parametrize("status", ["ready", "running", "paused", "failed", "completed"])
def test_fixed_benchmark_evaluation_is_not_resumed_as_source_research(make_window, status):
    controller=FakeController(); state=controller.state(status=status)
    controller.states[state["id"]]["kind"]="benchmark_evaluation"
    window=make_window(controller)
    assert not window.resume_button.isEnabled()
    assert not window.continue_button.isEnabled()
    assert window.export_button.isEnabled()
    window.resume_study(); window.continue_study()
    assert controller.run_ids == [] and controller.continued == []


def test_fixed_evaluation_renders_planned_missing_and_measured_seeds_separately(make_window):
    controller=FakeController(); state=controller.state()
    state.update(kind="benchmark_evaluation", max_generations=0, conclusion={"kind":"fixed_program_benchmark", "rsi_effect":False},
        benchmark_evaluation={"results":[
            {"seed":1,"status":"measured","report":{"score":0.75,"score_available":True,"work_units":123,
                "tasks":[{"task_id":"case-1","score":0.75,"status":"ok"}],"execution":{"instructions":123}}},
            {"seed":2,"status":"missing","report":{"score":0.0,"score_available":False,"status":"timeout","tasks":[]},"error":"source timeout"},
            {"seed":3,"status":"planned","report":None}],
            "summary":{"planned":3,"measured":1,"missing":1,"mean_score":None,"observed_mean_score":0.75}})
    state["benchmark"]["work_unit"]="source_instruction_events"
    controller.states[state["id"]]=state
    window=make_window(controller)
    assert window.program_card.caption.text() == "固定任务程序"
    assert window.round_card.value.text() == "1 / 3"
    assert "固定程序基准评价" in window.overview.toPlainText()
    assert window.evaluations.item(0,2).text() == "0.750"
    assert window.evaluations.item(1,2).text() == "缺测"
    assert window.evaluations.item(2,1).text() == "尚未执行"
    assert window.evaluations.item(2,2).text() == "—"
    assert "完整评价均分 —" in window.conclusion.toPlainText()
    assert "仅已观测部分均分 0.750" in window.conclusion.toPlainText()
    assert "源码执行事件 123" in window.experiments_detail.toPlainText()
    window.experiments_list.setCurrentRow(1)
    assert "任务得分 缺测" in window.experiments_detail.toPlainText()


def test_actual_controller_window_starts_with_no_installed_plugins(qtbot, tmp_path, monkeypatch):
    import nexgent.benchmarks as registry
    monkeypatch.setattr(registry, "entry_points", lambda **kwargs: [])
    window=ResearchWindow(tmp_path); qtbot.addWidget(window)
    window.show()
    assert window.controller.list_benchmarks() == []
    assert window.controller.list_studies() == []
    assert "没有可用的基准插件" in window.benchmark_hint.text()
    assert window._worker is None and not window.start_button.isEnabled()
    assert not window.details_button.isEnabled()
    assert "等待选择任务基准" in window.overview.toPlainText()
    window.close()


@pytest.mark.parametrize("missing", [0, 1, 2])
def test_completed_fixed_benchmark_missingness_is_visible_in_header_and_history(make_window, missing):
    controller = FakeController(); state = controller.state()
    state.update(kind="benchmark_evaluation", max_generations=0,
        benchmark_evaluation={"results": [], "summary": {
            "planned": 2, "measured": 2 - missing, "missing": missing,
            "mean_score": None if missing else 1.0,
            "observed_mean_score": None if missing == 2 else 1.0}})
    controller.states[state["id"]] = state
    window = make_window(controller)
    assert ("存在缺测" in window.state_label.text()) == bool(missing)
    assert ("存在缺测" in window.history.item(0).text()) == bool(missing)
    if missing == 2:
        assert window.round_card.value.text() == "0 / 2"
        assert "完整评价均分 —" in window.conclusion.toPlainText()
        assert not window.continue_button.isEnabled()
