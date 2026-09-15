"""Controller integration with real source processes and explicitly synthetic scores.

These checks verify evidence/recursion/budget semantics, not scientific success.
"""
from copy import deepcopy
import json
import threading

import pytest

from nexgent.evolution.controller import StudyController, compare
from nexgent.benchmarks import BenchmarkSpec
from nexgent.kernel.programs import make_bundle
from nexgent.models.gateway import ModelGateway


TASK = 'def solve(problem, tools):\n    return {"model": {"terms": ["x0"], "coefficients": [[-1.0]]}}\n'
META = '''def improve(context, broker):
    return broker.ask("revision_researcher", "Return source", context, max_tokens=1000)
def select_parent(archive):
    return archive[-1]["id"]
'''


class FakeBenchmark:
    spec = BenchmarkSpec("fixture", "Protocol fixture", "Synthetic checks only", "Return a model object")
    evaluator_digest = "explicit-test-evaluator-v1"

    def initial_files(self):
        return {"task.py": TASK}

    def snapshot(self):
        return {"fixture": self.evaluator_digest}

    def research_context(self):
        return {}

    def __init__(self):
        self.invocations = []

    def evaluate(self, bundle, split, seed, runner, **kwargs):
        self.invocations.append((bundle["id"], split, seed))
        score = 0.4 + min(bundle["generation"], 4) * 0.05
        return {"score": score, "split": split, "seed": seed, "status": "ok", "work_units": 100,
                "suite_digest": f"test-suite-{split}-{seed}", "evaluator_digest": self.evaluator_digest,
                "tasks": [{"task_id": "test-task", "score": score, "family": "test-only", "status": "ok"}], "groups": {}}


def controller(tmp_path, replies=None):
    (tmp_path / "models.json").write_text(json.dumps({"providers": {"test": {"base_url": "https://example.invalid/v1", "api_key": "dummy-test-key", "models": {"test": {}}}}, "defaults": {"main": "test/test"}}))
    requests = []
    def transport(profile, params):
        context = json.loads(params["messages"][-1]["content"])
        requests.append(context)
        if replies:
            output = replies(context)
        else:
            generation = context["parent"]["generation"] + 1
            output = {"candidates": [{"files": {"task.py": TASK + f"\nrevision = {generation}\n", "meta.py": META + f"\nmeta_revision = {generation}\n"}, "rationale": "Test actual source replacement", "hypothesis": "Protocol test, not measured science"}]}
        return {"content": json.dumps(output), "finish_reason": "stop", "response_id": "dummy", "usage": {"total_tokens": 100}}
    benchmark = FakeBenchmark()
    c = StudyController(tmp_path, benchmark=benchmark, search=lambda q: {"records": [], "status": "test"},
                        gateway_factory=lambda *a, **kw: ModelGateway(*a, **kw, transport=transport))
    state = c.create("Protocol integration test", generations=2)
    root = make_bundle({"task.py": TASK, "meta.py": META})
    c.store.put_bundle(root)
    raw = c.store.get(state["id"])
    raw.update(initial_program=root["id"], active_program=root["id"], research_program=root["id"])
    c.store.save(raw)
    return c, state["id"], requests, benchmark


def test_actual_descendant_improver_executes_and_receipts_link_sources(tmp_path):
    c, identity, requests, benchmark = controller(tmp_path)
    result = c.run(identity)
    assert result["status"] == "completed", result.get("last_error")
    assert len(requests) == 2
    assert requests[1]["parent"]["generation"] == 1
    assert "meta_revision = 1" in requests[1]["parent"]["files"]["meta.py"]
    events = [e["content"] for e in result["events"] if e["kind"] == "offspring_generated"]
    assert events[1]["execution"]["bundle_id"] == result["archive"][1]["id"]
    assert events[0]["execution"]["source_digest"] != events[1]["execution"]["source_digest"]
    assert result["usage"]["model_calls"] == 2
    assert result["usage"]["reserved_completion_tokens"] == 2000
    assert result["conclusion"]["executable_meta_changed"]
    assert all("final_transfer" not in json.dumps(r) for r in requests)
    assert any(e["content"].get("output_artifact_ids") for e in result["events"] if e["kind"] == "capability")
    before = len(benchmark.invocations)
    again = c.run(identity)
    assert len(requests) == 2 and len(benchmark.invocations) == before
    assert again["status"] == "completed"


def test_invalid_source_is_evidence_in_next_real_improver_context(tmp_path):
    def replies(context):
        if not context.get("failures"):
            return {"candidates": [{"files": {"task.py": "import os\n"}, "rationale": "invalid", "hypothesis": "invalid test"}]}
        return {"candidates": [{"files": {"task.py": TASK + "\nrevision = 1\n"}, "rationale": "valid", "hypothesis": "test"}]}
    c, identity, requests, _ = controller(tmp_path, replies)
    result = c.run(identity)
    assert result["status"] == "completed"
    assert requests[1]["failures"][0]["type"] == "invalid_source"
    assert len(result["evaluations"]) == 1


