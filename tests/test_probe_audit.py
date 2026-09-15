"""Independent probe audit with real local source workers and scripted model IO.

These fixtures test transport, privacy, provenance and accounting contracts.
Their arbitrary scalar scores are not scientific or model capability evidence.
"""

from copy import deepcopy
import json
from threading import Event

import pytest

from nexgent.agents.seed import seed_files
from nexgent.benchmarks import BenchmarkSpec
from nexgent.evolution.controller import StudyController, compare
from nexgent.evolution.meta_evaluation import evaluate_improver_probe
from nexgent.kernel.programs import canonical, make_bundle
from nexgent.models.gateway import ModelGateway


def task(value=0, *, model=False, padding=0):
    expression = f'tools.ask("task_model", "Return the supplied fixture answer", {{"fixture_answer": {value}}}, max_tokens=20)' if model else repr({"answer": value})
    return f"def solve(problem, tools):\n    return {expression}\n" + "# bounded generated source documentation\n" * padding


def improver(value=1, *, model=False, padding=0):
    if model:
        return ('def improve(context, broker):\n'
                f'    return broker.ask("source_writer", "variant={value}", context, max_tokens=6000)\n')
    candidate = {"candidates": [{"files": {"task.py": task(value, model=True, padding=padding)},
                                "rationale": "Protocol fixture", "hypothesis": "Return fixture scalar through actual task-model IO"}]}
    return 'def improve(context, broker):\n    return ' + repr(candidate) + '\n'


class AuditBenchmark:
    spec = BenchmarkSpec("probe_audit", "Probe audit fixture", "Local tests only", "Return an answer scalar; score is larger-is-better")
    evaluator_digest = "probe-audit-fixture-v1"

    def initial_files(self):
        return {"task.py": task()}

    def snapshot(self):
        return {"fixture": self.evaluator_digest}

    def research_context(self):
        return {"literature": [{"kind": "fixture", "text": "Registered adapter evidence"}]}

    def evaluate(self, bundle, split, seed, runner, **kwargs):
        assert split in getattr(self, "allowed_splits", {"development"}), "Unregistered split access"
        response = runner.run(bundle, "solve_batch", {"problems": [{}]}, timeout=10, **kwargs)
        row = response["value"][0]
        assert row["ok"], row
        score = row["submission"]["answer"] / 10
        return {"status": "ok", "score_available": True, "split": split, "seed": seed, "score": score,
                "work_units": response["execution"]["instructions"], "execution": response["execution"],
                "suite_digest": "fixture-suite", "tasks": [{"task_id": "fixture", "status": "ok", "score": score}]}