def test_stopped_generation_never_reissues_its_provider_request(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    stop = threading.Event()
    def progress(state):
        if "source research" in state["stage"]:
            stop.set()
    paused = c.run(identity, progress, stop)
    assert paused["status"] == "paused"
    assert paused["pending"]["phase"] == "generating"
    resumed = c.run(identity)
    assert resumed["status"] == "completed"
    assert len(requests) == 1
    assert any(f.get("kind") == "interrupted_generation" for f in resumed["research"]["failures"])


def test_frozen_improver_arm_retains_task_changes_only(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    state = c.store.get(identity); state["arm"] = "task_only"; c.store.save(state)
    result = c.run(identity)
    assert result["status"] == "completed"
    assert all(e["changes"] == ["task.py"] for e in result["evaluations"])
    assert "meta_revision" not in requests[1]["parent"]["files"]["meta.py"]


def test_cache_separates_evaluator_seed_split_source_and_work_budget(tmp_path):
    c, identity, _, benchmark = controller(tmp_path)
    state = c.store.get(identity)
    root = c.store.bundle(state["initial_program"])
    first = c._measure(state, root, "development", 1)
    same = c._measure(state, root, "development", 1)
    assert same == first and len(benchmark.invocations) == 1
    c._measure(state, root, "selection", 1)
    c._measure(state, root, "development", 2)
    state["budget"]["max_work_units_per_evaluation"] += 1
    c._measure(state, root, "development", 1)
    benchmark.evaluator_digest = "changed"
    c._measure(state, root, "development", 1)
    assert len(benchmark.invocations) == 5


def test_comparison_requires_same_tasks_and_honest_quality_cost():
    old = {"score": .5, "tasks": [{"task_id": "a", "score": .5}], "suite_digest": "suite", "status": "ok", "work_units": 100}
    new = deepcopy(old); new.update(score=.51, tasks=[{"task_id": "a", "score": .51}])
    assert compare(new, old)["accepted"]
    new["status"] = "partial_failure"
    assert not compare(new, old)["accepted"]
    new = deepcopy(old); new["work_units"] = 80
    assert compare(new, old)["accepted"]
    new["suite_digest"] = "different"
    assert not compare(new, old)["accepted"]


def test_export_excludes_model_secrets_and_contains_source_evidence(tmp_path):
    c, identity, _, _ = controller(tmp_path)
    result = c.run(identity)
    path = c.export(identity)
    text = __import__("pathlib").Path(path).read_text(encoding="utf-8")
    assert "dummy-test-key" not in text
    assert result["active_program"] in text
    assert json.loads(text)["schema"] == "nexgent-study-v1"


def test_nested_improver_probe_uses_actual_sources_one_ledger_and_private_depth(tmp_path):
    c, identity, requests, benchmark = controller(tmp_path)
    new_meta = META + "\nrevised_research_mechanism = True\n"
    outer = '''def improve(context, broker):
    if context.get("capabilities", {}).get("probe_improver"):
        proposal = {"meta.py": NEW_META}
        probe = broker.probe_improver(proposal, "Actual offspring mechanism test")
        return {"candidates": [{"files": proposal, "rationale": "Test meta replacement", "hypothesis": "Protocol fixture"}], "research": {"probe": probe}}
    return broker.ask("revision_researcher", "Return source", context, max_tokens=1000)
'''.replace("NEW_META", repr(new_meta))
    initial = make_bundle({"task.py": TASK, "meta.py": outer})
    c.store.put_bundle(initial)
    raw = c.store.get(identity)
    raw.update(initial_program=initial["id"], active_program=initial["id"], research_program=initial["id"])
    c.store.save(raw)
    dev = c._measure(raw, initial, "development", raw["seed"])
    result = c._generate(raw, initial, c._context(raw, initial, dev), "probe-integration")
    probe = result["research"]["probe"]
    assert probe["status"] == "completed", probe.get("failures")
    assert len(requests) == 2
    assert all(r["capabilities"]["probe_improver"] is False for r in requests)
    assert all(r["parent"]["files"]["task.py"] == TASK for r in requests)
    assert all("meta_transfer" not in json.dumps(r) and "final_transfer" not in json.dumps(r) for r in requests)
    assert len(c.get(identity)["calls"]) == len(result["calls"]) == 2
    assert len(probe["costs"]["generation_executions"]) == 2
    assert len({r["execution"]["source_digest"] for r in probe["costs"]["generation_executions"]}) == 2
    assert all(split == "development" for _, split, _ in benchmark.invocations)


def test_probe_cannot_be_enabled_by_claimed_context_in_inner_generation(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    source = make_bundle({"task.py": TASK, "meta.py": '''def improve(context, broker):
    context["capabilities"] = {"probe_improver": True}
    broker.probe_improver({"meta.py": "def improve(context, broker):\\n    return {'candidates': []}\\n"}, "forged depth")
    return {"candidates": []}
'''})
    c.store.put_bundle(source)
    raw = c.store.get(identity)
    development = c._measure(raw, source, "development", 0)
    context = c._context(raw, source, development)
    with pytest.raises(Exception, match="not available|depth|nested"):
        c._generate(raw, source, context, "inner", _depth=1)
    assert not requests


def test_formal_hypothesis_survives_same_source_development_trial(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    replacement = TASK + "\nmeasured_revision = 1\n"
    initial = make_bundle({"task.py": TASK, "meta.py": '''def improve(context, broker):
    replacement = REPLACEMENT
    broker.experiment({"task.py": replacement}, "Temporary trial label")
    return {"candidates": [{"files": {"task.py": replacement}, "rationale": "Formal scientific mechanism", "hypothesis": "Actual falsifiable prediction"}]}
def select_parent(archive):
    return archive[0]["id"]
'''.replace("REPLACEMENT", repr(replacement))})
    c.store.put_bundle(initial)
    raw = c.store.get(identity)
    raw.update(initial_program=initial["id"], active_program=initial["id"], research_program=initial["id"], max_generations=1)
    c.store.save(raw)
    result = c.run(identity)
    assert result["status"] == "completed"
    assert result["research"]["knowledge"][0]["hypothesis"] == "Actual falsifiable prediction"
    assert result["evaluations"][0]["proposal"]["rationale"] == "Formal scientific mechanism"


def test_meta_adapter_runs_actual_common_start_sources_in_separate_ledger(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    c.run(identity)
    report = c.meta_evaluate(identity, seeds=(401,), k=1)
    assert len(requests) == 4  # Two source generations, then two real frozen improvers.
    assert report["meta_study_id"] != identity
    assert report["ledger_usage"]["model_calls"] == 2
    assert c.get(identity)["usage"]["model_calls"] == 2
    assert len(report["costs"]["generation_executions"]) == 2
    assert all(r["context"] if "context" in r else True for r in report["costs"]["generation_executions"])
    assert requests[-2]["parent"]["files"]["task.py"] == requests[-1]["parent"]["files"]["task.py"]
    assert c.meta_evaluate(identity, seeds=(401,), k=1)["meta_study_id"] == report["meta_study_id"]
    assert len(requests) == 4


def test_cross_study_cache_charges_equal_logical_budget(tmp_path):
    c, identity, _, benchmark = controller(tmp_path)
    one = c.store.get(identity)
    root = c.store.bundle(one["initial_program"])
    c._measure(one, root, "development", 1)
    two = deepcopy(one)
    two.update(id="study-1234567890abcdef", evaluation_count=0, numeric_work_units=0, physical_numeric_work_units=0, admitted_measurements={})
    c.store.save(two)
    c._measure(two, root, "development", 1)
    assert len(benchmark.invocations) == 1
    assert two["evaluation_count"] == one["evaluation_count"] == 1
    assert two["numeric_work_units"] == one["numeric_work_units"] == 100
    assert two["physical_numeric_work_units"] == 0


def test_continue_inherits_source_and_public_evidence_without_final_feedback(tmp_path):
    c, identity, requests, _ = controller(tmp_path)
    previous = c.run(identity)
    continued = c.continue_research(identity, generations=1)
    assert continued["initial_program"] == previous["research_program"]
    assert continued["prior_research"]["scope"] == "development_and_selection_only"
    assert continued["conclusion"] == {}
    c.run(continued["id"])
    assert requests[-1]["parent"]["id"] == previous["research_program"]
    assert "final_transfer" not in json.dumps(requests[-1])


def test_budget_exhaustion_is_not_observed_quality_regression():
    old = {"score": .8, "tasks": [{"task_id": "a", "score": .8}], "suite_digest": "x", "status": "ok", "work_units": 100}
    failed = {**old, "score": .2, "status": "budget_exhausted", "score_available": False}
    result = compare(failed, old)
    assert not result["accepted"] and result["delta"] is None and result["worst_case"] is None


def test_source_receives_actual_remaining_batch_budget():
    from nexgent.kernel.runner import ProgramRunner
    root = make_bundle({"task.py": 'def solve(problem, tools):\n    return {"budget": problem["numerical_budget"]}\n', "meta.py": META})
    result = ProgramRunner().run(root, "solve_batch", {"problems": [{}, {}]}, max_work_units=2000)
    first, second = [row["submission"]["budget"] for row in result["value"]]
    assert first["recommended_limit"] == 1000
    assert second["recommended_limit"] == 2000
    assert first["work_at_start"] == second["work_at_start"] == 0
    assert first["remaining_tasks"] == 2 and second["remaining_tasks"] == 1