def controller_fixture(tmp_path, *, generated_padding=0):
    (tmp_path / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "base_url": "https://example.invalid/v1", "api_key": "dummy-test-key", "models": {"fixture": {}}}},
        "defaults": {"main": "fixture/fixture"}}), encoding="utf-8")
    requests = []
    def transport(profile, params):
        payload = json.loads(params["messages"][-1]["content"])
        requests.append(deepcopy(payload))
        if "fixture_answer" in payload:
            output = {"answer": payload["fixture_answer"]}
        else:
            value = 2 if "variant=2" in params["messages"][0]["content"] else 1
            output = {"candidates": [{"files": {"task.py": task(value, padding=generated_padding)},
                "rationale": "Scripted full-source response", "hypothesis": "Fixture source execution"}]}
        return {"content": json.dumps(output), "finish_reason": "stop", "response_id": "fixture",
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
    controller = StudyController(tmp_path, benchmark=AuditBenchmark(),
        search=lambda query: {"status": "no_results", "papers": []},
        gateway_factory=lambda *args, **kwargs: ModelGateway(*args, **kwargs, transport=transport))
    state = controller.create("Probe audit fixture", generations=2,
        budget={"max_model_calls": 40, "max_completion_tokens": 200000, "max_evaluations": 40})
    return controller, controller.store.get(state["id"]), requests


def install_parent(controller, state, parent):
    controller.store.put_bundle(parent)
    state.update(initial_program=parent["id"], active_program=parent["id"], research_program=parent["id"])
    controller.store.save(state)


def test_probe_model_receipts_include_baseline_and_selected_task_calls(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    parent = make_bundle({"task.py": task(model=True), "meta.py": improver(1)})
    install_parent(controller, state, parent)
    proposed = {**parent["files"], "meta.py": improver(2)}
    report = controller._probe_improver(state, parent, proposed, "Actual task model cost audit", {}, Event())
    calls = controller.store.calls(state["id"])
    assert len(calls) == 4 and len(requests) == 4
    assert report["status"] == "completed"
    assert report["costs"]["model_calls_with_identity"] == len(calls)
    assert {row["call_id"] for row in report["costs"]["calls"]} == {row["call_id"] for row in calls}
    assert report["costs"]["reserved_completion_tokens"] == 80
    assert report["costs"]["known_usage"]["total_tokens"] == 80


@pytest.mark.parametrize("unavailable_level", ["top", "task"])
def test_probe_explicit_unavailable_score_is_missing_even_with_ok_status(unavailable_level):
    parent = make_bundle({"task.py": task(), "meta.py": improver(1)})
    proposed = make_bundle({"meta.py": improver(2)}, parent)
    def unavailable(bundle, split, seed):
        return {"status": "ok", "score_available": unavailable_level != "top", "score": 0, "split": split, "work_units": 0,
                "tasks": [{"status": "ok", "score_available": unavailable_level != "task", "score": 0}],
                "execution": {"source_digest": bundle["digest"], "entry": "solve_batch"}}
    def forbidden(*args):
        pytest.fail("Unavailable baseline score cannot license offspring generation")
    report = evaluate_improver_probe(parent, proposed, parent, seed=12, generate=forbidden, evaluate=unavailable)
    assert report["status"] == "incomplete" and report["aggregate"]["paired_development_gain"] is None


def test_full_source_probe_feedback_fits_registered_model_input_limit(tmp_path):
    controller, state, requests = controller_fixture(tmp_path, generated_padding=400)
    # Real bootstrap workflow + role sizes; returned source is about 16k chars,
    # within the ordinary 6000-token response envelope for this ASCII fixture.
    parent = make_bundle({**seed_files({"task.py": task()}), "meta.py": improver(1, model=True)})
    install_parent(controller, state, parent)
    proposed = {**parent["files"], "meta.py": improver(2, model=True)}
    report = controller._probe_improver(state, parent, proposed, "Probe payload size audit", {}, Event())
    assert report["status"] == "completed"
    payload = {"parent": parent, "actual_probe": report, "phase": "meta_repair_after_actual_probe",
               "previous_candidate": {"files": {"meta.py": proposed["meta.py"]}}}
    report_chars, payload_chars = len(canonical(report)), len(json.dumps(payload, ensure_ascii=False))
    assert payload_chars <= 240000, f"Probe report={report_chars:,} chars; repair input={payload_chars:,} exceeds ModelGateway 240,000 cap"


def test_probe_insufficient_pair_budget_runs_neither_arm(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    parent = make_bundle({"task.py": task(), "meta.py": improver(1, model=True)})
    install_parent(controller, state, parent)
    state["budget"]["max_model_calls"] = 11
    controller.store.save(state)
    report = controller._probe_improver(state, parent, {**parent["files"], "meta.py": improver(2, model=True)},
                                       "No half pair", {}, Event())
    assert report["status"] == "incomplete" and report["reason"] == "insufficient_budget"
    assert report["arms"] == [] and not requests and controller.store.calls(state["id"]) == []
    assert state["evaluation_count"] == 0


def test_optional_selector_continues_unproven_research_source_not_deployed_parent(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    parent = make_bundle({"task.py": task(), "meta.py": improver(1)})
    install_parent(controller, state, parent)
    child = make_bundle({"meta.py": improver(2)}, parent,
                        provenance={"evidence_status": "unproven"})
    controller.store.put_bundle(child)
    state["research_program"] = child["id"]
    state["archive"] = [{"id": parent["id"]}, {"id": child["id"]}]
    controller.store.save(state)
    assert controller._parent(state, Event())["id"] == child["id"]
    assert state["active_program"] == parent["id"]


def test_source_cannot_self_assign_supported_status_without_a_real_matching_probe(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    claim = {"candidates": [{"files": {"meta.py": improver(2)}, "rationale": "Fixture agent claim",
        "hypothesis": "The host must distinguish an agent claim from actual probe support",
        "evidence_status": "development_supported", "probe_id": "fabricated-probe-id"}]}
    parent = make_bundle({"task.py": task(), "meta.py": "def improve(context, broker):\n    return " + repr(claim) + "\n"})
    install_parent(controller, state, parent)
    result = controller._generate(state, parent, {"parent": parent}, "Source evidence claim audit")
    assert len(result["candidates"]) == 1, "The unproven source may remain a research branch"
    provenance = result["candidates"][0]["provenance"]
    assert provenance.get("evidence_status") not in {"development_supported", "verified"}, (
        "Unvalidated source-provided evidence status was copied as candidate provenance; "
        "namespace it as an agent claim or verify the actual probe/source pair")
    assert not requests and not any(event["kind"] == "improver_probe" for event in controller.store.events(state["id"]))


def test_post_probe_changed_improver_cannot_reuse_old_positive_evidence(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    parent = make_bundle({"task.py": task(model=True), "meta.py": improver(1)})
    install_parent(controller, state, parent)
    proposed = {**parent["files"], "meta.py": improver(2)}
    report = controller._probe_improver(state, parent, proposed, "Source-specific evidence audit", {}, Event())
    assert report["status"] == "completed" and report["aggregate"]["paired_development_gain"] > 0
    original = make_bundle(proposed, parent)
    verified = controller._candidate_evidence(state, original, {"probe_id": report["probe_id"]})
    assert verified["evidence_status"] == "development_supported"
    repaired = make_bundle({"meta.py": improver(3)}, parent)
    unknown = controller._candidate_evidence(state, repaired, {"evidence_status": "development_supported", "probe_id": report["probe_id"]})
    assert unknown["evidence_status"] == "unverified" and unknown["needs_probe"]
    assert unknown["based_on_probe_id"] == report["probe_id"]


def test_large_domain_diagnostics_are_bounded_in_probe_feedback(tmp_path):
    controller, state, requests = controller_fixture(tmp_path)
    measured = controller.benchmark.evaluate
    def verbose_evaluation(*args, **kwargs):
        report = measured(*args, **kwargs)
        # A domain may return a long explanation/trace while its submission and
        # source remain small. The complete trace belongs in the host artifact.
        report["tasks"][0]["diagnostics"] = {"trace": "fixture observed diagnostic\n" * 5000}
        return report
    controller.benchmark.evaluate = verbose_evaluation
    parent = make_bundle({**seed_files({"task.py": task()}), "meta.py": improver(1, model=True)})
    install_parent(controller, state, parent)
    proposed = {**parent["files"], "meta.py": improver(2, model=True)}
    report = controller._probe_improver(state, parent, proposed, "Generic domain diagnostic bound", {}, Event())
    assert report["status"] == "completed"
    payload = {"parent": parent, "actual_probe": report, "phase": "meta_repair_after_actual_probe"}
    size = len(json.dumps(payload, ensure_ascii=False))
    assert size <= 240000, f"Domain diagnostics leave compact probe repair input at {size:,} chars"


def completed_meta_origin(tmp_path):
    """Authored origin metadata for integration checks, not an empirical study."""
    controller, state, requests = controller_fixture(tmp_path)
    controller.benchmark.allowed_splits = {"development", "meta_transfer"}
    initial = make_bundle({"task.py": task(model=True), "meta.py": improver(1)})
    evolved = make_bundle({"meta.py": improver(2)}, initial)
    install_parent(controller, state, initial)
    controller.store.put_bundle(evolved)
    state.update(status="completed", research_program=evolved["id"],
                 evaluations=[{"candidate_id": evolved["id"], "changes": ["meta.py"]}])
    controller.store.save(state)
    return controller, state, requests


def test_independent_meta_accounts_for_all_task_model_calls_with_equal_arm_caps(tmp_path):
    controller, state, requests = completed_meta_origin(tmp_path)
    report = controller.meta_evaluate(state["id"], seeds=[701], k=1,
        generation_budget={"max_model_calls": 2, "max_completion_tokens": 2000},
        arm_budget={"max_model_calls": 8, "max_completion_tokens": 1000})
    calls = controller.store.calls(report["meta_study_id"])
    # Both improvers here generate without a model. Each arm's baseline/child
    # development and transfer still makes four actual task-model calls.
    assert len(calls) == len(requests) == 8
    assert report["costs"]["model_calls_with_identity"] == report["ledger_usage"]["model_calls"] == 8
    assert report["costs"]["reserved_completion_tokens"] == 160
    assert len(report["costs"]["generation_executions"]) == 2
    assert {row["meta_arm"] for row in calls} == {"initial", "evolved"}
    assert all(row["meta_seed"] == 701 for row in calls)
    assert sorted(row["model_calls"] for row in report["arm_accounting"]) == [4, 4]
    assert report["aggregate"]["paired_difference"]["values"] == pytest.approx([.1])
    assert controller.get(state["id"])["usage"]["model_calls"] == 0
    replay = controller.meta_evaluate(state["id"], seeds=[701], k=1,
        generation_budget={"max_model_calls": 2, "max_completion_tokens": 2000},
        arm_budget={"max_model_calls": 8, "max_completion_tokens": 1000})
    assert replay["meta_study_id"] == report["meta_study_id"] and len(requests) == 8
    assert replay["ledger_usage"]["model_calls"] == 8


def test_independent_meta_rejects_half_pair_budget_overrun_and_old_high_budget_cache(tmp_path):
    controller, state, requests = completed_meta_origin(tmp_path)
    first = controller.meta_evaluate(state["id"], seeds=[702], arm_budget={"max_model_calls": 8, "max_completion_tokens": 1000})
    assert first["aggregate"]["paired_difference"]["n"] == 1 and len(requests) == 8
    # A new deliberately constrained registration cannot silently reuse the
    # previous high-resource task/model evaluations as zero-cost new evidence.
    constrained = controller.meta_evaluate(state["id"], seeds=[702], arm_budget={"max_model_calls": 1, "max_completion_tokens": 1000})
    assert first["meta_study_id"] != constrained["meta_study_id"]
    assert constrained["aggregate"]["paired_difference"]["n"] == 0
    assert constrained["aggregate"]["incomplete_seeds"] == [702]
    assert constrained["costs"]["model_calls_with_identity"] == 2 and len(requests) == 10
    assert sorted(row["model_calls"] for row in constrained["arm_accounting"]) == [1, 1]
    assert constrained["registered_arm_budget"]["max_model_calls"] == 1


@pytest.mark.parametrize("options", [
    {"generation_budget": {"max_model_calls": True}},
    {"generation_budget": {"max_development_experiments": 0}},
    {"arm_budget": {"max_completion_tokens": -1}},
    {"arm_budget": {"unknown": 9}},
])
def test_meta_budget_configuration_is_explicit_and_validated_before_requests(tmp_path, options):
    controller, state, requests = completed_meta_origin(tmp_path)
    with pytest.raises(ValueError, match="budget"):
        controller.meta_evaluate(state["id"], seeds=[703], **options)
    assert requests == [] and controller.store.calls(state["id"]) == []


@pytest.mark.parametrize("unavailable_level", ["top", "task"])
def test_selection_rejects_explicit_unavailable_score_at_either_level(unavailable_level):
    reference = {"status": "ok", "score_available": True, "score": .5, "work_units": 10,
                 "suite_digest": "fixture", "tasks": [{"task_id": "a", "status": "ok", "score": .5}]}
    candidate = deepcopy(reference)
    candidate["score"] = candidate["tasks"][0]["score"] = .9
    if unavailable_level == "top":
        candidate["score_available"] = False
    else:
        candidate["tasks"][0]["score_available"] = False
    decision = compare(candidate, reference)
    assert not decision["accepted"] and decision["delta"] is None


def test_controller_cross_benchmark_meta_uses_target_task_tools_contract_and_no_hidden_feedback(tmp_path):
    """Exercise the real controller and source processes; all model IO is scripted."""
    from nexgent_scientific_discovery.toolbox import Toolbox
    assert Toolbox is not None  # The installed test plugin must also load in each fresh worker.
    class TargetBenchmark(AuditBenchmark):
        spec = BenchmarkSpec("target_probe_audit", "Target fixture", "A distinct registered task contract",
            "TARGET_CONTRACT: return answer and contract_seen", "feature_matrix(states, terms) returns a numeric matrix",
            "nexgent_scientific_discovery.toolbox:Toolbox")
        evaluator_digest = "distinct-target-fixture-v1"
        def __init__(self):
            self.evaluations = []
        def initial_files(self):
            return {"task.py": self.task_source(0)}
        @staticmethod
        def task_source(delta):
            return ('def solve(problem, tools):\n'
                    '    matrix = tools.feature_matrix([[2.0], [3.0]], ["x0"])\n'
                    f'    return {{"answer": matrix[0][0] + {delta}, "contract_seen": problem["contract"]}}\n')
        def evaluate(self, bundle, split, seed, runner, **kwargs):
            assert split in {"development", "meta_transfer"}
            assert "OLD_DOMAIN_ONLY" not in bundle["files"]["task.py"]
            response = runner.run(bundle, "solve_batch", {"problems": [{"contract": self.spec.task_contract}]}, timeout=10, **kwargs)
            entry = response["value"][0]
            assert entry["ok"], entry
            assert entry["submission"]["contract_seen"] == self.spec.task_contract
            assert response["execution"]["tool_receipts"], "Target toolbox must really execute"
            score = entry["submission"]["answer"] / 10
            report = {"status": "ok", "score_available": True, "score": score, "split": split, "seed": seed,
                "work_units": response["execution"]["work_units"], "execution": response["execution"],
                "tasks": [{"task_id": "target", "status": "ok", "score": score}], "suite_digest": "target-fixture"}
            if split == "meta_transfer":
                report["tasks"][0]["submission"] = "PRIVATE_TRANSFER_FEEDBACK_MARKER"
            self.evaluations.append({"bundle": deepcopy(bundle), "split": split, "report": deepcopy(report)})
            return report
    controller, state, requests = controller_fixture(tmp_path)
    target = TargetBenchmark()
    controller.registry.instances[target.spec.id] = target
    initial = make_bundle({"task.py": 'def solve(problem, tools):\n    return {"OLD_DOMAIN_ONLY": True}\n',
                           "meta.py": improver(1, model=True)})
    evolved = make_bundle({"meta.py": improver(2, model=True)}, initial)
    install_parent(controller, state, initial)
    controller.store.put_bundle(evolved)
    state.update(status="completed", research_program=evolved["id"],
                 evaluations=[{"candidate_id": evolved["id"], "changes": ["meta.py"]}])
    controller.store.save(state)
    def transport(profile, params):
        context = json.loads(params["messages"][-1]["content"])
        requests.append(deepcopy(context))
        assert context["parent"]["files"]["task.py"] == target.initial_files()["task.py"]
        assert context["domain"]["id"] == target.spec.id
        assert context["task_contract"] == target.spec.task_contract and context["tool_api"] == target.spec.tool_api
        assert context["capabilities"]["probe_improver"] is False
        assert context["development"]["split"] == "development"
        assert "PRIVATE_TRANSFER_FEEDBACK_MARKER" not in json.dumps(context)
        delta = 2 if "variant=2" in params["messages"][0]["content"] else 1
        reply = {"candidates": [{"files": {"task.py": target.task_source(delta)},
            "rationale": "Scripted target-domain source", "hypothesis": "Test actual target tools and contract"}]}
        return {"content": json.dumps(reply), "finish_reason": "stop", "response_id": "fixture",
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
    controller.gateway_factory = lambda *args, **kwargs: ModelGateway(*args, **kwargs, transport=transport)
    report = controller.meta_evaluate(state["id"], seeds=[704], benchmark_id=target.spec.id)
    assert report["cross_benchmark"] and report["benchmark"]["id"] == target.spec.id
    assert report["cross_attribution"]["kind"] == "not_applicable_cross_benchmark"
    assert report["cross_attribution"]["rows"] == []
    assert len(requests) == 2 and report["costs"]["model_calls_with_identity"] == 2, report["failures"]
    assert report["aggregate"]["paired_difference"]["values"] == pytest.approx([.1])
    expected = {"initial": initial, "evolved": evolved}
    for arm in report["arms"]:
        name = arm["arm"]
        assert arm["improver_origin"]["id"] == expected[name]["id"]
        parent = report["artifacts"][arm["parent"]["id"]]
        assert parent["files"]["task.py"] == target.initial_files()["task.py"]
        assert parent["component_digests"]["meta.py"] == expected[name]["component_digests"]["meta.py"]
        assert arm["attempts"][0]["execution"]["source_digest"] == parent["digest"]
    assert len(target.evaluations) == 8  # Development/transfer baseline + child for both M.
    assert all(row["report"]["execution"]["source_digest"] == row["bundle"]["digest"] for row in target.evaluations)
